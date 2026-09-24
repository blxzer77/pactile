import { createHash } from "node:crypto";
import {
  fingerprintPactileContractV1,
  parseOwnershipLedgerV1,
  parseProjectionPlanV1,
  type OwnershipClaimantV1,
  type OwnershipLedgerEntryV1,
  type OwnershipLedgerV1,
  type OwnershipSnapshotV1,
  type ProjectionOperationV1,
} from "../../core/index.js";
import { mergeManagedBlock } from "./managed-block.js";
import {
  mergeJsonPointers,
  mergeTomlKeys,
  type TomlOwnedKey,
} from "./structured-merge.js";

export const fingerprintBytes = (bytes: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** Shared accepted artifact/output and persisted-file limit; includes stage recovery. */
export const MAX_PROJECTION_BYTES = 16 * 1024 * 1024;
export interface ProjectionContent {
  readonly bytes: Uint8Array;
  readonly ownedJsonPointers?: readonly string[];
  readonly ownedTomlKeys?: readonly TomlOwnedKey[];
}
/** Immutable artifact resolver. Specs belong to referenced artifacts, never extra fields on M0 operations. */
export type ContentResolver = (contentRef: string) => ProjectionContent;
export interface ExternalBindingClaim {
  readonly resourceId: string;
  readonly externalAssetId: string;
  readonly claimants: readonly string[];
}
export interface ProjectionMutation {
  readonly targetPath: string;
  readonly before: string | null;
  readonly bytes: Uint8Array | null;
}
export interface ProjectionDecision {
  readonly operationId: string;
  readonly resourceId: string;
  readonly disposition: string;
}
export interface ProjectionPreview {
  readonly status: "ready";
  /** Adapter identity carried from the validated plan for adapter-scoped receipts. */
  readonly adapterId: string;
  readonly planFingerprint: string;
  readonly expectedLedgerFingerprint: string | null;
  readonly ledger: OwnershipLedgerV1;
  readonly mutations: readonly ProjectionMutation[];
  readonly observations: readonly {
    targetPath: string;
    fingerprint: string | null;
  }[];
  readonly decisions: readonly ProjectionDecision[];
  /** Pure-plan state; ProjectionStore persists only claim identities, never bodies. */
  readonly externalClaims: readonly ExternalBindingClaim[];
}
export type ProjectionPreviewResult =
  | ProjectionPreview
  | { readonly status: "review" | "conflict"; readonly reason: string };
export interface ProjectionInputs {
  readonly plan: unknown;
  readonly ledger: unknown | null;
  readonly canonicalFingerprint: string;
  readonly updatedAt: string;
  readonly observe: (targetPath: string) => Uint8Array | null;
  readonly resolveContent: ContentResolver;
  readonly externalClaims?: readonly ExternalBindingClaim[];
}
const absent: OwnershipSnapshotV1 = {
  state: "absent",
  fingerprint: null,
  contentRef: null,
};
const snapshot = (
  bytes: Uint8Array | null,
  contentRef: string | null = null,
): OwnershipSnapshotV1 =>
  bytes === null
    ? absent
    : { state: "present", fingerprint: fingerprintBytes(bytes), contentRef };
const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalOwnershipLedger(input: unknown): {
  ledger: OwnershipLedgerV1;
  fingerprint: string;
} {
  const parsed = parseOwnershipLedgerV1(input);
  if (!parsed.success) throw new Error("invalid-ownership-ledger");
  const ledger: OwnershipLedgerV1 = {
    ...parsed.data,
    entries: [...parsed.data.entries]
      .sort((a, b) => lexical(a.resourceId, b.resourceId))
      .map((entry) => ({
        ...entry,
        claimants: [...entry.claimants].sort((a, b) => lexical(a.id, b.id)),
      })),
  };
  return { ledger, fingerprint: fingerprintPactileContractV1(ledger) };
}

/** Pure external-ref reducer. It cannot receive an asset path or filesystem writer. */
export function reduceExternalBindingClaims(
  input: readonly ExternalBindingClaim[],
  operations: readonly ProjectionOperationV1[],
): readonly ExternalBindingClaim[] {
  const claims = new Map<string, ExternalBindingClaim>();
  for (const item of input) {
    if (
      !item.resourceId ||
      !item.externalAssetId ||
      claims.has(item.resourceId) ||
      new Set(item.claimants).size !== item.claimants.length ||
      item.claimants.some((id) => !id)
    )
      throw new Error("invalid-binding-claims");
    claims.set(item.resourceId, {
      ...item,
      claimants: [...item.claimants].sort(lexical),
    });
  }
  for (const op of operations) {
    if (
      !["bind", "detach"].includes(op.action) ||
      op.control !== "borrowed" ||
      op.format !== "external-ref" ||
      op.targetPath !== null ||
      !op.externalAssetId
    )
      throw new Error("invalid-binding-operation");
    const previous = claims.get(op.resourceId);
    if (previous && previous.externalAssetId !== op.externalAssetId)
      throw new Error("external-binding-conflict");
    const ids = new Set(previous?.claimants ?? []);
    if (op.action === "bind") ids.add(op.claimantId);
    else ids.delete(op.claimantId);
    // Empty entries retain asset identity for deterministic reclaim; they never authorize deletion.
    claims.set(op.resourceId, {
      resourceId: op.resourceId,
      externalAssetId: op.externalAssetId,
      claimants: [...ids].sort(lexical),
    });
  }
  return [...claims.values()].sort((a, b) =>
    lexical(a.resourceId, b.resourceId),
  );
}

function utf8(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes),
    text = buffer.toString("utf8");
  if (!Buffer.from(text).equals(buffer)) throw new Error("invalid-utf8");
  return text;
}

