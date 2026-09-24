import type { PactileIntentV1 } from "../core/index.js";

export interface ClassifiedToolCalls {
  readonly exact_count: number;
  readonly semantic_count: number;
  readonly structural_count: number;
  readonly external_count: number;
  readonly read_count: number;
  readonly git_count: number;
  readonly test_count: number;
  readonly router_cli_invoked: boolean;
  readonly unclassified_count: number;
}

const EXACT_PATTERNS = [
  /^grep$/i,
  /^rg$/i,
  /ripgrep/i,
  /find.?files?/i,
  /^glob$/i,
];
const SEMANTIC_PATTERNS = [/semantic/i, /concept/i, /meaning/i];
const STRUCTURAL_PATTERNS = [
  /structural/i,
  /callers?/i,
  /callees?/i,
  /dependenc/i,
  /call.?graph/i,
];
const EXTERNAL_PATTERNS = [
  /external/i,
  /^web/i,
  /browser/i,
  /http.?fetch/i,
  /remote.?search/i,
];
const READ_PATTERNS = [
  /^read$/i,
  /read.?file/i,
  /get-content/i,
  /source.?read/i,
];
const GIT_PATTERNS = [/^git(?:\s|$)/i, /git.?diff/i, /git.?log/i, /git.?show/i];
const TEST_PATTERNS = [/test/i, /vitest/i, /pytest/i, /check/i];
const ROUTER_PATTERNS = [/route.?codebase.?retrieval/i, /retrieval.?plan/i];

function matches(name: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(name));
}

/** Classify observed execution only; this function never selects a route. */
export function classifyToolCalls(
  rawNames: readonly string[],
): ClassifiedToolCalls {
  let exact = 0;
  let semantic = 0;
  let structural = 0;
  let external = 0;
  let read = 0;
  let git = 0;
  let test = 0;
  let router = false;
  let unclassified = 0;
  for (const raw of rawNames) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) {
      unclassified += 1;
      continue;
    }
    let classified = false;
    if (matches(name, EXACT_PATTERNS)) {
      exact += 1;
      classified = true;
    }
    if (matches(name, SEMANTIC_PATTERNS)) {
      semantic += 1;
      classified = true;
    }
    if (matches(name, STRUCTURAL_PATTERNS)) {
      structural += 1;
      classified = true;
    }
    if (matches(name, EXTERNAL_PATTERNS)) {
      external += 1;
      classified = true;
    }
    if (matches(name, READ_PATTERNS)) {
      read += 1;
      classified = true;
    }
    if (matches(name, GIT_PATTERNS)) {
      git += 1;
      classified = true;
    }
    if (matches(name, TEST_PATTERNS)) {
      test += 1;
      classified = true;
    }
    if (matches(name, ROUTER_PATTERNS)) {
      router = true;
      classified = true;
    }
    if (!classified) unclassified += 1;
  }
  return {
    exact_count: exact,
    semantic_count: semantic,
    structural_count: structural,
    external_count: external,
    read_count: read,
    git_count: git,
    test_count: test,
    router_cli_invoked: router,
    unclassified_count: unclassified,
  };
}

export function structuralRoutesInPlan(intents: readonly string[]): boolean {
  return intents.includes("structural");
}

export function semanticRoutesInPlan(intents: readonly string[]): boolean {
  return intents.includes("semantic");
}

export function observedIntentCount(
  classified: ClassifiedToolCalls,
  intent: PactileIntentV1,
): number {
  switch (intent) {
    case "exact":
      return classified.exact_count;
    case "semantic":
      return classified.semantic_count;
    case "structural":
      return classified.structural_count;
    case "external":
      return classified.external_count;
  }
}
