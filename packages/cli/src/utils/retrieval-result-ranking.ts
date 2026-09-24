import { Buffer } from "node:buffer";

import type { PactileIntentV1 } from "../core/index.js";

export type RetrievalRankingIntent = PactileIntentV1;

export interface RetrievalResultCandidate {
  readonly path: string;
  readonly line?: number;
  readonly baseScore?: number;
  readonly exactMatch?: boolean;
  readonly semanticScore?: number;
  readonly structuralMatch?: boolean;
  readonly externalFreshness?: number;
  readonly sourceReference?: string;
  readonly assemblyOnly?: boolean;
}

export interface RankedRetrievalResultCandidate extends RetrievalResultCandidate {
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface RankRetrievalResultOptions {
  readonly intents: readonly RetrievalRankingIntent[];
  readonly topK?: number;
}

export interface RankedRetrievalResult {
  readonly ranked: readonly RankedRetrievalResultCandidate[];
  readonly total: number;
}

function clamp(value: number | undefined, min = 0, max = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").normalize("NFC").toLowerCase();
}

function scoreCandidate(
  candidate: RetrievalResultCandidate,
  intents: ReadonlySet<RetrievalRankingIntent>,
): RankedRetrievalResultCandidate {
  let score = clamp(candidate.baseScore, -1000, 1000);
  const reasons: string[] = [];
  if (intents.has("exact") && candidate.exactMatch) {
    score += 100;
    reasons.push("exact-match");
  }
  if (intents.has("semantic") && candidate.semanticScore !== undefined) {
    score += clamp(candidate.semanticScore) * 40;
    reasons.push("semantic-candidate");
  }
  if (intents.has("structural") && candidate.structuralMatch) {
    score += 60;
    reasons.push("structural-match");
  }
  if (intents.has("external") && candidate.externalFreshness !== undefined) {
    score += clamp(candidate.externalFreshness) * 30;
    reasons.push("external-freshness-candidate");
  }
  if (candidate.sourceReference) {
    score += 10;
    reasons.push("source-reference-present");
  }
  if (candidate.assemblyOnly) {
    score -= intents.has("structural") ? 30 : 10;
    reasons.push("assembly-only-demotion");
  }
  return { ...candidate, score, reasons };
}

export function rankRetrievalResultCandidates(
  candidates: readonly RetrievalResultCandidate[],
  options: RankRetrievalResultOptions,
): RankedRetrievalResult {
  const intents = new Set(options.intents);
  const topK = Math.max(
    0,
    Math.min(options.topK ?? candidates.length, candidates.length),
  );
  const ranked = candidates
    .map((candidate) => scoreCandidate(candidate, intents))
    .sort((left, right) => {
      const byScore = right.score - left.score;
      if (byScore !== 0) return byScore;
      const byPath = Buffer.compare(
        Buffer.from(normalizedPath(left.path), "utf8"),
        Buffer.from(normalizedPath(right.path), "utf8"),
      );
      if (byPath !== 0) return byPath;
      return (left.line ?? 0) - (right.line ?? 0);
    })
    .slice(0, topK);
  return { ranked, total: candidates.length };
}

export interface PagedCallerResult {
  readonly page: number;
  readonly candidates: readonly RetrievalResultCandidate[];
}

export function pagedCallerAggregation(
  pages: readonly PagedCallerResult[],
  options: Omit<RankRetrievalResultOptions, "intents"> & {
    readonly intents?: readonly RetrievalRankingIntent[];
  } = {},
): RankedRetrievalResult {
  const ordered = [...pages].sort((left, right) => left.page - right.page);
  const unique = new Map<string, RetrievalResultCandidate>();
  for (const page of ordered) {
    for (const candidate of page.candidates) {
      const key = `${normalizedPath(candidate.path)}:${candidate.line ?? 0}`;
      if (!unique.has(key)) unique.set(key, candidate);
    }
  }
  return rankRetrievalResultCandidates([...unique.values()], {
    intents: options.intents ?? ["structural"],
    topK: options.topK,
  });
}
