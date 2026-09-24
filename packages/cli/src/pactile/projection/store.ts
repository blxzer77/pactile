import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalizePactileJsonV1,
  fingerprintPactileContractV1,
} from "../../core/index.js";
import {
  canonicalOwnershipLedger,
  fingerprintBytes,
  MAX_PROJECTION_BYTES,
  planProjection,
  reduceExternalBindingClaims,
  type ExternalBindingClaim,
  type ProjectionInputs,
  type ProjectionPreview,
  type ProjectionPreviewResult,
} from "./planner.js";
import { parseProjectionJson } from "./structured-merge.js";

const LEDGER = ".pactile/runtime/ownership-ledger.json";
const EXTERNAL_CLAIMS = ".pactile/runtime/external-claims.json";
const JOURNAL = ".pactile/runtime/projection-transaction.json";
const LOCK = ".pactile/runtime/projection.lock";
const fpSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const EMPTY_EXTERNAL_CLAIMS_FINGERPRINT = fingerprintPactileContractV1({
  version: 1,
  claims: [],
});
const stepSchema = z
  .object({
    targetPath: z.string(),
    before: fpSchema.nullable(),
    after: fpSchema.nullable(),
    stagePath: z.string().nullable(),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    planFingerprint: fpSchema,
    receiptPath: z.string(),
    steps: z.array(stepSchema),
  })
  .strict();
