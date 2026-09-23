import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
  type InstallStateV1,
  type OwnershipLedgerEntryV1,
  type ProjectionOperationV1,
} from "@blxzer/pactile-core";
import {
  fingerprintBytes,
  MAX_PROJECTION_BYTES,
  type ProjectionContent,
  type ProjectionPreview,
} from "../projection/planner.js";
import {
  ProjectionStore,
  type ProjectionApplyResult,
} from "../projection/store.js";
import {
  GenerationStore,
  InstallStateStore,
  type GenerationSeal,
  type InstallStateSnapshot,
} from "../runtime/stores.js";
import { runLifecycleCommand } from "../lifecycle/command-runner.js";
import { materializeCanonicalGeneration } from "../lifecycle/project-files.js";
import type { PactilePlatform } from "../registry.js";
import {
  type ExitReceiptSnapshot,
  type ExitReceiptV1,
  writeExitReceipt,
} from "./receipt.js";

const LOGICAL_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const CANONICAL_ROOT = ".pactile";

type ExitFailureStatus = "review" | "conflict" | "busy" | "interrupted";

export interface ExitFailure {
  readonly status: ExitFailureStatus;
  readonly reason: string;
}

export interface DetachPlan {
  readonly status: "ready";
  readonly adapterId: string;
  readonly generationId: string;
  readonly generationFingerprint: string;
  readonly installStateFingerprint: string;
  readonly occurredAt: string;
  readonly preview: ProjectionPreview;
  readonly previewFingerprint: string;
}

export type DetachPlanResult = DetachPlan | ExitFailure;

export type DetachApplyResult =
  | {
      readonly status: "applied" | "already-applied";
      readonly adapterId: string;
      readonly decisions: ProjectionPreview["decisions"];
      readonly installState: InstallStateSnapshot;
      readonly receipt: ExitReceiptSnapshot;
    }
  | ExitFailure;

export type UninstallResult =
  | {
      readonly status: "applied" | "already-inactive";
      readonly adapterIds: readonly string[];
      readonly detachments: readonly DetachApplyResult[];
      readonly installState: InstallStateSnapshot;
      readonly receipt: ExitReceiptSnapshot;
    }
  | {
      readonly status: "degraded";
      readonly reason: string;
      readonly adapterIds: readonly string[];
      readonly detachments: readonly DetachApplyResult[];
      readonly installState: InstallStateSnapshot | null;
      readonly receipt: ExitReceiptSnapshot | null;
    };

export interface RollbackPlan {
  readonly status: "ready";
  readonly fromGenerationId: string;
  readonly toGenerationId: string;
  readonly targetGenerationFingerprint: string;
  readonly installStateFingerprint: string;
  readonly occurredAt: string;
  readonly planFingerprint: string;
  readonly alreadyActive: boolean;
}

export type RollbackPlanResult = RollbackPlan | ExitFailure;

export type RollbackApplyResult =
  | {
      readonly status: "applied" | "degraded" | "already-active";
      readonly fromGenerationId: string;
      readonly toGenerationId: string;
      readonly installState: InstallStateSnapshot;
      readonly receipt: ExitReceiptSnapshot;
    }
  | ExitFailure;

export interface PurgeTarget {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly size: number | null;
  readonly fingerprint: string | null;
}

export interface PurgePlan {
  readonly status: "ready";
  readonly generationId: string;
  readonly adapterIds: readonly string[];
  readonly targets: readonly PurgeTarget[];
  readonly manifestFingerprint: string;
  readonly occurredAt: string;
}

export type PurgePlanResult = PurgePlan | ExitFailure;

export type PurgeApplyResult =
  | {
      readonly status: "applied";
      readonly deletedTargets: number;
      /** Returned to the caller because a successful purge removes its store. */
      readonly receipt: ExitReceiptSnapshot;
    }
  | ExitFailure;

