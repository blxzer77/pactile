import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyTaskRecord } from "../../../src/core/task/index.js";
import { KernelError } from "../../../src/core/task/kernel-contract.js";
import {
  applyKernelArchive,
  applyKernelCreate,
  applyKernelRecordGate,
  applyKernelStart,
  readKernel,
} from "../../../src/core/task/kernel-store.js";
import {
  LITE_BASELINE_MODULES,
  LITE_PACK_SOURCE,
  LITE_RETRIEVAL_INTENTS,
  LiteContextPackError,
  buildLiteContextPack,
} from "../../../src/core/task/lite-context-pack.js";

function liteRecord() {
  return emptyTaskRecord({
    id: "personal-lite",
    name: "personal-lite",
    title: "Personal Lite Demo",
    status: "planning",
    assignee: "developer",
    creator: "developer",
    priority: "P2",
  });
}

function writeDefinition(taskDir: string): void {
  fs.writeFileSync(
    path.join(taskDir, "prd.md"),
    [
      "# Personal Lite Demo",
      "",
      "## Acceptance Criteria",
      "",
      "- [x] Open to Close without Parent or Git",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeEvidence(taskDir: string): void {
  fs.writeFileSync(
    path.join(taskDir, "verify.md"),
    [
      "# Verification Evidence",
      "",
      "- validation: pnpm --filter @blxzer/pactile-core test",
      "- acceptance: Lite path completed without Parent",
      "- durable learning: no durable learning",
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("Stage 3 Personal Lite path", () => {
  let tmp: string;
  let taskDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-lite-path-"));
    taskDir = path.join(tmp, "08-28-personal-lite");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("create → start → archive without .git, Parent, or status rename", () => {
    expect(fs.existsSync(path.join(tmp, ".git"))).toBe(false);

    const created = applyKernelCreate({
      taskDir,
      actor: "task.py create",
      idempotencyKey: "create:personal-lite",
      record: liteRecord(),
    });
    writeDefinition(taskDir);
    writeEvidence(taskDir);

    expect(created.kernel.phase).toBe("define");
    expect(created.legacy.status).toBe("planning");
    expect(fs.existsSync(path.join(taskDir, "prd.md"))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, "verify.md"))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, "task-map.md"))).toBe(false);

    const started = applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "task.py start-execution --approved",
      idempotencyKey: "start:personal-lite",
      record: { ...liteRecord(), status: "in_progress" },
      extras: {
        execution_approval: {
          approved_by: "user",
          approval_source: "task.py start-execution --approved",
        },
      },
      evidence: "task.py start-execution --approved",
    });
    expect(started.kernel.phase).toBe("execute");
    expect(started.legacy.status).toBe("in_progress");

    const current = readKernel({ taskDir });
    const archived = applyKernelArchive({
      taskDir,
      expectedRevision: current.kernel.revision,
      actor: "task.py archive",
      idempotencyKey: "archive:personal-lite",
      record: {
        ...liteRecord(),
        status: "completed",
        completedAt: "2026-08-28",
      },
      evidence: "verify.md",
    });

    expect(archived.kernel.phase).toBe("close");
    expect(archived.kernel.outcome).toBe("completed");
    expect(archived.legacy.status).toBe("completed");
    expect(fs.existsSync(path.join(tmp, ".git"))).toBe(false);

    const taskJson = JSON.parse(
      fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"),
    ) as { status: string; children: unknown[]; parent: string | null };
    expect(taskJson.status).toBe("completed");
    expect(taskJson.children).toEqual([]);
    expect(taskJson.parent).toBeNull();
  });

  it("rejects fake-green PASS gates without evidence", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:personal-lite",
      record: liteRecord(),
    });
    try {
      applyKernelRecordGate({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "gate:fake",
        transition: "start-execution",
        gateName: "code-review",
        record: { result: "PASS", evidence: "" },
      });
      expect.unreachable("empty PASS evidence should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("INVALID_REQUEST");
    }
  });

  it("assembles a budgeted Lite pack without On-demand or workflow dump", () => {
    const pack = buildLiteContextPack({
      phase: "verify",
      artifacts: [
        {
          role: "definition",
          path: "prd.md",
          content: "# Lite\n\n## Acceptance Criteria\n\n- [x] Close without Git\n",
        },
        {
          role: "evidence",
          path: "verify.md",
          content: "- validation: core test\n- acceptance: done\n",
        },
      ],
    });

    expect(pack.source).toBe(LITE_PACK_SOURCE);
    expect(pack.modules.baseline).toEqual([...LITE_BASELINE_MODULES]);
    expect(pack.retrievalIntents).toEqual([...LITE_RETRIEVAL_INTENTS]);
    expect(pack.budget.itemsUsed).toBeGreaterThan(0);
    expect(pack.budget.estimatedTokens).toBeLessThanOrEqual(
      pack.budget.maxEstimatedTokens,
    );
    expect(pack.selected.some((item) => item.role === "retrieval-router")).toBe(
      true,
    );
    expect(
      pack.selected.some((item) =>
        ["parent-child", "vcs-integration", "personal-memory", "retention-storage", "retrieval-extended"].includes(
          item.module,
        ),
      ),
    ).toBe(false);
  });

  it("fails instead of silently dumping workflow.md or inactive On-demand", () => {
    expect(() =>
      buildLiteContextPack({
        phase: "define",
        includeFullWorkflow: true,
      }),
    ).toThrow(LiteContextPackError);

    expect(() =>
      buildLiteContextPack({
        phase: "define",
        artifacts: [{ role: "definition", path: "workflow.md", content: "x" }],
      }),
    ).toThrow(/workflow.md dump/);

    expect(() =>
      buildLiteContextPack({
        phase: "execute",
        activatedModules: ["parent-child"],
      }),
    ).toThrow(/On-demand module: parent-child/);

    expect(() =>
      buildLiteContextPack({
        phase: "execute",
        artifacts: [
          {
            role: "evidence",
            module: "retrieval-extended",
            path: "retrieval-pack-latest.json",
            content: "{}",
          },
        ],
      }),
    ).toThrow(/retrieval-extended/);
  });

  it("omits overflow items under a tight budget instead of dumping", () => {
    const pack = buildLiteContextPack({
      phase: "verify",
      maxItems: 1,
      maxEstimatedTokens: 80,
      artifacts: [
        {
          role: "definition",
          path: "prd.md",
          content: "x".repeat(400),
        },
        {
          role: "evidence",
          path: "verify.md",
          content: "y".repeat(400),
        },
      ],
    });
    expect(pack.budget.itemsUsed).toBe(1);
    expect(pack.omitted.length).toBeGreaterThan(0);
    expect(pack.warnings).toContain("budget limits caused Lite pack omission");
  });
});
