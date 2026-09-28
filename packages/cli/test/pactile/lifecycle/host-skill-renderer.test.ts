import { describe, expect, it } from "vitest";
import { loadBaselineTileContent } from "../../../src/pactile/tiles/content/baseline/index.js";
import { parseTileYaml } from "../../../src/pactile/tiles/safe-yaml.js";
import { renderHostSkill } from "../../../src/pactile/lifecycle/host-skill-renderer.js";

describe("host Agent Skill renderer", () => {
  it("quotes description text as a YAML scalar and preserves the Tile body", () => {
    const loaded = loadBaselineTileContent();
    if (!loaded.success) throw new Error(JSON.stringify(loaded.diagnostics));
    const tile = loaded.data.find(
      ({ manifest }) => manifest.identity.id === "approval-personal",
    );
    if (!tile) throw new Error("missing baseline tile");

    const summary = 'Use "quoted" descriptions safely:\nkeep this as data';
    const text = renderHostSkill({ ...tile.manifest, summary }, tile.skillText);
    const metadataEnd = text.indexOf("\n---\n", 4);
    if (metadataEnd < 0) throw new Error("missing frontmatter terminator");

    expect(parseTileYaml(text.slice(4, metadataEnd))).toEqual({
      name: tile.manifest.identity.id,
      description: summary,
    });
    expect(text.slice(metadataEnd + "\n---\n\n".length)).toBe(tile.skillText);
  });
});
