import { describe, expect, it } from "vitest";
import {
  ALL_MANAGED_DIRS,
  PLATFORM_IDS,
  collectPlatformTemplates,
  getInitToolChoices,
  isManagedPath,
  resolveCliFlag,
} from "../../src/configurators/index.js";

describe("active host registry", () => {
  it("offers Codex only and rejects Cursor as a new init target", () => {
    expect(PLATFORM_IDS).toEqual(["codex"]);
    expect(getInitToolChoices().map((choice) => choice.key)).toEqual(["codex"]);
    expect(resolveCliFlag("codex")).toBe("codex");
    expect(resolveCliFlag("cursor")).toBeUndefined();
  });

  it("does not claim legacy Cursor files as active managed paths", () => {
    expect(ALL_MANAGED_DIRS).toEqual([".pactile", ".codex", ".agents/skills"]);
    expect(isManagedPath(".cursor/hooks.json")).toBe(false);
    expect(isManagedPath(".codex/config.toml")).toBe(true);
    expect(isManagedPath(".agents/skills/pactile-start/SKILL.md")).toBe(true);
  });

  it("keeps host projection outside legacy template collection", () => {
    expect(collectPlatformTemplates("codex")).toBeUndefined();
  });
});
