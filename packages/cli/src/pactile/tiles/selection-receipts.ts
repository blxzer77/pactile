import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
} from "../../core/index.js";
import {
  assertCanonicalWriteTarget,
  resolveCanonicalPaths,
} from "../runtime/paths.js";
import { buildTileCatalog, type TileCatalog } from "./catalog.js";
import {
  normalizeTileSelectionReplayInput,
  normalizeTileSelectionRequest,
  prepareTileSelection,
  replayTileSelectionDecision,
  replayTileSelectionDecisionFromOffer,
  sanitizeTileSelectionDecisionForOffer,
  sanitizeTileSelectionDecisionForReplay,
  type TileSelectionDecision,
  type TileSelectionDecisionReceipt,
  type TileSelectionFact,
  type TileSelectionRequest,
  type TileSelectionOffer,
} from "./selection.js";
import { TILE_COMPILER_ABI_VERSION, type TileDiagnostic } from "./loader.js";

const TILE_SELECTION_SNAPSHOT_SCHEMA_VERSION = 2 as const;
const TILE_SELECTION_SNAPSHOT_KIND = "pactile.tile-selection-replay" as const;
const MAX_TILE_SELECTION_SNAPSHOT_BYTES = 4 * 1024 * 1024;

interface TileSelectionSnapshotBody {
  readonly schemaVersion: typeof TILE_SELECTION_SNAPSHOT_SCHEMA_VERSION;
  readonly kind: typeof TILE_SELECTION_SNAPSHOT_KIND;
  readonly compilerAbiVersion: typeof TILE_COMPILER_ABI_VERSION;
  readonly projectFingerprint: string;
  readonly scopeFingerprint: string;
  readonly taskId: string;
  readonly catalogFingerprint: string;
  readonly offer: TileSelectionOffer;
  readonly request: TileSelectionRequest;
  readonly candidateFacts: readonly TileSelectionFact[];
  readonly decision: TileSelectionDecision;
  readonly offerFingerprint: string;
  readonly receipt: TileSelectionDecisionReceipt;
}

export interface TileSelectionSnapshotV2 extends TileSelectionSnapshotBody {
  readonly fingerprint: string;
}

export interface WrittenTileSelectionSnapshot {
  readonly fingerprint: string;
  readonly fileName: string;
}

export interface ReplayedTileSelectionSnapshot {
  readonly snapshotFingerprint: string;
  readonly offerFingerprint: string;
  readonly offer: TileSelectionOffer;
  readonly receipt: TileSelectionDecisionReceipt;
}

export type TileSelectionSnapshotResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly diagnostics: readonly TileDiagnostic[] };

function failure<T = never>(code: string): TileSelectionSnapshotResult<T> {
  return {
    success: false,
    diagnostics: [{ code, tileRef: null, relatedRef: null, path: "$.snapshot" }],
  };
}

function stableFilesystemPath(value: string): string {
  const resolved = fs.realpathSync.native(path.resolve(value)).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function projectFingerprint(projectRoot: string): string {
  return fingerprintPactileContractV1({
    schemaVersion: 1,
    kind: "pactile.tile-selection.project-scope",
    root: stableFilesystemPath(projectRoot),
  });
}

function receiptTarget(projectRoot: string, fingerprint: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint))
    throw new Error("tile-selection-snapshot-fingerprint-invalid");
  const target = path.join(
    resolveCanonicalPaths(projectRoot).receiptsPath,
    `tile-selection-${fingerprint.slice(7)}.json`,
  );
  return assertCanonicalWriteTarget(projectRoot, target);
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && left.equals(right);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalizePactileJsonV1(left) === canonicalizePactileJsonV1(right);
}

function ensureNoExistingConflict(target: string, expected: Buffer): boolean {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TILE_SELECTION_SNAPSHOT_BYTES)
      throw new Error("tile-selection-snapshot-unsafe-existing-file");
    if (!sameBytes(fs.readFileSync(target), expected))
      throw new Error("tile-selection-snapshot-conflict");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function completeSnapshot(body: TileSelectionSnapshotBody): TileSelectionSnapshotV2 {
  return { ...body, fingerprint: fingerprintPactileContractV1(body) };
}

/**
 * Persist the normalized Task decision and immutable compiler inputs. This is
 * intentionally called only by the current-Task registry seam, which supplies
 * the bundled catalog rather than caller-authored Skill bodies.
 */
