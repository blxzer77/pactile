import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inquirer from "inquirer";

import {
  emptyTaskRecord,
  isWaveCConfirmed,
  WAVE_C_STATE_REL,
} from "@blxzer/pactile-core/task";

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "PACTILE") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn().mockImplementation((cmd: string) => {
      const py = process.platform === "win32" ? "python" : "python3";
      if (cmd === `${py} --version`) return "Python 3.11.12";
      if (cmd === "smart-search doctor --format json") {
        return JSON.stringify({ ok: true, minimum_profile_ok: true });
      }
      return "";
    }),
  };
});

import { init } from "../../src/commands/init.js";
import { update } from "../../src/commands/update.js";
import { migratePreview } from "../../src/commands/migrate.js";
import { DIR_NAMES } from "../../src/constants/paths.js";
import { computeHash } from "../../src/utils/template-hash.js";

const TRIAGE = `---
description: "old triage"
alwaysApply: true
---

# old triage
`;

const PRD = "# KEEP-THIS-PRD-BODY\n";
const PY = process.platform === "win32" ? "python" : "python3";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readHashesV2(hashFile: string): Record<string, string> {
  const raw = JSON.parse(fs.readFileSync(hashFile, "utf-8")) as {
    hashes?: Record<string, string>;
  };
  return raw.hashes ?? {};
}

function writeHashesV2(hashFile: string, hashes: Record<string, string>): void {
  fs.writeFileSync(hashFile, JSON.stringify({ __version: 2, hashes }, null, 2));
}

