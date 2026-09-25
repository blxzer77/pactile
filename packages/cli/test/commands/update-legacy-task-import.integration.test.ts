import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inquirer from "inquirer";

vi.mock("figlet", () => ({ default: { textSync: vi.fn(() => "PACTILE") } }));
vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((command: string) => {
    const python = process.platform === "win32" ? "python" : "python3";
    if (command === `${python} --version`) return "Python 3.12.10";
    if (command === "smart-search doctor --format json") {
      return JSON.stringify({ ok: true, minimum_profile_ok: true });
    }
    return "";
  }),
}));

import { init } from "../../src/commands/init.js";
import { update } from "../../src/commands/update.js";
import { buildLegacyTaskV2Import } from "../../src/core/task/legacy-task-v2-import.js";
import { scanLegacyTaskMigration } from "../../src/core/task/legacy-task-migration.js";
import { VERSION } from "../../src/constants/version.js";
import { readTaskKernel } from "../../src/core/task/task-kernel.js";
import {
  readPreparedLegacyTaskBatch,
  runLegacyTaskBatch,
} from "../../src/pactile/migration/legacy-task-batch.js";

const roots: string[] = [];
let originalIsTTY: PropertyDescriptor | undefined;
let root: string;

function projectFile(...parts: string[]): string {
  return path.join(root, ...parts);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function addLegacyTask(
  options: { readonly damagedKernel?: boolean } = {},
): string {
  const taskDir = projectFile(".pactile", "tasks", "09-26-legacy-task");
  writeJson(path.join(taskDir, "task.json"), {
    id: "legacy-task",
    title: "Legacy task preserved by update",
    description: "Existing work must remain source-preserved.",
    status: "completed",
    createdAt: "2026-09-25T12:00:00.000Z",
    creator: "legacy-author",
    deliverable: "A reviewable migrated Task",
    deliveryLevel: "local-result",
    custom_unknown_field: { keep: true },
  });
  fs.writeFileSync(
    path.join(taskDir, "prd.md"),
    "# Legacy PRD\n\n## Acceptance Criteria\n\n- The generated Task starts in Define without historical completion.\n",
    "utf8",
  );
  if (options.damagedKernel)
    fs.writeFileSync(path.join(taskDir, "kernel.json"), "{ damaged\n", "utf8");
  return taskDir;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-update-import-"));
  roots.push(root);
  vi.spyOn(process, "cwd").mockReturnValue(root);
  originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(inquirer.prompt).mockReset().mockResolvedValue({ proceed: true });
  vi.mocked(execSync).mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: VERSION }),
    }),
  );
  await init({ yes: true, force: true, skipReadiness: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (originalIsTTY)
    Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  for (const tempRoot of roots.splice(0))
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("pactile update legacy Task import", () => {
  it("keeps dry-run and cancelled updates free of migration writes", async () => {
    const taskDir = addLegacyTask();
    const taskBytes = fs.readFileSync(path.join(taskDir, "task.json"));
    const prdBytes = fs.readFileSync(path.join(taskDir, "prd.md"));

    await update({
      dryRun: true,
      skipReadiness: true,
      skipPostUpdateSmoke: true,
    });
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(
      fs.existsSync(
        projectFile(".pactile", "runtime", "legacy-task-migrations"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(taskDir, "task.json")).equals(taskBytes),
    ).toBe(true);
    expect(fs.readFileSync(path.join(taskDir, "prd.md")).equals(prdBytes)).toBe(
      true,
    );

    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: false });
    await update({ skipReadiness: true, skipPostUpdateSmoke: true });
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(
      fs.existsSync(
        projectFile(".pactile", "runtime", "legacy-task-migrations"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(taskDir, "task.json")).equals(taskBytes),
    ).toBe(true);
  });

  it("imports automatically after consent, preserves legacy bytes, and does not re-import on retry", async () => {
    const taskDir = addLegacyTask();
    const sourceBytes = fs.readFileSync(path.join(taskDir, "task.json"));
    const plan = scanLegacyTaskMigration({ projectRoot: root });
    const candidate = buildLegacyTaskV2Import(plan);
    const interrupted = await runLegacyTaskBatch(
      { projectRoot: root, plan, targets: candidate.targets },
      {
        approved: true,
        onPhase(phase) {
          if (phase === "targets-validated") {
            throw new Error(
              "simulated-process-interruption-before-update-retry",
            );
          }
        },
      },
    );
    expect(interrupted.status).toBe("interrupted");
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    await update({
      force: true,
      skipReadiness: true,
      skipPostUpdateSmoke: true,
    });
    const authority = readPreparedLegacyTaskBatch(root);
    expect(authority).toMatchObject({ visibility: "active-v2" });
    expect(
      fs.readFileSync(path.join(taskDir, "task.json")).equals(sourceBytes),
    ).toBe(true);
    const imported = readTaskKernel({ root, taskDir, cwd: root });
    expect(imported.kind).toBe("task-kernel-v2");
    if (imported.kind !== "task-kernel-v2")
      throw new Error("expected active V2 Task");
    expect(imported.kernel).toMatchObject({
      phase: "define",
      outcome: null,
      runs: [],
      reviews: [],
      closure: null,
      definition: {
        acceptanceCriteria: [
          {
            description:
              "The generated Task starts in Define without historical completion.",
          },
        ],
      },
    });

    const pointerBytes = fs.readFileSync(
      projectFile(
        ".pactile",
        "runtime",
        "legacy-task-migrations",
        "authority.json",
      ),
    );
    const userEditedTask = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf8"),
    ) as Record<string, unknown>;
    userEditedTask.user_after_import = "keep this post-import edit";
    writeJson(path.join(taskDir, "task.json"), userEditedTask);
    await update({
      force: true,
      skipReadiness: true,
      skipPostUpdateSmoke: true,
    });
    expect(
      fs
        .readFileSync(
          projectFile(
            ".pactile",
            "runtime",
            "legacy-task-migrations",
            "authority.json",
          ),
        )
        .equals(pointerBytes),
    ).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")),
    ).toMatchObject({ user_after_import: "keep this post-import edit" });
    expect(readTaskKernel({ root, taskDir, cwd: root }).kind).toBe(
      "task-kernel-v2",
    );
  });

  it("refuses a damaged legacy Kernel before update writes an authority pointer", async () => {
    const taskDir = addLegacyTask({ damagedKernel: true });
    const sourceBytes = fs.readFileSync(path.join(taskDir, "task.json"));
    await expect(
      update({ force: true, skipReadiness: true, skipPostUpdateSmoke: true }),
    ).rejects.toThrow(/Legacy Task migration preflight blocked/);
    expect(readPreparedLegacyTaskBatch(root)).toBeNull();
    expect(
      fs.existsSync(
        projectFile(".pactile", "runtime", "legacy-task-migrations"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(taskDir, "task.json")).equals(sourceBytes),
    ).toBe(true);
  });
});
