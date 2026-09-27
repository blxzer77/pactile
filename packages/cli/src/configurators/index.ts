/** Active host metadata. Adapter projection performs all host writes. */

import fs from "node:fs";
import path from "node:path";
import { AI_TOOLS, getManagedPaths, type AITool, type CliFlag } from "../types/ai-tools.js";

export const PLATFORM_IDS = Object.keys(AI_TOOLS) as AITool[];
export const FIRST_CLASS_PLATFORM_IDS = PLATFORM_IDS.filter(
  (id) => AI_TOOLS[id].tier === "first-class",
);
export const LEGACY_PLATFORM_IDS = PLATFORM_IDS.filter(
  (id) => AI_TOOLS[id].tier === "legacy",
);
export const CONFIG_DIRS = PLATFORM_IDS.map((id) => AI_TOOLS[id].configDir);
export const PLATFORM_MANAGED_DIRS = PLATFORM_IDS.flatMap(getManagedPaths);
export const ALL_MANAGED_DIRS = [".pactile", ...new Set(PLATFORM_MANAGED_DIRS)];

export function getConfiguredPlatforms(cwd: string): Set<AITool> {
  return new Set(
    PLATFORM_IDS.filter((id) => fs.existsSync(path.join(cwd, AI_TOOLS[id].configDir))),
  );
}

export function isManagedPath(dirPath: string): boolean {
  const normalized = dirPath.replace(/\\/g, "/");
  return ALL_MANAGED_DIRS.some(
    (dir) => normalized === dir || normalized.startsWith(`${dir}/`),
  );
}

export function isManagedRootDir(dirName: string): boolean {
  return ALL_MANAGED_DIRS.includes(dirName);
}

export function getPlatformManagedPaths(platformId: AITool): string[] {
  return getManagedPaths(platformId);
}

/** Host files are projected by the lifecycle, never by a template writer. */
export function collectPlatformTemplates(_platformId: AITool): undefined {
  return undefined;
}

export function getInitToolChoices(): {
  key: CliFlag;
  name: string;
  defaultChecked: boolean;
  platformId: AITool;
}[] {
  return PLATFORM_IDS.map((id) => ({
    key: AI_TOOLS[id].cliFlag,
    name: AI_TOOLS[id].name,
    defaultChecked: AI_TOOLS[id].defaultChecked,
    platformId: id,
  }));
}

export function resolveCliFlag(flag: string): AITool | undefined {
  return PLATFORM_IDS.find((id) => AI_TOOLS[id].cliFlag === flag);
}