export interface PactileExitManagerOptions {
  readonly now?: () => string;
  readonly projectionStore?: ProjectionStore;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function physicalIdentity(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

/**
 * Compare paths by filesystem identity when Windows exposes an alias for a
 * directory (for example, a runner temp directory junction or an 8.3 path).
 * The textual fallback keeps this helper usable for paths that no longer
 * exist, while stat identity prevents a harmless spelling difference from
 * being mistaken for an escape.
 */
function samePhysicalPath(left: string, right: string): boolean {
  if (physicalIdentity(left) === physicalIdentity(right)) return true;
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function digestIdentity(value: unknown): string {
  return fingerprintPactileContractV1(value).slice(7, 31);
}

function failure(status: ExitFailureStatus, reason: string): ExitFailure {
  return { status, reason };
}

function safeRelativeTarget(relative: string): boolean {
  return (
    relative.length > 0 &&
    relative.length <= 1024 &&
    !relative.includes("\\") &&
    !relative.includes(":") &&
    !path.posix.isAbsolute(relative) &&
    relative
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
          !/[<>"|?*]/u.test(part) &&
          !/[. ]$/u.test(part) &&
          ![...part].some((character) => character.charCodeAt(0) < 32),
      )
  );
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Read a host surface without following links or accepting case aliases. */
function readHostSurface(projectRoot: string, relative: string): Buffer | null {
  if (!safeRelativeTarget(relative)) throw new Error("unsafe-exit-target");
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, ...relative.split("/"));
  if (!contained(root, target) || target === root)
    throw new Error("unsafe-exit-target");
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("unsafe-project-root");
  const realRoot = fs.realpathSync.native(root);
  if (!samePhysicalPath(realRoot, root)) throw new Error("unsafe-project-root");

  let cursor = root;
  for (const part of relative.split("/")) {
    const parent = fs.lstatSync(cursor);
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error("unsafe-exit-target");
    const matches = fs
      .readdirSync(cursor)
      .filter((name) => physicalIdentity(name) === physicalIdentity(part));
    if (matches.length > 1 || (matches.length === 1 && matches[0] !== part))
      throw new Error("ambiguous-exit-target");
    if (matches.length === 0) return null;
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
      throw new Error("unsafe-exit-target");
    const real = fs.realpathSync.native(cursor);
    if (!contained(realRoot, real) || !samePhysicalPath(real, cursor))
      throw new Error("unsafe-exit-target");
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.size > MAX_PROJECTION_BYTES)
    throw new Error("unsafe-exit-target");
  const bytes = fs.readFileSync(target);
  if (bytes.byteLength > MAX_PROJECTION_BYTES)
    throw new Error("unsafe-exit-target");
  return bytes;
}

function aggregateInstallStatus(
  adapters: InstallStateV1["installedAdapters"],
): InstallStateV1["status"] {
  if (adapters.every((adapter) => adapter.status === "detached"))
    return "inactive";
  if (adapters.some((adapter) => adapter.status === "degraded"))
    return "degraded";
  return "active";
}

function receipt(
  action: ExitReceiptV1["action"],
  generationId: string,
  previousGenerationId: string | null,
  adapterIds: readonly string[],
  result: ExitReceiptV1["result"],
  evidenceFingerprint: string,
  occurredAt: string,
): ExitReceiptV1 {
  return {
    schemaVersion: 1,
    action,
    generationId,
    previousGenerationId,
    adapterIds: [...adapterIds].sort(lexical),
    result,
    evidenceFingerprint,
    occurredAt,
  };
}

function receiptSnapshot(value: ExitReceiptV1): ExitReceiptSnapshot {
  return { receipt: value, fingerprint: fingerprintPactileContractV1(value) };
}

function mapApplyFailure(result: ProjectionApplyResult): ExitFailure {
  if (result.status === "busy") return failure("busy", result.reason);
  if (result.status === "conflict") return failure("conflict", result.reason);
  if (result.status === "review") return failure("review", result.reason);
  if (result.status === "interrupted")
    return failure("interrupted", result.reason);
  throw new Error("projection-result-is-not-a-failure");
}

function platformForAdapter(adapterId: string): PactilePlatform | null {
  if (adapterId === "adapter.codex") return "codex";
  return null;
}

function hasTransientOrLockName(relative: string): boolean {
  return relative
    .split("/")
    .some(
      (part) =>
        part.endsWith(".lock") ||
        part.includes(".tmp-") ||
        /^.+\.pactile-[0-9a-f-]+\.tmp$/i.test(part) ||
        part === "projection-transaction.json",
    );
}

function hashFile(target: string, expected: fs.Stats): string {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    )
      throw new Error("unsafe-purge-target");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const count = fs.readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.byteLength, opened.size - offset),
        offset,
      );
      if (count <= 0) throw new Error("purge-read-incomplete");
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    )
      throw new Error("purge-target-race");
    return `sha256:${hash.digest("hex")}`;
  } finally {
    fs.closeSync(descriptor);
  }
}

