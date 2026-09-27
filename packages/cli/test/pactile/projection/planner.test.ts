import { describe, expect, it } from "vitest";
import {
  parseOwnershipLedgerV1,
  type OwnershipLedgerV1,
} from "../../../src/core/index.js";
import {
  canonicalOwnershipLedger,
  fingerprintBytes,
  planProjection,
  reduceExternalBindingClaims,
} from "../../../src/pactile/projection/planner.js";
import {
  canonical,
  operation,
  plan,
  ready,
  resolveContent,
  timestamp,
} from "./fixtures.js";

describe("canonical ownership planner", () => {
  it("review F3 protects imported fingerprint-only generated state from another claimant", () => {
    const initial = ready(
      planProjection({
        plan: plan(operation()),
        ledger: null,
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        observe: () => null,
        resolveContent,
      }),
    );
    for (const alreadyClaimed of [false, true]) {
      const entry = initial.ledger.entries[0];
      const ledger = {
        ...initial.ledger,
        entries: [
          {
            ...entry,
            generated: { ...entry.generated, contentRef: null },
            claimants: [
              ...entry.claimants,
              ...(alreadyClaimed
                ? [
                    {
                      id: "adapter-b",
                      kind: "adapter" as const,
                      adapterId: "adapter-b",
                    },
                  ]
                : []),
            ],
          },
        ],
      };
      expect(parseOwnershipLedgerV1(ledger).success).toBe(true);
      const request = {
        ledger,
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        observe: () => null,
        resolveContent,
      };
      const next = operation({
        claimantId: "adapter-b",
        contentRef: "text-v2",
        desiredFingerprint: fingerprintBytes(resolveContent("text-v2").bytes),
      });
      expect(
        planProjection({
          ...request,
          plan: plan(
            next,
            canonicalOwnershipLedger(ledger).fingerprint,
            "adapter-b",
          ),
        }),
      ).toMatchObject({
        status: "review",
        reason: "claimant-content-conflict",
      });
      const same = operation({ claimantId: "adapter-b" });
      expect(
        ready(
          planProjection({
            ...request,
            plan: plan(
              same,
              canonicalOwnershipLedger(ledger).fingerprint,
              "adapter-b",
            ),
          }),
        ).ledger.entries[0].claimants,
      ).toHaveLength(2);
    }
  });
  it("covers 48 ownership/remaining-claim/current/generated combinations at the public plan seam", () => {
    const generatedBytes = Buffer.from("generated\n"),
      userBytes = Buffer.from("user-modified\n");
    const present = {
      state: "present" as const,
      fingerprint: fingerprintBytes(generatedBytes),
      contentRef: "text-v1",
    };
    const absent = {
      state: "absent" as const,
      fingerprint: null,
      contentRef: null,
    };
    const unknown = {
      state: "unknown" as const,
      fingerprint: null,
      contentRef: null,
    };
    for (const mode of ["created", "adopted", "borrowed", "unknown"] as const)
      for (const remaining of [false, true])
        for (const generatedPresent of [false, true])
          for (const observed of ["same", "modified", "missing"] as const) {
            const currentBytes =
              observed === "missing"
                ? null
                : observed === "same"
                  ? generatedBytes
                  : userBytes;
            const current =
              currentBytes === null
                ? absent
                : { ...present, fingerprint: fingerprintBytes(currentBytes) };
            const ledger: OwnershipLedgerV1 = {
              schemaVersion: 1,
              generationId: "generation-a",
              updatedAt: timestamp,
              entries: [
                {
                  resourceId: "shared-resource",
                  targetPath: "AGENTS.md",
                  format: "text",
                  origin: mode === "borrowed" ? "adopted" : mode,
                  control:
                    mode === "borrowed" || mode === "unknown"
                      ? mode
                      : "pactile-owned",
                  owner: {
                    kind:
                      mode === "borrowed"
                        ? "external"
                        : mode === "unknown"
                          ? "unknown"
                          : "pactile",
                    id: mode === "unknown" ? null : "owner",
                  },
                  claimants: [
                    {
                      id: "adapter-a",
                      kind: "adapter",
                      adapterId: "adapter-a",
                    },
                    ...(remaining
                      ? [
                          {
                            id: "adapter-b",
                            kind: "adapter" as const,
                            adapterId: "adapter-b",
                          },
                        ]
                      : []),
                  ],
                  preimage:
                    mode === "created"
                      ? absent
                      : mode === "unknown"
                        ? unknown
                        : present,
                  generated: generatedPresent ? present : absent,
                  current,
                  conflict: "none",
                  disposition: "no-op",
                },
              ],
            };
            const result = planProjection({
              plan: plan(
                operation({
                  action: "remove",
                  contentRef: null,
                  desiredFingerprint: null,
                  expectedCurrentFingerprint: current.fingerprint,
                }),
                canonicalOwnershipLedger(ledger).fingerprint,
              ),
              ledger,
              canonicalFingerprint: canonical,
              updatedAt: timestamp,
              observe: () => currentBytes,
              resolveContent,
            });
            if (observed === "missing") {
              expect(result.status).toBe("ready");
              if (result.status === "ready") expect(result.mutations).toEqual([]);
              continue;
            }
            const preview = ready(result),
              mayDelete =
                mode === "created" &&
                !remaining &&
                generatedPresent &&
                observed === "same";
            expect(preview.mutations.length).toBe(mayDelete ? 1 : 0);
            if (mayDelete) expect(preview.mutations[0].bytes).toBeNull();
          }
  });
  it("sorts claimants before hashing and rejects duplicate claims in imported ledger", () => {
    const initial = ready(
      planProjection({
        plan: plan(operation()),
        ledger: null,
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        observe: () => null,
        resolveContent,
      }),
    );
    const a = { id: "a", kind: "adapter" as const, adapterId: "a" },
      b = { id: "b", kind: "adapter" as const, adapterId: "b" };
    const one = {
      ...initial.ledger,
      entries: [{ ...initial.ledger.entries[0], claimants: [a, b] }],
    };
    const two = {
      ...initial.ledger,
      entries: [{ ...initial.ledger.entries[0], claimants: [b, a] }],
    };
    expect(canonicalOwnershipLedger(one).fingerprint).toBe(
      canonicalOwnershipLedger(two).fingerprint,
    );
    expect(() =>
      canonicalOwnershipLedger({
        ...one,
        entries: [{ ...one.entries[0], claimants: [a, a] }],
      }),
    ).toThrow("invalid-ownership-ledger");
  });
  it("unknown/borrowed/adopted remove entries preserve content and only release the selected claim", () => {
    for (const mode of ["unknown", "borrowed", "adopted"] as const) {
      const bytes = Buffer.from("generated\n"),
        present = {
          state: "present" as const,
          fingerprint: fingerprintBytes(bytes),
          contentRef: "text-v1",
        };
      const unknown = {
        state: "unknown" as const,
        fingerprint: null,
        contentRef: null,
      };
      const ledger: OwnershipLedgerV1 = {
        schemaVersion: 1,
        generationId: "generation-a",
        updatedAt: timestamp,
        entries: [
          {
            resourceId: "shared-resource",
            targetPath: "AGENTS.md",
            format: "text",
            origin: mode === "unknown" ? "unknown" : "adopted",
            control: mode === "adopted" ? "pactile-owned" : mode,
            owner: {
              kind:
                mode === "adopted"
                  ? "pactile"
                  : mode === "borrowed"
                    ? "external"
                    : "unknown",
              id: mode === "unknown" ? null : "owner",
            },
            claimants: [
              { id: "adapter-a", kind: "adapter", adapterId: "adapter-a" },
            ],
            preimage: mode === "unknown" ? unknown : present,
            generated: present,
            current: present,
            conflict: "none",
            disposition: "no-op",
          },
        ],
      };
      expect(parseOwnershipLedgerV1(ledger).success).toBe(true);
      const result = ready(
        planProjection({
          plan: plan(
            operation({
              action: "remove",
              contentRef: null,
              desiredFingerprint: null,
              expectedCurrentFingerprint: present.fingerprint,
            }),
            canonicalOwnershipLedger(ledger).fingerprint,
          ),
          ledger,
          canonicalFingerprint: canonical,
          updatedAt: timestamp,
          observe: () => bytes,
          resolveContent,
        }),
      );
      expect(result.mutations).toEqual([]);
      expect(result.ledger.entries[0].claimants).toEqual([]);
      expect(result.ledger.entries[0].origin).toBe(ledger.entries[0].origin);
      expect(result.ledger.entries[0].preimage).toEqual(
        ledger.entries[0].preimage,
      );
    }
  });
  it("caller-supplied adopted preimage references survive, but restore-preimage is never executed", () => {
    const bytes = Buffer.from("generated\n"),
      current = {
        state: "present" as const,
        fingerprint: fingerprintBytes(bytes),
        contentRef: "text-v1",
      };
    const ledger: OwnershipLedgerV1 = {
      schemaVersion: 1,
      generationId: "generation-a",
      updatedAt: timestamp,
      entries: [
        {
          resourceId: "shared-resource",
          targetPath: "AGENTS.md",
          format: "text",
          origin: "adopted",
          control: "pactile-owned",
          owner: { kind: "pactile", id: "owner" },
          claimants: [],
          preimage: { ...current, contentRef: "caller-retained-preimage" },
          generated: current,
          current,
          conflict: "none",
          disposition: "restore-preimage",
        },
      ],
    };
    expect(parseOwnershipLedgerV1(ledger).success).toBe(true);
    const preview = ready(
      planProjection({
        plan: plan(
          operation({
            action: "remove",
            contentRef: null,
            desiredFingerprint: null,
            expectedCurrentFingerprint: current.fingerprint,
          }),
          canonicalOwnershipLedger(ledger).fingerprint,
        ),
        ledger,
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        observe: () => bytes,
        resolveContent: () => {
          throw new Error("preimage resolution forbidden");
        },
      }),
    );
    expect(preview.mutations).toEqual([]);
    expect(preview.decisions[0].disposition).toBe("no-op");
    expect(preview.ledger.entries[0].preimage.contentRef).toBe(
      "caller-retained-preimage",
    );
  });
  it("keeps plan pure and blocks missing ownership, canonical drift and malformed ledger", () => {
    let reads = 0;
    const input = {
      plan: plan(operation()),
      ledger: null,
      canonicalFingerprint: canonical,
      updatedAt: timestamp,
      observe: () => {
        reads++;
        return null;
      },
      resolveContent,
    };
    expect(ready(planProjection(input)).mutations).toHaveLength(1);
    expect(reads).toBe(1);
    expect(
      planProjection({
        ...input,
        canonicalFingerprint: fingerprintBytes("different"),
      }),
    ).toMatchObject({ status: "conflict" });
    expect(planProjection({ ...input, ledger: {} })).toMatchObject({
      status: "review",
    });
  });
  it("uses null as an absent-target CAS for idempotent removal", () => {
    const initial = ready(
      planProjection({
        plan: plan(operation()),
        ledger: null,
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        observe: () => null,
        resolveContent,
      }),
    );
    const entry = initial.ledger.entries[0];
    const absentLedger: OwnershipLedgerV1 = {
      ...initial.ledger,
      entries: [
        {
          ...entry,
          current: { state: "absent", fingerprint: null, contentRef: null },
        },
      ],
    };
    const remove = operation({
      action: "remove",
      contentRef: null,
      desiredFingerprint: null,
      expectedCurrentFingerprint: null,
    });
    const absent = planProjection({
      plan: plan(remove, canonicalOwnershipLedger(absentLedger).fingerprint),
      ledger: absentLedger,
      canonicalFingerprint: canonical,
      updatedAt: timestamp,
      observe: () => null,
      resolveContent,
    });
    expect(absent).toMatchObject({ status: "ready", mutations: [] });
    expect(
      planProjection({
        plan: plan(remove, canonicalOwnershipLedger(absentLedger).fingerprint),
        ledger: absentLedger,
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        observe: () => Buffer.from("unexpected\n"),
        resolveContent,
      }),
    ).toEqual({ status: "conflict", reason: "target-cas-mismatch" });
  });
});
describe("memory-only external binding claim reducer", () => {
  const bind = operation({
    action: "bind",
    format: "external-ref",
    control: "borrowed",
    targetPath: null,
    contentRef: null,
    desiredFingerprint: null,
    externalAssetId: "external-skill-a",
  });
  it("claim two/release one/release last/reclaim are deterministic and never produce file mutations", () => {
    const one = reduceExternalBindingClaims([], [bind]),
      two = reduceExternalBindingClaims(one, [
        { ...bind, claimantId: "adapter-b" },
      ]);
    expect(two[0].claimants).toEqual(["adapter-a", "adapter-b"]);
    expect(reduceExternalBindingClaims(two, [bind])).toEqual(two);
    const released = reduceExternalBindingClaims(two, [
      { ...bind, action: "detach" },
    ]);
    expect(released[0].claimants).toEqual(["adapter-b"]);
    const empty = reduceExternalBindingClaims(released, [
      { ...bind, action: "detach", claimantId: "adapter-b" },
    ]);
    expect(empty[0].claimants).toEqual([]);
    expect(reduceExternalBindingClaims(empty, [bind])).toEqual(one);
    const result = ready(
      planProjection({
        plan: plan(bind),
        ledger: null,
        canonicalFingerprint: canonical,
        updatedAt: timestamp,
        observe: () => {
          throw new Error("asset read forbidden");
        },
        resolveContent: () => {
          throw new Error("asset resolution forbidden");
        },
      }),
    );
    expect(result.mutations).toEqual([]);
    expect(result.ledger.entries).toEqual([]);
    expect(result.externalClaims).toEqual(one);
  });
  it("rejects duplicate input claimants and conflicting external asset identity", () => {
    expect(() =>
      reduceExternalBindingClaims(
        [
          {
            resourceId: bind.resourceId,
            externalAssetId: "external-skill-a",
            claimants: ["a", "a"],
          },
        ],
        [],
      ),
    ).toThrow();
    expect(() =>
      reduceExternalBindingClaims(reduceExternalBindingClaims([], [bind]), [
        { ...bind, externalAssetId: "another-asset" },
      ]),
    ).toThrow();
  });
});