const receiptSchema = z
  .object({
    version: z.literal(1),
    planFingerprint: fpSchema,
    ledgerFingerprint: fpSchema,
    // B2 receipts predate durable external claims. They are compatible only
    // with the canonical empty claim view for the verified Adapter; a claim
    // belonging to that Adapter still requires an explicit fingerprint and
    // therefore cannot be silently laundered.
    externalClaimsFingerprint: fpSchema.default(
      EMPTY_EXTERNAL_CLAIMS_FINGERPRINT,
    ),
    decisions: z.array(
      z
        .object({
          operationId: z.string().min(1),
          resourceId: z.string().min(1),
          disposition: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
type Step = z.infer<typeof stepSchema>;
const externalClaimSchema = z
  .object({
    resourceId: z.string().min(1),
    externalAssetId: z.string().min(1),
    claimants: z.array(z.string().min(1)),
  })
  .strict();
const externalClaimsSchema = z
  .object({
    version: z.literal(1),
    claims: z.array(externalClaimSchema),
  })
  .strict();
export interface ProjectionReceipt {
  readonly version: 1;
  readonly planFingerprint: string;
  readonly ledgerFingerprint: string;
  readonly externalClaimsFingerprint: string;
  readonly decisions: ProjectionPreview["decisions"];
}
export type ProjectionApplyResult =
  | {
      readonly status: "applied" | "already-applied";
      readonly receipt: ProjectionReceipt;
      readonly externalClaims: readonly ExternalBindingClaim[];
    }
  | {
      readonly status: "review" | "conflict" | "busy" | "interrupted";
      readonly reason: string;
    };
export type ProjectionVerificationResult =
  | {
      readonly status: "applied";
      readonly receipt: ProjectionReceipt;
      readonly externalClaims: readonly ExternalBindingClaim[];
    }
  | {
      readonly status: "drift" | "review" | "conflict";
      readonly reason: string;
    };
/** Test/embedding fault seam. Never serialized; callbacks receive no content or asset identity. */
export interface ProjectionStoreOptions {
  readonly fault?: (
    phase: "before-journal" | "after-journal" | "after-write",
    index: number,
  ) => void;
}

function relativeSafe(relative: string): boolean {
  return (
    !!relative &&
    !relative.includes("\\") &&
    !relative.includes(":") &&
    !path.posix.isAbsolute(relative) &&
    relative
      .split("/")
      .every(
        (part) =>
          !!part &&
          part !== "." &&
          part !== ".." &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
          !/[<>"|?*]/.test(part) &&
          ![...part].some((character) => character.charCodeAt(0) < 32) &&
          !/[. ]$/.test(part),
      )
  );
}
const identity = (value: string): string =>
  path.resolve(value).replace(/\\/g, "/").toLowerCase();
function parseStored(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes))
    throw new Error("invalid-state-encoding");
  return parseProjectionJson(text);
}

function receiptMatches(bytes: Buffer, expected: ProjectionReceipt): boolean {
  const parsed = receiptSchema.safeParse(parseStored(bytes));
  return (
    parsed.success &&
    canonicalizePactileJsonV1(parsed.data) ===
      canonicalizePactileJsonV1(expected)
  );
}

function canonicalExternalClaims(value: unknown): {
  readonly claims: readonly ExternalBindingClaim[];
  readonly fingerprint: string;
  readonly bytes: Buffer;
} {
  const parsed = externalClaimsSchema.parse(value);
  const claims = reduceExternalBindingClaims(parsed.claims, []);
  const state = { version: 1 as const, claims };
  const serialized = canonicalizePactileJsonV1(state);
  return {
    claims,
    fingerprint: fingerprintPactileContractV1(state),
    bytes: Buffer.from(serialized),
  };
}

/**
 * Return the durable external-claim view that belongs to one Adapter.
 *
 * External claims are shared state, so a sibling Adapter may add or release
 * its own claimant without changing this Adapter's projection. Canonicalize
 * the filtered view with only the requested claimant before hashing; retaining
 * sibling claimant ids here would make every sibling change look like drift.
 */
function canonicalExternalClaimsForAdapter(
  claims: readonly ExternalBindingClaim[],
  adapterId: string,
): {
  readonly claims: readonly ExternalBindingClaim[];
  readonly fingerprint: string;
} {
  const scoped = claims
    .filter((claim) => claim.claimants.includes(adapterId))
    .map((claim) => ({
      resourceId: claim.resourceId,
      externalAssetId: claim.externalAssetId,
      claimants: [adapterId],
    }));
  return canonicalExternalClaims({ version: 1, claims: scoped });
}

/** Single cooperative writer. Rejects namespace links; not a hostile OS rename sandbox. */
export class ProjectionStore {
  readonly root: string;
  private readonly inspected = new WeakMap<ProjectionPreview, string>();
  constructor(
    root: string,
    private readonly options: ProjectionStoreOptions = {},
  ) {
    this.root = path.resolve(root);
    if (!fs.statSync(this.root).isDirectory())
      throw new Error("projection-root-not-directory");
    this.assertSafe(this.root);
  }
  private absolute(relative: string): string {
    if (!relativeSafe(relative)) throw new Error("unsafe-projection-path");
    const result = path.resolve(this.root, ...relative.split("/"));
    if (!identity(result).startsWith(identity(this.root) + "/"))
      throw new Error("unsafe-projection-path");
    return result;
  }
  private assertSafe(absolute: string): void {
    const parsed = path.parse(absolute);
    let cursor = parsed.root;
    for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
      cursor = path.join(cursor, part);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new Error("unsafe-projection-link");
    }
  }
  private read(relative: string): Buffer | null {
    const absolute = this.absolute(relative);
    this.assertSafe(absolute);
    let fd: number;
    try {
      fd = fs.openSync(absolute, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const opened = fs.fstatSync(fd),
        visible = fs.lstatSync(absolute);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.ino !== visible.ino ||
        opened.dev !== visible.dev ||
        visible.isSymbolicLink()
      )
        throw new Error("unsafe-opened-projection-file");
      this.assertSafe(absolute);
      if (opened.size > MAX_PROJECTION_BYTES)
        throw new Error("projection-file-too-large");
      const bytes = fs.readFileSync(fd);
      if (bytes.byteLength > MAX_PROJECTION_BYTES)
        throw new Error("projection-file-too-large");
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  }
  private ensureParent(relative: string): void {
    const absolute = this.absolute(relative),
      parent = path.dirname(absolute);
    this.assertSafe(parent);
    fs.mkdirSync(parent, { recursive: true });
    this.assertSafe(parent);
  }
  private create(relative: string, bytes: Uint8Array): void {
    if (bytes.byteLength > MAX_PROJECTION_BYTES)
      throw new Error("projection-file-too-large");
    this.ensureParent(relative);
    const absolute = this.absolute(relative);
    this.assertSafe(absolute);
    const fd = fs.openSync(absolute, "wx", 0o600);
    let owned: fs.Stats | undefined;
    try {
      owned = fs.fstatSync(fd);
      if (!owned.isFile() || owned.nlink !== 1)
        throw new Error("unsafe-created-projection-file");
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch (error) {
      // close may throw either before or after releasing the descriptor.
      try {
        fs.closeSync(fd);
      } catch {
        /* Preserve the original failure. */
      }
      if (owned) {
        this.assertSafe(absolute);
        const visible = fs.lstatSync(absolute);
        if (
          visible.ino !== owned.ino ||
          visible.dev !== owned.dev ||
          visible.nlink !== 1 ||
          !visible.isFile()
        )
          throw new Error("unsafe-incomplete-projection-stage");
        this.remove(relative);
      }
      throw error;
    }
  }
  private remove(relative: string): void {
    const absolute = this.absolute(relative);
    this.assertSafe(absolute);
    try {
      fs.unlinkSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private withLock<T>(action: () => T): T {
    this.ensureParent(LOCK);
    this.assertSafe(this.absolute(LOCK));
    let fd: number;
    try {
      fd = fs.openSync(this.absolute(LOCK), "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("projection-busy");
      throw error;
    }
    const owned = fs.fstatSync(fd);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      fs.fsyncSync(fd);
      return action();
    } finally {
      fs.closeSync(fd);
      const visible = fs.lstatSync(this.absolute(LOCK));
      if (
        visible.ino === owned.ino &&
        visible.dev === owned.dev &&
        visible.nlink === 1 &&
        !visible.isSymbolicLink()
      )
        this.remove(LOCK);
    }
  }
  inspect(
    input: Omit<ProjectionInputs, "ledger" | "observe">,
  ): ProjectionPreviewResult {
    try {
      if (this.read(JOURNAL))
        return { status: "review", reason: "pending-projection-recovery" };
      const bytes = this.read(LEDGER);
      const result = planProjection({
        ...input,
        ledger: bytes === null ? null : parseStored(bytes),
        observe: (target) => this.read(target),
        externalClaims: this.readExternalClaims().claims,
      });
      if (result.status === "ready")
        this.inspected.set(result, this.previewFingerprint(result));
      return result;
    } catch {
      return {
        status: "review",
        reason: "unsafe-or-unreadable-projection-state",
      };
    }
  }
  readLedger(): ReturnType<typeof canonicalOwnershipLedger> | null {
    const bytes = this.read(LEDGER);
    return bytes ? canonicalOwnershipLedger(parseStored(bytes)) : null;
  }
  readExternalClaims(): {
    readonly claims: readonly ExternalBindingClaim[];
    readonly fingerprint: string;
  } {
    const bytes = this.read(EXTERNAL_CLAIMS);
    const state = canonicalExternalClaims(
      bytes ? parseStored(bytes) : { version: 1, claims: [] },
    );
    return { claims: state.claims, fingerprint: state.fingerprint };
  }
  /**
   * Read-only proof that a previously inspected projection still matches its
   * durable receipt, ownership ledger and current host bytes.
   */
  verifyApplied(preview: ProjectionPreview): ProjectionVerificationResult {
    try {
      if (this.inspected.get(preview) !== this.previewFingerprint(preview))
        return { status: "review", reason: "unrecognized-or-modified-preview" };
      preview = structuredClone(preview);
      const ledger = canonicalOwnershipLedger(preview.ledger);
      const external = canonicalExternalClaims({
        version: 1,
        claims: preview.externalClaims,
      });
      const scopedExternal = canonicalExternalClaimsForAdapter(
        external.claims,
        preview.adapterId,
      );
      const receipt: ProjectionReceipt = {
        version: 1,
        planFingerprint: preview.planFingerprint,
        ledgerFingerprint: ledger.fingerprint,
        externalClaimsFingerprint: scopedExternal.fingerprint,
        decisions: preview.decisions,
      };
      const oldReceipt = this.read(this.receiptPath(preview.planFingerprint));
      if (!oldReceipt)
        return { status: "drift", reason: "projection-receipt-missing" };
      if (!receiptMatches(oldReceipt, receipt))
        return { status: "conflict", reason: "receipt-identity-conflict" };
      if (
        this.readLedger()?.fingerprint !== ledger.fingerprint ||
        canonicalExternalClaimsForAdapter(
          this.readExternalClaims().claims,
          preview.adapterId,
        ).fingerprint !== scopedExternal.fingerprint ||
        preview.observations.some((item) => {
          const mutation = preview.mutations.find(
            (candidate) => candidate.targetPath === item.targetPath,
          );
          const expected = mutation
            ? mutation.bytes === null
              ? null
              : fingerprintBytes(mutation.bytes)
            : item.fingerprint;
          return this.fingerprint(item.targetPath) !== expected;
        })
      )
        return { status: "drift", reason: "applied-state-drift" };
      return {
        status: "applied",
        receipt,
        externalClaims: external.claims,
      };
    } catch {
      return {
        status: "review",
        reason: "unsafe-or-unreadable-projection-state",
      };
    }
  }
  /**
   * Verify the durable receipt and every ledger-owned host surface currently
   * claimed by one Adapter. Sibling claim changes may evolve the global ledger
   * without invalidating this Adapter's already-applied projection.
   */
  verifyAdapterState(
    adapterId: string,
    projectionFingerprint: string | null,
  ): ProjectionVerificationResult {
    try {
      if (
        !projectionFingerprint ||
        !fpSchema.safeParse(projectionFingerprint).success
      )
        return { status: "drift", reason: "projection-receipt-missing" };
      const receiptBytes = this.read(this.receiptPath(projectionFingerprint));
      if (!receiptBytes)
        return { status: "drift", reason: "projection-receipt-missing" };
      const parsedReceipt = receiptSchema.safeParse(parseStored(receiptBytes));
      if (
        !parsedReceipt.success ||
        parsedReceipt.data.planFingerprint !== projectionFingerprint
      )
        return { status: "conflict", reason: "receipt-identity-conflict" };
      const ledger = this.readLedger();
      if (!ledger)
        return { status: "drift", reason: "ownership-ledger-missing" };
      const external = this.readExternalClaims();
      if (
        canonicalExternalClaimsForAdapter(external.claims, adapterId)
          .fingerprint !== parsedReceipt.data.externalClaimsFingerprint
      )
        return { status: "drift", reason: "external-claim-state-drift" };
      const byResource = new Map(
        ledger.ledger.entries.map((entry) => [entry.resourceId, entry]),
      );
      for (const decision of parsedReceipt.data.decisions) {
        if (decision.disposition === "preserve-borrowed") {
          const claim = external.claims.find(
            (item) => item.resourceId === decision.resourceId,
          );
          if (!claim?.claimants.includes(adapterId))
            return { status: "drift", reason: "adapter-claim-missing" };
          continue;
        }
        const entry = byResource.get(decision.resourceId);
        if (!entry?.claimants.some((claimant) => claimant.id === adapterId))
          return { status: "drift", reason: "adapter-claim-missing" };
      }
      for (const entry of ledger.ledger.entries) {
        if (!entry.claimants.some((claimant) => claimant.id === adapterId))
          continue;
        const expected =
          entry.current.state === "present" ? entry.current.fingerprint : null;
        if (this.fingerprint(entry.targetPath) !== expected)
          return { status: "drift", reason: "applied-state-drift" };
      }
      return {
        status: "applied",
        receipt: parsedReceipt.data,
        externalClaims: external.claims.filter((claim) =>
          claim.claimants.includes(adapterId),
        ),
      };
    } catch {
      return {
        status: "review",
        reason: "unsafe-or-unreadable-projection-state",
      };
    }
  }
  private fingerprint(relative: string): string | null {
    const bytes = this.read(relative);
    return bytes === null ? null : fingerprintBytes(bytes);
  }
  private receiptPath(fingerprint: string): string {
    if (!fpSchema.safeParse(fingerprint).success)
      throw new Error("invalid-plan-fingerprint");
    return `.pactile/runtime/receipts/projection-${fingerprint.slice(7)}.json`;
  }
  private decodeJournal(bytes: Buffer): Journal {
    const journal = journalSchema.parse(parseStored(bytes));
    if (
      journal.receiptPath !== this.receiptPath(journal.planFingerprint) ||
      journal.steps.length < 3 ||
      journal.steps.at(-3)?.targetPath !== EXTERNAL_CLAIMS ||
      journal.steps.at(-2)?.targetPath !== LEDGER ||
      journal.steps.at(-1)?.targetPath !== journal.receiptPath
    )
      throw new Error("invalid-projection-journal");
    const identities = new Set<string>();
    for (const step of journal.steps) {
      if (
        !relativeSafe(step.targetPath) ||
        identities.has(identity(this.absolute(step.targetPath)))
      )
        throw new Error("invalid-projection-journal-target");
      identities.add(identity(this.absolute(step.targetPath)));
      if (
        ![EXTERNAL_CLAIMS, LEDGER, journal.receiptPath].includes(
          step.targetPath,
        ) &&
        step.targetPath
          .split("/")
          .some((part) =>
            [".pactile", ".cstl", ".trellis"].includes(
              part.normalize("NFC").toLowerCase(),
            ),
          )
      )
        throw new Error("invalid-projection-journal-target");
      if (
        step.stagePath !==
        (step.after === null
          ? null
          : `${step.targetPath}.pactile-${journal.id}.tmp`)
      )
        throw new Error("invalid-projection-stage");
    }
    return journal;
  }
  private finish(journal: Journal): void {
    // Preflight the entire remaining transaction before another host write.
    for (const step of journal.steps) {
      const current = this.fingerprint(step.targetPath);
      if (current !== step.before && current !== step.after)
        throw new Error("projection-recovery-cas");
      if (step.stagePath) {
        const staged = this.fingerprint(step.stagePath);
        if (
          (current !== step.after && staged !== step.after) ||
          (staged !== null && staged !== step.after)
        )
          throw new Error("projection-stage-corrupt");
      }
    }
    for (const [index, step] of journal.steps.entries()) {
      const current = this.fingerprint(step.targetPath);
      if (current !== step.after) {
        if (current !== step.before) throw new Error("projection-recovery-cas");
        if (step.stagePath) {
          if (this.fingerprint(step.stagePath) !== step.after)
            throw new Error("projection-stage-corrupt");
          this.assertSafe(this.absolute(step.targetPath));
          fs.renameSync(
            this.absolute(step.stagePath),
            this.absolute(step.targetPath),
          );
        } else this.remove(step.targetPath);
      }
      this.options.fault?.("after-write", index);
    }
    for (const step of journal.steps)
      if (step.stagePath) {
        const staged = this.fingerprint(step.stagePath);
        if (staged !== null && staged !== step.after)
          throw new Error("projection-stage-corrupt");
        this.remove(step.stagePath);
      }
    this.remove(JOURNAL);
  }
  apply(preview: ProjectionPreview): ProjectionApplyResult {
    try {
      if (this.inspected.get(preview) !== this.previewFingerprint(preview))
        return { status: "review", reason: "unrecognized-or-modified-preview" };
      preview = structuredClone(preview);
      return this.withLock(() => {
        if (this.read(JOURNAL))
          return {
            status: "review",
            reason: "pending-projection-recovery",
          } as const;
        const ledger = canonicalOwnershipLedger(preview.ledger);
        const external = canonicalExternalClaims({
          version: 1,
          claims: preview.externalClaims,
        });
        const scopedExternal = canonicalExternalClaimsForAdapter(
          external.claims,
          preview.adapterId,
        );
        const receipt: ProjectionReceipt = {
          version: 1,
          planFingerprint: preview.planFingerprint,
          ledgerFingerprint: ledger.fingerprint,
          externalClaimsFingerprint: scopedExternal.fingerprint,
          decisions: preview.decisions,
        };
        const receiptPath = this.receiptPath(preview.planFingerprint),
          oldReceipt = this.read(receiptPath);
        if (oldReceipt) {
          if (!receiptMatches(oldReceipt, receipt))
            return {
              status: "conflict",
              reason: "receipt-identity-conflict",
            } as const;
          if (
            this.readLedger()?.fingerprint !== ledger.fingerprint ||
            canonicalExternalClaimsForAdapter(
              this.readExternalClaims().claims,
              preview.adapterId,
            ).fingerprint !== scopedExternal.fingerprint ||
            preview.observations.some((item) => {
              const mutation = preview.mutations.find(
                (candidate) => candidate.targetPath === item.targetPath,
              );
              const expected = mutation
                ? mutation.bytes === null
                  ? null
                  : fingerprintBytes(mutation.bytes)
                : item.fingerprint;
              return this.fingerprint(item.targetPath) !== expected;
            })
          )
            return {
              status: "conflict",
              reason: "applied-state-drift",
            } as const;
          return {
            status: "already-applied",
            receipt,
            externalClaims: external.claims,
          } as const;
        }
        if (
          (this.readLedger()?.fingerprint ?? null) !==
            preview.expectedLedgerFingerprint ||
          preview.observations.some(
            (item) => this.fingerprint(item.targetPath) !== item.fingerprint,
          )
        )
          return {
            status: "conflict",
            reason: "projection-cas-mismatch",
          } as const;
        const id = randomUUID(),
          steps: Step[] = [];
        const payloads = [
          ...preview.mutations.map((mutation) => ({ ...mutation })),
          {
            targetPath: EXTERNAL_CLAIMS,
            before: this.fingerprint(EXTERNAL_CLAIMS),
            bytes: external.bytes,
          },
          {
            targetPath: LEDGER,
            before: this.fingerprint(LEDGER),
            bytes: Buffer.from(canonicalizePactileJsonV1(ledger.ledger)),
          },
          {
            targetPath: receiptPath,
            before: null,
            bytes: Buffer.from(canonicalizePactileJsonV1(receipt)),
          },
        ];
        let recorded = false;
        try {
          for (const payload of payloads) {
            const stagePath =
              payload.bytes === null
                ? null
                : `${payload.targetPath}.pactile-${id}.tmp`;
            if (stagePath && payload.bytes)
              this.create(stagePath, payload.bytes);
            steps.push({
              targetPath: payload.targetPath,
              before: payload.before,
              after:
                payload.bytes === null ? null : fingerprintBytes(payload.bytes),
              stagePath,
            });
          }
          const journal: Journal = {
            version: 1,
            id,
            planFingerprint: preview.planFingerprint,
            receiptPath,
            steps,
          };
          this.decodeJournal(Buffer.from(JSON.stringify(journal)));
          this.options.fault?.("before-journal", -1);
          if (
            preview.observations.some(
              (item) => this.fingerprint(item.targetPath) !== item.fingerprint,
            )
          )
            throw new Error("projection-target-race");
          const journalStage = `${JOURNAL}.${id}.tmp`;
          this.create(
            journalStage,
            Buffer.from(canonicalizePactileJsonV1(journal)),
          );
          try {
            this.assertSafe(this.absolute(JOURNAL));
            if (this.read(JOURNAL)) throw new Error("projection-journal-race");
            fs.renameSync(this.absolute(journalStage), this.absolute(JOURNAL));
            recorded = true;
          } finally {
            this.remove(journalStage);
          }
          this.options.fault?.("after-journal", -1);
          this.finish(journal);
          return {
            status: "applied",
            receipt,
            externalClaims: external.claims,
          } as const;
        } finally {
          if (!recorded)
            for (const step of steps)
              if (step.stagePath) this.remove(step.stagePath);
        }
      });
    } catch (error) {
      return {
        status:
          error instanceof Error && error.message === "projection-busy"
            ? "busy"
            : "interrupted",
        reason: "projection-apply-not-completed",
      };
    }
  }
  /** Explicit roll-forward only. A divergent target or damaged stage requires human review. */
  recover(): {
    status: "recovered" | "no-pending" | "review" | "busy";
    reason?: string;
  } {
    try {
      return this.withLock(() => {
        const bytes = this.read(JOURNAL);
        if (!bytes) return { status: "no-pending" } as const;
        this.finish(this.decodeJournal(bytes));
        return { status: "recovered" } as const;
      });
    } catch (error) {
      return {
        status:
          error instanceof Error && error.message === "projection-busy"
            ? "busy"
            : "review",
        reason: "projection-recovery-not-completed",
      };
    }
  }
  /** Hash of a preview for callers that keep immutable previews across an approval boundary. */
  previewFingerprint(preview: ProjectionPreview): string {
    return fingerprintPactileContractV1({
      planFingerprint: preview.planFingerprint,
      adapterId: preview.adapterId,
      expectedLedgerFingerprint: preview.expectedLedgerFingerprint,
      ledger: preview.ledger,
      observations: preview.observations,
      decisions: preview.decisions,
      externalClaims: preview.externalClaims,
      mutations: preview.mutations.map((item) => ({
        targetPath: item.targetPath,
        before: item.before,
        after: item.bytes === null ? null : fingerprintBytes(item.bytes),
      })),
    });
  }
}
