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
  applyKernelStart,
  readKernel,
} from "../../../src/core/task/kernel-store.js";
import {
  LITE_BLOCKED_ON_DEMAND_MODULES,
  LiteContextPackError,
  buildLiteContextPack,
} from "../../../src/core/task/lite-context-pack.js";
import {
  ONDEMAND_OWNERS,
  STAGE5_ONDEMAND_MODULES,
  activateOnDemand,
  applyRetention,
  assertIntegrationAuthority,
  assignParent,
  captureCandidate,
  confirmDecompose,
  defaultTopology,
  projectTaskMapGraph,
  proposeDecompose,
  renderTaskMapProjection,
  residentOnDemandModules,
} from "../../../src/core/task/ondemand-topology.js";
import { resolveRequiredControls } from "../../../src/core/task/full-quality.js";

function stage5Record(
  overrides: Parameters<typeof emptyTaskRecord>[0] = {},
) {
  return emptyTaskRecord({
    id: "stage5-demo",
    name: "stage5-demo",
    title: "Stage 5 Demo",
    status: "planning",
    assignee: "developer",
    creator: "developer",
    priority: "P2",
    ...overrides,
  });
}

describe("Stage 5 On-demand and Topology", () => {
  let tmp: string;
  let taskDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-stage5-"));
    taskDir = path.join(tmp, "08-28-stage5");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps Topology orthogonal to Rigor: Lite Single Close without Parent or Git", () => {
    expect(fs.existsSync(path.join(tmp, ".git"))).toBe(false);
    const created = applyKernelCreate({
      taskDir,
      actor: "task.py create",
      idempotencyKey: "create:stage5-lite",
      record: stage5Record(),
      extras: {
        required_controls: resolveRequiredControls({ rigor: "lite" }),
      },
    });
    const extras = created.kernel.projection?.extras ?? {};
    expect(extras.topology).toMatchObject({
      kind: "single",
      parent_id: null,
      children: [],
    });
    expect(residentOnDemandModules(extras)).not.toEqual(
      expect.arrayContaining([
        "parent-child",
        "vcs-integration",
        "personal-memory",
        "retention-storage",
      ]),
    );
    expect(created.legacy.status).toBe("planning");

    fs.writeFileSync(path.join(taskDir, "prd.md"), "# Lite\n", "utf-8");
    fs.writeFileSync(
      path.join(taskDir, "verify.md"),
      "- validation: core test\n- acceptance: lite close\n",
      "utf-8",
    );

    const started = applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "task.py start-execution --approved",
      idempotencyKey: "start:stage5-lite",
      record: { ...stage5Record(), status: "in_progress" },
      extras: {
        execution_approval: { approved_by: "user" },
      },
      evidence: "task.py start-execution --approved",
    });
    expect(started.legacy.status).toBe("in_progress");

    const archived = applyKernelArchive({
      taskDir,
      expectedRevision: started.kernel.revision,
      actor: "task.py archive",
      idempotencyKey: "archive:stage5-lite",
      record: { ...stage5Record(), status: "completed", completedAt: "2026-08-28" },
      extras: { close_outcome: "completed" },
      evidence: "verify.md",
    });
    expect(archived.kernel.phase).toBe("close");
    expect(archived.legacy.status).toBe("completed");
    expect(archived.kernel.projection?.extras.close_outcome).toBe("completed");
    expect(fs.existsSync(path.join(tmp, ".git"))).toBe(false);
  });

  it("allows Full + single and Lite + child-with-parent without mixing the axes", () => {
    const fullSingle = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:full-single",
      record: stage5Record(),
      extras: {
        required_controls: resolveRequiredControls({
          rigor: "full",
          verificationProfile: "standard",
        }),
      },
    });
    expect(fullSingle.kernel.projection?.extras.topology).toMatchObject({
      kind: "single",
    });
    expect(fullSingle.kernel.projection?.extras.required_controls).toMatchObject({
      rigor: "full",
    });

    const childDir = path.join(tmp, "lite-child");
    const liteChild = applyKernelCreate({
      taskDir: childDir,
      actor: "a",
      idempotencyKey: "create:lite-child",
      record: stage5Record({
        id: "lite-child",
        name: "lite-child",
        parent: "stage5-demo",
      }),
      extras: {
        required_controls: resolveRequiredControls({ rigor: "lite" }),
      },
    });
    expect(liteChild.kernel.projection?.extras.topology).toMatchObject({
      kind: "single",
      parent_id: "stage5-demo",
      children: [],
    });
    expect(liteChild.kernel.projection?.extras.required_controls).toMatchObject({
      rigor: "lite",
    });
    expect(residentOnDemandModules(liteChild.kernel.projection?.extras ?? {})).not.toContain(
      "parent-child",
    );
  });

  it("keeps an ordinary Child as single and only controllers with children as parent-child", () => {
    expect(defaultTopology({ parent: "parent-a", children: [] })).toMatchObject({
      kind: "single",
      parent_id: "parent-a",
      children: [],
    });
    expect(assignParent(defaultTopology(), "parent-a")).toMatchObject({
      kind: "single",
      parent_id: "parent-a",
      children: [],
    });
    expect(defaultTopology({ children: ["child-a"] })).toMatchObject({
      kind: "parent-child",
      parent_id: null,
      children: ["child-a"],
    });
    expect(
      assignParent(defaultTopology({ children: ["child-a"] }), "grand-parent"),
    ).toMatchObject({
      kind: "parent-child",
      parent_id: "grand-parent",
      children: ["child-a"],
    });
  });

  it("rejects a second Parent on an already-linked Child", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:child",
      record: stage5Record({ parent: "parent-a" }),
    });
    try {
      applyKernelPatch({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "patch:second-parent",
        record: { parent: "parent-b" },
      });
      expect.unreachable("second parent should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).message).toMatch(/second parent/);
    }
    expect(() => assignParent(defaultTopology({ parent: "parent-a" }), "parent-b")).toThrow(
      /second parent/,
    );
  });

  it("Decompose proposal does not create Child until confirmed", () => {
    const proposal = proposeDecompose("stage5-demo", ["child-a"]);
    expect(proposal.confirmed).toBe(false);
    expect(proposal.children_created).toEqual([]);

    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:parent",
      record: stage5Record(),
    });
    try {
      applyKernelPatch({
        taskDir,
        expectedRevision: 1,
        actor: "a",
        idempotencyKey: "patch:unconfirmed-child",
        record: { children: ["child-a"] },
        extras: { decompose_proposal: proposal },
      });
      expect.unreachable("unconfirmed decompose should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).message).toMatch(/before confirmation/);
    }

    const confirmed = confirmDecompose(proposal);
    const patched = applyKernelPatch({
      taskDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "patch:confirmed-child",
      record: { children: ["child-a"] },
      extras: { decompose_proposal: confirmed },
    });
    expect(patched.kernel.projection?.extras.topology).toMatchObject({
      kind: "parent-child",
      children: ["child-a"],
    });
  });

  it("Capture Candidate does not create a Task", () => {
    const candidate = captureCandidate("maybe later");
    expect(candidate.task_created).toBe(false);
    expect(candidate.kind).toBe("candidate");
    try {
      applyKernelCreate({
        taskDir,
        actor: "a",
        idempotencyKey: "create:capture",
        record: stage5Record(),
        extras: { intake_outcome: "capture-candidate" },
      });
      expect.unreachable("capture-candidate create should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).message).toMatch(/must not create a Task/);
    }
  });

  it("blocks start when requires is unmet and allows advisory", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:requires",
      record: stage5Record(),
      extras: { depends_on: ["upstream-task"] },
    });
    const created = readKernel({ taskDir });
    expect(created.kernel.projection?.extras.dependency_graph).toMatchObject({
      edges: [{ from: "stage5-demo", to: "upstream-task", type: "requires" }],
    });
    try {
      applyKernelStart({
        taskDir,
        expectedRevision: created.kernel.revision,
        actor: "a",
        idempotencyKey: "start:blocked",
        record: { ...stage5Record(), status: "in_progress" },
        evidence: "start",
      });
      expect.unreachable("unmet requires should block start");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("INVALID_TRANSITION");
      expect((err as KernelError).message).toMatch(/requires unmet/);
    }

    const advisoryDir = path.join(tmp, "advisory");
    applyKernelCreate({
      taskDir: advisoryDir,
      actor: "a",
      idempotencyKey: "create:advisory",
      record: stage5Record({ id: "advisory", name: "advisory" }),
      extras: {
        dependency_graph: {
          schema_version: 1,
          edges: [{ from: "advisory", to: "hint-task", type: "advisory" }],
        },
      },
    });
    const started = applyKernelStart({
      taskDir: advisoryDir,
      expectedRevision: 1,
      actor: "a",
      idempotencyKey: "start:advisory",
      record: { ...stage5Record({ id: "advisory", name: "advisory" }), status: "in_progress" },
      evidence: "start",
    });
    expect(started.legacy.status).toBe("in_progress");
  });

  it("starts after requires is satisfied and projects task-map from the Kernel graph", () => {
    const created = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:graph",
      record: stage5Record({ children: ["child-a"] }),
      extras: {
        depends_on: ["upstream"],
        dependency_graph: {
          schema_version: 1,
          edges: [{ from: "child-a", to: "other", type: "requires" }],
        },
      },
    });
    const extras = created.kernel.projection?.extras ?? {};
    const projection = projectTaskMapGraph(
      extras.topology as {
        schema_version: 1;
        kind: "parent-child";
        parent_id: string | null;
        children: string[];
      },
      extras.dependency_graph as {
        schema_version: 1;
        edges: { from: string; to: string; type: "requires" | "advisory" }[];
      },
    );
    expect(projection.graph_authority).toBe("kernel-extras");
    expect(projection.children).toEqual([{ id: "child-a", depends_on: ["other"] }]);
    expect(renderTaskMapProjection(projection)).toMatch(/graph_authority: kernel-extras/);

    applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "a",
      idempotencyKey: "start:satisfied",
      record: { ...stage5Record({ children: ["child-a"] }), status: "in_progress" },
      extras: { dependency_satisfied: ["upstream"] },
      evidence: "start",
    });
    expect(readKernel({ taskDir }).legacy.status).toBe("in_progress");
  });

  it("rejects Child integrate-child and keeps Parent authority", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:auth",
      record: stage5Record({ parent: "the-parent" }),
    });
    try {
      applyKernelPatch({
        taskDir,
        expectedRevision: 1,
        actor: "child-worker",
        idempotencyKey: "patch:integrate",
        extras: {
          integration_action: "integrate-child",
          integration_actor: "child",
        },
      });
      expect.unreachable("child integrate should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).message).toMatch(/Integration authority/);
    }
    expect(() => assertIntegrationAuthority("child")).toThrow(/Integration authority/);
    expect(() => assertIntegrationAuthority("parent")).not.toThrow();
  });

  it("registers Stage 5 On-demand dormant and traces first trigger", () => {
    const created = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:ondemand",
      record: stage5Record(),
    });
    const extras = created.kernel.projection?.extras ?? {};
    const modules = extras.ondemand_modules as {
      registered: string[];
      active: string[];
      triggers: { module: string; reason: string }[];
      owners: Record<string, string>;
    };
    expect(modules.registered).toEqual(expect.arrayContaining([...STAGE5_ONDEMAND_MODULES]));
    expect(modules.registered).toContain("independent-check");
    expect(modules.registered).toContain("retrieval-extended");
    expect(modules.registered).not.toContain("integration-handoff");
    expect(modules.active).toEqual([]);
    expect(modules.owners["integration-handoff"]).toBe("parent-child");
    expect(modules.owners["session-transfer"]).toBe("session-transfer");
    expect(ONDEMAND_OWNERS["integration-handoff"]).not.toBe(
      ONDEMAND_OWNERS["session-transfer"],
    );
    const baseline = extras.baseline_modules as { active: string[]; source: string };
    expect(baseline.source).toBe("profile-runtime");
    expect(baseline.active).toHaveLength(8);
    expect(baseline.active).toEqual(
      expect.arrayContaining(["execute-agent", "context-progressive"]),
    );

    const patched = applyKernelPatch({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "a",
      idempotencyKey: "patch:activate-vcs",
      extras: {},
    });
    const next = { ...(patched.kernel.projection?.extras ?? {}) };
    activateOnDemand(next, "vcs-integration", "vcs-detected");
    const activated = applyKernelPatch({
      taskDir,
      expectedRevision: patched.kernel.revision,
      actor: "a",
      idempotencyKey: "patch:vcs-on",
      extras: { ondemand_modules: next.ondemand_modules },
    });
    const after = activated.kernel.projection?.extras ?? {};
    expect(residentOnDemandModules(after)).toContain("vcs-integration");
    expect(residentOnDemandModules(after)).not.toContain("parent-child");
    const triggers = (
      after.ondemand_modules as { triggers: { module: string; reason: string }[] }
    ).triggers;
    expect(triggers.some((item) => item.module === "vcs-integration")).toBe(true);

    const withRetrieval = { ...after };
    activateOnDemand(withRetrieval, "retrieval-extended", "collected-evidence-ranking");
    expect(residentOnDemandModules(withRetrieval)).toContain("retrieval-extended");
  });

  it("keeps an explicit empty baseline_modules.active list", () => {
    const created = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:baseline-empty",
      record: stage5Record(),
      extras: { baseline_modules: { active: [] } },
    });
    const baseline = created.kernel.projection?.extras.baseline_modules as {
      active: string[];
    };
    expect(baseline.active).toEqual([]);
  });

  it("does not put untriggered parent-child or vcs into the Lite resident pack", () => {
    expect(LITE_BLOCKED_ON_DEMAND_MODULES).toEqual(
      expect.arrayContaining([
        "parent-child",
        "vcs-integration",
        "personal-memory",
        "retention-storage",
      ]),
    );
    expect(() =>
      buildLiteContextPack({
        phase: "execute",
        activatedModules: ["parent-child"],
      }),
    ).toThrow(LiteContextPackError);
    expect(() =>
      buildLiteContextPack({
        phase: "execute",
        artifacts: [
          {
            role: "evidence",
            module: "vcs-integration",
            path: "git-status.txt",
            content: "ok",
          },
        ],
      }),
    ).toThrow(/vcs-integration/);
  });

  it("blocks missing lifecycle slots and degrades missing On-demand without fake-green", () => {
    applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:slots",
      record: stage5Record(),
      extras: { ondemand_required_missing: ["external-knowledge"] },
    });
    const created = readKernel({ taskDir });
    expect(created.kernel.projection?.extras.profile_health).toBe("degraded");
    expect(
      (created.kernel.projection?.extras.ondemand_modules as { degraded: string[] }).degraded,
    ).toContain("external-knowledge");

    try {
      applyKernelStart({
        taskDir,
        expectedRevision: created.kernel.revision,
        actor: "a",
        idempotencyKey: "start:slots",
        record: { ...stage5Record(), status: "in_progress" },
        extras: { lifecycle_slots: ["define", "approve"] },
        evidence: "start",
      });
      expect.unreachable("missing lifecycle slots should block");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).message).toMatch(/lifecycle required slot missing/);
    }
  });

  it("does not change Outcome when Retention runs and does not rename status", () => {
    expect(applyRetention("completed")).toBe("completed");
    const created = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:retention",
      record: stage5Record(),
    });
    expect(created.legacy.status).toBe("planning");
    const started = applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "a",
      idempotencyKey: "start:retention",
      record: { ...stage5Record(), status: "in_progress" },
      evidence: "start",
    });
    expect(started.legacy.status).toBe("in_progress");
    const archived = applyKernelArchive({
      taskDir,
      expectedRevision: started.kernel.revision,
      actor: "a",
      idempotencyKey: "archive:retention",
      record: { ...stage5Record(), status: "completed", completedAt: "2026-08-28" },
      extras: { close_outcome: "completed" },
      evidence: "verify.md",
    });
    expect(archived.legacy.status).toBe("completed");
    expect(archived.kernel.projection?.extras.close_outcome).toBe("completed");
  });
});