function inventoryCanonicalRoot(projectRoot: string): readonly PurgeTarget[] {
  const root = path.resolve(projectRoot);
  const canonical = path.join(root, CANONICAL_ROOT);
  const first = fs.lstatSync(canonical);
  if (!first.isDirectory() || first.isSymbolicLink())
    throw new Error("unsafe-purge-root");
  if (!samePhysicalPath(fs.realpathSync.native(canonical), canonical))
    throw new Error("unsafe-purge-root");

  const targets: PurgeTarget[] = [];
  const visit = (absolute: string, relative: string): void => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
      throw new Error("unsafe-purge-target");
    if (!samePhysicalPath(fs.realpathSync.native(absolute), absolute))
      throw new Error("unsafe-purge-target");
    if (hasTransientOrLockName(relative)) throw new Error("purge-runtime-busy");
    if (stat.isFile()) {
      targets.push({
        path: relative,
        kind: "file",
        size: stat.size,
        fingerprint: hashFile(absolute, stat),
      });
      return;
    }
    if (!stat.isDirectory()) throw new Error("unsafe-purge-target");
    targets.push({
      path: relative,
      kind: "directory",
      size: null,
      fingerprint: null,
    });
    const names = fs.readdirSync(absolute).sort(lexical);
    const identities = new Set<string>();
    for (const name of names) {
      const identity = physicalIdentity(name);
      if (identities.has(identity)) throw new Error("ambiguous-purge-target");
      identities.add(identity);
      visit(path.join(absolute, name), `${relative}/${name}`);
    }
  };
  visit(canonical, CANONICAL_ROOT);
  return targets.sort((left, right) => lexical(left.path, right.path));
}

function samePurgeTargets(
  left: readonly PurgeTarget[],
  right: readonly PurgeTarget[],
): boolean {
  return canonicalizePactileJsonV1(left) === canonicalizePactileJsonV1(right);
}

/**
 * Evidence-driven exit coordinator. It holds the ProjectionStore instance so
 * only an inspected, unmodified preview can cross the apply boundary.
 */
export class PactileExitManager {
  readonly projectRoot: string;
  private readonly now: () => string;
  private readonly projections: ProjectionStore;

  constructor(projectRoot: string, options: PactileExitManagerOptions = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.now = options.now ?? (() => new Date().toISOString());
    this.projections =
      options.projectionStore ?? new ProjectionStore(this.projectRoot);
  }

