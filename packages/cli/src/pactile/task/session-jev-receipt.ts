import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
} from "../../core/index.js";
import type { JevDecisionResultV1 } from "../jev/index.js";
import type { JevConfidenceReceiptV1 } from "../jev/index.js";
import { projectJevConfidenceReceiptV1 } from "../jev/response.js";
import {
  assertCanonicalWriteTarget,
  resolveCanonicalPaths,
} from "../runtime/paths.js";
import type { TileSelectionJevAdviceV1 } from "../tiles/jev-selection.js";
import type {
  TileSelectionDecisionReceipt,
  TileSelectionDecision,
  TileSelectionOffer,
} from "../tiles/selection.js";

const SESSION_JEV_MODEL = "jev-latest";
const SESSION_CHANGED_EXPLANATION =
  "The selected Task, Run, or Tile offer changed while Jev was deciding; the suggestion was discarded and the current deterministic session was kept.";

export interface SessionJevReceiptV1 {
  readonly schemaVersion: 1;
  readonly status: "answered" | "fallback" | "discarded-stale";
  readonly node: "tile-selection";
  readonly model: string | null;
  /** Run identities read from the selected Task Kernel, never from CLI input. */
  readonly activeRunId: string | null;
  readonly approvalRunId: string | null;
  /** Fingerprint of the bounded offer/candidate input; never includes its text. */
  readonly offerFingerprint: string;
  readonly inputFingerprint: string;
  readonly candidateRefs: readonly string[];
  readonly outboundAttempted: boolean;
  readonly suggestedRefs: readonly string[];
  readonly deterministicRefs: readonly string[];
  readonly recommendedAction: "adopt" | "override" | "no-match" | null;
  /** Recommendations require the existing explicit Tile decision command. */
  readonly application:
    | "pending-explicit-decision"
    | "not-applied"
    | "discarded";
  /** Content fingerprint of the persisted, immutable pending advice receipt. */
  readonly adviceFingerprint?: string;
  readonly decisionCommand?: string;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedInputCostMicrousd: number | null;
  readonly confidence: JevConfidenceReceiptV1;
  readonly fallback: {
    readonly reasonCode: string;
    readonly explanation: string;
  } | null;
}

export interface SessionJevRunIdentityV1 {
  readonly activeRunId: string;
  readonly approvalRunId: string;
}

export interface SessionJevKernelRunIdentityV1 {
  readonly activeRunId: string | null;
  readonly approvalRunId: string | null;
}

function advisedCandidateRefs(offer: TileSelectionOffer): string[] {
  return offer.candidates
    .filter((candidate) => candidate.outputScore > 0)
    .slice(0, 8)
    .map((candidate) => candidate.ref);
}

function equalRefs(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((ref, index) => ref === right[index])
  );
}

function decisionCommand(
  offer: TileSelectionOffer,
  decision: TileSelectionDecision,
  adviceFingerprint?: string,
): {
  readonly command: string;
  readonly action: "adopt" | "override" | "no-match";
} {
  if (decision.kind === "no-match" || decision.kind === "invalid") {
    return {
      action: "no-match",
      command: [
        "pactile tile-selection decide --session",
        `--offer-fingerprint ${offer.fingerprint}`,
        ...(adviceFingerprint
          ? [`--jev-advice-fingerprint ${adviceFingerprint}`]
          : []),
        "--kind no-match",
      ].join(" "),
    };
  }
  const refs =
    decision.kind === "adopt"
      ? offer.suggestion.selectedRefs
      : (decision.selectedRefs ?? []);
  const action = equalRefs(refs, offer.suggestion.selectedRefs)
    ? "adopt"
    : "override";
  const command = [
    "pactile tile-selection decide --session",
    `--offer-fingerprint ${offer.fingerprint}`,
    ...(adviceFingerprint
      ? [`--jev-advice-fingerprint ${adviceFingerprint}`]
      : []),
    `--kind ${action}`,
    ...(action === "override" ? refs.map((ref) => `--tile ${ref}`) : []),
  ].join(" ");
  return { action, command };
}

function inputFingerprint(offer: TileSelectionOffer): string {
  return fingerprintPactileContractV1({
    schemaVersion: 1,
    kind: "pactile.session.jev-input",
    offerFingerprint: offer.fingerprint,
    candidateRefs: advisedCandidateRefs(offer),
    model: SESSION_JEV_MODEL,
  });
}

