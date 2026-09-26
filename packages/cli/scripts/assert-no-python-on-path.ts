import { spawnSync } from "node:child_process";

const PYTHON_COMMANDS = [
  "python",
  "python.exe",
  "python3",
  "python3.exe",
  "py",
  "py.exe",
] as const;

interface ProbeResult {
  error?: NodeJS.ErrnoException | null;
}
type PythonCommandProbe = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) => ProbeResult;

function probePythonCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ProbeResult {
  const result = spawnSync(command, ["--version"], {
    cwd,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  return { error: result.error };
}

export function assertNoPythonOnPath({
  cwd,
  env,
  probe = probePythonCommand,
}: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  probe?: PythonCommandProbe;
}): void {
  for (const command of PYTHON_COMMANDS) {
    const result = probe(command, cwd, env);
    if (result.error?.code !== "ENOENT") {
      throw new Error(
        `Python command is available on the conformance PATH: ${command}`,
      );
    }
  }
}