  planDetach(adapterId: string, occurredAt = this.now()): DetachPlanResult {
    try {
      if (!LOGICAL_ID.test(adapterId))
        return failure("review", "invalid-adapter-id");
      const installs = new InstallStateStore(this.projectRoot);
      const installed = installs.read();
      if (!installed) return failure("review", "install-state-required");
      const normalizedAdapterId = physicalIdentity(adapterId);
      const matchingAdapters = installed.state.installedAdapters.filter(
        (adapter) => physicalIdentity(adapter.id) === normalizedAdapterId,
      );
      if (
        matchingAdapters.length !== 1 ||
        matchingAdapters[0]?.id !== adapterId
      )
        return failure("review", "adapter-identity-ambiguous-or-missing");

      const seal = new GenerationStore(this.projectRoot).verify(
        installed.state.generationId,
      );
      const ledger = this.projections.readLedger();
      if (!ledger) return failure("review", "ownership-ledger-required");
      if (ledger.ledger.generationId !== installed.state.generationId)
        return failure("conflict", "ledger-generation-mismatch");

      const targetIdentities = new Set<string>();
      const contentCandidates = new Map<string, Buffer>();
      const operations: ProjectionOperationV1[] = [];
      for (const [index, entry] of ledger.ledger.entries.entries()) {
        const targetIdentity = physicalIdentity(entry.targetPath);
        if (targetIdentities.has(targetIdentity))
          return failure("review", "ambiguous-physical-target");
        targetIdentities.add(targetIdentity);
        if (entry.format === "directory" || entry.format === "external-ref")
          return failure("review", "unsupported-ledger-entry");

        const normalizedClaimants = new Set<string>();
        for (const claimant of entry.claimants) {
          const claimantIdentity = physicalIdentity(claimant.id);
          if (normalizedClaimants.has(claimantIdentity))
            return failure("review", "ambiguous-claimant-identity");
          normalizedClaimants.add(claimantIdentity);
        }
        const matchingClaimants = entry.claimants.filter(
          (claimant) => physicalIdentity(claimant.id) === normalizedAdapterId,
        );
        if (matchingClaimants.length > 1)
          return failure("review", "ambiguous-claimant-identity");
        if (matchingClaimants.length === 0) continue;
        if (matchingClaimants[0]?.id !== adapterId)
          return failure("review", "ambiguous-claimant-identity");
        if (entry.control === "unknown")
          return failure("review", "ownership-review-required");

        const current = readHostSurface(this.projectRoot, entry.targetPath);
        if (
          entry.generated.state === "present" &&
          entry.generated.contentRef &&
          current !== null &&
          fingerprintBytes(current) === entry.generated.fingerprint
        ) {
          const former = contentCandidates.get(entry.generated.contentRef);
          if (former && !former.equals(current))
            return failure("review", "ambiguous-content-reference");
          contentCandidates.set(entry.generated.contentRef, current);
        }
        operations.push({
          id: `exit.remove.${index}`,
          resourceId: entry.resourceId,
          claimantId: adapterId,
          action: "remove",
          // Existing borrowed/unknown truth is consulted from the ledger. A
          // file remove operation itself must use the M1 writable grammar.
          control: "pactile-owned",
          targetPath: entry.targetPath,
          format: entry.format,
          contentRef: null,
          desiredFingerprint: null,
          expectedCurrentFingerprint:
            current === null ? null : fingerprintBytes(current),
          externalAssetId: null,
        });
      }
      for (const [index, claim] of this.projections
        .readExternalClaims()
        .claims.entries()) {
        if (!claim.claimants.includes(adapterId)) continue;
        operations.push({
          id: `exit.detach.external.${index}`,
          resourceId: claim.resourceId,
          claimantId: adapterId,
          action: "detach",
          control: "borrowed",
          targetPath: null,
          format: "external-ref",
          contentRef: null,
          desiredFingerprint: null,
          expectedCurrentFingerprint: null,
          externalAssetId: claim.externalAssetId,
        });
      }

      const planIdentity = digestIdentity({
        adapterId,
        generationId: installed.state.generationId,
        ledgerFingerprint: ledger.fingerprint,
        observations: operations.map((operation) => ({
          resourceId: operation.resourceId,
          fingerprint: operation.expectedCurrentFingerprint,
        })),
      });
      const preview = this.projections.inspect({
        plan: {
          schemaVersion: 1,
          id: `exit.detach.${planIdentity}`,
          adapterId,
          generationId: installed.state.generationId,
          canonicalFingerprint: seal.fingerprint,
          expectedLedgerFingerprint: ledger.fingerprint,
          operations,
        },
        canonicalFingerprint: seal.fingerprint,
        updatedAt: occurredAt,
        resolveContent: (contentRef): ProjectionContent => {
          const bytes = contentCandidates.get(contentRef);
          if (!bytes) throw new Error("unavailable-generated-baseline");
          return { bytes };
        },
      });
      if (preview.status !== "ready")
        return failure(preview.status, preview.reason);
      if (
        preview.decisions.some(
          (decision) => decision.disposition === "manual-review",
        )
      )
        return failure("review", "ownership-review-required");
      return {
        status: "ready",
        adapterId,
        generationId: installed.state.generationId,
        generationFingerprint: seal.fingerprint,
        installStateFingerprint: installed.fingerprint,
        occurredAt,
        preview,
        previewFingerprint: this.projections.previewFingerprint(preview),
      };
    } catch {
      return failure("review", "unsafe-or-unreadable-exit-state");
    }
  }

