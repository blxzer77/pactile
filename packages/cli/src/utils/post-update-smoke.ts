import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { UpdateSmokeCheckResult } from "./update-rollout-report.js";

const cliBin = fileURLToPath(new URL("../../bin/pactile.js", import.meta.url));

function runCheck(args: string[], cwd: string): UpdateSmokeCheckResult {
  const command = `node pactile ${args.join(" ")}`;
  try {
    execFileSync(process.execPath, [cliBin, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120_000,
    });
    return { command, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "command failed";
    return { command, ok: false, detail: message.replace(/\s+/g, " ").trim() };
  }
}

/** Non-destructive Node CLI checks after an update. */
export function runPostUpdateSmoke(cwd: string): UpdateSmokeCheckResult[] {
  return [
    runCheck(["--help"], cwd),
    runCheck(["task", "dashboard"], cwd),
    runCheck(["context", "--mode", "packages", "--json"], cwd),
  ];
}
