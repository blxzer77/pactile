import fs from "node:fs";
import path from "node:path";
import type { KernelPhase } from "../../core/task/index.js";
import {
  projectTaskKernelLifecycle,
  readTaskKernel,
} from "../../core/task/index.js";
import { readLegacyTaskImportRecord } from "../../core/task/legacy-task-migration-reader.js";
import {
  createJevDecisionFacadeV1,
  type JevEgressAuthorizationV1,
} from "../jev/index.js";
import { JEV_ORIGIN_V1 } from "../jev/contracts.js";
import {
  prepareSelectedTaskAgentTileSelection,
  prepareSelectedTaskAgentTileSelectionWithJevV1,
} from "../registry.js";
import {
  attachSessionJevReceiptV1,
  createSessionJevRunIdentityFallbackV1,
  createSessionJevReceiptV1,
  createStaleSessionJevReceiptV1,
  persistSessionJevReceiptV1,
  type SessionJevKernelRunIdentityV1,
  type SessionJevRunIdentityV1,
  type SessionJevReceiptV1,
} from "./session-jev-receipt.js";
import type {
  TileSelectionOffer,
  TileTaskLifecycleFact,
} from "../tiles/selection.js";
import { resolveSelectedTask, resolveTaskDir } from "./session.js";
import { compileSessionPack } from "./session-pack.js";

const SESSION_JEV_DEADLINE_MS = 2_500;
const SESSION_JEV_MAX_RETRIES = 1;

interface SessionPackKernelV1 {
  readonly taskId?: unknown;
  readonly revision?: unknown;
  readonly phase?: unknown;
  readonly selected?: unknown;
}

interface SessionStampV1 {
  readonly taskPath: string;
  readonly contextKey: string | null;
  readonly taskId: string;
  readonly revision: number;
  readonly phase: string;
  readonly activeRunId: string | null;
  readonly approvalRunId: string | null;
  readonly hasTaskKernelV2: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function currentOffer(
  pack: Record<string, unknown>,
): TileSelectionOffer | null {
  const selection = record(pack.tileSelection);
  const offer = record(selection?.offer);
  if (
    selection?.status !== "offered" ||
    typeof offer?.fingerprint !== "string" ||
    !Array.isArray(offer.candidates) ||
    !Array.isArray(offer.requiredOutputs) ||
    typeof offer.intent !== "string" ||
    typeof offer.channel !== "string" ||
    !offer.suggestion ||
    typeof offer.suggestion !== "object"
  )
    return null;
  return offer as unknown as TileSelectionOffer;
}

function expectedLifecycle(
  pack: Record<string, unknown>,
): Pick<TileTaskLifecycleFact, "taskId" | "phase" | "revision"> | null {
  const kernel = record(pack.kernel) as SessionPackKernelV1 | null;
  if (
    typeof kernel?.taskId !== "string" ||
    typeof kernel.phase !== "string" ||
    typeof kernel.revision !== "number" ||
    !Number.isSafeInteger(kernel.revision) ||
    kernel.revision < 0
  )
    return null;
  return {
    taskId: kernel.taskId,
    phase: kernel.phase as KernelPhase,
    revision: kernel.revision,
  };
}

function captureStamp(
  root: string,
  pack: Record<string, unknown>,
): SessionStampV1 | null {
  const lifecycle = expectedLifecycle(pack);
  if (!lifecycle) return null;
  const selection = resolveSelectedTask(root);
  if (!selection.taskPath || selection.stale) return null;
  const taskDir = resolveTaskDir(root, selection.taskPath);
  if (
    !fs.existsSync(path.join(taskDir, "kernel.json")) &&
    !readLegacyTaskImportRecord(root, taskDir)
  )
    return null;
  const read = readTaskKernel({ root, taskDir, cwd: root });
  if (read.kind === "task-kernel-v2") {
    const projected = projectTaskKernelLifecycle(read.kernel);
    return {
      taskPath: selection.taskPath,
      contextKey: selection.contextKey,
      taskId: projected.taskId,
      revision: projected.revision,
      phase: projected.phase,
      activeRunId: projected.gateSnapshot.runStart.activeRunId,
      approvalRunId: projected.approvalSnapshot.runId,
      hasTaskKernelV2: true,
    };
  }
  return {
    taskPath: selection.taskPath,
    contextKey: selection.contextKey,
    taskId: lifecycle.taskId,
    revision: lifecycle.revision,
    phase: lifecycle.phase,
    activeRunId: null,
    approvalRunId: null,
    hasTaskKernelV2: false,
  };
}

function runIdentityFacts(stamp: SessionStampV1): SessionJevKernelRunIdentityV1 {
  return {
    activeRunId: stamp.activeRunId,
    approvalRunId: stamp.approvalRunId,
  };
}

function trustedRunIdentity(stamp: SessionStampV1): SessionJevRunIdentityV1 | null {
  if (
    !stamp.hasTaskKernelV2 ||
    !stamp.activeRunId ||
    !stamp.approvalRunId
  )
    return null;
  return {
    activeRunId: stamp.activeRunId,
    approvalRunId: stamp.approvalRunId,
  };
}

function sameStamp(
  left: SessionStampV1 | null,
  right: SessionStampV1 | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.taskPath === right.taskPath &&
    left.contextKey === right.contextKey &&
    left.taskId === right.taskId &&
    left.revision === right.revision &&
    left.phase === right.phase &&
    left.hasTaskKernelV2 === right.hasTaskKernelV2 &&
    left.activeRunId === right.activeRunId &&
    left.approvalRunId === right.approvalRunId
  );
}