  applyDetach(plan: DetachPlan): DetachApplyResult {
    try {
      if (
        plan.status !== "ready" ||
        this.projections.previewFingerprint(plan.preview) !==
          plan.previewFingerprint
      )
        return failure("review", "detach-preview-changed");
      const installs = new InstallStateStore(this.projectRoot);
      const current = installs.read();
      if (!current) return failure("conflict", "install-state-cas-mismatch");
      if (
        current.fingerprint !== plan.installStateFingerprint ||
        current.state.generationId !== plan.generationId
      )
        return failure("conflict", "install-state-cas-mismatch");
      const pendingAdapters = current.state.installedAdapters.map((adapter) =>
        adapter.id === plan.adapterId
          ? {
              ...adapter,
              status: "degraded" as const,
            }
          : adapter,
      );
      if (!pendingAdapters.some((adapter) => adapter.id === plan.adapterId))
        return failure("review", "adapter-identity-ambiguous-or-missing");
      const pending = installs.compareAndSwap(current.fingerprint, {
        ...current.state,
        status: aggregateInstallStatus(pendingAdapters),
        installedAdapters: pendingAdapters,
        updatedAt: plan.occurredAt,
      });
      const applied = this.projections.apply(plan.preview);
      if (applied.status !== "applied" && applied.status !== "already-applied")
        return mapApplyFailure(applied);

      const adapters = pending.state.installedAdapters.map((adapter) =>
        adapter.id === plan.adapterId
          ? {
              ...adapter,
              status: "detached" as const,
              lastProjectionFingerprint: applied.receipt.planFingerprint,
              reconciledAt: plan.occurredAt,
            }
          : adapter,
      );
      const next = installs.compareAndSwap(pending.fingerprint, {
        ...pending.state,
        status: aggregateInstallStatus(adapters),
        installedAdapters: adapters,
        updatedAt: plan.occurredAt,
      });
      const evidenceFingerprint = fingerprintPactileContractV1({
        previewFingerprint: plan.previewFingerprint,
        projectionFingerprint: applied.receipt.planFingerprint,
        installStateFingerprint: next.fingerprint,
      });
      const exitReceipt = writeExitReceipt(
        this.projectRoot,
        receipt(
          "detach",
          plan.generationId,
          null,
          [plan.adapterId],
          "applied",
          evidenceFingerprint,
          plan.occurredAt,
        ),
      );
      return {
        status: applied.status,
        adapterId: plan.adapterId,
        decisions: plan.preview.decisions,
        installState: next,
        receipt: exitReceipt,
      };
    } catch {
      return failure("interrupted", "detach-not-completed");
    }
  }