export function createSessionJevReceiptV1(
  offer: TileSelectionOffer,
  advice: TileSelectionJevAdviceV1,
  runIdentity: SessionJevRunIdentityV1,
): SessionJevReceiptV1 {
  const decision = advice.jevDecision;
  const transport = decision?.receipt.transport;
  const candidateRefs = advisedCandidateRefs(offer);
  const suggestedRefs =
    advice.suggestedDecision?.kind === "override"
      ? [...(advice.suggestedDecision.selectedRefs ?? [])].slice(0, 8)
      : advice.suggestedDecision?.kind === "no-match"
        ? []
        : advice.source === "jev-advised"
          ? [...offer.suggestion.selectedRefs].slice(0, 8)
          : [];
  const command =
    advice.source === "jev-advised" && advice.suggestedDecision
      ? decisionCommand(offer, advice.suggestedDecision)
      : null;
  return {
    schemaVersion: 1,
    status: advice.source === "jev-advised" ? "answered" : "fallback",
    node: "tile-selection",
    model: transport?.model ?? SESSION_JEV_MODEL,
    activeRunId: runIdentity.activeRunId,
    approvalRunId: runIdentity.approvalRunId,
    offerFingerprint: offer.fingerprint,
    inputFingerprint: inputFingerprint(offer),
    candidateRefs,
    outboundAttempted: (transport?.attempts ?? 0) > 0,
    suggestedRefs,
    deterministicRefs: [...offer.suggestion.selectedRefs].slice(0, 8),
    recommendedAction: command?.action ?? null,
    application: command ? "pending-explicit-decision" : "not-applied",
    ...(command ? { decisionCommand: command.command } : {}),
    attempts: transport?.attempts ?? 0,
    latencyMs: transport?.latencyMs ?? 0,
    httpStatus: transport?.httpStatus ?? null,
    requestId: transport?.requestId ?? null,
    inputTokens: transport?.inputTokens ?? null,
    outputTokens: transport?.outputTokens ?? null,
    estimatedInputCostMicrousd: transport?.estimatedInputCostMicrousd ?? null,
    confidence: projectJevConfidenceReceiptV1(
      transport?.confidence,
      candidateRefs.map((_ref, index) => `candidate${index}`),
    ),
    fallback: advice.fallback,
  };
}

const SESSION_JEV_RECEIPT_FIELDS = [
  "schemaVersion",
  "status",
  "node",
  "model",
  "activeRunId",
  "approvalRunId",
  "offerFingerprint",
  "inputFingerprint",
  "candidateRefs",
  "outboundAttempted",
  "suggestedRefs",
  "deterministicRefs",
  "recommendedAction",
  "application",
  "attempts",
  "latencyMs",
  "httpStatus",
  "requestId",
  "inputTokens",
  "outputTokens",
  "estimatedInputCostMicrousd",
  "confidence",
  "fallback",
  "adviceFingerprint",
].sort();

const MAX_SESSION_JEV_RECEIPT_BYTES = 128 * 1024;

function adviceReceiptBody(
  receipt: SessionJevReceiptV1,
): Omit<SessionJevReceiptV1, "adviceFingerprint" | "decisionCommand"> {
  const {
    adviceFingerprint: _adviceFingerprint,
    decisionCommand: _command,
    ...body
  } = receipt;
  return {
    ...body,
    confidence: Object.fromEntries(
      Object.entries(receipt.confidence).map(([questionId, value]) => [
        questionId,
        { ...value },
      ]),
    ),
  };
}

function receiptTarget(root: string, adviceFingerprint: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(adviceFingerprint))
    throw new Error("session-jev-advice-fingerprint-invalid");
  return assertCanonicalWriteTarget(
    root,
    path.join(
      resolveCanonicalPaths(root).receiptsPath,
      `session-jev-advice-${adviceFingerprint.slice(7)}.json`,
    ),
  );
}

