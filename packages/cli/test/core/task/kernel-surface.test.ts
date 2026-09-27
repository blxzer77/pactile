import { describe, expect, it } from "vitest";

import {
  TASK_RECORD_FIELD_ORDER,
  emptyTaskRecord,
  kernelPhaseHumanTitle,
  kernelPhaseToLegacyStatus,
  projectKernelSurface,
  topologyNeedsIntegrate,
} from "../../../src/core/task/index.js";

describe("projectKernelSurface", () => {
  it("titles a kernel phase=define task as Define, not Planning", () => {
    const surface = projectKernelSurface({
      phase: "define",
      condition: "ready",
      outcome: null,
      status: "planning",
    });
    expect(surface.phase).toBe("define");
    expect(surface.condition).toBe("ready");
    expect(surface.outcome).toBeNull();
    expect(surface.humanPhase).toBe("Define");
    expect(surface.humanPhase).not.toBe("Planning");
    expect(surface.status).toBe("planning");
  });

  it("projects legacy status=planning onto Define without dropping status", () => {
    const surface = projectKernelSurface({ status: "planning" });
    expect(surface.phase).toBe("define");
    expect(surface.humanPhase).toBe("Define");
    expect(surface.status).toBe("planning");
  });

  it("uses zh titles when locale=zh", () => {
    expect(kernelPhaseHumanTitle("define", "zh")).toBe("定义");
    expect(projectKernelSurface({ phase: "define", locale: "zh" }).humanPhase).toBe(
      "定义",
    );
  });

  it("shows Integrate only for parent-child topology or integrate phase", () => {
    expect(topologyNeedsIntegrate("single")).toBe(false);
    expect(topologyNeedsIntegrate("parent-child")).toBe(true);
    expect(projectKernelSurface({ phase: "execute" }).showIntegrate).toBe(false);
    expect(
      projectKernelSurface({
        phase: "execute",
        topologyKind: "parent-child",
      }).showIntegrate,
    ).toBe(true);
    expect(projectKernelSurface({ phase: "integrate" }).showIntegrate).toBe(true);
  });

  it("fills missing condition/outcome from the target phase", () => {
    const execute = projectKernelSurface({ phase: "execute" });
    expect(execute.condition).toBe("active");
    expect(execute.outcome).toBeNull();
    expect(execute.status).toBe(kernelPhaseToLegacyStatus("execute"));
  });
});

describe("legacy status compatibility", () => {
  it("keeps status in the canonical task.json field order", () => {
    expect(TASK_RECORD_FIELD_ORDER).toContain("status");
    expect(emptyTaskRecord().status).toBe("planning");
  });
});