export function writeTileSelectionSnapshot(
  projectRoot: string,
  catalog: TileCatalog,
  request: TileSelectionRequest,
  facts: readonly TileSelectionFact[],
  decision: TileSelectionDecision,
  receipt: TileSelectionDecisionReceipt,
): TileSelectionSnapshotResult<WrittenTileSelectionSnapshot> {
  try {
    const expectedProjectFingerprint = projectFingerprint(projectRoot);
    const checkedCatalog = buildTileCatalog(catalog.entries);
    if (!checkedCatalog.success) return checkedCatalog;
    const normalized = normalizeTileSelectionReplayInput(
      checkedCatalog.data,
      request,
      facts,
    );
    if (!normalized.success) return normalized;
    const taskLifecycle = normalized.data.request.taskLifecycle;
    if (
      taskLifecycle?.projectFingerprint !== expectedProjectFingerprint ||
      !taskLifecycle?.scopeFingerprint ||
      taskLifecycle.taskId.length === 0
    )
      return failure("tile-selection-snapshot-task-scope-mismatch");
    const safeDecision = sanitizeTileSelectionDecisionForReplay(
      checkedCatalog.data,
      normalized.data.request,
      normalized.data.facts,
      decision,
    );
    if (!safeDecision.success) return safeDecision;
    const replayed = replayTileSelectionDecision(
      checkedCatalog.data,
      normalized.data.request,
      normalized.data.facts,
      safeDecision.data,
    );
    if (
      !replayed.success ||
      replayed.data.fingerprint !== receipt.fingerprint ||
      replayed.data.offerFingerprint !== receipt.offerFingerprint
    )
      return failure("tile-selection-snapshot-receipt-mismatch");
    const offer = prepareTileSelection(
      checkedCatalog.data,
      normalized.data.request,
      normalized.data.facts,
    );
    if (!offer.success || offer.data.offer.fingerprint !== receipt.offerFingerprint)
      return failure("tile-selection-snapshot-offer-mismatch");

    const offeredRefs = new Set(offer.data.offer.candidates.flatMap((candidate) => [
      candidate.ref,
      ...candidate.dependencyClosure,
    ]));
    const candidateFacts = normalized.data.facts.filter((fact) => offeredRefs.has(fact.ref));
    if (candidateFacts.length !== offeredRefs.size)
      return failure("tile-selection-snapshot-offer-mismatch");

    const body: TileSelectionSnapshotBody = {
      schemaVersion: TILE_SELECTION_SNAPSHOT_SCHEMA_VERSION,
      kind: TILE_SELECTION_SNAPSHOT_KIND,
      compilerAbiVersion: TILE_COMPILER_ABI_VERSION,
      projectFingerprint: expectedProjectFingerprint,
      scopeFingerprint: taskLifecycle.scopeFingerprint,
      taskId: taskLifecycle.taskId,
      catalogFingerprint: checkedCatalog.data.fingerprint,
      offer: offer.data.offer,
      request: normalized.data.request,
      candidateFacts,
      decision: safeDecision.data,
      offerFingerprint: receipt.offerFingerprint,
      receipt,
    };
    const snapshot = completeSnapshot(body);
    const bytes = Buffer.from(canonicalizePactileJsonV1(snapshot), "utf8");
    if (bytes.byteLength > MAX_TILE_SELECTION_SNAPSHOT_BYTES)
      return failure("tile-selection-snapshot-size-limit");

    const target = receiptTarget(projectRoot, snapshot.fingerprint);
    const parent = assertCanonicalWriteTarget(projectRoot, path.dirname(target));
    fs.mkdirSync(parent, { recursive: true });
    assertCanonicalWriteTarget(projectRoot, parent);
    if (ensureNoExistingConflict(target, bytes))
      return {
        success: true,
        data: {
          fingerprint: snapshot.fingerprint,
          fileName: path.basename(target),
        },
      };

    const temporary = assertCanonicalWriteTarget(
      projectRoot,
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
        return failure("tile-selection-snapshot-unsafe-target");
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      assertCanonicalWriteTarget(projectRoot, target);
      assertCanonicalWriteTarget(projectRoot, temporary);
      try {
        fs.linkSync(temporary, target);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          if (ensureNoExistingConflict(target, bytes))
            return {
              success: true,
              data: {
                fingerprint: snapshot.fingerprint,
                fileName: path.basename(target),
              },
            };
        }
        throw error;
      }
      fs.unlinkSync(temporary);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch {
        // An unexpected residue remains discoverable and is never replaced.
      }
    }
    return {
      success: true,
      data: {
        fingerprint: snapshot.fingerprint,
        fileName: path.basename(target),
      },
    };
  } catch {
    return failure("tile-selection-snapshot-write-failed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSnapshot(projectRoot: string, fingerprint: string): TileSelectionSnapshotResult<TileSelectionSnapshotV2> {
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint))
    return failure("tile-selection-snapshot-fingerprint-invalid");
  try {
    const target = receiptTarget(projectRoot, fingerprint);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TILE_SELECTION_SNAPSHOT_BYTES)
      return failure("tile-selection-snapshot-unsafe-target");
    const bytes = fs.readFileSync(target);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed) || canonicalizePactileJsonV1(parsed) !== bytes.toString("utf8"))
      return failure("tile-selection-snapshot-malformed");
    const { fingerprint: storedFingerprint, ...body } = parsed;
    if (
      storedFingerprint !== fingerprint ||
      fingerprintPactileContractV1(body) !== fingerprint ||
      parsed.schemaVersion !== TILE_SELECTION_SNAPSHOT_SCHEMA_VERSION ||
      parsed.kind !== TILE_SELECTION_SNAPSHOT_KIND ||
      parsed.compilerAbiVersion !== TILE_COMPILER_ABI_VERSION ||
      parsed.projectFingerprint !== projectFingerprint(projectRoot)
    )
      return failure("tile-selection-snapshot-identity-mismatch");
    return { success: true, data: parsed as unknown as TileSelectionSnapshotV2 };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return failure("tile-selection-snapshot-not-found");
    return failure("tile-selection-snapshot-read-failed");
  }
}

