import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyTaskRecord } from "../../../src/core/task/index.js";
import { KernelError } from "../../../src/core/task/kernel-contract.js";
import {
  applyKernelArchive,
  applyKernelCreate,
  applyKernelPatch,
  applyKernelStart,
} from "../../../src/core/task/kernel-store.js";
import {
  EXTERNAL_KNOWLEDGE_CAPABILITY,
  RETRIEVAL_INTENTS,
  SHIPPED_MIDDLEWARE_PROVIDERS,
  SHIPPED_PROVIDER_CAPABILITY,
  SHIPPED_PROVIDER_PROBE,
  recordHookEvent,
  selectRegisteredMcpServers,
  mcpServerIdsFromConfig,
  resolveProviderV1,
  subscribeEvent,
  normalizeStage6InExtras,
  type ProviderResolutionInputV1,
} from "../../../src/core/task/adapter-middleware.js";
import { resolveRequiredControls } from "../../../src/core/task/full-quality.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.resolve(here, "../../../src/core");
const cliTemplates = path.resolve(here, "../../../src/templates");

function stage6Record(overrides: Parameters<typeof emptyTaskRecord>[0] = {}) {
  return emptyTaskRecord({
    id: "stage6-demo",
    name: "stage6-demo",
    title: "Stage 6 Demo",
    status: "planning",
    assignee: "developer",
    creator: "developer",
    priority: "P2",
    ...overrides,
  });
}

function writeSurfaces(taskDir: string): void {
  fs.writeFileSync(path.join(taskDir, "prd.md"), "# Stage 6\n", "utf-8");
  fs.writeFileSync(
    path.join(taskDir, "verify.md"),
    "- validation: core test\n- acceptance: stage6 close\n",
    "utf-8",
  );
}

