/**
 * P36 official-surface A planner and vernacular summary for `pactile update`.
 *
 * Wave A refreshes unmodified shipped files (already owned by update hash
 * analysis) and retires leftover extra always-on rules. User-modified
 * official files are listed and kept. Wave C stop-read is confirm-gated
 * on the same `pactile update` plus one confirmation.
 */

import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";

import {
  formatArtifactVernacular,
  formatWaveCVernacular,
  type ArtifactMigratePlan,
  type WaveCPlan,
} from "../core/task/index.js";
import type { TemplateHashes } from "../types/migration.js";
import { computeHash, removeHash } from "./template-hash.js";
import { toPosix } from "./posix.js";

export const RETIRED_ALWAYS_ON_RULES = [
  ".cursor/rules/cstl-triage.mdc",
  ".cursor/rules/trellis-triage.mdc",
  ".cursor/rules/cstl-subagent-dispatch.mdc",
  ".cursor/rules/trellis-subagent-dispatch.mdc",
  ".cursor/rules/retrieval-routing.mdc",
  ".cursor/rules/cstl-retrieval-routing.mdc",
  ".cursor/rules/trellis-retrieval-routing.mdc",
] as const;

export const KEEP_ALWAYS_ON_RULES = [".cursor/rules/pactile-bootstrap.mdc"] as const;

export type OfficialRetireAction = "retire" | "preserve";

export interface OfficialSurfaceItem {
  path: string;
  action: OfficialRetireAction;
  reason: string;
}

export interface OfficialSurfacePlan {
  refresh: string[];
  preserved: string[];
  added: string[];
  retire: OfficialSurfaceItem[];
  preserve: OfficialSurfaceItem[];
}

export interface P36UpgradePlan {
  official: OfficialSurfacePlan;
  artifacts: ArtifactMigratePlan;
  writeArtifacts: boolean;
  waveC: WaveCPlan;
  vernacular: string[];
}

export function planOfficialSurfaceA(options: {
  cwd: string;
  hashes: TemplateHashes;
  refresh: string[];
  preserved: string[];
  added?: string[];
}): OfficialSurfacePlan {
  const retire: OfficialSurfaceItem[] = [];
  const preserve: OfficialSurfaceItem[] = [];

  for (const relativePath of RETIRED_ALWAYS_ON_RULES) {
    const fullPath = path.join(options.cwd, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const posix = toPosix(relativePath);
    const stored = options.hashes[posix] ?? options.hashes[relativePath];
    let currentHash: string | null = null;
    try {
      currentHash = computeHash(fs.readFileSync(fullPath, "utf-8"));
    } catch {
      preserve.push({
        path: posix,
        action: "preserve",
        reason: "unreadable leftover",
      });
      continue;
    }
    const unmodified = Boolean(stored && stored === currentHash);
    const knownUntracked = !stored && hasAlwaysApply(fullPath);
    if (unmodified || knownUntracked) {
      retire.push({
        path: posix,
        action: "retire",
        reason: unmodified
          ? "unmodified shipped always-on"
          : "known official always-on path",
      });
    } else {
      preserve.push({
        path: posix,
        action: "preserve",
        reason: "you edited this official file",
      });
    }
  }

  return {
    refresh: [...options.refresh],
    preserved: [...options.preserved],
    added: [...(options.added ?? [])],
    retire,
    preserve,
  };
}

export function applyOfficialRetire(
  cwd: string,
  plan: OfficialSurfacePlan,
): number {
  let deleted = 0;
  for (const item of plan.retire) {
    const fullPath = path.join(cwd, item.path);
    if (!fs.existsSync(fullPath)) continue;
    // The plan is computed before canonical commit and Adapter projection.
    // Re-check the official marker so a concurrent/user edit is preserved
    // instead of being unlinked from a stale pre-commit observation.
    if (!hasAlwaysApply(fullPath)) continue;
    fs.unlinkSync(fullPath);
    try {
      removeHash(cwd, item.path);
    } catch {
      // Hash store is optional in unit fixtures; retiring the file is enough.
    }
    deleted += 1;
  }
  return deleted;
}

export function composeP36Plan(options: {
  official: OfficialSurfacePlan;
  artifacts: ArtifactMigratePlan;
  writeArtifacts: boolean;
  waveC: WaveCPlan;
}): P36UpgradePlan {
  const officialCount =
    options.official.refresh.length +
    options.official.added.length +
    options.official.retire.length;
  const preservedCount =
    options.official.preserved.length + options.official.preserve.length;
  const vernacular = [
    `官方面：将刷新 ${officialCount} 个未改过的官方文件/规则；你改过的 ${preservedCount} 个已保留。`,
    "--force / --skip-all / --create-new 会套官方文件，但不写 .p36-wave-c.json；只有交互确认 Proceed? 才停读。",
    ...formatArtifactVernacular(options.artifacts, options.writeArtifacts),
    ...formatWaveCVernacular(options.waveC),
  ];
  return {
    official: options.official,
    artifacts: options.artifacts,
    writeArtifacts: options.writeArtifacts,
    waveC: options.waveC,
    vernacular,
  };
}

export function printP36Vernacular(plan: P36UpgradePlan): void {
  console.log(chalk.cyan("升级摘要"));
  for (const line of plan.vernacular) {
    console.log(`  ${line}`);
  }
  if (plan.official.preserve.length > 0) {
    console.log(chalk.yellow("  你改过、已保留："));
    for (const item of plan.official.preserve) {
      console.log(chalk.yellow(`    ? ${item.path}`));
    }
  }
  if (plan.official.preserved.length > 0 && plan.official.preserve.length === 0) {
    console.log(chalk.yellow("  你改过、已保留："));
    for (const relativePath of plan.official.preserved.slice(0, 8)) {
      console.log(chalk.yellow(`    ? ${relativePath}`));
    }
  }
  console.log("");
}

export function officialWorkPending(plan: OfficialSurfacePlan): boolean {
  return (
    plan.refresh.length > 0 ||
    plan.added.length > 0 ||
    plan.retire.length > 0
  );
}

export function waveCWorkPending(plan: P36UpgradePlan): boolean {
  return !plan.waveC.confirmed;
}

export function p36SummaryForRollout(plan: P36UpgradePlan): {
  officialRefresh: number;
  officialPreserved: number;
  officialRetire: number;
  artifactDualRead: number;
  artifactWritable: number;
  degraded: string[];
  writeArtifacts: boolean;
  waveCConfirmed: boolean;
  leftoverCloseout: number;
  alreadyNewShape: number;
} {
  return {
    officialRefresh:
      plan.official.refresh.length +
      plan.official.added.length +
      plan.official.retire.length,
    officialPreserved:
      plan.official.preserved.length + plan.official.preserve.length,
    officialRetire: plan.official.retire.length,
    artifactDualRead: plan.artifacts.activeDualRead,
    artifactWritable: plan.writeArtifacts ? plan.artifacts.writable.length : 0,
    degraded: plan.artifacts.degraded,
    writeArtifacts: plan.writeArtifacts,
    waveCConfirmed: plan.waveC.confirmed,
    leftoverCloseout: plan.waveC.leftoverCloseout,
    alreadyNewShape: plan.waveC.alreadyNewShape,
  };
}

function hasAlwaysApply(fullPath: string): boolean {
  try {
    return /alwaysApply:\s*true/.test(fs.readFileSync(fullPath, "utf-8"));
  } catch {
    return false;
  }
}
