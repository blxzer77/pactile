/**
 * Personal Lite context pack (P29 context-progressive / P30 Stage 3).
 *
 * Pure assembler: phase + Definition/Evidence surfaces under a budget.
 * Unactivated On-demand modules (Parent / VCS / retrieval-extended) and a
 * full workflow.md dump are rejected instead of silently stuffed into the pack.
 * Does not write Kernel store or task.json.
 */

import {
  isKernelPhase,
  type KernelPhase,
} from "./kernel-contract.js";

export const LITE_PACK_VERSION = 1 as const;
export const LITE_PACK_SOURCE = "personal-lite-context-pack";

export const LITE_BASELINE_MODULES = [
  "intake-basic",
  "define-basic",
  "approval-personal",
  "execute-agent",
  "verify-basic",
  "close-basic",
  "context-progressive",
  "observability-local",
] as const;

export const LITE_BLOCKED_ON_DEMAND_MODULES = [
  "parent-child",
  "vcs-integration",
  "personal-memory",
  "retention-storage",
  "retrieval-extended",
] as const;

export const LITE_RETRIEVAL_INTENTS = [
  "exact",
  "semantic",
  "structural",
  "external",
] as const;

export const LITE_DEFAULT_MAX_ITEMS = 8;
export const LITE_DEFAULT_MAX_ESTIMATED_TOKENS = 4000;
export const LITE_CHARS_PER_TOKEN = 4;
export const LITE_MIN_ITEM_TOKENS = 40;

export type LitePackErrorCode =
  | "BUDGET_EXCEEDED"
  | "ON_DEMAND_INACTIVE"
  | "WORKFLOW_DUMP";

export class LiteContextPackError extends Error {
  readonly code: LitePackErrorCode;

  constructor(code: LitePackErrorCode, message: string) {
    super(message);
    this.name = "LiteContextPackError";
    this.code = code;
  }
}

export interface LitePackArtifact {
  role: string;
  path?: string;
  content?: string;
  module?: string;
}

export interface LitePackItem {
  role: string;
  module: string;
  path: string;
  estimatedTokens: number;
}

export interface LitePackOmission {
  role: string;
  path: string;
  reason: string;
}

export interface LiteContextPackRequest {
  phase: KernelPhase;
  artifacts?: LitePackArtifact[];
  activatedModules?: string[];
  includeFullWorkflow?: boolean;
  maxItems?: number;
  maxEstimatedTokens?: number;
}

export interface LiteContextPack {
  version: typeof LITE_PACK_VERSION;
  source: typeof LITE_PACK_SOURCE;
  phase: KernelPhase;
  budget: {
    maxItems: number;
    maxEstimatedTokens: number;
    estimatedTokens: number;
    itemsUsed: number;
  };
  selected: LitePackItem[];
  omitted: LitePackOmission[];
  modules: {
    baseline: readonly string[];
    activatedOnDemand: string[];
  };
  retrievalIntents: typeof LITE_RETRIEVAL_INTENTS;
  warnings: string[];
}

const PHASE_ROLES: Record<KernelPhase, readonly string[]> = {
  open: ["triage", "retrieval-router"],
  define: ["triage", "definition", "retrieval-router"],
  approve: ["triage", "definition", "approval", "retrieval-router"],
  execute: ["definition", "approval", "retrieval-router"],
  verify: ["definition", "evidence", "retrieval-router"],
  integrate: ["definition", "evidence", "retrieval-router"],
  close: ["definition", "evidence", "outcome", "retrieval-router"],
};

const ROLE_MODULE: Record<string, string> = {
  triage: "intake-basic",
  definition: "define-basic",
  approval: "approval-personal",
  evidence: "verify-basic",
  outcome: "close-basic",
  "retrieval-router": "context-progressive",
};

export function isBlockedOnDemandModule(name: string): boolean {
  return (LITE_BLOCKED_ON_DEMAND_MODULES as readonly string[]).includes(name);
}

export function estimateLiteTokens(text: string): number {
  if (!text) return LITE_MIN_ITEM_TOKENS;
  return Math.max(
    LITE_MIN_ITEM_TOKENS,
    Math.floor(text.length / LITE_CHARS_PER_TOKEN) + 20,
  );
}

