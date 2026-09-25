import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseBoundedCapabilityRequestV1 } from "../core/index.js";
import {
  createDefaultCapabilityPolicyV1,
  executeNodeCapabilityRequestV1,
} from "../pactile/capabilities/node.js";

const MAX_REQUEST_BYTES = 256 * 1024;

function required(value: string | undefined, label: string): string {
  if (!value || value.startsWith("--")) throw new Error(`${label} is required`);
  return value;
}

function allOptions(args: readonly string[], optionName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === optionName) {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${optionName} requires a value`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value)) {
        throw new Error(`${optionName} must be a command id, not a path`);
      }
      values.push(value);
      index += 1;
    } else {
      throw new Error(`unknown option: ${args[index]}`);
    }
  }
  return values;
}

async function readRequestFile(
  root: string,
  requestFile: string,
): Promise<{ readonly bytes: Buffer; readonly relativePath: string }> {
  const rootReal = await fs.realpath(root);
  const file = path.resolve(rootReal, requestFile);
  const lexicalRelative = path.relative(rootReal, file);
  if (
    path.isAbsolute(lexicalRelative) ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${path.sep}`) ||
    lexicalRelative.split(path.sep).some((segment) => {
      const base = segment.split(".", 1)[0] ?? "";
      return (
        segment.includes(":") ||
        segment.endsWith(".") ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(base)
      );
    })
  ) {
    throw new Error("request file must use a safe workspace-relative path");
  }
  const resolved = await fs.realpath(file);
  const relative = path.relative(rootReal, resolved);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("request file must resolve inside the workspace");
  }
  const expected = await fs.stat(resolved);
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await fs.open(resolved, fsConstants.O_RDONLY | noFollow);
  try {
    const [stat, link, currentPath] = await Promise.all([
      handle.stat(),
      fs.lstat(resolved),
      fs.realpath(file),
    ]);
    if (
      !stat.isFile() ||
      link.isSymbolicLink() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.dev !== link.dev ||
      stat.ino !== link.ino ||
      currentPath !== resolved
    ) {
      throw new Error(
        "request file changed while its workspace boundary was checked",
      );
    }
    const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead > MAX_REQUEST_BYTES) {
      throw new Error(`request file exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    return {
      bytes: buffer.subarray(0, read.bytesRead),
      relativePath: path.relative(rootReal, resolved).replaceAll("\\", "/"),
    };
  } finally {
    await handle.close();
  }
}

/** Execute a versioned capability request; Node is the default adapter. */
export async function runCapabilityCli(
  argv: string[],
  root = process.cwd(),
): Promise<number> {
  const [requestFile, ...args] = argv;
  let controller: AbortController | null = null;
  const onInterrupt = (): void => controller?.abort("CANCELLED");
  try {
    const relativeRequestFile = required(requestFile, "request file");
    const requestFileData = await readRequestFile(root, relativeRequestFile);
    let input: unknown;
    try {
      input = JSON.parse(requestFileData.bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error("request file must contain valid JSON");
    }
    const parsed = parseBoundedCapabilityRequestV1(input);
    if (!parsed.success) {
      throw new Error(
        parsed.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; "),
      );
    }
    const allowedCommands = allOptions(args, "--allow-command");
    controller = new AbortController();
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    const result = await executeNodeCapabilityRequestV1(parsed.data, {
      root,
      policy: createDefaultCapabilityPolicyV1(allowedCommands),
      signal: controller.signal,
      adapterId: "node",
      excludedPaths: [requestFileData.relativePath],
    });
    console.log(JSON.stringify(result));
    return ["complete", "empty", "partial"].includes(result.outcome) ? 0 : 1;
  } catch (error) {
    console.error(
      `Pactile capability: ${error instanceof Error ? error.message : "request failed"}`,
    );
    return 2;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}