  uninstall(occurredAt = this.now()): UninstallResult {
    const installs = new InstallStateStore(this.projectRoot);
    let initial: InstallStateSnapshot | null;
    try {
      initial = installs.read();
    } catch {
      return {
        status: "degraded",
        reason: "unsafe-or-unreadable-exit-state",
        adapterIds: [],
        detachments: [],
        installState: null,
        receipt: null,
      };
    }
    if (!initial)
      return {
        status: "degraded",
        reason: "install-state-required",
        adapterIds: [],
        detachments: [],
        installState: null,
        receipt: null,
      };
    const adapterIds = initial.state.installedAdapters
      .filter((adapter) => adapter.status !== "detached")
      .map((adapter) => adapter.id)
      .sort(lexical);
    const detachments: DetachApplyResult[] = [];
    for (const adapterId of adapterIds) {
      const planned = this.planDetach(adapterId, occurredAt);
      if (planned.status !== "ready") {
        detachments.push(planned);
        const current = installs.read();
        return {
          status: "degraded",
          reason: planned.reason,
          adapterIds,
          detachments,
          installState: current,
          receipt: current
            ? writeExitReceipt(
                this.projectRoot,
                receipt(
                  "uninstall",
                  current.state.generationId,
                  null,
                  adapterIds,
                  "degraded",
                  fingerprintPactileContractV1({
                    adapterIds,
                    completed: detachments.length - 1,
                    reason: planned.reason,
                    installStateFingerprint: current.fingerprint,
                  }),
                  occurredAt,
                ),
              )
            : null,
        };
      }
      const applied = this.applyDetach(planned);
      detachments.push(applied);
      if ("reason" in applied) {
        const current = installs.read();
        return {
          status: "degraded",
          reason: applied.reason,
          adapterIds,
          detachments,
          installState: current,
          receipt: current
            ? writeExitReceipt(
                this.projectRoot,
                receipt(
                  "uninstall",
                  current.state.generationId,
                  null,
                  adapterIds,
                  "degraded",
                  fingerprintPactileContractV1({
                    adapterIds,
                    completed: detachments.length - 1,
                    reason: applied.reason,
                    installStateFingerprint: current.fingerprint,
                  }),
                  occurredAt,
                ),
              )
            : null,
        };
      }
    }

    let final = installs.read();
    if (!final)
      return {
        status: "degraded",
        reason: "install-state-required",
        adapterIds,
        detachments,
        installState: null,
        receipt: null,
      };
    if (final.state.status !== "inactive") {
      const nextAdapters = final.state.installedAdapters.map((adapter) => ({
        ...adapter,
        status: "detached" as const,
      }));
      final = installs.compareAndSwap(final.fingerprint, {
        ...final.state,
        status: "inactive",
        installedAdapters: nextAdapters,
        updatedAt: occurredAt,
      });
    }
    const evidenceFingerprint = fingerprintPactileContractV1({
      adapterIds,
      detachReceipts: detachments
        .filter(
          (
            result,
          ): result is Extract<
            DetachApplyResult,
            { status: "applied" | "already-applied" }
          > =>
            result.status === "applied" || result.status === "already-applied",
        )
        .map((result) => result.receipt.fingerprint),
      installStateFingerprint: final.fingerprint,
    });
    const uninstallReceipt = writeExitReceipt(
      this.projectRoot,
      receipt(
        "uninstall",
        final.state.generationId,
        null,
        adapterIds,
        "applied",
        evidenceFingerprint,
        occurredAt,
      ),
    );
    return {
      status: adapterIds.length === 0 ? "already-inactive" : "applied",
      adapterIds,
      detachments,
      installState: final,
      receipt: uninstallReceipt,
    };
  }

  planRollback(
    targetGenerationId: string,
    occurredAt = this.now(),
  ): RollbackPlanResult {
    try {
      if (!LOGICAL_ID.test(targetGenerationId))
        return failure("review", "invalid-generation-id");
      const installed = new InstallStateStore(this.projectRoot).read();
      if (!installed) return failure("review", "install-state-required");
      const generations = new GenerationStore(this.projectRoot);
      generations.verify(installed.state.generationId);
      const target = generations.verify(targetGenerationId);
      const planFingerprint = fingerprintPactileContractV1({
        action: "rollback",
        fromGenerationId: installed.state.generationId,
        toGenerationId: targetGenerationId,
        targetGenerationFingerprint: target.fingerprint,
        installStateFingerprint: installed.fingerprint,
      });
      return {
        status: "ready",
        fromGenerationId: installed.state.generationId,
        toGenerationId: targetGenerationId,
        targetGenerationFingerprint: target.fingerprint,
        installStateFingerprint: installed.fingerprint,
        occurredAt,
        planFingerprint,
        alreadyActive: installed.state.generationId === targetGenerationId,
      };
    } catch {
      return failure("review", "target-generation-unverified");
    }
  }