describe("Stage 6 Adapter and Middleware", () => {
  let tmp: string;
  let taskDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-stage6-"));
    taskDir = path.join(tmp, "08-28-stage6");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("records a hook event and does not fail unsubscribed modules", () => {
    const extras: Record<string, unknown> = {};
    subscribeEvent(extras, "sessionStart", "observability-local");
    subscribeEvent(extras, "stop", "retrieval-extended");
    const last = recordHookEvent(extras, {
      event: "sessionStart",
      source: "cursor-hooks",
      at: "2026-08-28T00:00:00.000Z",
    });
    expect(last.delivered).toEqual(["observability-local"]);
    expect(last.skipped).toEqual(["retrieval-extended"]);
    expect(() =>
      recordHookEvent(extras, { event: "preToolUse", source: "cursor-hooks" }),
    ).not.toThrow();
  });

  it("persists Event Bridge via patch extras without a new Command op", () => {
    const created = applyKernelCreate({
      taskDir,
      actor: "task.py create",
      idempotencyKey: "create:stage6-bridge",
      record: stage6Record(),
    });
    const patched = applyKernelPatch({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "task.py",
      idempotencyKey: "patch:stage6-bridge",
      extras: {
        hook_event: { event: "sessionStart", source: "cursor-hooks" },
        event_bridge: {
          subscriptions: [
            { event: "sessionStart", module: "observability-local" },
          ],
        },
      },
    });
    const extras = patched.kernel.projection?.extras ?? {};
    expect(extras.event_bridge).toMatchObject({
      source: "stage6-adapter-middleware",
      last_event: {
        event: "sessionStart",
        delivered: ["observability-local"],
      },
    });
  });

  it("retires the legacy single-Provider probe without blocking Lite", () => {
    expect(fs.existsSync(path.join(tmp, ".git"))).toBe(false);
    const created = applyKernelCreate({
      taskDir,
      actor: "task.py create",
      idempotencyKey: "create:stage6-lite",
      record: stage6Record(),
      extras: {
        required_controls: resolveRequiredControls({ rigor: "lite" }),
        smart_search_probe: {
          available: false,
          evidence: "TOKEN=do-not-persist",
        },
      },
    });
    const extras = created.kernel.projection?.extras ?? {};
    expect(extras.profile_health).toBeUndefined();
    expect(extras).not.toHaveProperty("smart_search_probe");
    expect(extras.middleware_providers).toMatchObject({
      registered: [],
      required: [],
      degraded: [],
      readiness: {},
    });
    expect(JSON.stringify(extras)).not.toMatch(/do-not-persist|TOKEN=/i);
    expect(extras.capability_router).toMatchObject({
      exact: true,
      semantic: true,
      structural: true,
      external: true,
    });
    expect(created.legacy.status).toBe("planning");
    writeSurfaces(taskDir);

    const started = applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "task.py start-execution --approved",
      idempotencyKey: "start:stage6-lite",
      record: { ...stage6Record(), status: "in_progress" },
      extras: { execution_approval: { approved_by: "user" } },
      evidence: "task.py start-execution --approved",
    });
    expect(started.legacy.status).toBe("in_progress");

    const archived = applyKernelArchive({
      taskDir,
      expectedRevision: started.kernel.revision,
      actor: "task.py archive",
      idempotencyKey: "archive:stage6-lite",
      record: {
        ...stage6Record(),
        status: "completed",
        completedAt: "2026-08-28",
      },
      extras: { close_outcome: "completed" },
      evidence: "verify.md",
    });
    expect(archived.kernel.phase).toBe("close");
    expect(archived.legacy.status).toBe("completed");
  });

  it("starts Full Quality without an implicitly required Provider", () => {
    const created = applyKernelCreate({
      taskDir,
      actor: "task.py create",
      idempotencyKey: "create:stage6-full",
      record: stage6Record({ id: "stage6-full", name: "stage6-full" }),
      extras: {
        required_controls: resolveRequiredControls({
          rigor: "full",
          verificationProfile: "standard",
        }),
        smart_search_probe: { available: false },
      },
    });
    writeSurfaces(taskDir);
    fs.writeFileSync(
      path.join(taskDir, "implement.md"),
      "execution_mode: inline\nverification_profile: standard\n",
      "utf-8",
    );
    const started = applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "a",
      idempotencyKey: "start:stage6-full",
      record: {
        ...stage6Record({ id: "stage6-full", name: "stage6-full" }),
        status: "in_progress",
      },
      extras: { execution_approval: { approved_by: "user" } },
      evidence: "approved",
    });
    expect(started.legacy.status).toBe("in_progress");
    expect(started.kernel.projection?.extras?.profile_health).toBeUndefined();
  });

  it("blocks start when external-knowledge is required and Provider is missing", () => {
    const created = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:stage6-required",
      record: stage6Record(),
      extras: {
        required_capabilities: [EXTERNAL_KNOWLEDGE_CAPABILITY],
        smart_search_probe: { available: false },
      },
    });
    try {
      applyKernelStart({
        taskDir,
        expectedRevision: created.kernel.revision,
        actor: "a",
        idempotencyKey: "start:stage6-required",
        record: { ...stage6Record(), status: "in_progress" },
        extras: { execution_approval: { approved_by: "user" } },
        evidence: "approved",
      });
      expect.unreachable("missing Provider should block required capability");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("INVALID_TRANSITION");
    }
  });

  it("allows Policy degrade when external-knowledge is required but missing", () => {
    const created = applyKernelCreate({
      taskDir,
      actor: "a",
      idempotencyKey: "create:stage6-degrade",
      record: stage6Record(),
      extras: {
        required_capabilities: [EXTERNAL_KNOWLEDGE_CAPABILITY],
        external_knowledge_policy: "degrade",
        smart_search_probe: { available: false },
      },
    });
    writeSurfaces(taskDir);
    const started = applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "a",
      idempotencyKey: "start:stage6-degrade",
      record: { ...stage6Record(), status: "in_progress" },
      extras: {
        execution_approval: { approved_by: "user" },
        external_knowledge_policy: "degrade",
      },
      evidence: "approved",
    });
    expect(started.legacy.status).toBe("in_progress");
    expect(started.kernel.projection?.extras?.profile_health).toBe("degraded");
  });

  it("rejects capability_router bindings to Optional tool names", () => {
    try {
      applyKernelCreate({
        taskDir,
        actor: "a",
        idempotencyKey: "create:stage6-tools",
        record: stage6Record(),
        extras: {
          capability_router: { exact: true, codegraph: true },
        },
      });
      expect.unreachable("tool-name binding should fail");
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe("INVALID_REQUEST");
    }
  });

  it("keeps Core independent of smart-search imports", () => {
    const source = fs.readFileSync(
      path.join(coreRoot, "task/adapter-middleware.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/from ["']@blxzer\/smart-search/);
    expect(RETRIEVAL_INTENTS).toEqual([
      "exact",
      "semantic",
      "structural",
      "external",
    ]);
  });

  it("default templates do not force codegraph/fast-context or revive retired alternate client / pactile-byok live entries", () => {
    expect(fs.existsSync(path.join(cliTemplates, "cursor"))).toBe(false);
    const retrieval = fs.readFileSync(
      path.join(cliTemplates, "pactile/modules/retrieval-extended/contract.md"),
      "utf-8",
    );
    expect(retrieval).toMatch(/optional/i);
    expect(retrieval).not.toMatch(/always-on codegraph/i);

    const workflow = fs.readFileSync(
      path.join(cliTemplates, "pactile/workflow.md"),
      "utf-8",
    );
    expect(workflow).not.toMatch(/compatible v0\.0\.11\+/);
    expect(workflow).not.toMatch(/\.pactile\/local\/retired-alternate-client\//);
    expect(workflow).toContain("not runtime SSOT");
    expect(workflow).toContain(".pactile/framework/index.md");
  });

  it("keeps the facade host-neutral and accepts only caller-supplied registrations", () => {
    const extras: Record<string, unknown> = {
      middleware_providers: {
        registered: ["provider.beta", "provider.alpha"],
        required: ["provider.alpha"],
        readiness: {
          "provider.alpha": {
            status: "ready",
            capability: EXTERNAL_KNOWLEDGE_CAPABILITY,
            evidence: "evidence://probe/provider.alpha/1",
          },
          "provider.extra": {
            status: "ready",
            capability: "extra",
          },
        },
      },
    };
    normalizeStage6InExtras(extras);
    const providers = extras.middleware_providers as {
      registered: string[];
      required: string[];
      readiness: Record<string, { capability: string; status: string }>;
    };
    expect(SHIPPED_MIDDLEWARE_PROVIDERS).toEqual([]);
    expect(SHIPPED_PROVIDER_CAPABILITY).toEqual({});
    expect(SHIPPED_PROVIDER_PROBE).toEqual({});
    expect(providers.registered).toEqual(["provider.beta", "provider.alpha"]);
    expect(providers.required).toEqual(["provider.alpha"]);
    expect(providers.readiness).toEqual({
      "provider.alpha": {
        status: "ready",
        capability: EXTERNAL_KNOWLEDGE_CAPABILITY,
        evidence: "evidence://probe/provider.alpha/1",
      },
    });
  });

  it("lets Lite close when an optional Provider is missing and ignores unknown probes", () => {
    expect(fs.existsSync(path.join(tmp, ".git"))).toBe(false);
    const created = applyKernelCreate({
      taskDir,
      actor: "task.py create",
      idempotencyKey: "create:stage6-optional-mcp",
      record: stage6Record({
        id: "stage6-optional",
        name: "stage6-optional",
      }),
      extras: {
        required_controls: resolveRequiredControls({ rigor: "lite" }),
        middleware_providers: {
          registered: ["provider.required", "provider.optional"],
          required: ["provider.required"],
          readiness: {},
        },
        middleware_probes: {
          "provider.required": {
            present: true,
            capability: EXTERNAL_KNOWLEDGE_CAPABILITY,
            evidence: "evidence://probe/provider.required/1",
          },
          "provider.optional": {
            present: false,
            capability: "search.semantic",
          },
          "provider.extra": { present: true, capability: "extra" },
        },
      },
    });
    const extras = created.kernel.projection?.extras ?? {};
    expect(extras.profile_health).not.toBe("degraded");
    expect(extras.middleware_providers).toMatchObject({
      required: ["provider.required"],
      degraded: [],
      readiness: {
        "provider.optional": {
          status: "missing",
          capability: "search.semantic",
        },
        "provider.required": {
          status: "ready",
          capability: EXTERNAL_KNOWLEDGE_CAPABILITY,
        },
      },
    });
    const providers = extras.middleware_providers as {
      registered: string[];
      readiness: Record<string, unknown>;
    };
    expect(providers.registered).not.toContain("provider.extra");
    expect(providers.readiness["provider.extra"]).toBeUndefined();
    expect(
      selectRegisteredMcpServers(
        mcpServerIdsFromConfig({
          mcpServers: {
            "provider.optional": {},
            "provider.extra": {},
            "provider.required": {},
          },
        }),
        ["provider.required", "provider.optional"],
      ),
    ).toEqual(["provider.optional", "provider.required"]);
    writeSurfaces(taskDir);
    const started = applyKernelStart({
      taskDir,
      expectedRevision: created.kernel.revision,
      actor: "task.py start-execution --approved",
      idempotencyKey: "start:stage6-optional",
      record: {
        ...stage6Record({ id: "stage6-optional", name: "stage6-optional" }),
        status: "in_progress",
      },
      extras: { execution_approval: { approved_by: "user" } },
      evidence: "task.py start-execution --approved",
    });
    expect(started.legacy.status).toBe("in_progress");
    const archived = applyKernelArchive({
      taskDir,
      expectedRevision: started.kernel.revision,
      actor: "task.py archive",
      idempotencyKey: "archive:stage6-optional",
      record: {
        ...stage6Record({ id: "stage6-optional", name: "stage6-optional" }),
        status: "completed",
        completedAt: "2026-08-29",
      },
      extras: { close_outcome: "completed" },
      evidence: "verify.md",
    });
    expect(archived.kernel.phase).toBe("close");
    expect(archived.legacy.status).toBe("completed");
  });
});

const LOCAL_POLICY = {
  filesystem: "read",
  process: "none",
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: [],
  telemetry: "local-only",
  cost: "free",
} as const;

function providerResolutionInput(): ProviderResolutionInputV1 {
  return {
    schemaVersion: 1,
    intent: "semantic",
    capabilityId: "search.semantic",
    minimumAssurance: "evidence-backed",
    requestedPolicy: LOCAL_POLICY,
    authorizedProviderIds: ["provider.beta", "provider.alpha"],
    activeProviderIds: ["provider.alpha"],
    standbyProviderIds: ["provider.beta"],
    fallbackAllowed: true,
    manifests: [
      {
        schemaVersion: 1,
        id: "provider.alpha",
        version: "1.0.0",
        origin: "provider",
        intents: ["semantic"],
        capabilityIds: ["search.semantic"],
        maximumAssurance: "verified",
        policyCeiling: LOCAL_POLICY,
        evidenceKinds: ["probe-result"],
        probe: { supported: true, maxAgeSeconds: 300 },
      },
      {
        schemaVersion: 1,
        id: "provider.beta",
        version: "1.0.0",
        origin: "provider",
        intents: ["semantic"],
        capabilityIds: ["search.semantic"],
        maximumAssurance: "evidence-backed",
        policyCeiling: LOCAL_POLICY,
        evidenceKinds: ["source-reference"],
        probe: { supported: false, maxAgeSeconds: null },
      },
    ],
    bindings: [
      {
        schemaVersion: 1,
        id: "binding.alpha",
        capabilityId: "search.semantic",
        mode: "adopted",
        control: "borrowed",
        deleteBoundary: "preserve",
        asset: {
          schemaVersion: 1,
          id: "asset.alpha",
          kind: "mcp",
          source: "user-installed",
          scope: "project",
          owner: { kind: "user", id: null },
          locator: "user-installed://provider.alpha",
          fingerprint: null,
          readiness: "ready",
          installHint: null,
        },
        intents: ["semantic"],
        providerId: "provider.alpha",
      },
      {
        schemaVersion: 1,
        id: "binding.beta",
        capabilityId: "search.semantic",
        mode: "adopted",
        control: "borrowed",
        deleteBoundary: "preserve",
        asset: {
          schemaVersion: 1,
          id: "asset.beta",
          kind: "mcp",
          source: "user-installed",
          scope: "project",
          owner: { kind: "user", id: null },
          locator: "user-installed://provider.beta",
          fingerprint: null,
          readiness: "ready",
          installHint: null,
        },
        intents: ["semantic"],
        providerId: "provider.beta",
      },
    ],
    runtimeFacts: [
      {
        providerId: "provider.alpha",
        providerVersion: "1.0.0",
        readiness: "ready",
        assurance: "verified",
        freshness: "fresh",
        probedAt: "2026-09-09T10:00:00Z",
        probeResult: "passed",
        evidenceRefs: ["evidence://probe/provider.alpha/1"],
      },
      {
        providerId: "provider.beta",
        providerVersion: "1.0.0",
        readiness: "ready",
        assurance: "evidence-backed",
        freshness: "not-applicable",
        probedAt: null,
        probeResult: "not-run",
        evidenceRefs: ["evidence://source/provider.beta/1"],
      },
    ],
    now: "2026-09-09T10:01:00Z",
  };
}

describe("Pactile Provider Resolver v1", () => {
  it("selects an authorized ready active Provider and emits an M0-valid resolution", () => {
    const result = resolveProviderV1(providerResolutionInput());

    expect(result.status).toBe("supported");
    expect(result.resolution).toEqual({
      schemaVersion: 1,
      intent: "semantic",
      minimumAssurance: "evidence-backed",
      origin: "provider",
      providerId: "provider.alpha",
      providerVersion: "1.0.0",
      assurance: "verified",
      readiness: "ready",
      requestedPolicy: LOCAL_POLICY,
      effectivePolicy: LOCAL_POLICY,
      evidenceRefs: ["evidence://probe/provider.alpha/1"],
      freshness: "fresh",
      probedAt: "2026-09-09T10:00:00Z",
      probeResult: "passed",
      fallbackFromProviderId: null,
    });
    expect(result.explain.reasonCode).toBe("provider-selected");
    expect(result.explain.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "provider.alpha",
          accepted: true,
          selected: true,
          reasonCodes: ["provider-selected-active"],
        }),
      ]),
    );
  });

  it("uses standby only when explicit fallback is allowed and never bypasses policy", () => {
    const input = providerResolutionInput();
    input.runtimeFacts = input.runtimeFacts.map((fact) =>
      fact.providerId === "provider.alpha"
        ? {
            ...fact,
            readiness: "unavailable",
            assurance: null,
            freshness: "not-applicable",
            probedAt: null,
            probeResult: "not-run",
            evidenceRefs: [],
          }
        : fact,
    );

    const fallback = resolveProviderV1(input);
    expect(fallback.status).toBe("supported");
    expect(fallback.resolution?.providerId).toBe("provider.beta");
    expect(fallback.resolution?.fallbackFromProviderId).toBe("provider.alpha");

    const disabled = resolveProviderV1({ ...input, fallbackAllowed: false });
    expect(disabled.status).toBe("unsupported");
    expect(disabled.resolution?.providerId).toBeNull();
    expect(disabled.explain.reasonCode).toBe("provider-fallback-disabled");

    const overPolicy = resolveProviderV1({
      ...input,
      requestedPolicy: { ...LOCAL_POLICY, filesystem: "write" },
    });
    expect(overPolicy.status).toBe("unsupported");
    expect(overPolicy.resolution?.providerId).toBeNull();
    expect(
      overPolicy.explain.candidates.every((candidate) => !candidate.accepted),
    ).toBe(true);
    expect(overPolicy.explain.candidates[0]?.reasonCodes).toEqual([
      "provider-policy-filesystem-exceeded",
    ]);
  });

  it("rejects stale, unknown, degraded-without-evidence, and invalid binding facts", () => {
    const stale = providerResolutionInput();
    stale.runtimeFacts = stale.runtimeFacts.map((fact) =>
      fact.providerId === "provider.alpha"
        ? { ...fact, freshness: "stale" }
        : fact,
    );
    stale.fallbackAllowed = false;
    expect(resolveProviderV1(stale).explain.candidates[0]?.reasonCodes).toEqual(
      ["provider-freshness-stale"],
    );

    const unknown = providerResolutionInput();
    unknown.runtimeFacts = unknown.runtimeFacts.map((fact) =>
      fact.providerId === "provider.alpha"
        ? { ...fact, readiness: "unknown" }
        : fact,
    );
    unknown.fallbackAllowed = false;
    expect(
      resolveProviderV1(unknown).explain.candidates[0]?.reasonCodes,
    ).toEqual(["provider-readiness-unknown"]);

    const degraded = providerResolutionInput();
    degraded.runtimeFacts = degraded.runtimeFacts.map((fact) =>
      fact.providerId === "provider.alpha"
        ? {
            ...fact,
            readiness: "degraded",
            assurance: "best-effort",
            evidenceRefs: [],
          }
        : fact,
    );
    degraded.minimumAssurance = "best-effort";
    degraded.fallbackAllowed = false;
    expect(
      resolveProviderV1(degraded).explain.candidates[0]?.reasonCodes,
    ).toEqual(["provider-degraded-without-evidence"]);

    const binding = providerResolutionInput();
    binding.bindings = binding.bindings.filter(
      (item) => item.providerId !== "provider.alpha",
    );
    binding.fallbackAllowed = false;
    expect(
      resolveProviderV1(binding).explain.candidates[0]?.reasonCodes,
    ).toEqual(["provider-binding-missing"]);
  });

  it("is permutation-stable and excludes caller now from its fingerprint", () => {
    const input = providerResolutionInput();
    const expected = resolveProviderV1(input);
    const permuted = resolveProviderV1({
      ...input,
      authorizedProviderIds: [...input.authorizedProviderIds].reverse(),
      manifests: [...input.manifests].reverse(),
      bindings: [...input.bindings].reverse(),
      runtimeFacts: [...input.runtimeFacts].reverse().map((fact) => ({
        ...fact,
        evidenceRefs: [...fact.evidenceRefs].reverse(),
      })),
      now: "2026-09-09T10:02:00Z",
    });

    expect(permuted).toEqual(expected);
    expect(expected.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("fails closed without echoing malformed caller values or secret canaries", () => {
    const canary = "TOKEN=top-secret-value";
    const input = providerResolutionInput() as ProviderResolutionInputV1 & {
      runtimeFacts: Record<string, unknown>[];
    };
    input.runtimeFacts[0] = {
      ...input.runtimeFacts[0],
      evidenceRefs: [canary, "C:\\Users\\person\\secret.txt"],
    };

    const result = resolveProviderV1(input as ProviderResolutionInputV1);
    const serialized = JSON.stringify(result);
    expect(result.status).toBe("invalid");
    expect(result.resolution).toBeNull();
    expect(result.explain.reasonCode).toBe("provider-input-invalid");
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("C:\\Users");
    expect(serialized).not.toMatch(/token|secret-value/i);

    const policyCanary = "api.example.com?token=do-not-print";
    const invalidPolicy = resolveProviderV1({
      ...providerResolutionInput(),
      requestedPolicy: {
        ...LOCAL_POLICY,
        network: "project-authorized",
        privacy: "external",
        egressDestinations: [policyCanary],
      },
    });
    expect(invalidPolicy.status).toBe("invalid");
    expect(JSON.stringify(invalidPolicy)).not.toContain(policyCanary);
    expect(JSON.stringify(invalidPolicy)).not.toMatch(/do-not-print|token=/i);

    const unknownEnvironment = resolveProviderV1({
      ...providerResolutionInput(),
      environment: canary,
    });
    expect(unknownEnvironment.status).toBe("invalid");
    expect(JSON.stringify(unknownEnvironment)).not.toContain(canary);
    expect(JSON.stringify(unknownEnvironment)).not.toMatch(
      /token|secret-value/i,
    );
  });

  it("rejects hostile object graphs at the public seam without invoking accessors", () => {
    const canary = "TOKEN=hostile-object-canary";
    let accessorReads = 0;
    let unknownAccessorReads = 0;

    const inherited = Object.assign(
      Object.create({ environment: canary }) as Record<string, unknown>,
      providerResolutionInput(),
    );
    const ownProto = providerResolutionInput() as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(ownProto, "__proto__", {
      configurable: true,
      enumerable: true,
      value: canary,
    });
    const ownConstructor = providerResolutionInput() as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(ownConstructor, "constructor", {
      configurable: true,
      enumerable: true,
      value: canary,
    });
    const throwingGetter = providerResolutionInput() as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(throwingGetter, "now", {
      configurable: true,
      enumerable: true,
      get(): never {
        throw new Error(canary);
      },
    });
    const unknownGetter = providerResolutionInput() as unknown as Record<
      string,
      unknown
    >;
    Object.defineProperty(unknownGetter, "environment", {
      configurable: true,
      enumerable: true,
      get(): never {
        unknownAccessorReads += 1;
        throw new Error(canary);
      },
    });

    const accessorPolicy = { ...LOCAL_POLICY } as Record<string, unknown>;
    Object.defineProperty(accessorPolicy, "filesystem", {
      configurable: true,
      enumerable: true,
      get(): string {
        accessorReads += 1;
        return "read";
      },
    });
    const nestedAccessor = {
      ...providerResolutionInput(),
      requestedPolicy: accessorPolicy,
    };
    const nestedUnknownPolicy = { ...LOCAL_POLICY } as Record<string, unknown>;
    Object.defineProperty(nestedUnknownPolicy, "environment", {
      configurable: true,
      enumerable: true,
      get(): never {
        unknownAccessorReads += 1;
        throw new Error(canary);
      },
    });
    const nestedUnknownAccessor = {
      ...providerResolutionInput(),
      requestedPolicy: nestedUnknownPolicy,
    };
    const nestedPrototype = {
      ...providerResolutionInput(),
      requestedPolicy: Object.assign(
        Object.create({ environment: canary }) as Record<string, unknown>,
        LOCAL_POLICY,
      ),
    };
    const nestedProxy = {
      ...providerResolutionInput(),
      requestedPolicy: new Proxy({ ...LOCAL_POLICY }, {}),
    };
    const proxy = new Proxy(providerResolutionInput(), {});
    const throwingOwnKeysProxy = new Proxy(providerResolutionInput(), {
      ownKeys(): never {
        throw new Error(canary);
      },
    });
    const throwingGetProxy = new Proxy(providerResolutionInput(), {
      get(): never {
        throw new Error(canary);
      },
    });

    const cases: readonly [string, unknown][] = [
      ["custom prototype", inherited],
      ["own __proto__", ownProto],
      ["own constructor", ownConstructor],
      ["throwing getter", throwingGetter],
      ["unknown getter", unknownGetter],
      ["nested accessor", nestedAccessor],
      ["nested unknown accessor", nestedUnknownAccessor],
      ["nested custom prototype", nestedPrototype],
      ["nested Proxy", nestedProxy],
      ["Proxy", proxy],
      ["throwing ownKeys Proxy", throwingOwnKeysProxy],
      ["throwing get Proxy", throwingGetProxy],
    ];

    for (const [name, input] of cases) {
      let result: ReturnType<typeof resolveProviderV1> | undefined;
      expect(() => {
        result = resolveProviderV1(input);
      }, name).not.toThrow();
      expect(result, name).toEqual({
        schemaVersion: 1,
        status: "invalid",
        resolution: null,
        fingerprint: null,
        explain: {
          schemaVersion: 1,
          decision: "invalid",
          reasonCode: "provider-input-invalid",
          selectedProviderId: null,
          fallbackFromProviderId: null,
          effectivePolicy: null,
          evidenceRefs: [],
          candidates: [],
        },
      });
      expect(JSON.stringify(result), name).not.toMatch(
        /hostile-object-canary|TOKEN=/i,
      );
    }
    expect(accessorReads).toBe(0);
    expect(unknownAccessorReads).toBe(0);
  });

  it("does not read polluted Object.prototype getters for missing required fields", () => {
    const canary = "TOKEN=object-prototype-canary";
    const expectedInvalid = {
      schemaVersion: 1,
      status: "invalid",
      resolution: null,
      fingerprint: null,
      explain: {
        schemaVersion: 1,
        decision: "invalid",
        reasonCode: "provider-input-invalid",
        selectedProviderId: null,
        fallbackFromProviderId: null,
        effectivePolicy: null,
        evidenceRefs: [],
        candidates: [],
      },
    } as const;

    const missingNow = providerResolutionInput() as unknown as Record<
      string,
      unknown
    >;
    Reflect.deleteProperty(missingNow, "now");
    const originalNow = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "now",
    );
    let nowReads = 0;
    let nowResult: ReturnType<typeof resolveProviderV1> | undefined;
    Object.defineProperty(Object.prototype, "now", {
      configurable: true,
      get(): never {
        nowReads += 1;
        throw new Error(canary);
      },
    });
    try {
      expect(() => {
        nowResult = resolveProviderV1(missingNow);
      }).not.toThrow();
    } finally {
      if (originalNow === undefined) {
        Reflect.deleteProperty(Object.prototype, "now");
      } else {
        Object.defineProperty(Object.prototype, "now", originalNow);
      }
    }
    expect(nowReads).toBe(0);
    expect(nowResult).toEqual(expectedInvalid);
    expect(JSON.stringify(nowResult)).not.toMatch(
      /object-prototype-canary|TOKEN=/i,
    );

    const requestedPolicy = { ...LOCAL_POLICY } as Record<string, unknown>;
    Reflect.deleteProperty(requestedPolicy, "filesystem");
    const missingNestedPolicyField = {
      ...providerResolutionInput(),
      requestedPolicy,
    };
    const originalFilesystem = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "filesystem",
    );
    let policyReads = 0;
    let policyResult: ReturnType<typeof resolveProviderV1> | undefined;
    Object.defineProperty(Object.prototype, "filesystem", {
      configurable: true,
      get(): never {
        policyReads += 1;
        throw new Error(canary);
      },
    });
    try {
      expect(() => {
        policyResult = resolveProviderV1(missingNestedPolicyField);
      }).not.toThrow();
    } finally {
      if (originalFilesystem === undefined) {
        Reflect.deleteProperty(Object.prototype, "filesystem");
      } else {
        Object.defineProperty(
          Object.prototype,
          "filesystem",
          originalFilesystem,
        );
      }
    }
    expect(policyReads).toBe(0);
    expect(policyResult).toEqual(expectedInvalid);
    expect(JSON.stringify(policyResult)).not.toMatch(
      /object-prototype-canary|TOKEN=/i,
    );
  });

  it("rejects every policy dimension in contract order", () => {
    const cases: {
      expected: string;
      requested: Record<string, unknown>;
      ceiling?: Record<string, unknown>;
    }[] = [
      {
        expected: "provider-policy-filesystem-exceeded",
        requested: { filesystem: "write" },
      },
      {
        expected: "provider-policy-process-exceeded",
        requested: { process: "execute" },
      },
      {
        expected: "provider-policy-network-exceeded",
        requested: { network: "project-authorized" },
      },
      {
        expected: "provider-policy-credentials-exceeded",
        requested: { credentials: "project-authorized" },
      },
      {
        expected: "provider-policy-privacy-exceeded",
        requested: {
          network: "project-authorized",
          privacy: "external",
          egressDestinations: ["docs.example"],
        },
        ceiling: {
          network: "project-authorized",
          privacy: "local-only",
          egressDestinations: ["docs.example"],
        },
      },
      {
        expected: "provider-policy-egress-exceeded",
        requested: {
          network: "project-authorized",
          privacy: "external",
          egressDestinations: ["other.example"],
        },
        ceiling: {
          network: "project-authorized",
          privacy: "external",
          egressDestinations: ["docs.example"],
        },
      },
      {
        expected: "provider-policy-telemetry-exceeded",
        requested: {
          network: "project-authorized",
          telemetry: "project-authorized",
        },
        ceiling: { network: "project-authorized" },
      },
      {
        expected: "provider-policy-cost-exceeded",
        requested: { cost: "high" },
      },
    ];

    for (const testCase of cases) {
      const input = providerResolutionInput();
      input.requestedPolicy = {
        ...LOCAL_POLICY,
        ...testCase.requested,
      } as ProviderResolutionInputV1["requestedPolicy"];
      if (testCase.ceiling) {
        input.manifests = input.manifests.map((manifest) => ({
          ...manifest,
          policyCeiling: {
            ...manifest.policyCeiling,
            ...testCase.ceiling,
          } as ProviderResolutionInputV1["requestedPolicy"],
        }));
      }

      const result = resolveProviderV1(input);
      expect(result.status, testCase.expected).toBe("unsupported");
      expect(
        result.explain.candidates[0]?.reasonCodes,
        testCase.expected,
      ).toEqual([testCase.expected]);
    }
  });

  it("applies authorization, intent, capability, assurance, and probe gates before selection", () => {
    const mutations: {
      expected: string;
      mutate(input: ProviderResolutionInputV1): void;
    }[] = [
      {
        expected: "provider-not-authorized",
        mutate: (input) => {
          input.authorizedProviderIds = ["provider.beta"];
        },
      },
      {
        expected: "provider-intent-mismatch",
        mutate: (input) => {
          input.intent = "structural";
        },
      },
      {
        expected: "provider-capability-mismatch",
        mutate: (input) => {
          input.capabilityId = "search.other";
        },
      },
      {
        expected: "provider-assurance-insufficient",
        mutate: (input) => {
          input.minimumAssurance = "verified";
          input.runtimeFacts = input.runtimeFacts.map((fact) =>
            fact.providerId === "provider.alpha"
              ? { ...fact, assurance: "evidence-backed" }
              : fact,
          );
        },
      },
      {
        expected: "provider-probe-not-run",
        mutate: (input) => {
          input.runtimeFacts = input.runtimeFacts.map((fact) =>
            fact.providerId === "provider.alpha"
              ? {
                  ...fact,
                  freshness: "unknown",
                  probedAt: null,
                  probeResult: "not-run",
                }
              : fact,
          );
        },
      },
      {
        expected: "provider-probe-failed",
        mutate: (input) => {
          input.runtimeFacts = input.runtimeFacts.map((fact) =>
            fact.providerId === "provider.alpha"
              ? { ...fact, probeResult: "failed" }
              : fact,
          );
        },
      },
      {
        expected: "provider-probe-expired",
        mutate: (input) => {
          input.now = "2026-09-09T10:06:00Z";
        },
      },
      {
        expected: "provider-probe-from-future",
        mutate: (input) => {
          input.now = "2026-09-09T09:59:00Z";
        },
      },
    ];

    for (const mutation of mutations) {
      const input = providerResolutionInput();
      input.fallbackAllowed = false;
      mutation.mutate(input);
      const result = resolveProviderV1(input);
      expect(
        result.explain.candidates[0]?.reasonCodes,
        mutation.expected,
      ).toEqual([mutation.expected]);
    }
  });

  it("fails closed on duplicate manifests and keeps unsupported facts honest", () => {
    const duplicate = providerResolutionInput();
    const firstManifest = duplicate.manifests[0];
    expect(firstManifest).toBeDefined();
    if (firstManifest === undefined) {
      throw new Error("expected a Provider fixture");
    }
    duplicate.manifests = [...duplicate.manifests, firstManifest];
    const invalid = resolveProviderV1(duplicate);
    expect(invalid).toMatchObject({
      status: "invalid",
      resolution: null,
      fingerprint: null,
      explain: { reasonCode: "provider-manifest-duplicate", candidates: [] },
    });

    const unsupportedInput = providerResolutionInput();
    unsupportedInput.authorizedProviderIds = [];
    unsupportedInput.activeProviderIds = [];
    unsupportedInput.standbyProviderIds = [];
    const unsupported = resolveProviderV1(unsupportedInput);
    expect(unsupported.resolution).toMatchObject({
      origin: "unsupported",
      providerId: null,
      providerVersion: null,
      assurance: null,
      readiness: "unavailable",
      effectivePolicy: null,
      evidenceRefs: [],
      freshness: "not-applicable",
      probedAt: null,
      probeResult: "not-run",
      fallbackFromProviderId: null,
    });
  });

  it("makes the fingerprint sensitive to policy and observed Provider facts", () => {
    const input = providerResolutionInput();
    const baseline = resolveProviderV1(input).fingerprint;
    const changedPolicy = resolveProviderV1({
      ...input,
      requestedPolicy: { ...input.requestedPolicy, cost: "none" },
    }).fingerprint;
    const changedFact = resolveProviderV1({
      ...input,
      runtimeFacts: input.runtimeFacts.map((fact) =>
        fact.providerId === "provider.beta"
          ? { ...fact, readiness: "degraded" }
          : fact,
      ),
    }).fingerprint;

    expect(baseline).not.toBe(changedPolicy);
    expect(baseline).not.toBe(changedFact);
  });
});
