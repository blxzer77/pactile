import fs from "node:fs";
import path from "node:path";
import { TileYamlError, parseTileYaml } from "../tiles/safe-yaml.js";

export type JevProjectEgressPolicyV1 =
  | {
      readonly allowed: true;
      readonly source: "default" | "configured";
    }
  | {
      readonly allowed: false;
      readonly reasonCode: "egress-denied" | "configuration-invalid";
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseProjectConfig(content: string): Record<string, unknown> | null {
  try {
    return record(parseTileYaml(content, { allowLegacyBooleanStrings: true }));
  } catch (error) {
    // The project template is intentionally comments-only until users opt in.
    if (error instanceof TileYamlError && error.code === "yaml-empty")
      return {};
    return null;
  }
}

function invalid(): JevProjectEgressPolicyV1 {
  return { allowed: false, reasonCode: "configuration-invalid" };
}

/** Resolve only the project-level Jev egress switch; it does not grant retrieval Providers. */
export function resolveJevProjectEgressPolicyV1(
  root: string,
): JevProjectEgressPolicyV1 {
  const configPath = path.join(root, ".pactile", "config.yaml");
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { allowed: true, source: "default" };
    return invalid();
  }
  const config = parseProjectConfig(content);
  if (!config) return invalid();
  const jev = config.jev;
  if (jev === undefined) return { allowed: true, source: "default" };
  const section = record(jev);
  if (!section) return invalid();
  const egress = section.egress;
  if (egress === undefined) return { allowed: true, source: "default" };
  if (egress === "allow") return { allowed: true, source: "configured" };
  if (egress === "deny") return { allowed: false, reasonCode: "egress-denied" };
  return invalid();
}
