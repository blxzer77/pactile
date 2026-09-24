import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyTaskRecord } from "../../../src/core/task/index.js";
import { KernelError } from "../../../src/core/task/kernel-contract.js";
import {
  applyKernelArchive,
  applyKernelCreate,
  applyKernelPatch,
  applyKernelRecordGate,
  applyKernelStart,
  readKernel,
} from "../../../src/core/task/kernel-store.js";
import {
  FULL_BASELINE_CONTROLS,
  buildAcEvidenceLedger,
  evaluateIndependentCheck,
  parseAcceptanceItems,
  qualityFingerprint,
  resolveRequiredControls,
} from "../../../src/core/task/full-quality.js";

function fullRecord() {
  return emptyTaskRecord({
    id: "full-quality",
    name: "full-quality",
    title: "Full Quality Demo",
    status: "planning",
    assignee: "developer",
    creator: "developer",
    priority: "P2",
  });
}

const PRD = [
  "# Full Quality Demo",
  "",
  "## Acceptance Criteria",
  "",
  "- [x] Conditional Design does not infer Rigor from files",
  "- [x] AC maps to real Evidence",
  "",
].join("\n");

const IMPLEMENT = [
  "# Implement",
  "",
  "execution_mode: inline",
  "verification_profile: standard",
  "",
].join("\n");

const VERIFY = [
  "# Verification Evidence",
  "",
  "- validation: pnpm --filter @blxzer/pactile-core test",
  "- acceptance: Full Quality Close completed",
  "- durable learning: no durable learning",
  "",
].join("\n");

function fullControls(overrides: Record<string, unknown> = {}) {
  return {
    required_controls: resolveRequiredControls({
      rigor: "full",
      verificationProfile: "standard",
    }),
    ...overrides,
  };
}

function writeSurfaces(
  taskDir: string,
  files: { prd?: boolean; implement?: boolean; verify?: boolean; design?: boolean },
): void {
  if (files.prd !== false) fs.writeFileSync(path.join(taskDir, "prd.md"), PRD, "utf-8");
  if (files.implement) {
    fs.writeFileSync(path.join(taskDir, "implement.md"), IMPLEMENT, "utf-8");
  }
  if (files.verify) fs.writeFileSync(path.join(taskDir, "verify.md"), VERIFY, "utf-8");
  if (files.design) {
    fs.writeFileSync(path.join(taskDir, "design.md"), "# Design\n\nRisk required.\n", "utf-8");
  }
}

function ledgerFor(taskDir: string, testedCodeFingerprint = "code-v1") {
  const prd = fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8");
  const verify = fs.readFileSync(path.join(taskDir, "verify.md"), "utf-8");
  const items = parseAcceptanceItems(prd);
  return buildAcEvidenceLedger({
    acceptanceItems: items,
    mappings: items.map((item) => ({
      ac_id: item.id,
      evidence_ref: "verify.md#validation",
    })),
    sourceFingerprint: qualityFingerprint(prd),
    evidenceFingerprint: qualityFingerprint(verify),
    testedCodeFingerprint,
  });
}

function selfReview(codeFingerprint = "code-v1") {
  return evaluateIndependentCheck({
    mode: "self-review",
    independentWorkerAvailable: false,
    evidence: "check.jsonl self-review of Full Quality surfaces",
    codeFingerprint,
  });
}

