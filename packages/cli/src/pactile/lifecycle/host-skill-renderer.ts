import type { TileManifestV1 } from "../../core/index.js";

/** Add the portable Agent Skills metadata at the host projection boundary. */
export function renderHostSkill(
  manifest: TileManifestV1,
  skillText: string,
): string {
  return [
    "---",
    `name: ${JSON.stringify(manifest.identity.id)}`,
    `description: ${JSON.stringify(manifest.summary)}`,
    "---",
    "",
    skillText,
  ].join("\n");
}
