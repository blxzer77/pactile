/**
 * P36 Wave C: confirm-gated stop-read of leftover Task fields.
 *
 * Written only after `pactile update` confirm. Dry-run and refusal never write.
 * Runtime closeout reads this flag; leftover kind/mode/classification stay
 * dual-read until it exists.
 */

import fs from "node:fs";
import path from "node:path";

import {
  scanContractMigration,
  type ContractMigrateReport,
} from "./contract-migrate.js";
import { isPlainObject } from "./schema.js";

export const WAVE_C_STATE_REL = ".pactile/.p36-wave-c.json";
export const WAVE_C_SCHEMA_VERSION = 1;

export interface WaveCState {
  schema_version: number;
  wave: "C";
  confirmed: boolean;
  confirmedAt: string | null;
}

export interface WaveCPlan {
  confirmed: boolean;
  scanned: number;
  leftoverCloseout: number;
  alreadyNewShape: number;
  vernacular: string[];
}

export function waveCStatePath(root: string): string {
  return path.join(path.resolve(root), WAVE_C_STATE_REL);
}

export function emptyWaveCState(): WaveCState {
  return {
    schema_version: WAVE_C_SCHEMA_VERSION,
    wave: "C",
    confirmed: false,
    confirmedAt: null,
  };
}

export function readWaveCState(root: string): WaveCState {
  const file = waveCStatePath(root);
  if (!fs.existsSync(file)) return emptyWaveCState();
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!isPlainObject(parsed)) return emptyWaveCState();
    return {
      schema_version:
        parsed.schema_version === WAVE_C_SCHEMA_VERSION
          ? WAVE_C_SCHEMA_VERSION
          : WAVE_C_SCHEMA_VERSION,
      wave: "C",
      confirmed: parsed.confirmed === true,
      confirmedAt:
        typeof parsed.confirmedAt === "string" ? parsed.confirmedAt : null,
    };
  } catch {
    return emptyWaveCState();
  }
}

export function isWaveCConfirmed(root: string): boolean {
  return readWaveCState(root).confirmed;
}

export function writeWaveCConfirmed(
  root: string,
  at: Date = new Date(),
): WaveCState {
  const state: WaveCState = {
    schema_version: WAVE_C_SCHEMA_VERSION,
    wave: "C",
    confirmed: true,
    confirmedAt: at.toISOString(),
  };
  const file = waveCStatePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  return state;
}

export function planWaveC(options: {
  root: string;
  report?: ContractMigrateReport;
}): WaveCPlan {
  const confirmed = isWaveCConfirmed(options.root);
  const report = options.report ?? scanContractMigration({ root: options.root });
  const leftoverPaths = new Set<string>();
  for (const finding of report.findings) {
    if (
      finding.kind === "retired-field" ||
      finding.kind === "children-inferred-parent" ||
      finding.kind === "file-inferred-rigor" ||
      finding.kind === "legacy-parent"
    ) {
      leftoverPaths.add(finding.path);
    }
  }
  const leftoverCloseout = leftoverPaths.size;
  const alreadyNewShape = Math.max(0, report.scanned - leftoverCloseout);
  return {
    confirmed,
    scanned: report.scanned,
    leftoverCloseout,
    alreadyNewShape,
    vernacular: formatWaveCVernacular({
      confirmed,
      scanned: report.scanned,
      leftoverCloseout,
      alreadyNewShape,
    }),
  };
}

export function formatWaveCVernacular(plan: {
  confirmed: boolean;
  scanned: number;
  leftoverCloseout: number;
  alreadyNewShape: number;
}): string[] {
  if (plan.confirmed) {
    return [
      "已确认停读旧形状。新任务只认 topology / required_controls，不再靠 leftover kind/mode/classification 推断 Rigor / Parent。",
    ];
  }
  return [
    "确认后才会停读旧形状：不再把 leftover kind/mode/classification 当 Rigor/Parent 唯一真相。",
    `已扫描 ${plan.scanned} 个任务：${plan.alreadyNewShape} 个已是新形状，${plan.leftoverCloseout} 个仍靠旧字段。`,
    "拒绝或失败：项目仍能 Continue / Close，可再跑 update。",
  ];
}
