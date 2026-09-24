import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTrace,
  fingerprintPactileContractV1,
  parseInstallStateV1,
  parseTileManifestV1,
  readTrace,
  resolveProviderV1,
  validateComposition,
  type CompositionTraceEventV1,
  type InstallStateV1,
  type PolicyCeilingV1,
  type ProjectionOperationV1,
  type ProviderResolutionInputV1,
  type ResolvedProviderV1,
} from "../../../src/core/index.js";
import {
  buildTileCatalog,
  compileTileComposition,
  discoverRuntimeRoots,
  discoverSnapshot,
  GenerationStore,
  InstallStateStore,
  loadTileUnit,
  planBinding,
  planProjection,
  planRetrievalV3,
} from "../../../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const at = "2026-09-09T00:00:00Z";
const localPolicy: PolicyCeilingV1 = {
  filesystem: "read",
  process: "none",
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: [],
  telemetry: "local-only",
  cost: "free",
};

// This fixture declares observable behavior, not a second YAML serializer.
const tileYaml = `schemaVersion: 1
identity:
  id: local.inspect
  version: "1.0.0"
summary: "Inspect explicitly supplied local context"
trigger:
  mode: explicit
  intents:
    - exact
  description: "User selected local inspection"
inputs: []
outputs:
  - source.refs
dependencies: []
conflicts: []
permissions:
  filesystem: read
  process: none
  credentials: forbidden
egress:
  network: forbidden
  privacy: local-only
  telemetry: local-only
  destinations: []
cost:
  ceiling: free
fallback:
  allowed: false
  minimumAssurance: null
  policy: null
stop:
  conditions:
    - success
    - blocked
  maxAttempts: 2
minimumAssurance: best-effort
evidence: []
`;

