import { describe, expect, it } from "vitest";
import {
  SHARED_HOOKS_BY_PLATFORM,
  getSharedHookScripts,
  getSharedHookScriptsForPlatform,
} from "../../src/templates/shared-hooks/index.js";

describe("active shared-hook distribution", () => {
  it("declares only the Codex platform", () => {
    expect(Object.keys(SHARED_HOOKS_BY_PLATFORM)).toEqual(["codex"]);
    expect(SHARED_HOOKS_BY_PLATFORM.codex).toEqual(["inject-workflow-state.py"]);
  });

  it("ships exactly the declared hook to Codex", () => {
    expect(getSharedHookScriptsForPlatform("codex").map((hook) => hook.name)).toEqual([
      "inject-workflow-state.py",
    ]);
  });

  it("does not bundle Cursor-specific hook files", () => {
    const names = getSharedHookScripts().map((hook) => hook.name);
    for (const retired of [
      "event-bridge.py",
      "inject-shell-session-context.py",
      "rename-session-for-task.py",
      "inject-retrieval-plan.py",
      "spec-write-audit.py",
    ]) {
      expect(names).not.toContain(retired);
    }
  });

});
