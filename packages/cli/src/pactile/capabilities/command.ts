import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import type {
  BoundedCapabilityRequestV1,
  RunCapabilityDataV1,
} from "../../core/index.js";
import {
  CapabilityNodeError,
  isInside,
  jsonBytes,
  operationDataBudget,
  stopReason,
  stopResult,
  truncateUtf8,
  type OperationResult,
} from "./shared.js";
import { realDirectory } from "./workspace.js";

function fitRunOutput(
  data: RunCapabilityDataV1,
  maxOutputBytes: number,
): RunCapabilityDataV1 {
  let stdout = data.stdout;
  let stderr = data.stderr;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const wasReduced = stdout !== data.stdout || stderr !== data.stderr;
    const candidate = {
      ...data,
      stdout,
      stderr,
      truncated: data.truncated || wasReduced,
    };
    if (jsonBytes(candidate) <= maxOutputBytes) return candidate;
    if (
      Buffer.byteLength(stdout, "utf8") >= Buffer.byteLength(stderr, "utf8")
    ) {
      stdout = truncateUtf8(
        stdout,
        Math.floor(Buffer.byteLength(stdout, "utf8") * 0.75),
      );
    } else {
      stderr = truncateUtf8(
        stderr,
        Math.floor(Buffer.byteLength(stderr, "utf8") * 0.75),
      );
    }
  }
  return { ...data, stdout: "", stderr: "", truncated: true };
}

async function executableSearchPath(root: string): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = path.resolve(entry);
    if (isInside(root, candidate)) continue;
    try {
      const resolved = await fsp.realpath(candidate);
      if (!isInside(root, resolved) && !seen.has(resolved)) {
        result.push(resolved);
        seen.add(resolved);
      }
    } catch {
      // An unusable PATH entry cannot provide an approved executable.
    }
  }
  return result;
}

async function resolveAllowedExecutable(
  root: string,
  commandId: string,
): Promise<{ readonly executable: string; readonly path: string }> {
  const searchPath = await executableSearchPath(root);
  if (/^node(?:\.exe)?$/iu.test(commandId)) {
    const executable = await fsp.realpath(process.execPath);
    if (!isInside(root, executable)) {
      return { executable, path: searchPath.join(path.delimiter) };
    }
  }
  const name =
    process.platform === "win32" && !/\.exe$/iu.test(commandId)
      ? `${commandId}.exe`
      : commandId;
  if (process.platform === "win32" && !/\.exe$/iu.test(name)) {
    throw new CapabilityNodeError(
      "ADAPTER_UNAVAILABLE",
      "The approved command is unavailable.",
    );
  }
  for (const directory of searchPath) {
    const candidate = path.join(directory, name);
    try {
      const resolved = await fsp.realpath(candidate);
      const stat = await fsp.stat(resolved);
      if (!stat.isFile() || isInside(root, resolved)) continue;
      if (
        process.platform !== "win32" &&
        !(await fsp.access(resolved, fs.constants.X_OK).then(
          () => true,
          () => false,
        ))
      ) {
        continue;
      }
      return { executable: resolved, path: searchPath.join(path.delimiter) };
    } catch {
      // Continue with the next trusted, absolute PATH directory.
    }
  }
  throw new CapabilityNodeError(
    "ADAPTER_UNAVAILABLE",
    "The approved command is unavailable.",
  );
}

async function terminateProcessTree(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    const taskkill = systemRoot
      ? path.join(systemRoot, "System32", "taskkill.exe")
      : null;
    if (taskkill && fs.existsSync(taskkill)) {
      await new Promise<void>((resolve) => {
        const killer = spawn(
          taskkill,
          ["/PID", String(child.pid), "/T", "/F"],
          {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          },
        );
        killer.once("error", () => resolve());
        killer.once("close", () => resolve());
      });
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runCommand(
  root: string,
  request: Extract<BoundedCapabilityRequestV1, { operation: "run" }>,
  signal: AbortSignal,
): Promise<OperationResult> {
  const stopped = stopReason(signal);
  if (stopped) return stopResult(stopped, null);
  const cwd = await realDirectory(root, request.cwd);
  const beforeResolveStop = stopReason(signal);
  if (beforeResolveStop) return stopResult(beforeResolveStop, null);
  const rawLimit = operationDataBudget(request);
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  let stdout = "";
  let stderr = "";
  let bytesCaptured = 0;
  let truncated = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const args = [...request.args];
  const { executable, path: safePath } = await resolveAllowedExecutable(
    root,
    request.command,
  );
  const beforeSpawnStop = stopReason(signal);
  if (beforeSpawnStop) return stopResult(beforeSpawnStop, null);
  const child = spawn(executable, args, {
    cwd,
    env: {
      PATH: safePath,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    },
    shell: false,
    windowsHide: true,
    ...(process.platform !== "win32" ? { detached: true } : {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let termination: Promise<void> | null = null;
  const terminate = (): void => {
    termination ??= terminateProcessTree(child);
  };
  const onAbort = (): void => terminate();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) terminate();
  const capture = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
    const available = Math.max(0, rawLimit - bytesCaptured);
    const accepted = chunk.subarray(0, available);
    bytesCaptured += accepted.length;
    if (stream === "stdout") stdout += outDecoder.write(accepted);
    else stderr += errDecoder.write(accepted);
    if (accepted.length < chunk.length) {
      truncated = true;
      terminate();
    }
  };
  child.stdout.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
  let launchError: unknown;
  child.once("error", (error) => {
    launchError = error;
  });
  await new Promise<void>((resolve) => {
    child.once("close", (code, closeSignal) => {
      exitCode = code;
      exitSignal = closeSignal;
      resolve();
    });
  });
  if (termination) await termination;
  signal.removeEventListener("abort", onAbort);
  stdout += outDecoder.end();
  stderr += errDecoder.end();
  if (launchError) {
    const code =
      launchError && typeof launchError === "object" && "code" in launchError
        ? String((launchError as { code?: unknown }).code)
        : "";
    if (code === "ENOENT")
      throw new CapabilityNodeError(
        "ADAPTER_UNAVAILABLE",
        "The approved command is unavailable.",
      );
    if (code === "EACCES" || code === "EPERM")
      throw new CapabilityNodeError(
        "PERMISSION_DENIED",
        "The approved command could not be launched.",
      );
    throw new CapabilityNodeError(
      "EXECUTION_FAILED",
      "The approved command could not be launched.",
    );
  }
  const completed = fitRunOutput(
    {
      command: request.command,
      exitCode,
      signal: exitSignal,
      stdout,
      stderr,
      bytesCaptured,
      truncated,
    },
    operationDataBudget(request),
  );
  const stop = stopReason(signal);
  if (stop) return stopResult(stop, completed);
  if (truncated || completed.truncated) {
    return {
      data: completed,
      outcome: "partial",
      partial: true,
      error: {
        code: "OUTPUT_LIMIT",
        message: "The command output reached its byte limit.",
      },
    };
  }
  if (exitCode !== 0) {
    return {
      data: completed,
      outcome: "failed",
      partial: false,
      error: {
        code: "EXECUTION_FAILED",
        message: "The command exited with a non-zero status.",
      },
    };
  }
  return { data: completed, outcome: "complete", partial: false, error: null };
}