describe("Stage 4 Full Quality", () => {
  let tmp: string;
  let taskDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-full-quality-"));
    taskDir = path.join(tmp, "08-28-full-quality");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("persists required_controls without inferring Rigor from design.md", () => {
    const withoutDesign = resolveRequiredControls({
      rigor: "full",
      verificationProfile: "standard",
    });
    expect(withoutDesign.controls).toEqual([...FULL_BASELINE_CONTROLS]);
    expect(withoutDesign.controls).not.toContain("design");

    const withArchitecture = resolveRequiredControls({
      rigor: "full",
      verificationProfile: "architecture",
    });
    expect(withArchitecture.controls).toContain("design");

    const created = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:full",
      record: fullRecord(),
      extras: { required_controls: withoutDesign },
    });
    fs.writeFileSync(path.join(taskDir, "design.md"), "# accidental\n", "utf-8");
    expect(created.kernel.projection?.extras.required_controls).toMatchObject({
      rigor: "full",
    });
    expect(
      (created.kernel.projection?.extras.required_controls as { controls: string[] })
        .controls,
    ).not.toContain("design");
  });

  it("starts Full without design.md when Design is not a required control", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:full",
      record: fullRecord(),
      extras: fullControls(),
    });
    writeSurfaces(taskDir, { implement: true });
    expect(fs.existsSync(path.join(taskDir, "design.md"))).toBe(false);

    const started = applyKernelStart({
      taskDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "start:full",
      record: { ...fullRecord(), status: "in_progress" },
      extras: { execution_approval: { approved_by: "user" } },
      evidence: "task.py start-execution --approved",
    });
    expect(started.kernel.phase).toBe("execute");
    expect(started.legacy.status).toBe("in_progress");
  });

  it("rejects start when Risk/Policy requires Design and design.md is missing", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:full",
      record: fullRecord(),
      extras: {
        required_controls: resolveRequiredControls({
          rigor: "full",
          verificationProfile: "architecture",
          policyRequiresDesign: true,
        }),
      },
    });
    writeSurfaces(taskDir, { implement: true });
    try {
      applyKernelStart({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "start:full",
        record: { ...fullRecord(), status: "in_progress" },
      });
      expect.unreachable("missing design.md should fail");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("INVALID_REQUEST");
      expect((err as KernelError).message).toMatch(/design.md/);
    }
  });

  it("closes Full with AC ledger and self-review; Lite extras are not required", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:full",
      record: fullRecord(),
      extras: fullControls(),
    });
    writeSurfaces(taskDir, { implement: true, verify: true });
    applyKernelStart({
      taskDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "start:full",
      record: { ...fullRecord(), status: "in_progress" },
    });
    const patched = applyKernelPatch({
      taskDir,
      expectedRevision: readKernel({ taskDir }).kernel.revision,
      actor: "a",
      idempotencyKey: "patch:ledger",
      extras: {
        ac_evidence_ledger: ledgerFor(taskDir),
        independent_check: selfReview(),
      },
    });
    const archived = applyKernelArchive({
      taskDir,
      expectedRevision: patched.kernel.revision,
      actor: "a",
      idempotencyKey: "archive:full",
      record: { ...fullRecord(), status: "completed", completedAt: "2026-08-28" },
      evidence: "verify.md",
    });
    expect(archived.kernel.phase).toBe("close");
    expect(archived.legacy.status).toBe("completed");
  });

  it("rejects Close without AC mapping or with placeholder evidence", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:full",
      record: fullRecord(),
      extras: fullControls(),
    });
    writeSurfaces(taskDir, { implement: true, verify: true });
    applyKernelStart({
      taskDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "start:full",
      record: { ...fullRecord(), status: "in_progress" },
    });
    applyKernelPatch({
      taskDir,
      expectedRevision: readKernel({ taskDir }).kernel.revision,
      actor: "a",
      idempotencyKey: "patch:bad-ledger",
      extras: {
        ac_evidence_ledger: {
          schema_version: 1,
          items: [{ ac_id: "AC-1", evidence_ref: "TBD" }],
          source_fingerprint: "x",
          evidence_fingerprint: "y",
        },
        independent_check: selfReview(),
      },
    });
    try {
      applyKernelArchive({
        taskDir,
        expectedRevision: readKernel({ taskDir }).kernel.revision,
        actor: "a",
        idempotencyKey: "archive:full",
        record: { ...fullRecord(), status: "completed", completedAt: "2026-08-28" },
      });
      expect.unreachable("placeholder ledger should fail");
    } catch (err) {
      expect((err as KernelError).code).toBe("INVALID_REQUEST");
    }
  });

  it("invalidates ledger and Independent Check after tested-code fingerprint change", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:full",
      record: fullRecord(),
      extras: fullControls({
        ac_evidence_ledger: undefined,
      }),
    });
    writeSurfaces(taskDir, { implement: true, verify: true });
    applyKernelStart({
      taskDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "start:full",
      record: { ...fullRecord(), status: "in_progress" },
    });
    applyKernelPatch({
      taskDir,
      expectedRevision: readKernel({ taskDir }).kernel.revision,
      actor: "a",
      idempotencyKey: "patch:ledger",
      extras: {
        ac_evidence_ledger: ledgerFor(taskDir, "code-v1"),
        independent_check: selfReview("code-v1"),
      },
    });
    fs.writeFileSync(path.join(taskDir, "prd.md"), `${PRD}\n- [x] extra\n`, "utf-8");
    try {
      applyKernelArchive({
        taskDir,
        expectedRevision: readKernel({ taskDir }).kernel.revision,
        actor: "a",
        idempotencyKey: "archive:stale",
        record: { ...fullRecord(), status: "completed", completedAt: "2026-08-28" },
      });
      expect.unreachable("stale definition fingerprint should fail");
    } catch (err) {
      expect((err as KernelError).message).toMatch(/stale/);
    }
  });

  it("invalidates Independent Check when its code fingerprint no longer matches the ledger", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:full",
      record: fullRecord(),
      extras: fullControls(),
    });
    writeSurfaces(taskDir, { implement: true, verify: true });
    applyKernelStart({
      taskDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "start:full",
      record: { ...fullRecord(), status: "in_progress" },
    });
    applyKernelPatch({
      taskDir,
      expectedRevision: readKernel({ taskDir }).kernel.revision,
      actor: "a",
      idempotencyKey: "patch:ledger",
      extras: {
        ac_evidence_ledger: ledgerFor(taskDir, "code-v2"),
        independent_check: selfReview("code-v1"),
      },
    });
    try {
      applyKernelArchive({
        taskDir,
        expectedRevision: readKernel({ taskDir }).kernel.revision,
        actor: "a",
        idempotencyKey: "archive:stale-check",
        record: { ...fullRecord(), status: "completed", completedAt: "2026-08-28" },
      });
      expect.unreachable("stale independent-check fingerprint should fail");
    } catch (err) {
      expect((err as KernelError).message).toMatch(/stale/);
    }
  });

  it("distinguishes self-review from true-independent and blocks the latter without a worker", () => {
    const self = evaluateIndependentCheck({
      mode: "self-review",
      independentWorkerAvailable: false,
      evidence: "structured second pass",
      codeFingerprint: "code-v1",
    });
    expect(self.mode).toBe("self-review");
    expect(self.result).toBe("PASS");

    const blocked = evaluateIndependentCheck({
      mode: "true-independent",
      independentWorkerAvailable: false,
      evidence: "would-be independent",
      codeFingerprint: "code-v1",
    });
    expect(blocked.mode).toBe("true-independent");
    expect(blocked.result).toBe("BLOCKED");
    expect(blocked.independent_worker).toBe(false);

    try {
      evaluateIndependentCheck({
        mode: "self-review",
        independentWorkerAvailable: false,
        evidence: "x",
        codeFingerprint: "code-v1",
        attemptedWrites: true,
      });
      expect.unreachable("writes during check should fail");
    } catch (err) {
      expect((err as KernelError).message).toMatch(/read-only/);
    }

    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:full",
      record: fullRecord(),
      extras: fullControls(),
    });
    try {
      applyKernelRecordGate({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "gate:ind",
        transition: "full-task-complete",
        gateName: "independent-check",
        record: {
          result: "PASS",
          evidence: "pretend independent",
          mode: "true-independent",
          independent_worker: false,
        },
      });
      expect.unreachable("true-independent without worker should fail");
    } catch (err) {
      expect((err as KernelError).code).toBe("INVALID_REQUEST");
      expect((err as KernelError).message).toMatch(/independent worker/);
    }
  });

  it("does not force Independent Check on Lite Open→Close", () => {
    const created = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:lite",
      record: emptyTaskRecord({
        id: "lite",
        name: "lite",
        title: "Lite",
        status: "planning",
        assignee: "developer",
        creator: "developer",
        priority: "P2",
      }),
    });
    fs.writeFileSync(path.join(taskDir, "prd.md"), "# Lite\n", "utf-8");
    fs.writeFileSync(path.join(taskDir, "verify.md"), VERIFY, "utf-8");
    applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "a",
      idempotencyKey: "start:lite",
      record: {
        ...emptyTaskRecord({
          id: "lite",
          name: "lite",
          title: "Lite",
          status: "in_progress",
          assignee: "developer",
          creator: "developer",
          priority: "P2",
        }),
      },
    });
    const archived = applyKernelArchive({
      taskDir,
      expectedRevision: readKernel({ taskDir }).kernel.revision,
      actor: "a",
      idempotencyKey: "archive:lite",
      record: {
        ...emptyTaskRecord({
          id: "lite",
          name: "lite",
          title: "Lite",
          status: "completed",
          assignee: "developer",
          creator: "developer",
          priority: "P2",
        }),
        completedAt: "2026-08-28",
      },
      evidence: "verify.md",
    });
    expect(archived.kernel.phase).toBe("close");
    expect(archived.legacy.status).toBe("completed");
    expect(archived.kernel.projection?.extras.independent_check).toBeUndefined();
  });
});