function onlyGeneratedBytes(
  entry: OwnershipLedgerEntryV1,
  resolve: ContentResolver,
): string | null {
  if (!entry.generated.contentRef) return null;
  const content = resolve(entry.generated.contentRef),
    desired = utf8(content.bytes);
  if (
    entry.format === "text" ||
    (entry.format === "json" && !content.ownedJsonPointers?.length) ||
    (entry.format === "toml" && !content.ownedTomlKeys?.length)
  )
    return fingerprintBytes(content.bytes);
  const result =
    entry.format === "json"
      ? mergeJsonPointers("{}", null, desired, content.ownedJsonPointers ?? [])
      : entry.format === "toml"
        ? mergeTomlKeys("", null, desired, content.ownedTomlKeys ?? [])
        : entry.format === "managed-block"
          ? mergeManagedBlock("", null, desired)
          : null;
  return result?.status === "merged" ? fingerprintBytes(result.text) : null;
}

/** Read-only planning. A single ambiguous operation rejects the complete transaction. */
export function planProjection(
  input: ProjectionInputs,
): ProjectionPreviewResult {
  try {
    const resolveContent: ContentResolver = (ref) => {
      const content = input.resolveContent(ref);
      if (content.bytes.byteLength > MAX_PROJECTION_BYTES)
        throw new Error("projection-file-too-large");
      return content;
    };
    const parsed = parseProjectionPlanV1(input.plan);
    if (!parsed.success)
      return { status: "review", reason: "invalid-projection-plan" };
    const plan = parsed.data;
    if (plan.canonicalFingerprint !== input.canonicalFingerprint)
      return { status: "conflict", reason: "canonical-cas-mismatch" };
    const previous =
      input.ledger === null ? null : canonicalOwnershipLedger(input.ledger);
    if (plan.expectedLedgerFingerprint !== (previous?.fingerprint ?? null))
      return { status: "conflict", reason: "ledger-cas-mismatch" };
    const entries = new Map(
      (previous?.ledger.entries ?? []).map((entry) => [
        entry.resourceId,
        entry,
      ]),
    );
    const mutations: ProjectionMutation[] = [],
      decisions: ProjectionDecision[] = [],
      observations: { targetPath: string; fingerprint: string | null }[] = [];
    const externalOps = plan.operations.filter(
      (op) => op.format === "external-ref",
    );
    const externalClaims = reduceExternalBindingClaims(
      input.externalClaims ?? [],
      externalOps,
    );
    for (const op of plan.operations) {
      if (op.format === "external-ref") {
        decisions.push({
          operationId: op.id,
          resourceId: op.resourceId,
          disposition: "preserve-borrowed",
        });
        continue;
      }
      if (op.format === "directory")
        return {
          status: "review",
          reason: "directory-requires-explicit-child-plan",
        };
      const targetPath = op.targetPath;
      if (!targetPath)
        return { status: "review", reason: "missing-target-path" };
      const currentBytes = input.observe(targetPath),
        current = snapshot(currentBytes);
      observations.push({ targetPath, fingerprint: current.fingerprint });
      if (op.expectedCurrentFingerprint !== current.fingerprint)
        return { status: "conflict", reason: "target-cas-mismatch" };
      const existing = entries.get(op.resourceId);
      if (
        existing &&
        (existing.targetPath !== targetPath || existing.format !== op.format)
      )
        return { status: "review", reason: "resource-identity-conflict" };
      if (
        [...entries.values()].some(
          (entry) =>
            entry.resourceId !== op.resourceId &&
            entry.targetPath.normalize("NFC").toLowerCase() ===
              targetPath.normalize("NFC").toLowerCase(),
        )
      )
        return { status: "review", reason: "physical-target-conflict" };
      const claimant: OwnershipClaimantV1 = {
        id: op.claimantId,
        kind: "adapter",
        adapterId: plan.adapterId,
      };
      const former = existing?.claimants.find(
        (item) => item.id === claimant.id,
      );
      if (
        former &&
        (former.kind !== claimant.kind ||
          former.adapterId !== claimant.adapterId)
      )
        return { status: "review", reason: "claimant-identity-conflict" };
      const claimants = new Map(
        (existing?.claimants ?? []).map((item) => [item.id, item]),
      );
      if (op.action === "remove") claimants.delete(claimant.id);
      else claimants.set(claimant.id, claimant);
      let entry: OwnershipLedgerEntryV1 = existing
        ? {
            ...existing,
            current,
            claimants: [...claimants.values()],
            conflict: "none",
            disposition: "no-op",
          }
        : {
            resourceId: op.resourceId,
            targetPath,
            format: op.format,
            origin: currentBytes === null ? "created" : "adopted",
            control: "pactile-owned",
            // Ownership belongs to the Pactile projection layer; Adapter
            // participation is represented separately by claimants. Keeping
            // this identity stable makes Cursor/Codex install order semantic.
            owner: { kind: "pactile", id: "pactile" },
            claimants: [...claimants.values()],
            preimage: current,
            generated: absent,
            current,
            conflict: "none",
            disposition: "no-op",
          };
      if (op.action === "remove") {
        if (!existing)
          return { status: "review", reason: "unrecorded-removal" };
        if (entry.control === "borrowed")
          entry = { ...entry, disposition: "preserve-borrowed" };
        else if (entry.control === "unknown")
          entry = {
            ...entry,
            conflict: "ownership-unknown",
            disposition: "manual-review",
          };
        else if (
          current.state === "present" &&
          entry.generated.state === "present" &&
          current.fingerprint !== entry.generated.fingerprint
        )
          entry = {
            ...entry,
            conflict: "modified",
            disposition: "preserve-modified",
          };
        else if (
          !claimants.size &&
          entry.origin === "created" &&
          current.state === "present" &&
          current.fingerprint === entry.generated.fingerprint &&
          onlyGeneratedBytes(entry, resolveContent) ===
            entry.generated.fingerprint
        ) {
          mutations.push({
            targetPath,
            before: current.fingerprint,
            bytes: null,
          });
          // Persist the post-apply state, not a destructive intent masquerading as current reality.
          entry = { ...entry, current: absent, generated: absent };
          decisions.push({
            operationId: op.id,
            resourceId: op.resourceId,
            disposition: "remove-generated",
          });
        }
      } else {
        if (entry.control !== "pactile-owned" || op.control !== "pactile-owned")
          return { status: "review", reason: "ownership-not-established" };
        if (!op.contentRef)
          return { status: "review", reason: "missing-content-reference" };
        // The existing generated fingerprint is durable evidence of absorbed
        // foreign bytes. Never replace that evidence with a later pure result:
        // without a v1 provenance field, further writes require explicit review.
        if (
          existing?.origin === "created" &&
          existing.generated.state === "present" &&
          existing.generated.contentRef &&
          onlyGeneratedBytes(existing, resolveContent) !==
            existing.generated.fingerprint
        )
          return {
            status: "review",
            reason: "foreign-provenance-requires-review",
          };
        const content = resolveContent(op.contentRef);
        if (fingerprintBytes(content.bytes) !== op.desiredFingerprint)
          return { status: "conflict", reason: "content-fingerprint-mismatch" };
        const priorContent = existing?.generated.contentRef
          ? resolveContent(existing.generated.contentRef)
          : null;
        if (
          priorContent &&
          (JSON.stringify(priorContent.ownedJsonPointers ?? []) !==
            JSON.stringify(content.ownedJsonPointers ?? []) ||
            JSON.stringify(priorContent.ownedTomlKeys ?? []) !==
              JSON.stringify(content.ownedTomlKeys ?? []))
        )
          return { status: "review", reason: "owned-scope-change" };
        if (
          existing?.generated.state === "present" &&
          !priorContent &&
          op.action === "merge"
        )
          return { status: "review", reason: "missing-owned-baseline" };
        if (
          [...claimants.keys()].some((id) => id !== claimant.id) &&
          existing?.generated.state === "present" &&
          (priorContent
            ? fingerprintBytes(priorContent.bytes)
            : existing.generated.fingerprint) !== op.desiredFingerprint
        )
          return { status: "review", reason: "claimant-content-conflict" };
        let nextBytes: Uint8Array;
        if (op.action === "merge") {
          const now =
              currentBytes === null
                ? op.format === "json"
                  ? "{}"
                  : ""
                : utf8(currentBytes),
            old = priorContent ? utf8(priorContent.bytes) : null,
            next = utf8(content.bytes);
          const merged =
            op.format === "json"
              ? mergeJsonPointers(
                  now,
                  old,
                  next,
                  content.ownedJsonPointers ?? [],
                )
              : op.format === "toml"
                ? mergeTomlKeys(now, old, next, content.ownedTomlKeys ?? [])
                : mergeManagedBlock(now, old, next);
          if (merged.status !== "merged") return merged;
          nextBytes = Buffer.from(merged.text);
        } else {
          if (
            currentBytes !== null &&
            current.fingerprint !== op.desiredFingerprint &&
            (entry.origin !== "created" ||
              current.fingerprint !== entry.generated.fingerprint ||
              onlyGeneratedBytes(entry, resolveContent) !== current.fingerprint)
          )
            return { status: "review", reason: "whole-file-not-owned" };
          nextBytes = Buffer.from(content.bytes);
        }
        if (nextBytes.byteLength > MAX_PROJECTION_BYTES)
          return { status: "review", reason: "projection-file-too-large" };
        const generated = snapshot(nextBytes, op.contentRef);
        if (current.fingerprint !== generated.fingerprint)
          mutations.push({
            targetPath,
            before: current.fingerprint,
            bytes: nextBytes,
          });
        entry = {
          ...entry,
          generated,
          current: generated,
          disposition: "no-op",
        };
      }
      entries.set(entry.resourceId, entry);
      if (!decisions.some((item) => item.operationId === op.id))
        decisions.push({
          operationId: op.id,
          resourceId: op.resourceId,
          disposition: mutations.some((item) => item.targetPath === targetPath)
            ? "write-generated"
            : entry.disposition,
        });
    }
    let ledger = canonicalOwnershipLedger({
      schemaVersion: 1,
      generationId: plan.generationId,
      updatedAt: input.updatedAt,
      entries: [...entries.values()],
    }).ledger;
    // Repeating a no-op does not churn timestamps or the CAS fingerprint.
    if (
      previous?.fingerprint ===
      fingerprintPactileContractV1({
        ...ledger,
        updatedAt: previous?.ledger.updatedAt ?? input.updatedAt,
      })
    )
      ledger = previous.ledger;
    return {
      status: "ready",
      adapterId: plan.adapterId,
      planFingerprint: parsed.fingerprint,
      expectedLedgerFingerprint: previous?.fingerprint ?? null,
      ledger,
      mutations,
      observations,
      decisions,
      externalClaims,
    };
  } catch {
    return {
      status: "review",
      reason: "unsafe-or-unavailable-projection-input",
    };
  }
}
