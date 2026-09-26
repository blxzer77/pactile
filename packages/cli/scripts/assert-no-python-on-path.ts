import fs from "node:fs";
import path from "node:path";

export const BLOCKED_NODE_ONLY_PATH_EXECUTABLES = [
  "python",
  "python.exe",
  "python.cmd",
  "python.bat",
  "python.ps1",
  "python3",
  "python3.exe",
  "python3.cmd",
  "python3.bat",
  "python3.ps1",
  "py",
  "py.exe",
  "py.cmd",
  "py.bat",
  "py.ps1",
  "pi",
  "pi.exe",
  "pi.cmd",
  "pi.bat",
  "pi.ps1",
] as const;

export function assertNoPythonOrPiOnPath({
  env,
}: {
  env: NodeJS.ProcessEnv;
}): void {
  const pathValues = new Set(
    [env.PATH, env.Path].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const available: string[] = [];
  for (const pathValue of pathValues) {
    for (const folder of pathValue.split(path.delimiter)) {
      if (!folder) continue;
      for (const executable of BLOCKED_NODE_ONLY_PATH_EXECUTABLES) {
        if (fs.existsSync(path.join(folder, executable))) {
          available.push(path.join(folder, executable));
        }
      }
    }
  }
  if (available.length > 0) {
    throw new Error(
      `Node-only conformance PATH contains Python or Pi executables: ${available.join(", ")}`,
    );
  }
}