  async applyRollback(plan: RollbackPlan): Promise<RollbackApplyResult> {
    try {
      const installs = new InstallStateStore(this.projectRoot);
      const current = installs.read();
      if (!current) return failure("conflict", "install-state-cas-mismatch");
      if (
        current.fingerprint !== plan.installStateFingerprint ||
        current.state.generationId !== plan.fromGenerationId
      )
        return failure("conflict", "install-state-cas-mismatch");
      const generations = new GenerationStore(this.projectRoot);
      generations.verify(plan.fromGenerationId);
      const target = generations.verify(plan.toGenerationId);
      if (target.fingerprint !== plan.targetGenerationFingerprint)
        return failure("conflict", "target-generation-changed");

      // A rollback may be re-planned after an interrupted materialization,
      // leaving the install pointer already on the target generation while
      // the live managed view still reflects a newer one. Repair that view
      // even on the already-active fast path, using the sealed bytes only.
      const materializeTarget = (): void =>
        materializeCanonicalGeneration(this.projectRoot, {
          generationId: target.generationId,
          files: target.files,
          readFile: (relativePath) =>
            generations.readFile(target.generationId, relativePath),
          readFiles: (relativePaths) =>
            generations.readFiles(target.generationId, relativePaths),
        });

      if (plan.alreadyActive) {
        materializeTarget();
        const value = receipt(
          "rollback",
          plan.toGenerationId,
          plan.fromGenerationId,
          [],
          "applied",
          plan.planFingerprint,
          plan.occurredAt,
        );
        return {
          status: "already-active",
          fromGenerationId: plan.fromGenerationId,
          toGenerationId: plan.toGenerationId,
          installState: current,
          receipt: writeExitReceipt(this.projectRoot, value),
        };
      }

      const rollbackId = `exit.rollback.${digestIdentity({
        from: plan.fromGenerationId,
        to: plan.toGenerationId,
        state: current.fingerprint,
      })}`;
      const stagedAdapters = current.state.installedAdapters.map((adapter) =>
        adapter.status === "detached"
          ? adapter
          : { ...adapter, status: "degraded" as const },
      );
      let next = installs.compareAndSwap(current.fingerprint, {
        ...current.state,
        generationId: plan.toGenerationId,
        status: aggregateInstallStatus(stagedAdapters),
        installedAdapters: stagedAdapters,
        lastMigrationJournalId: rollbackId,
        updatedAt: plan.occurredAt,
      });

      const platforms = stagedAdapters
        .filter((adapter) => adapter.status !== "detached")
        .map((adapter) => platformForAdapter(adapter.id))
        .filter((platform): platform is PactilePlatform => platform !== null)
        .sort(lexical);
      let finalStatus: "applied" | "degraded" = stagedAdapters.some(
        (adapter) =>
          adapter.status !== "detached" &&
          platformForAdapter(adapter.id) === null,
      )
        ? "degraded"
        : "applied";
      if (platforms.length > 0) {
        const files = generations.readFiles(
          plan.toGenerationId,
          target.files.map((file) => file.path),
        );
        const reconciled = await runLifecycleCommand({
          projectRoot: this.projectRoot,
          operation: "reconcile",
          runtimeVersion: current.state.runtimeVersion,
          files: target.files.map((file) => ({
            path: file.path,
            bytes: files.get(file.path) ?? Buffer.alloc(0),
          })),
          platforms,
          occurredAt: plan.occurredAt,
          materializeCanonical: materializeTarget,
        });
        next = reconciled.installState ?? installs.read() ?? next;
        if (reconciled.status !== "completed") finalStatus = "degraded";
      } else {
        // Detached/unknown adapters still need the canonical target view;
        // there is no lifecycle Adapter lane that could invoke the callback.
        materializeTarget();
      }
      const value = receipt(
        "rollback",
        plan.toGenerationId,
        plan.fromGenerationId,
        stagedAdapters.map((adapter) => adapter.id),
        finalStatus === "applied" ? "applied" : "degraded",
        fingerprintPactileContractV1({
          planFingerprint: plan.planFingerprint,
          previousGenerationId: plan.fromGenerationId,
          targetGenerationFingerprint: target.fingerprint,
          installStateFingerprint: next.fingerprint,
        }),
        plan.occurredAt,
      );
      return {
        status: finalStatus,
        fromGenerationId: plan.fromGenerationId,
        toGenerationId: plan.toGenerationId,
        installState: next,
        receipt: writeExitReceipt(this.projectRoot, value),
      };
    } catch {
      return failure("interrupted", "rollback-not-completed");
    }
  }