/**
 * Add an optional, Task-grant-gated Jev advisory to the real session context.
 * The deterministic offer remains unchanged; advice is a receipt only and the
 * existing Tile decision command is still required to apply any proposal.
 */
export async function compileSessionPackWithJevV1(
  root: string,
  factGap = false,
): Promise<Record<string, unknown>> {
  const initialPack = compileSessionPack(root, factGap);
  const offer = currentOffer(initialPack);
  const expected = expectedLifecycle(initialPack);
  if (!offer || !expected) return initialPack;

  const initialStamp = captureStamp(root, initialPack);
  const initialRunIdentity = initialStamp
    ? trustedRunIdentity(initialStamp)
    : null;
  if (initialStamp && !initialRunIdentity)
    return attachSessionJevReceiptV1(
      initialPack,
      createSessionJevRunIdentityFallbackV1(
        offer,
        runIdentityFacts(initialStamp),
      ),
    );
  const preflight = prepareSelectedTaskAgentTileSelection(root, {
    ...expected,
    activeRunId: initialStamp?.activeRunId,
    approvalRunId: initialStamp?.approvalRunId,
  });
  if (
    !initialStamp ||
    !initialRunIdentity ||
    !preflight.success ||
    preflight.data.offer.fingerprint !== offer.fingerprint
  ) {
    const current = compileSessionPack(root, factGap);
    const currentOfferValue = currentOffer(current);
    return currentOfferValue
      ? attachSessionJevReceiptV1(
          current,
          createStaleSessionJevReceiptV1(
            offer,
            null,
            "before-advice",
            initialStamp ? runIdentityFacts(initialStamp) : undefined,
          ),
        )
      : current;
  }

  const enabledValue = process.env.PACTILE_JEV_ENABLED?.trim().toLowerCase();
  const explicitlyDisabled = enabledValue === "false";
  const facade = createJevDecisionFacadeV1({
    ...(explicitlyDisabled ? { enabled: false } : {}),
    maxDecisions: 1,
    maxDeadlineMs: SESSION_JEV_DEADLINE_MS,
    transport: {
      apiKey: process.env.PACTILE_JEV_API_KEY,
      deadlineMs: SESSION_JEV_DEADLINE_MS,
      maxRetries: SESSION_JEV_MAX_RETRIES,
    },
  });
  const egress: JevEgressAuthorizationV1 = {
    network: "project-authorized",
    privacy: "project-approved-egress",
    credentials: "project-authorized",
    destination: JEV_ORIGIN_V1,
    egressDestinations: [JEV_ORIGIN_V1],
    contentDecision: "task-summary-and-snippets-approved",
  };
  const result = await prepareSelectedTaskAgentTileSelectionWithJevV1(
    root,
    { facade, callOptions: { egress } },
    {
      ...expected,
      activeRunId: initialStamp?.activeRunId,
      approvalRunId: initialStamp?.approvalRunId,
    },
  );

  const currentPack = compileSessionPack(root, factGap);
  const currentStamp = captureStamp(root, currentPack);
  const currentPlan = prepareSelectedTaskAgentTileSelection(root);
  const currentOfferValue = currentOffer(currentPack);
  const resultOfferFingerprint = result.success
    ? result.data.offer.fingerprint
    : null;
  const unchanged =
    sameStamp(initialStamp, currentStamp) &&
    currentOfferValue?.fingerprint === offer.fingerprint &&
    currentPlan.success &&
    currentPlan.data.offer.fingerprint === offer.fingerprint &&
    (resultOfferFingerprint === null ||
      resultOfferFingerprint === offer.fingerprint);

  if (!unchanged) {
    const jevDecision = result.success ? result.data.jevDecision : null;
    return currentOfferValue
      ? attachSessionJevReceiptV1(
          currentPack,
              createStaleSessionJevReceiptV1(
                offer,
                jevDecision,
                "during-advice",
                initialStamp ? runIdentityFacts(initialStamp) : undefined,
              ),
        )
      : currentPack;
  }

  if (!result.success) {
    const noAdvice: SessionJevReceiptV1 = {
      ...createStaleSessionJevReceiptV1(
        offer,
        null,
        "during-advice",
        runIdentityFacts(initialStamp),
      ),
      status: "fallback",
      application: "not-applied",
      fallback: {
        reasonCode: "session-advice-unavailable",
        explanation:
          "The current selected Task could not be safely re-read for Jev advice; the deterministic session was kept.",
      },
    };
    return attachSessionJevReceiptV1(currentPack, noAdvice);
  }

  const advice = createSessionJevReceiptV1(offer, result.data, initialRunIdentity);
  try {
    return attachSessionJevReceiptV1(
      currentPack,
      persistSessionJevReceiptV1(root, offer, advice),
    );
  } catch {
    const { decisionCommand: _decisionCommand, ...unlinkedAdvice } = advice;
    return attachSessionJevReceiptV1(currentPack, {
      ...unlinkedAdvice,
      status: "fallback",
      suggestedRefs: [],
      recommendedAction: null,
      application: "not-applied",
      fallback: {
        reasonCode: "session-advice-receipt-write-failed",
        explanation:
          "Jev advice could not be recorded safely; use the deterministic Tile offer.",
      },
    });
  }
}
