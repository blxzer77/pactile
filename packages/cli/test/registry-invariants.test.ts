import { describe, expect, it } from "vitest";
import { AI_TOOLS } from "../src/types/ai-tools.js";
import {
  FIRST_CLASS_PLATFORM_IDS,
  LEGACY_PLATFORM_IDS,
  PLATFORM_IDS,
  getInitToolChoices,
} from "../src/configurators/index.js";
import {
  getPactilePlatform,
  listPactilePlatforms,
} from "../src/pactile/registry.js";

describe("active host declarations", () => {
  it("keeps the CLI and projection registries Codex-only", () => {
    expect(Object.keys(AI_TOOLS)).toEqual(["codex"]);
    expect(PLATFORM_IDS).toEqual(["codex"]);
    expect(FIRST_CLASS_PLATFORM_IDS).toEqual(["codex"]);
    expect(LEGACY_PLATFORM_IDS).toEqual([]);
    expect(getInitToolChoices().map((choice) => choice.platformId)).toEqual(["codex"]);
    expect(listPactilePlatforms().map((host) => host.platform)).toEqual(["codex"]);
  });

  it("rejects Cursor for new projections while keeping legacy detach separate", () => {
    expect(getPactilePlatform("cursor")).toBeNull();
    expect(getPactilePlatform("codex")?.adapterId).toBe("adapter.codex");
  });
});