  planPurge(occurredAt = this.now()): PurgePlanResult {
    try {
      const installed = new InstallStateStore(this.projectRoot).read();
      if (!installed) return failure("review", "install-state-required");
      if (
        installed.state.status !== "inactive" ||
        installed.state.installedAdapters.some(
          (adapter) => adapter.status !== "detached",
        )
      )
        return failure("review", "safe-uninstall-required-before-purge");
      new GenerationStore(this.projectRoot).verify(
        installed.state.generationId,
      );
      const ledger = this.projections.readLedger();
      if (ledger?.ledger.entries.some((entry) => entry.claimants.length > 0))
        return failure("review", "active-ownership-claims-remain");
      if (
        this.projections
          .readExternalClaims()
          .claims.some((claim) => claim.claimants.length > 0)
      )
        return failure("review", "active-external-claims-remain");
      const targets = inventoryCanonicalRoot(this.projectRoot);
      const manifestFingerprint = fingerprintPactileContractV1({
        action: "purge",
        targets,
      });
      return {
        status: "ready",
        generationId: installed.state.generationId,
        adapterIds: installed.state.installedAdapters
          .map((adapter) => adapter.id)
          .sort(lexical),
        targets,
        manifestFingerprint,
        occurredAt,
      };
    } catch {
      return failure("review", "unsafe-locked-or-malformed-purge-state");
    }
  }

  applyPurge(
    plan: PurgePlan,
    confirmationFingerprint: string,
  ): PurgeApplyResult {
    try {
      if (
        !FINGERPRINT.test(confirmationFingerprint) ||
        confirmationFingerprint !== plan.manifestFingerprint
      )
        return failure("review", "purge-confirmation-mismatch");
      const livePlan = this.planPurge(plan.occurredAt);
      if (
        livePlan.status !== "ready" ||
        livePlan.manifestFingerprint !== plan.manifestFingerprint ||
        !samePurgeTargets(livePlan.targets, plan.targets)
      )
        return failure("conflict", "purge-target-set-changed");

      const value = receipt(
        "purge",
        plan.generationId,
        null,
        plan.adapterIds,
        "applied",
        plan.manifestFingerprint,
        plan.occurredAt,
      );
      const finalReceipt = receiptSnapshot(value);
      // The second inventory above binds every byte to the confirmed manifest.
      // Move the whole canonical namespace out of service atomically before
      // recursive deletion so a mid-delete failure can never expose a partial
      // `.pactile` tree as if it were still a valid installation.
      const canonical = path.join(this.projectRoot, CANONICAL_ROOT);
      const tombstone = path.join(
        this.projectRoot,
        `${CANONICAL_ROOT}.purge-${randomUUID()}`,
      );
      if (fs.existsSync(tombstone)) throw new Error("purge-tombstone-conflict");
      const rootStat = fs.lstatSync(canonical);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new Error("unsafe-purge-root");
      fs.renameSync(canonical, tombstone);
      fs.rmSync(tombstone, { recursive: true, force: false });
      return {
        status: "applied",
        deletedTargets: plan.targets.length,
        receipt: finalReceipt,
      };
    } catch {
      return failure("interrupted", "purge-not-completed");
    }
  }
}

/** Narrow helper used by focused tests and callers that inspect one entry. */
export function entryHasAdapterClaim(
  entry: OwnershipLedgerEntryV1,
  adapterId: string,
): boolean {
  return entry.claimants.some((claimant) => claimant.id === adapterId);
}

export function generationFingerprint(seal: GenerationSeal): string {
  return seal.fingerprint;
}