function persistAdviceBytes(root: string, target: string, bytes: Buffer): void {
  const directory = assertCanonicalWriteTarget(root, path.dirname(target));
  fs.mkdirSync(directory, { recursive: true });
  assertCanonicalWriteTarget(root, directory);
  try {
    const existing = fs.lstatSync(target);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.size > MAX_SESSION_JEV_RECEIPT_BYTES ||
      !fs.readFileSync(target).equals(bytes)
    )
      throw new Error("session-jev-advice-receipt-conflict");
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }

  const temporary = assertCanonicalWriteTarget(
    root,
    `${target}.tmp-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("session-jev-advice-receipt-unsafe-target");
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertCanonicalWriteTarget(root, target);
    assertCanonicalWriteTarget(root, temporary);
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        const existing = fs.lstatSync(target);
        if (
          existing.isFile() &&
          !existing.isSymbolicLink() &&
          existing.size <= MAX_SESSION_JEV_RECEIPT_BYTES &&
          fs.readFileSync(target).equals(bytes)
        )
          return;
      }
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // An unexpected residue is not followed or replaced.
    }
  }
}

/** Persist only answered advice that requires an explicit user Tile decision. */
export function persistSessionJevReceiptV1(
  root: string,
  offer: TileSelectionOffer,
  receipt: SessionJevReceiptV1,
): SessionJevReceiptV1 {
  if (
    receipt.status !== "answered" ||
    receipt.application !== "pending-explicit-decision" ||
    !receipt.decisionCommand ||
    !receipt.recommendedAction
  )
    return receipt;

  const body = adviceReceiptBody(receipt);
  const adviceFingerprint = fingerprintPactileContractV1(body);
  const persisted: SessionJevReceiptV1 = { ...body, adviceFingerprint };
  const bytes = Buffer.from(
    `${canonicalizePactileJsonV1(persisted)}\n`,
    "utf8",
  );
  if (bytes.byteLength > MAX_SESSION_JEV_RECEIPT_BYTES)
    throw new Error("session-jev-advice-receipt-size-limit");
  persistAdviceBytes(root, receiptTarget(root, adviceFingerprint), bytes);

  const decision: TileSelectionDecision = {
    kind: receipt.recommendedAction,
    offerFingerprint: offer.fingerprint,
    ...(receipt.recommendedAction === "override"
      ? { selectedRefs: receipt.suggestedRefs }
      : {}),
  };
  const command = decisionCommand(offer, decision, adviceFingerprint);
  return {
    ...persisted,
    decisionCommand: command.command,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the exact persisted advice named by an explicit session decision. */
export function readSessionJevReceiptV1(
  root: string,
  adviceFingerprint: string,
  offer: TileSelectionOffer,
  expectedRunIdentity?: SessionJevRunIdentityV1,
): SessionJevReceiptV1 {
  const target = receiptTarget(root, adviceFingerprint);
  const stat = fs.lstatSync(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_SESSION_JEV_RECEIPT_BYTES
  )
    throw new Error("session-jev-advice-receipt-unsafe-target");
  const raw = fs.readFileSync(target, "utf8");
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || canonicalizePactileJsonV1(value) + "\n" !== raw)
    throw new Error("session-jev-advice-receipt-malformed");
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify(SESSION_JEV_RECEIPT_FIELDS)
  )
    throw new Error("session-jev-advice-receipt-shape-invalid");

  const receipt = value as unknown as SessionJevReceiptV1;
  const body = adviceReceiptBody(receipt);
  const expectedCandidates = advisedCandidateRefs(offer);
  const expectedInputFingerprint = inputFingerprint(offer);
  if (
    receipt.adviceFingerprint !== adviceFingerprint ||
    fingerprintPactileContractV1(body) !== adviceFingerprint ||
    receipt.schemaVersion !== 1 ||
    receipt.status !== "answered" ||
    receipt.node !== "tile-selection" ||
    receipt.application !== "pending-explicit-decision" ||
    typeof receipt.activeRunId !== "string" ||
    receipt.activeRunId.length === 0 ||
    typeof receipt.approvalRunId !== "string" ||
    receipt.approvalRunId.length === 0 ||
    receipt.offerFingerprint !== offer.fingerprint ||
    receipt.inputFingerprint !== expectedInputFingerprint ||
    !equalRefs(receipt.candidateRefs, expectedCandidates) ||
    !equalRefs(receipt.deterministicRefs, offer.suggestion.selectedRefs) ||
    receipt.fallback !== null ||
    !["adopt", "override", "no-match"].includes(
      String(receipt.recommendedAction),
    ) ||
    !Array.isArray(receipt.suggestedRefs) ||
    receipt.suggestedRefs.length > 8 ||
    receipt.suggestedRefs.some((ref) => !expectedCandidates.includes(ref))
  )
    throw new Error("session-jev-advice-receipt-binding-invalid");

  if (
    expectedRunIdentity &&
    (receipt.activeRunId !== expectedRunIdentity.activeRunId ||
      receipt.approvalRunId !== expectedRunIdentity.approvalRunId)
  )
    throw new Error("session-jev-advice-run-identity-mismatch");

  const expectedAction =
    receipt.suggestedRefs.length === 0
      ? "no-match"
      : equalRefs(receipt.suggestedRefs, receipt.deterministicRefs)
        ? "adopt"
        : "override";
  if (receipt.recommendedAction !== expectedAction)
    throw new Error("session-jev-advice-receipt-recommendation-invalid");
  return receipt;
}

export type SessionJevApplicationV1 = "adopted" | "overridden" | "no-match";

/** Classify the user's final compiler-accepted decision against the advice. */
export function sessionJevApplicationV1(
  advice: SessionJevReceiptV1,
  decision: TileSelectionDecisionReceipt,
): SessionJevApplicationV1 | null {
  if (
    advice.status !== "answered" ||
    advice.application !== "pending-explicit-decision" ||
    advice.offerFingerprint !== decision.offerFingerprint
  )
    return null;
  if (decision.outcome === "no-match" && decision.decision === "no-match")
    return "no-match";
  if (
    (decision.outcome !== "selected" && decision.outcome !== "overridden") ||
    (decision.decision !== "adopt" && decision.decision !== "override")
  )
    return null;
  return equalRefs(decision.selectedRefs, advice.suggestedRefs)
    ? "adopted"
    : "overridden";
}

export function createStaleSessionJevReceiptV1(
  offer: TileSelectionOffer,
  decision: JevDecisionResultV1 | null,
  stalePoint: "before-advice" | "during-advice" = "during-advice",
  runIdentity: SessionJevKernelRunIdentityV1 = {
    activeRunId: null,
    approvalRunId: null,
  },
): SessionJevReceiptV1 {
  const transport = decision?.receipt.transport;
  const candidateRefs = advisedCandidateRefs(offer);
  const beforeAdvice = stalePoint === "before-advice";
  return {
    schemaVersion: 1,
    status: "discarded-stale",
    node: "tile-selection",
    model: transport?.model ?? SESSION_JEV_MODEL,
    activeRunId: runIdentity.activeRunId,
    approvalRunId: runIdentity.approvalRunId,
    offerFingerprint: offer.fingerprint,
    inputFingerprint: inputFingerprint(offer),
    candidateRefs,
    outboundAttempted: (transport?.attempts ?? 0) > 0,
    suggestedRefs: [],
    deterministicRefs: [],
    recommendedAction: null,
    application: "discarded",
    attempts: transport?.attempts ?? 0,
    latencyMs: transport?.latencyMs ?? 0,
    httpStatus: transport?.httpStatus ?? null,
    requestId: transport?.requestId ?? null,
    inputTokens: transport?.inputTokens ?? null,
    outputTokens: transport?.outputTokens ?? null,
    estimatedInputCostMicrousd: transport?.estimatedInputCostMicrousd ?? null,
    confidence: projectJevConfidenceReceiptV1(
      transport?.confidence,
      candidateRefs.map((_ref, index) => `candidate${index}`),
    ),
    fallback: {
      reasonCode: beforeAdvice
        ? "session-changed-before-advice"
        : "session-changed-during-advice",
      explanation: beforeAdvice
        ? "The selected Task, Run, or Tile offer changed before Jev advice started; the current deterministic session was kept."
        : SESSION_CHANGED_EXPLANATION,
    },
  };
}

export function createSessionJevRunIdentityFallbackV1(
  offer: TileSelectionOffer,
  runIdentity: SessionJevKernelRunIdentityV1 = {
    activeRunId: null,
    approvalRunId: null,
  },
): SessionJevReceiptV1 {
  const stale = createStaleSessionJevReceiptV1(
    offer,
    null,
    "before-advice",
    runIdentity,
  );
  return {
    ...stale,
    status: "fallback",
    application: "not-applied",
    fallback: {
      reasonCode: "session-run-identity-unavailable",
      explanation:
        "Trusted active and approval Run IDs are unavailable; Jev advice was skipped and the deterministic Tile offer was kept.",
    },
  };
}

export function attachSessionJevReceiptV1(
  pack: Record<string, unknown>,
  advice: SessionJevReceiptV1,
): Record<string, unknown> {
  const selection = pack.tileSelection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection))
    return pack;
  return {
    ...pack,
    tileSelection: {
      ...(selection as Record<string, unknown>),
      jevAdvice: advice,
    },
  };
}