/** Replay against the matching installed catalog; the snapshot has no hidden manifests or Skill bodies. */
export function replayTileSelectionSnapshot(
  projectRoot: string,
  fingerprint: string,
  sourceCatalog: TileCatalog,
): TileSelectionSnapshotResult<ReplayedTileSelectionSnapshot> {
  const loaded = readSnapshot(projectRoot, fingerprint);
  if (!loaded.success) return loaded;
  const snapshot = loaded.data;
  try {
    const catalog = buildTileCatalog(sourceCatalog.entries);
    if (!catalog.success || catalog.data.fingerprint !== snapshot.catalogFingerprint ||
      catalog.data.fingerprint !== snapshot.receipt.catalogFingerprint)
      return failure("tile-selection-snapshot-historical-catalog-unavailable");
    const lifecycle = snapshot.request.taskLifecycle;
    if (
      lifecycle?.projectFingerprint !== snapshot.projectFingerprint ||
      lifecycle.scopeFingerprint !== snapshot.scopeFingerprint ||
      lifecycle.taskId !== snapshot.taskId
    )
      return failure("tile-selection-snapshot-task-scope-mismatch");
    const normalized = normalizeTileSelectionRequest(catalog.data, snapshot.request);
    if (
      !normalized.success ||
      !sameJson(normalized.data, snapshot.request) ||
      !isRecord(snapshot.offer) ||
      snapshot.offer.fingerprint !== snapshot.offerFingerprint ||
      snapshot.offer.catalogFingerprint !== snapshot.catalogFingerprint ||
      snapshot.offer.inputFingerprint !== snapshot.receipt.inputFingerprint ||
      snapshot.receipt.offerFingerprint !== snapshot.offerFingerprint
    )
      return failure("tile-selection-snapshot-input-mismatch");
    const safeDecision = sanitizeTileSelectionDecisionForOffer(snapshot.offer, snapshot.decision);
    if (!safeDecision.success || !sameJson(safeDecision.data, snapshot.decision))
      return failure("tile-selection-snapshot-decision-mismatch");
    const replayed = replayTileSelectionDecisionFromOffer(
      catalog.data,
      normalized.data,
      snapshot.offer,
      snapshot.candidateFacts,
      snapshot.decision,
    );
    if (!replayed.success || replayed.data.fingerprint !== snapshot.receipt.fingerprint ||
      !sameJson(replayed.data, snapshot.receipt))
      return failure("tile-selection-snapshot-replay-mismatch");
    return {
      success: true,
      data: {
        snapshotFingerprint: fingerprint,
        offerFingerprint: snapshot.offer.fingerprint,
        offer: snapshot.offer,
        receipt: replayed.data,
      },
    };
  } catch {
    return failure("tile-selection-snapshot-replay-failed");
  }
}