describe("M1 host-neutral foundation seams", () => {
  it("activates a sealed Tile, validates the supplied selection and appends observable facts without changing legacy bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-m1-flow-"));
    roots.push(root);
    const legacy = path.join(root, ".cstl", "tasks", "closed", "verify.md");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const legacyBytes = Buffer.from(
      "\uFEFF# retained evidence\r\nuser-owned bytes\r\n",
      "utf8",
    );
    fs.writeFileSync(legacy, legacyBytes);
    discoverRuntimeRoots(root);

    const generation = new GenerationStore(root);
    generation.stage("m1.integration");
    const files = [
      generation.writeFile(
        "m1.integration",
        "tiles/local.inspect/tile.yaml",
        tileYaml,
      ),
      generation.writeFile(
        "m1.integration",
        "tiles/local.inspect/SKILL.md",
        "# Local inspection\nInspect the explicitly supplied local source.\n",
      ),
    ];
    generation.seal("m1.integration", files);
    const state: InstallStateV1 = {
      schemaVersion: 1,
      product: "pactile",
      canonicalRoot: ".pactile",
      runtimeVersion: "0.5.0",
      contractVersion: 1,
      generationId: "m1.integration",
      status: "active",
      installedAdapters: [],
      lastMigrationJournalId: null,
      createdAt: at,
      updatedAt: at,
    };
    const install = new InstallStateStore(root);
    install.compareAndSwap(null, state);
    expect(parseInstallStateV1(install.read()?.state).success).toBe(true);
    expect(install.read()?.state.generationId).toBe("m1.integration");

    const loaded = loadTileUnit([
      {
        name: "tile.yaml",
        text: generation
          .readFile("m1.integration", files[0].path)
          .toString("utf8"),
      },
      {
        name: "SKILL.md",
        text: generation
          .readFile("m1.integration", files[1].path)
          .toString("utf8"),
      },
    ]);
    if (!loaded.success) throw new Error("M1 valid sealed Tile was rejected");
    const catalog = buildTileCatalog([loaded.data]);
    if (!catalog.success) throw new Error("M1 valid catalog was rejected");
    const candidate = compileTileComposition(catalog.data, {
      requestedSelection: ["local.inspect"],
      capabilities: [],
      policyCeiling: localPolicy,
    });
    if (!candidate.success)
      throw new Error("M1 explicit selection was rejected");
    expect(candidate.data.expandedSelection).toEqual(["local.inspect@1.0.0"]);
    expect(candidate.data.policyCeiling).toEqual(localPolicy);

    // A caller-supplied local fact, not a guessed host or an executed probe.
    const localFact: ResolvedProviderV1 = {
      schemaVersion: 1,
      intent: "exact",
      minimumAssurance: "best-effort",
      origin: "native",
      providerId: "local.exact",
      providerVersion: "1.0.0",
      assurance: "best-effort",
      readiness: "ready",
      requestedPolicy: localPolicy,
      effectivePolicy: localPolicy,
      evidenceRefs: [],
      freshness: "not-applicable",
      probedAt: null,
      probeResult: "not-run",
      fallbackFromProviderId: null,
    };
    const validation = validateComposition({
      // The Kernel port validates the M0 manifest fingerprint. The compiler's
      // separate content fingerprint additionally covers SKILL bytes and ABI.
      tiles: candidate.data.tiles.map(({ manifest }) => {
        const parsed = parseTileManifestV1(manifest);
        if (!parsed.success)
          throw new Error("Compiler emitted invalid M0 manifest");
        return { manifest: parsed.data, fingerprint: parsed.fingerprint };
      }),
      policyCeiling: candidate.data.policyCeiling,
      providers: [
        { tileId: "local.inspect", authorized: true, resolution: localFact },
      ],
    });
    expect(validation.outcome).toBe("accepted");
    expect(validation.reasonCodes).toEqual([]);
    expect(validation.selectedTileIds).toEqual(["local.inspect"]);

    const event: CompositionTraceEventV1 = {
      schemaVersion: 1,
      traceId: "m1.flow",
      eventId: "m1.selected",
      sequence: 1,
      previousEventFingerprint: null,
      at,
      event: "tile.selected",
      outcome: "accepted",
      taskId: "task.m1",
      tileId: "local.inspect",
      relatedTileId: null,
      intent: "exact",
      provider: null,
      position: null,
      durationMs: null,
      errorCode: null,
      artifactRefs: ["artifact://composition/m1"],
      evidenceRefs: [],
    };
    const head = appendTrace(root, event, { sequence: 0, fingerprint: null });
    expect(readTrace(root, "m1.flow", head).events).toEqual([event]);
    expect(head.fingerprint).toBe(fingerprintPactileContractV1(event));
    expect(fs.readFileSync(legacy)).toEqual(legacyBytes);
    expect(() =>
      generation.writeFile("m1.integration", "extra.txt", "not allowed"),
    ).toThrow();
    expect(install.read()?.state.generationId).toBe("m1.integration");
  });

  it("adopts only an explicit borrowed Provider, resolves supplied facts, and maps readiness into a retrieval request", () => {
    const canary = "TOKEN=must-not-cross-foundation-seams";
    const inventory = discoverSnapshot({
      context: {
        hostId: "editor.one",
        rootId: "project.tools",
        source: "user-installed",
        scope: "project",
        owner: { kind: "user", id: null },
      },
      assets: [
        {
          id: "semantic-search",
          kind: "mcp",
          locatorToken: "semantic-provider",
          present: true,
          enabled: true,
          transport: "stdio",
          tools: ["search"],
          env: { PRIVATE_KEY: canary },
          body: canary,
        },
      ],
    });
    expect(inventory.diagnostics).toEqual([]);
    expect(JSON.stringify(inventory)).not.toContain(canary);
    const proposed = planBinding({
      asset: inventory.assets[0],
      capabilityId: "search.semantic",
      providerId: "provider.alpha",
      intents: ["semantic"],
    });
    expect(proposed).toMatchObject({
      diagnostics: [],
      installHint: null,
      binding: { control: "borrowed", deleteBoundary: "preserve" },
    });
    if (!proposed.binding)
      throw new Error("Ready adopted Provider did not produce a binding");

    const input: ProviderResolutionInputV1 = {
      schemaVersion: 1,
      intent: "semantic",
      capabilityId: "search.semantic",
      minimumAssurance: "evidence-backed",
      requestedPolicy: localPolicy,
      authorizedProviderIds: ["provider.alpha"],
      activeProviderIds: ["provider.alpha"],
      standbyProviderIds: [],
      fallbackAllowed: false,
      manifests: [
        {
          schemaVersion: 1,
          id: "provider.alpha",
          version: "1.0.0",
          origin: "provider",
          intents: ["semantic"],
          capabilityIds: ["search.semantic"],
          maximumAssurance: "evidence-backed",
          policyCeiling: localPolicy,
          evidenceKinds: ["source-reference"],
          probe: { supported: false, maxAgeSeconds: null },
        },
      ],
      bindings: [proposed.binding],
      runtimeFacts: [
        {
          providerId: "provider.alpha",
          providerVersion: "1.0.0",
          readiness: "ready",
          assurance: "evidence-backed",
          freshness: "not-applicable",
          probedAt: null,
          probeResult: "not-run",
          evidenceRefs: ["evidence://source/provider.alpha/1"],
        },
      ],
      now: at,
    };
    const resolved = resolveProviderV1(input);
    expect(resolved).toMatchObject({
      status: "supported",
      resolution: {
        providerId: "provider.alpha",
        readiness: "ready",
        assurance: "evidence-backed",
      },
      explain: { reasonCode: "provider-selected" },
    });

    // This is the only seam mapping: Retrieval receives capability status,
    // never the Provider identity, manifest, binding, or host inventory.
    const planned = planRetrievalV3(
      {
        schemaVersion: 3,
        query: "explain the selected dependency behavior",
        intents: ["semantic"],
        scopeHints: [],
        minimumAssurance: "evidence-backed",
        requestedPolicy: localPolicy,
        requiredEvidenceKinds: ["source-reference"],
        budget: { maxSteps: 8, maxCandidatesPerStep: 25 },
      },
      {
        providerAvailability: [
          {
            intent: "semantic",
            status: resolved.status === "supported" ? "ready" : "unsupported",
            readiness: resolved.resolution?.readiness ?? "unavailable",
          },
        ],
      },
    );
    expect(planned.success).toBe(true);
    if (!planned.success) throw new Error("Mapped retrieval request was rejected");
    expect(planned.data.steps).toEqual([
      expect.objectContaining({ intent: "semantic", kind: "provider-request" }),
    ]);
    expect(planned.data.stopReasons).toEqual([]);
    expect(JSON.stringify(planned)).not.toContain("provider.alpha");

    const unauthorized = resolveProviderV1({
      ...input,
      authorizedProviderIds: [],
    });
    expect(unauthorized).toMatchObject({
      status: "unsupported",
      resolution: { providerId: null, assurance: null },
    });
    expect(unauthorized.explain.candidates[0]?.reasonCodes).toEqual([
      "provider-not-authorized",
    ]);
    const underAssured = resolveProviderV1({
      ...input,
      runtimeFacts: [{ ...input.runtimeFacts[0], assurance: "best-effort" }],
    });
    expect(underAssured.explain.candidates[0]?.reasonCodes).toEqual([
      "provider-assurance-insufficient",
    ]);
    const tainted = resolveProviderV1({
      ...input,
      [canary]: true,
    });
    expect(tainted.status).toBe("invalid");
    expect(JSON.stringify(tainted)).not.toContain(canary);
  });

  it("releases shared borrowed claims without mutating foreign JSON, TOML, or managed-block bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-m1-ledger-"));
    roots.push(root);
    const foreign = new Map([
      ["settings.json", Buffer.from('{"foreign":true}\r\n', "utf8")],
      ["settings.toml", Buffer.from('foreign = "retained"\r\n', "utf8")],
      [
        "AGENTS.md",
        Buffer.from(
          "foreign prefix\r\n<!-- PACTILE:START -->\r\nforeign block\r\n<!-- PACTILE:END -->\r\nforeign suffix\r\n",
          "utf8",
        ),
      ],
    ]);
    for (const [relative, bytes] of foreign)
      fs.writeFileSync(path.join(root, relative), bytes);

    const externalOperation = (
      id: string,
      claimantId: string,
      action: "bind" | "detach",
    ): ProjectionOperationV1 => ({
      id,
      resourceId: "shared.search",
      claimantId,
      action,
      control: "borrowed",
      targetPath: null,
      format: "external-ref",
      contentRef: null,
      desiredFingerprint: null,
      expectedCurrentFingerprint: null,
      externalAssetId: "semantic-search",
    });
    const preview = (
      operations: readonly ProjectionOperationV1[],
      externalClaims: readonly {
        resourceId: string;
        externalAssetId: string;
        claimants: readonly string[];
      }[] = [],
    ) => {
      const result = planProjection({
        plan: {
          schemaVersion: 1,
          id: `plan.${operations[0].id}`,
          adapterId: "adapter.parent",
          generationId: "generation.m1",
          canonicalFingerprint:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          expectedLedgerFingerprint: null,
          operations,
        },
        ledger: null,
        canonicalFingerprint:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        updatedAt: at,
        externalClaims,
        observe: () => {
          throw new Error("borrowed asset read forbidden");
        },
        resolveContent: () => {
          throw new Error("borrowed asset resolution forbidden");
        },
      });
      if (result.status !== "ready") throw new Error(JSON.stringify(result));
      expect(result.mutations).toEqual([]);
      expect(result.ledger.entries).toEqual([]);
      expect(result.decisions.every((item) => item.disposition === "preserve-borrowed")).toBe(
        true,
      );
      return result;
    };

    const shared = preview([
      externalOperation("bind.a", "adapter.a", "bind"),
      externalOperation("bind.b", "adapter.b", "bind"),
    ]);
    expect(shared.externalClaims[0]?.claimants).toEqual([
      "adapter.a",
      "adapter.b",
    ]);
    const oneLeft = preview(
      [externalOperation("detach.a", "adapter.a", "detach")],
      shared.externalClaims,
    );
    expect(oneLeft.externalClaims[0]?.claimants).toEqual(["adapter.b"]);
    const noneLeft = preview(
      [externalOperation("detach.b", "adapter.b", "detach")],
      oneLeft.externalClaims,
    );
    expect(noneLeft.externalClaims).toEqual([
      {
        resourceId: "shared.search",
        externalAssetId: "semantic-search",
        claimants: [],
      },
    ]);
    for (const [relative, bytes] of foreign)
      expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes);
  });
});
