import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectionOperationV1 } from "../../../src/core/index.js";
import { ProjectionStore } from "../../../src/pactile/projection/store.js";
import { fingerprintBytes } from "../../../src/pactile/projection/planner.js";
import {
  canonical,
  operation,
  plan,
  ready,
  resolveContent,
  timestamp,
} from "./fixtures.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "p45-ledger-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const target = () => path.join(root, "AGENTS.md");
const input = (
  store: ProjectionStore,
  op = operation(),
  adapter = "adapter-a",
) => ({
  plan: plan(op, store.readLedger()?.fingerprint ?? null, adapter),
  canonicalFingerprint: canonical,
  updatedAt: timestamp,
  resolveContent,
});
const inspect = (
  store: ProjectionStore,
  op = operation(),
  adapter = "adapter-a",
) => ready(store.inspect(input(store, op, adapter)));
const claim = (store: ProjectionStore, id = "adapter-a") =>
  operation({
    claimantId: id,
    expectedCurrentFingerprint: fs.existsSync(target())
      ? fingerprintBytes(fs.readFileSync(target()))
      : null,
  });
const release = (store: ProjectionStore, id = "adapter-a") => ({
  ...claim(store, id),
  action: "remove" as const,
  contentRef: null,
  desiredFingerprint: null,
});
describe("projection transaction store", () => {
  it("inspect writes nothing; apply and replay are idempotent; forged or edited preview is rejected", () => {
    const store = new ProjectionStore(root),
      preview = inspect(store);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(store.apply({ ...preview })).toMatchObject({ status: "review" });
    expect(store.apply(preview).status).toBe("applied");
    expect(store.apply(preview).status).toBe("already-applied");
    expect(fs.readFileSync(target(), "utf8")).toBe("generated\n");
    const next = inspect(store, claim(store));
    expect(next.mutations).toEqual([]);
    (next.mutations as unknown[]).push({
      targetPath: "foreign.txt",
      before: null,
      bytes: Buffer.from("bad"),
    });
    expect(store.apply(next)).toMatchObject({ status: "review" });
    expect(fs.existsSync(path.join(root, "foreign.txt"))).toBe(false);
  });
  it("verifies an applied receipt without writes and reports later host drift", () => {
    const store = new ProjectionStore(root);
    const preview = inspect(store);
    expect(store.apply(preview).status).toBe("applied");
    const before = fs.readFileSync(
      path.join(root, ".pactile/runtime/ownership-ledger.json"),
    );
    expect(store.verifyApplied(preview)).toMatchObject({ status: "applied" });
    expect(
      fs.readFileSync(
        path.join(root, ".pactile/runtime/ownership-ledger.json"),
      ),
    ).toEqual(before);

    fs.appendFileSync(target(), "user edit\n");
    expect(store.verifyApplied(preview)).toEqual({
      status: "drift",
      reason: "applied-state-drift",
    });
    expect(store.verifyApplied({ ...preview })).toEqual({
      status: "review",
      reason: "unrecognized-or-modified-preview",
    });
  });
  it("accepts a B2 receipt only as the canonical empty external-claim state", () => {
    const store = new ProjectionStore(root);
    const preview = inspect(store);
    const applied = store.apply(preview);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error(JSON.stringify(applied));
    const receiptPath = path.join(
      root,
      ".pactile/runtime/receipts",
      `projection-${applied.receipt.planFingerprint.slice(7)}.json`,
    );
    const legacyReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    delete legacyReceipt.externalClaimsFingerprint;
    fs.writeFileSync(receiptPath, JSON.stringify(legacyReceipt));

    expect(store.verifyApplied(preview)).toMatchObject({ status: "applied" });
    expect(
      store.verifyAdapterState("adapter-a", applied.receipt.planFingerprint),
    ).toMatchObject({ status: "applied" });
    expect(store.apply(preview).status).toBe("already-applied");
  });
  it("verifies one Adapter from its durable receipt while sibling claims evolve", () => {
    const store = new ProjectionStore(root);
    const first = inspect(store);
    const applied = store.apply(first);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error(JSON.stringify(applied));
    expect(
      store.verifyAdapterState("adapter-a", applied.receipt.planFingerprint),
    ).toMatchObject({ status: "applied" });

    expect(
      store.apply(inspect(store, claim(store, "adapter-b"), "adapter-b"))
        .status,
    ).toBe("applied");
    expect(
      store.verifyAdapterState("adapter-a", applied.receipt.planFingerprint),
    ).toMatchObject({ status: "applied" });

    fs.appendFileSync(target(), "user edit\n");
    expect(
      store.verifyAdapterState("adapter-a", applied.receipt.planFingerprint),
    ).toEqual({ status: "drift", reason: "applied-state-drift" });
  });
  it("claims two, releases one, deletes last unmodified created file, and reclaims", () => {
    const store = new ProjectionStore(root);
    expect(store.apply(inspect(store)).status).toBe("applied");
    expect(
      store.apply(inspect(store, claim(store, "adapter-b"), "adapter-b"))
        .status,
    ).toBe("applied");
    expect(store.readLedger()?.ledger.entries[0].claimants).toHaveLength(2);
    const one = inspect(store, release(store));
    expect(one.mutations).toEqual([]);
    expect(store.apply(one).status).toBe("applied");
    expect(fs.existsSync(target())).toBe(true);
    const last = inspect(store, release(store, "adapter-b"), "adapter-b");
    expect(last.decisions[0].disposition).toBe("remove-generated");
    expect(store.apply(last).status).toBe("applied");
    expect(store.apply(last).status).toBe("already-applied");
    expect(fs.existsSync(target())).toBe(false);
    expect(store.apply(inspect(store)).status).toBe("applied");
    expect(fs.existsSync(target())).toBe(true);
  });
  it("preserves a user-modified created file after last release", () => {
    const store = new ProjectionStore(root);
    store.apply(inspect(store));
    fs.appendFileSync(target(), "foreign addition\r\n");
    const preview = inspect(store, release(store));
    expect(preview.mutations).toEqual([]);
    expect(preview.decisions[0].disposition).toBe("preserve-modified");
    expect(store.apply(preview).status).toBe("applied");
    expect(fs.readFileSync(target(), "utf8")).toContain("foreign addition");
  });
  it("does not let one claimant change another claimant's generated content", () => {
    const store = new ProjectionStore(root);
    store.apply(inspect(store));
    const op = {
      ...claim(store, "adapter-b"),
      contentRef: "text-v2",
      desiredFingerprint: fingerprintBytes(resolveContent("text-v2").bytes),
    };
    expect(store.inspect(input(store, op, "adapter-b"))).toMatchObject({
      status: "review",
      reason: "claimant-content-conflict",
    });
  });
  it("updates JSON foreign regions losslessly and never deletes foreign bytes laundered through generated state", () => {
    const store = new ProjectionStore(root);
    const json = (ref: string): ProjectionOperationV1 =>
      operation({
        action: "merge",
        format: "json",
        contentRef: ref,
        desiredFingerprint: fingerprintBytes(resolveContent(ref).bytes),
        expectedCurrentFingerprint: fs.existsSync(target())
          ? fingerprintBytes(fs.readFileSync(target()))
          : null,
      });
    expect(store.apply(inspect(store, json("json-v1"))).status).toBe("applied");
    fs.writeFileSync(target(), '\ufeff{ "owned":1, "foreign" : 2 }\r\n');
    expect(store.apply(inspect(store, json("json-v2"))).status).toBe("applied");
    expect(fs.readFileSync(target(), "utf8")).toBe(
      '\ufeff{ "owned":2, "foreign" : 2 }\r\n',
    );
    const remove = { ...release(store), format: "json" as const };
    const preview = inspect(store, remove);
    expect(preview.mutations).toEqual([]);
    store.apply(preview);
    expect(fs.readFileSync(target(), "utf8")).toContain('"foreign" : 2');
  });
  it("preserves adopted whole files and denies owned divergence in adopted JSON", () => {
    fs.writeFileSync(target(), "generated\n");
    const store = new ProjectionStore(root);
    store.apply(inspect(store, claim(store)));
    expect(store.readLedger()?.ledger.entries[0].origin).toBe("adopted");
    const preview = inspect(store, release(store));
    expect(preview.mutations).toEqual([]);
    store.apply(preview);
    expect(fs.readFileSync(target(), "utf8")).toBe("generated\n");
  });
  it("cannot convert a foreign-preserving merge into a whole-file overwrite", () => {
    const store = new ProjectionStore(root);
    const merge = (ref: string): ProjectionOperationV1 =>
      operation({
        action: "merge",
        format: "json",
        contentRef: ref,
        desiredFingerprint: fingerprintBytes(resolveContent(ref).bytes),
        expectedCurrentFingerprint: fs.existsSync(target())
          ? fingerprintBytes(fs.readFileSync(target()))
          : null,
      });
    store.apply(inspect(store, merge("json-v1")));
    fs.writeFileSync(target(), '{"owned":1,"foreign":true}');
    store.apply(inspect(store, merge("json-v2")));
    expect(
      store.inspect(input(store, { ...merge("json-v1"), action: "ensure" }))
        .status,
    ).toBe("review");
    expect(fs.readFileSync(target(), "utf8")).toContain('"foreign":true');
  });
  it("review F1 cannot regain deletion or overwrite proof after foreign bytes are removed", () => {
    let store = new ProjectionStore(root);
    const merge = (ref: string): ProjectionOperationV1 =>
      operation({
        action: "merge",
        format: "json",
        contentRef: ref,
        desiredFingerprint: fingerprintBytes(resolveContent(ref).bytes),
        expectedCurrentFingerprint: fs.existsSync(target())
          ? fingerprintBytes(fs.readFileSync(target()))
          : null,
      });
    expect(store.apply(inspect(store, merge("json-v1"))).status).toBe(
      "applied",
    );
    fs.writeFileSync(target(), '{"owned":1,"foreign":true}');
    expect(store.apply(inspect(store, merge("json-v2"))).status).toBe(
      "applied",
    );
    // Reload from durable ledger; no process-local provenance flag may carry the proof.
    store = new ProjectionStore(root);
    fs.writeFileSync(target(), '{"owned":2}');
    const later = store.inspect(input(store, merge("json-v1")));
    // If automatic merging cannot retain the proof, review before replacing it is safe.
    if (later.status === "ready") store.apply(later);
    const releasePreview = inspect(store, {
      ...release(store),
      format: "json",
    });
    expect(releasePreview.mutations).toEqual([]);
    expect(store.apply(releasePreview).status).toBe("applied");
    expect(fs.readFileSync(target(), "utf8")).toBe('{"owned":2}');
    expect(later.status).toBe("review");
    expect(
      store.inspect(input(store, { ...merge("json-v1"), action: "ensure" }))
        .status,
    ).toBe("review");
  });
  it("CAS target and ledger races are rejected without overwriting either", () => {
    const store = new ProjectionStore(root),
      first = inspect(store),
      stale = inspect(store);
    expect(store.apply(first).status).toBe("applied");
    fs.appendFileSync(target(), "user");
    expect(store.apply(stale).status).toBe("conflict");
    expect(fs.readFileSync(target(), "utf8")).toContain("user");
    const update = inspect(store, release(store));
    const ledgerPath = path.join(
      root,
      ".pactile/runtime/ownership-ledger.json",
    );
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    ledger.updatedAt = "2026-09-09T01:00:00.000Z";
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    expect(store.apply(update).status).toBe("conflict");
    expect(fs.readFileSync(target(), "utf8")).toContain("user");
  });
  it("rejects stale target CAS at inspect", () => {
    const store = new ProjectionStore(root);
    fs.writeFileSync(target(), "foreign");
    expect(store.inspect(input(store))).toMatchObject({
      status: "conflict",
      reason: "target-cas-mismatch",
    });
  });
  it("review F5 rejects resolved artifacts over 16 MiB before any filesystem write", () => {
    const store = new ProjectionStore(root);
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 97);
    const op = operation({ desiredFingerprint: fingerprintBytes(bytes) });
    expect(
      store.inspect({ ...input(store, op), resolveContent: () => ({ bytes }) })
        .status,
    ).toBe("review");
    expect(fs.readdirSync(root)).toEqual([]);
    expect(store.recover().status).toBe("no-pending");
    expect(
      fs
        .readdirSync(root, { recursive: true })
        .filter((name) => String(name).endsWith(".tmp")),
    ).toEqual([]);
  });
  it.each([16 * 1024 * 1024 - 1, 16 * 1024 * 1024])(
    "review F5 accepts and recovers the %i byte boundary",
    (length) => {
      const bytes = Buffer.alloc(length, 97);
      const store = new ProjectionStore(root, {
        fault: (phase) => {
          if (phase === "after-journal")
            throw new Error("injected-interruption");
        },
      });
      const op = operation({ desiredFingerprint: fingerprintBytes(bytes) });
      const preview = ready(
        store.inspect({
          ...input(store, op),
          resolveContent: () => ({ bytes }),
        }),
      );
      expect(fs.readdirSync(root)).toEqual([]);
      expect(store.apply(preview).status).toBe("interrupted");
      const clean = new ProjectionStore(root);
      expect(clean.recover().status).toBe("recovered");
      expect(fs.statSync(target()).size).toBe(length);
      expect(fs.readFileSync(target()).equals(bytes)).toBe(true);
      expect(clean.recover().status).toBe("no-pending");
      expect(
        fs
          .readdirSync(root, { recursive: true })
          .filter((name) => String(name).endsWith(".tmp")),
      ).toEqual([]);
    },
  );
  it("review F5 also bounds merged output when current and desired are individually within limit", () => {
    const current = Buffer.alloc(16 * 1024 * 1024, 97);
    fs.writeFileSync(target(), current);
    const bytes = Buffer.from(
      "<!-- PACTILE:START -->\nowned\n<!-- PACTILE:END -->",
    );
    const store = new ProjectionStore(root);
    const op = operation({
      action: "merge",
      format: "managed-block",
      desiredFingerprint: fingerprintBytes(bytes),
      expectedCurrentFingerprint: fingerprintBytes(current),
    });
    expect(
      store.inspect({ ...input(store, op), resolveContent: () => ({ bytes }) })
        .status,
    ).toBe("review");
    expect(fs.readdirSync(root)).toEqual(["AGENTS.md"]);
    expect(fs.readFileSync(target()).equals(current)).toBe(true);
  });
  it("rejects invalid UTF-8 instead of laundering bytes through replacement characters", () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x7b]);
    fs.writeFileSync(target(), bytes);
    const store = new ProjectionStore(root),
      op = operation({
        action: "merge",
        format: "json",
        contentRef: "json-v1",
        desiredFingerprint: fingerprintBytes(resolveContent("json-v1").bytes),
        expectedCurrentFingerprint: fingerprintBytes(bytes),
      });
    expect(store.inspect(input(store, op)).status).toBe("review");
    expect(fs.readFileSync(target())).toEqual(bytes);
  });
  it("rejects duplicate or non-UTF8 canonical ledger state without rewriting it", () => {
    const store = new ProjectionStore(root);
    store.apply(inspect(store));
    const ledgerPath = path.join(
        root,
        ".pactile/runtime/ownership-ledger.json",
      ),
      original = fs.readFileSync(ledgerPath);
    const duplicated = original
      .toString()
      .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    fs.writeFileSync(ledgerPath, duplicated);
    expect(
      store.inspect({
        plan: plan(operation()),
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        resolveContent,
      }).status,
    ).toBe("review");
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(duplicated);
    const broken = Buffer.from(original);
    broken[broken.indexOf("text-v1")] = 0xff;
    fs.writeFileSync(ledgerPath, broken);
    expect(
      store.inspect({
        plan: plan(operation()),
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        resolveContent,
      }).status,
    ).toBe("review");
    expect(fs.readFileSync(ledgerPath)).toEqual(broken);
  });
  it("directories require explicit child plans, with all foreign children preserved", () => {
    fs.mkdirSync(path.join(root, "skills"));
    fs.writeFileSync(path.join(root, "skills/foreign.md"), "foreign");
    const store = new ProjectionStore(root);
    expect(
      store.inspect(
        input(store, operation({ targetPath: "skills", format: "directory" })),
      ).status,
    ).toBe("review");
    expect(fs.readFileSync(path.join(root, "skills/foreign.md"), "utf8")).toBe(
      "foreign",
    );
  });
  it("serializes cooperative concurrent writers with a lock and never reclaims an unknown lock", () => {
    const store = new ProjectionStore(root),
      preview = inspect(store);
    fs.mkdirSync(path.join(root, ".pactile/runtime"), { recursive: true });
    const lock = path.join(root, ".pactile/runtime/projection.lock");
    fs.writeFileSync(lock, "foreign-lock");
    expect(store.apply(preview).status).toBe("busy");
    expect(fs.readFileSync(lock, "utf8")).toBe("foreign-lock");
    expect(fs.existsSync(target())).toBe(false);
  });
  it("a competing store cannot enter while the first transaction owns the lock", () => {
    const second = new ProjectionStore(root),
      competing = inspect(second);
    let observed = "";
    const first = new ProjectionStore(root, {
      fault: (phase) => {
        if (phase === "before-journal")
          observed = second.apply(competing).status;
      },
    });
    expect(first.apply(inspect(first)).status).toBe("applied");
    expect(observed).toBe("busy");
    expect(second.apply(competing).status).toBe("already-applied");
  });
  it.each(["before-journal", "after-journal", "after-write"] as const)(
    "recovers or cleanly diagnoses interrupted %s",
    (phase) => {
      let tripped = false;
      const store = new ProjectionStore(root, {
        fault: (point) => {
          if (point === phase && !tripped) {
            tripped = true;
            throw new Error("injected");
          }
        },
      });
      const preview = inspect(store);
      expect(store.apply(preview).status).toBe("interrupted");
      const clean = new ProjectionStore(root);
      if (phase === "before-journal") {
        expect(fs.existsSync(target())).toBe(false);
        expect(clean.recover().status).toBe("no-pending");
      } else {
        expect(clean.inspect(input(clean)).status).toBe("review");
        expect(clean.recover().status).toBe("recovered");
        expect(fs.readFileSync(target(), "utf8")).toBe("generated\n");
        expect(clean.readLedger()).not.toBeNull();
      }
      expect(clean.recover().status).toBe("no-pending");
    },
  );
  it.each(
    ["payload", "journal"].flatMap((stageKind) =>
      ["open", "write", "fsync", "close", "close-before"].map((failure) => ({
        stageKind,
        failure,
      })),
    ),
  )(
    "review F2 removes incomplete $stageKind stages after $failure failure",
    ({ stageKind, failure }) => {
      let stageFd = -1,
        tripped = false;
      const open = fs.openSync,
        write = fs.writeFileSync,
        sync = fs.fsyncSync,
        close = fs.closeSync;
      vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
        const selected =
          String(file).endsWith(".tmp") &&
          (stageKind === "journal"
            ? String(file).includes("projection-transaction.json.")
            : String(file).includes("AGENTS.md.pactile-"));
        if (selected && failure === "open" && !tripped) {
          tripped = true;
          throw new Error("injected-stage-open");
        }
        const fd = open(file, flags, mode);
        if (selected) stageFd = fd;
        return fd;
      });
      vi.spyOn(fs, "writeFileSync").mockImplementation(
        (file, data, options) => {
          if (failure === "write" && file === stageFd && !tripped) {
            tripped = true;
            write(file, Buffer.from(data as Uint8Array).subarray(0, 3));
            throw new Error("injected-stage-write");
          }
          return write(file, data, options);
        },
      );
      vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (failure === "fsync" && fd === stageFd && !tripped) {
          tripped = true;
          throw new Error("injected-stage-fsync");
        }
        return sync(fd);
      });
      vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
        if (failure === "close-before" && fd === stageFd && !tripped) {
          tripped = true;
          throw new Error("injected-stage-close");
        }
        close(fd);
        if (failure === "close" && fd === stageFd && !tripped) {
          tripped = true;
          throw new Error("injected-stage-close");
        }
      });
      const store = new ProjectionStore(root);
      expect(store.apply(inspect(store)).status).toBe("interrupted");
      expect(tripped).toBe(true);
      vi.restoreAllMocks();
      expect(
        fs
          .readdirSync(root, { recursive: true })
          .filter((name) => String(name).endsWith(".tmp")),
      ).toEqual([]);
      expect(fs.existsSync(target())).toBe(false);
      expect(
        fs.existsSync(
          path.join(root, ".pactile/runtime/projection-transaction.json"),
        ),
      ).toBe(false);
      expect(new ProjectionStore(root).recover().status).toBe("no-pending");
    },
  );
  it("recovery preserves edits made after interruption, and retains a diagnosable journal", () => {
    const store = new ProjectionStore(root, {
      fault: (phase, index) => {
        if (phase === "after-write" && index === 0) throw new Error("injected");
      },
    });
    expect(store.apply(inspect(store)).status).toBe("interrupted");
    fs.writeFileSync(target(), "user-after-crash");
    expect(new ProjectionStore(root).recover().status).toBe("review");
    expect(fs.readFileSync(target(), "utf8")).toBe("user-after-crash");
    expect(
      fs.existsSync(
        path.join(root, ".pactile/runtime/projection-transaction.json"),
      ),
    ).toBe(true);
  });
  it("rejects corrupted staged bytes without beginning the transaction", () => {
    const store = new ProjectionStore(root, {
      fault: (phase) => {
        if (phase === "after-journal") throw new Error("injected");
      },
    });
    expect(store.apply(inspect(store)).status).toBe("interrupted");
    const stage = fs.readdirSync(root).find((name) => name.endsWith(".tmp"));
    expect(stage).toBeDefined();
    fs.writeFileSync(path.join(root, stage ?? "missing-stage"), "tampered");
    expect(new ProjectionStore(root).recover().status).toBe("review");
    expect(fs.existsSync(target())).toBe(false);
  });
  it("persists borrowed claim identity without reading or copying external content", () => {
    const store = new ProjectionStore(root),
      asset = path.join(root, "external.txt");
    fs.writeFileSync(asset, "SENSITIVE-FIXTURE-BODY");
    const op = operation({
      action: "bind",
      format: "external-ref",
      control: "borrowed",
      targetPath: null,
      contentRef: null,
      desiredFingerprint: null,
      externalAssetId: "external-skill-a",
    });
    const result = store.apply(inspect(store, op));
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    expect(
      store.verifyAdapterState(op.claimantId, result.receipt.planFingerprint),
    ).toMatchObject({
      status: "applied",
      externalClaims: [
        {
          resourceId: op.resourceId,
          externalAssetId: "external-skill-a",
          claimants: [op.claimantId],
        },
      ],
    });
    expect(fs.readFileSync(asset, "utf8")).toBe("SENSITIVE-FIXTURE-BODY");
    const receiptDir = path.join(root, ".pactile/runtime/receipts"),
      receipt = fs.readFileSync(
        path.join(receiptDir, fs.readdirSync(receiptDir)[0]),
        "utf8",
      );
    expect(receipt).not.toContain("external-skill-a");
    expect(receipt).not.toContain(root);
    expect(receipt).not.toContain("SENSITIVE-FIXTURE-BODY");
    expect(store.readLedger()?.ledger.entries).toEqual([]);
    expect(store.readExternalClaims().claims).toEqual([
      {
        resourceId: op.resourceId,
        externalAssetId: "external-skill-a",
        claimants: [op.claimantId],
      },
    ]);
    expect(
      fs.readFileSync(
        path.join(root, ".pactile/runtime/external-claims.json"),
        "utf8",
      ),
    ).not.toContain("SENSITIVE-FIXTURE-BODY");
    expect(fs.readdirSync(path.join(root, ".pactile/runtime")).sort()).toEqual([
      "external-claims.json",
      "ownership-ledger.json",
      "receipts",
    ]);
  });
  it("scopes external-claim receipts so sibling Adapter claims do not cause drift", () => {
    const store = new ProjectionStore(root);
    const external = (adapterId: string, resourceId: string) =>
      operation({
        id: `bind-${adapterId}`,
        resourceId,
        claimantId: adapterId,
        action: "bind",
        control: "borrowed",
        targetPath: null,
        format: "external-ref",
        contentRef: null,
        desiredFingerprint: null,
        expectedCurrentFingerprint: null,
        externalAssetId: `external-${resourceId}`,
      });

    const first = inspect(
      store,
      external("adapter-a", "external-a"),
      "adapter-a",
    );
    const applied = store.apply(first);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error(JSON.stringify(applied));
    expect(
      store.verifyAdapterState("adapter-a", applied.receipt.planFingerprint),
    ).toMatchObject({ status: "applied" });

    const sibling = inspect(
      store,
      external("adapter-b", "external-b"),
      "adapter-b",
    );
    expect(store.apply(sibling).status).toBe("applied");
    expect(
      store.verifyAdapterState("adapter-a", applied.receipt.planFingerprint),
    ).toMatchObject({ status: "applied" });
    expect(store.verifyApplied(first)).toMatchObject({ status: "applied" });
    expect(store.apply(first).status).toBe("already-applied");
  });
});
describe("Windows projection namespace boundaries", () => {
  it("rejects a real file symlink without touching its target", () => {
    const outside = path.join(root, "foreign-original");
    fs.writeFileSync(outside, "foreign");
    fs.symlinkSync(outside, target(), "file");
    const store = new ProjectionStore(root);
    expect(
      store.inspect(
        input(
          store,
          operation({
            expectedCurrentFingerprint: fingerprintBytes("foreign"),
          }),
        ),
      ).status,
    ).toBe("review");
    expect(fs.readFileSync(outside, "utf8")).toBe("foreign");
  });
  it("a hardlinked lock is rejected without altering the shared inode", () => {
    const store = new ProjectionStore(root),
      preview = inspect(store);
    fs.mkdirSync(path.join(root, ".pactile/runtime"), { recursive: true });
    const original = path.join(root, "foreign-lock");
    fs.writeFileSync(original, "lock-data");
    fs.linkSync(original, path.join(root, ".pactile/runtime/projection.lock"));
    expect(store.apply(preview).status).toBe("interrupted");
    expect(fs.readFileSync(original, "utf8")).toBe("lock-data");
    expect(fs.existsSync(target())).toBe(false);
  });
  it("a real Windows FileShare.None handle prevents overwrite and recovery preserves the preimage", async () => {
    if (process.platform !== "win32") return;
    fs.writeFileSync(target(), "generated\n");
    const store = new ProjectionStore(root),
      preview = inspect(store, claim(store));
    const filename = target().replace(/'/g, "''");
    const locker = spawn(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$handle = [System.IO.File]::Open('${filename}', 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $handle.Dispose()`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const closed = new Promise<void>((resolve) =>
      locker.once("close", () => resolve()),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        locker.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("READY")) resolve();
        });
        locker.once("error", reject);
        locker.once("exit", (code) => {
          if (!output.includes("READY"))
            reject(new Error(`locker-exit-${code}`));
        });
      });
      expect(store.apply(preview).status).toBe("interrupted");
    } finally {
      locker.stdin.end("release\n");
      await closed;
    }
    expect(fs.readFileSync(target(), "utf8")).toBe("generated\n");
    expect(store.apply(preview).status).toBe("applied");
  });
  it("rejects a directory junction ancestor and does not touch its external target", () => {
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "p45-ledger-outside-"),
    );
    try {
      fs.writeFileSync(path.join(outside, "foreign"), "outside");
      fs.symlinkSync(outside, path.join(root, "link"), "junction");
      const store = new ProjectionStore(root);
      expect(
        store.inspect(input(store, operation({ targetPath: "link/generated" })))
          .status,
      ).toBe("review");
      expect(fs.readdirSync(outside)).toEqual(["foreign"]);
      expect(() => new ProjectionStore(path.join(root, "link"))).toThrow();
    } finally {
      const linkPath = path.join(root, "link");
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it("rejects a hardlinked host file and hardlinked canonical ledger", () => {
    const original = path.join(root, "original");
    fs.writeFileSync(original, "generated\n");
    fs.linkSync(original, target());
    const store = new ProjectionStore(root);
    expect(
      store.inspect(
        input(
          store,
          operation({
            expectedCurrentFingerprint: fingerprintBytes("generated\n"),
          }),
        ),
      ).status,
    ).toBe("review");
    fs.unlinkSync(target());
    store.apply(inspect(store));
    const ledgerPath = path.join(
      root,
      ".pactile/runtime/ownership-ledger.json",
    );
    fs.linkSync(ledgerPath, path.join(root, "ledger-link"));
    expect(
      store.inspect({
        plan: plan(operation()),
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        resolveContent,
      }).status,
    ).toBe("review");
    expect(fs.readFileSync(original, "utf8")).toBe("generated\n");
  });
  it("rejects a junction introduced between inspect and apply", () => {
    fs.mkdirSync(path.join(root, "folder"));
    const store = new ProjectionStore(root);
    const preview = inspect(
      store,
      operation({ targetPath: "folder/generated" }),
    );
    fs.rmdirSync(path.join(root, "folder"));
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(
      path.join(root, "outside"),
      path.join(root, "folder"),
      "junction",
    );
    expect(store.apply(preview).status).toBe("interrupted");
    expect(fs.readdirSync(path.join(root, "outside"))).toEqual([]);
  });
});