export function buildLiteContextPack(
  request: LiteContextPackRequest,
): LiteContextPack {
  if (!isKernelPhase(request.phase)) {
    throw new LiteContextPackError(
      "WORKFLOW_DUMP",
      `invalid Lite pack phase: ${String(request.phase)}`,
    );
  }
  if (request.includeFullWorkflow) {
    throw new LiteContextPackError(
      "WORKFLOW_DUMP",
      "Lite context pack refuses a full workflow.md dump",
    );
  }

  const activated = (request.activatedModules ?? []).filter(
    (name) => typeof name === "string" && name.trim() !== "",
  );
  for (const name of activated) {
    if (isBlockedOnDemandModule(name)) {
      throw new LiteContextPackError(
        "ON_DEMAND_INACTIVE",
        `Lite pack excludes unactivated On-demand module: ${name}`,
      );
    }
  }

  const maxItems = request.maxItems ?? LITE_DEFAULT_MAX_ITEMS;
  const maxEstimatedTokens =
    request.maxEstimatedTokens ?? LITE_DEFAULT_MAX_ESTIMATED_TOKENS;
  const allowedRoles = new Set(PHASE_ROLES[request.phase]);

  const candidates: LitePackItem[] = [
    {
      role: "retrieval-router",
      module: "context-progressive",
      path: "capability://retrieval-router",
      estimatedTokens: LITE_MIN_ITEM_TOKENS,
    },
  ];

  for (const artifact of request.artifacts ?? []) {
    const path = normalizePackPath(artifact.path);
    if (isWorkflowDump(artifact.role, path)) {
      throw new LiteContextPackError(
        "WORKFLOW_DUMP",
        "Lite context pack refuses a full workflow.md dump",
      );
    }
    const moduleName = artifact.module ?? ROLE_MODULE[artifact.role] ?? "";
    if (isBlockedOnDemandModule(moduleName) || isBlockedOnDemandModule(artifact.role)) {
      throw new LiteContextPackError(
        "ON_DEMAND_INACTIVE",
        `Lite pack excludes unactivated On-demand module: ${moduleName || artifact.role}`,
      );
    }
    if (!allowedRoles.has(artifact.role)) {
      continue;
    }
    candidates.push({
      role: artifact.role,
      module: moduleName || "define-basic",
      path,
      estimatedTokens: estimateLiteTokens(artifact.content ?? ""),
    });
  }

  const selected: LitePackItem[] = [];
  const omitted: LitePackOmission[] = [];
  const warnings: string[] = [];
  let estimatedTokens = 0;
  let budgetExceeded = false;

  for (const item of candidates) {
    const wouldExceedItems = selected.length >= maxItems;
    const wouldExceedTokens =
      estimatedTokens + item.estimatedTokens > maxEstimatedTokens;
    if (wouldExceedItems || wouldExceedTokens) {
      budgetExceeded = true;
      omitted.push({
        role: item.role,
        path: item.path,
        reason: wouldExceedTokens
          ? "outside token budget after higher-ranked Lite surfaces"
          : "outside item budget after higher-ranked Lite surfaces",
      });
      continue;
    }
    selected.push(item);
    estimatedTokens += item.estimatedTokens;
  }

  if (budgetExceeded) {
    const dumped = omitted.some(
      (item) =>
        item.path.endsWith("workflow.md") || item.role === "workflow-full",
    );
    if (dumped) {
      throw new LiteContextPackError(
        "BUDGET_EXCEEDED",
        "Lite context pack over budget; refusing silent full workflow dump",
      );
    }
    warnings.push("budget limits caused Lite pack omission");
  }

  return {
    version: LITE_PACK_VERSION,
    source: LITE_PACK_SOURCE,
    phase: request.phase,
    budget: {
      maxItems,
      maxEstimatedTokens,
      estimatedTokens,
      itemsUsed: selected.length,
    },
    selected,
    omitted,
    modules: {
      baseline: LITE_BASELINE_MODULES,
      activatedOnDemand: activated,
    },
    retrievalIntents: LITE_RETRIEVAL_INTENTS,
    warnings,
  };
}

function normalizePackPath(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\\/g, "/");
}

function isWorkflowDump(role: string, path: string): boolean {
  if (role === "workflow-full") return true;
  const base = path.split("/").pop() ?? "";
  return base === "workflow.md";
}