describe("update() P36 A+B+C", () => {
  let tmpDir: string;
  let origIsTTY: PropertyDescriptor | undefined;

  function projectFile(relativePath: string): string {
    return path.join(tmpDir, relativePath);
  }

  function plantLegacySurfaces(): string {
    const waveCFlag = projectFile(WAVE_C_STATE_REL);
    if (fs.existsSync(waveCFlag)) {
      fs.unlinkSync(waveCFlag);
    }
    const triage = projectFile(".cursor/rules/cstl-triage.mdc");
    fs.mkdirSync(path.dirname(triage), { recursive: true });
    fs.writeFileSync(triage, TRIAGE, "utf-8");
    const hashFile = projectFile(`${DIR_NAMES.WORKFLOW}/.template-hashes.json`);
    const hashes = readHashesV2(hashFile);
    hashes[".cursor/rules/cstl-triage.mdc"] = computeHash(TRIAGE);
    writeHashesV2(hashFile, hashes);

    const taskDir = projectFile(`${DIR_NAMES.WORKFLOW}/tasks/old-lite`);
    writeJson(path.join(taskDir, "task.json"), {
      ...emptyTaskRecord({
        id: "old-lite",
        name: "old-lite",
        title: "Old lite",
        status: "in_progress",
        parent: "some-parent",
      }),
      kind: "parent",
      meta: { classification: "parent" },
    });
    fs.writeFileSync(path.join(taskDir, "prd.md"), PRD, "utf-8");
    return taskDir;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-upd-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    origIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: true });
    await init({ yes: true, force: true, skipReadiness: true });
  });

  afterEach(() => {
    if (origIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", origIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dry-run prints A+B+C summary and writes nothing", async () => {
    const taskDir = plantLegacySurfaces();
    const triage = projectFile(".cursor/rules/cstl-triage.mdc");
    const taskBefore = fs.readFileSync(path.join(taskDir, "task.json"), "utf-8");
    await update({ dryRun: true, skipReadiness: true, json: true });
    expect(fs.existsSync(triage)).toBe(true);
    expect(fs.existsSync(projectFile(WAVE_C_STATE_REL))).toBe(false);
    expect(isWaveCConfirmed(tmpDir)).toBe(false);
    expect(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8")).toBe(
      taskBefore,
    );
    expect(fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8")).toBe(PRD);
    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(logs.some((line) => line.includes("升级摘要") || line.includes("官方面"))).toBe(
      true,
    );
    expect(logs.some((line) => line.includes("确认后才会停读旧形状"))).toBe(true);
    expect(logs.some((line) => line.includes(".p36-wave-c.json"))).toBe(true);
    expect(logs.some((line) => line.includes("--force"))).toBe(true);
    expect(logs.some((line) => /Stage\s*[0-7]/.test(line))).toBe(false);
  });

  it("refuse keeps the project unchanged and does not stop-read", async () => {
    const taskDir = plantLegacySurfaces();
    const triage = projectFile(".cursor/rules/cstl-triage.mdc");
    const taskBefore = fs.readFileSync(path.join(taskDir, "task.json"), "utf-8");
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: false });
    await update({ skipReadiness: true });
    expect(fs.existsSync(triage)).toBe(true);
    expect(fs.existsSync(projectFile(WAVE_C_STATE_REL))).toBe(false);
    expect(isWaveCConfirmed(tmpDir)).toBe(false);
    expect(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8")).toBe(
      taskBefore,
    );
  });

  it("interactive Proceed? migrates A, dual-reads B, and confirms wave C stop-read", async () => {
    const taskDir = plantLegacySurfaces();
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: true });
    await update({ skipReadiness: true, skipPostUpdateSmoke: true });
    expect(fs.existsSync(projectFile(".cursor/rules/cstl-triage.mdc"))).toBe(
      false,
    );
    expect(isWaveCConfirmed(tmpDir)).toBe(true);
    const disk = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(disk.required_controls).toBeUndefined();
    expect(disk.status).toBe("in_progress");
    expect(fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8")).toBe(PRD);
  });

  it("smoke failure still reaches Proceed?; refuse writes no flag", async () => {
    plantLegacySurfaces();
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === `${PY} --version`) return "Python 3.11.12";
      if (cmd === "smart-search doctor --format json") {
        const error = new Error("Command failed: smart-search doctor");
        Object.assign(error, {
          status: 2,
          stdout: JSON.stringify({
            ok: false,
            minimum_profile_ok: false,
            error: "standard minimum profile is not configured",
          }),
        });
        throw error;
      }
      return "";
    });
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: false });
    await update({ skipPostUpdateSmoke: true });
    expect(inquirer.prompt).toHaveBeenCalled();
    expect(isWaveCConfirmed(tmpDir)).toBe(false);
    expect(fs.existsSync(projectFile(WAVE_C_STATE_REL))).toBe(false);
  });

  it("smoke failure still reaches Proceed?; yes writes the Wave C flag", async () => {
    plantLegacySurfaces();
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === `${PY} --version`) return "Python 3.11.12";
      if (cmd === "smart-search doctor --format json") {
        const error = new Error("Command failed: smart-search doctor");
        Object.assign(error, {
          status: 2,
          stdout: JSON.stringify({
            ok: false,
            minimum_profile_ok: false,
            error: "standard minimum profile is not configured",
          }),
        });
        throw error;
      }
      return "";
    });
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: true });
    await update({ skipPostUpdateSmoke: true });
    expect(inquirer.prompt).toHaveBeenCalled();
    expect(isWaveCConfirmed(tmpDir)).toBe(true);
  });

  it("file-conflict flags apply A but do not write the Wave C flag", async () => {
    const taskDir = plantLegacySurfaces();
    await update({ force: true, skipReadiness: true, skipPostUpdateSmoke: true });
    expect(fs.existsSync(projectFile(".cursor/rules/cstl-triage.mdc"))).toBe(
      false,
    );
    expect(fs.existsSync(projectFile(WAVE_C_STATE_REL))).toBe(false);
    expect(isWaveCConfirmed(tmpDir)).toBe(false);
    expect(fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8")).toBe(PRD);

    const skipDir = plantLegacySurfaces();
    await update({ skipAll: true, skipReadiness: true, skipPostUpdateSmoke: true });
    expect(isWaveCConfirmed(tmpDir)).toBe(false);
    expect(fs.readFileSync(path.join(skipDir, "prd.md"), "utf-8")).toBe(PRD);
  }, 240_000);

  it("maintainer flag writes B projections after confirm", async () => {
    const taskDir = plantLegacySurfaces();
    await update({
      force: true,
      skipReadiness: true,
      skipPostUpdateSmoke: true,
      writeArtifacts: true,
    });
    const disk = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect((disk.required_controls as { rigor?: string }).rigor).toBe("lite");
    expect((disk.topology as { kind?: string }).kind).toBe("single");
    expect(disk.title).toBe("Old lite");
    expect(fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8")).toBe(PRD);
  });

  it("migrate --dry-run never writes", () => {
    const taskDir = plantLegacySurfaces();
    const before = fs.readFileSync(path.join(taskDir, "task.json"), "utf-8");
    migratePreview({ dryRun: true, writeArtifacts: true });
    expect(fs.existsSync(projectFile(".cursor/rules/cstl-triage.mdc"))).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8")).toBe(
      before,
    );
  });
});
