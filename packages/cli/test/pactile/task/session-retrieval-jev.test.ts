import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runContextCliAsync } from "../../../src/commands/context.js";
import { runTaskCli } from "../../../src/commands/task.js";
import { resolveJevProjectEgressPolicyV1 } from "../../../src/pactile/jev/project-policy.js";
import { compileSessionPack } from "../../../src/pactile/task/session-pack.js";
import { compileSessionRetrievalPlanWithJevV1 } from "../../../src/pactile/task/session-retrieval-jev.js";

const API_KEY = "session-retrieval-test-key";
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function runTask(root: string, args: string[]): void {
  const code = runTaskCli(args, root);
  if (code !== 0) {
    const error = vi.mocked(console.error).mock.lastCall?.[0];
    const log = vi.mocked(console.log).mock.lastCall?.[0];
    throw new Error(
      "Task CLI failed: " + args[0] + " " + String(error ?? log ?? ""),
    );
  }
}

function createTask(root: string, slug: string, title: string): void {
  runTask(root, [
    "create",
    title,
    "--slug",
    slug,
    "--description",
    "Check the path a request takes through the local harness",
    "--deliverable",
    "A verified source map",
    "--delivery-level",
    "local-result",
    "--accept",
    "AC-1=The source map is verified",
  ]);
}

function createRoot(
  config?: string,
  taskTitle = "Trace request behavior",
): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-session-retrieval-"),
  );
  roots.push(root);
  fs.mkdirSync(path.join(root, ".pactile", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pactile", ".developer"), "name=alice\n");
  if (config !== undefined)
    fs.writeFileSync(path.join(root, ".pactile", "config.yaml"), config);
  vi.stubEnv("PACTILE_CONTEXT_ID", "codex_p34_session_retrieval");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  createTask(root, "session-retrieval-task", taskTitle);
  runTask(root, ["select", "session-retrieval-task"]);
  return root;
}

function choice(choiceValue: "include" | "exclude") {
  const confidence = 0.92;
  return {
    type: "choice",
    choice: choiceValue,
    confidence,
    probabilities:
      choiceValue === "include"
        ? { include: confidence, exclude: 1 - confidence }
        : { include: 1 - confidence, exclude: confidence },
  };
}

function mockJevFetch(captures: Record<string, unknown>[]) {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      state?: { sourceSnippets?: unknown[] };
      questions?: Record<string, unknown>;
    };
    captures.push(body as Record<string, unknown>);
    const questionNames = Object.keys(body.questions ?? {});
    const answers = Object.fromEntries(
      questionNames.map((name) => [
        name,
        name === "semantic"
          ? choice("include")
          : name === "structural"
            ? choice("exclude")
            : { type: "noul", noul: 0.02 },
      ]),
    );
    return new Response(
      JSON.stringify({
        model: "jev-test-model",
        answers,
        usage: { input_tokens: 20, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function parseLastPack(
  log: ReturnType<typeof vi.spyOn>,
): Record<string, unknown> {
  return JSON.parse(String(log.mock.lastCall?.[0])) as Record<string, unknown>;
}

describe("Jev project egress policy", () => {
  it("defaults to allow only when the project config is valid or absent", () => {
    const absentConfigRoot = createRoot();
    expect(resolveJevProjectEgressPolicyV1(absentConfigRoot)).toEqual({
      allowed: true,
      source: "default",
    });

    const commentsOnlyRoot = createRoot(
      "# Default Pactile config contains documentation only.\n# Jev has no override.\n",
    );
    expect(resolveJevProjectEgressPolicyV1(commentsOnlyRoot)).toEqual({
      allowed: true,
      source: "default",
    });

    const validConfigRoot = createRoot("artifact_locale: en\n");
    expect(resolveJevProjectEgressPolicyV1(validConfigRoot)).toEqual({
      allowed: true,
      source: "default",
    });

    const legacyConfigRoot = createRoot("session_auto_commit: yes\n");
    expect(resolveJevProjectEgressPolicyV1(legacyConfigRoot)).toEqual({
      allowed: true,
      source: "default",
    });

    const nestedConfigRoot = createRoot(
      "packages:\n  app:\n    path: packages/app\n    git: true\nhooks:\n  after_create:\n    - \"echo 'created'\"\nartifact_locale: en\n",
    );
    expect(resolveJevProjectEgressPolicyV1(nestedConfigRoot)).toEqual({
      allowed: true,
      source: "default",
    });

    const malformedRoot = createRoot("artifact_locale: en\n  orphan: true\n");
    expect(resolveJevProjectEgressPolicyV1(malformedRoot)).toEqual({
      allowed: false,
      reasonCode: "configuration-invalid",
    });

    const malformedYamlRoot = createRoot(
      "jev:\n  egress: allow\nother: [unterminated\n",
    );
    expect(resolveJevProjectEgressPolicyV1(malformedYamlRoot)).toEqual({
      allowed: false,
      reasonCode: "configuration-invalid",
    });

    const unsupportedMergeRoot = createRoot(
      "deny_policy: &deny { egress: deny }\njev:\n  <<: *deny\n",
    );
    expect(resolveJevProjectEgressPolicyV1(unsupportedMergeRoot)).toEqual({
      allowed: false,
      reasonCode: "configuration-invalid",
    });
  });

  it("accepts the explicit allow or deny switch and rejects unknown values", () => {
    const allowRoot = createRoot("jev:\n  egress: allow\n");
    expect(resolveJevProjectEgressPolicyV1(allowRoot)).toEqual({
      allowed: true,
      source: "configured",
    });

    const denyRoot = createRoot("jev:\n  egress: deny\n");
    expect(resolveJevProjectEgressPolicyV1(denyRoot)).toEqual({
      allowed: false,
      reasonCode: "egress-denied",
    });

    const invalidRoot = createRoot("jev:\n  egress: maybe\n");
    expect(resolveJevProjectEgressPolicyV1(invalidRoot)).toEqual({
      allowed: false,
      reasonCode: "configuration-invalid",
    });

    const ambiguousRoot = createRoot("jev:\n  egress: allow\n  egress: deny\n");
    expect(resolveJevProjectEgressPolicyV1(ambiguousRoot)).toEqual({
      allowed: false,
      reasonCode: "configuration-invalid",
    });
  });

  it("fails closed when the project config path is unreadable", () => {
    const root = createRoot("jev:\n  egress: allow\n");
    const configPath = path.join(root, ".pactile", "config.yaml");
    fs.rmSync(configPath);
    fs.mkdirSync(configPath);

    expect(resolveJevProjectEgressPolicyV1(root)).toEqual({
      allowed: false,
      reasonCode: "configuration-invalid",
    });
  });
});

describe("V2 Session Jev retrieval planning", () => {
  it("adds a confident local route to exact through the context command", async () => {
    const root = createRoot();
    vi.stubEnv("PACTILE_SESSION_FACT_GAP", "1");
    vi.stubEnv("PACTILE_JEV_API_KEY", API_KEY);
    const captures: Record<string, unknown>[] = [];
    const fetchMock = mockJevFetch(captures);
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runContextCliAsync(["--mode", "session", "--json"], root),
    ).toBe(0);

    const pack = parseLastPack(log);
    expect(pack.retrievalPlanning).toMatchObject({
      schemaVersion: 1,
      source: "jev-advised",
      intents: ["exact", "semantic"],
      fallback: null,
    });
    expect(
      (pack.retrievalPlanning as { intents: string[] }).intents,
    ).not.toContain("external");
    expect(pack).not.toHaveProperty("retrievalPlan.audit");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const retrievalCapture = captures[0] as
      | {
          state: { taskSummary: string; sourceSnippets: unknown[] };
          questions: Record<string, unknown>;
        }
      | undefined;
    expect(retrievalCapture?.state.taskSummary).toContain(
      "Trace request behavior",
    );
    expect(retrievalCapture?.state.sourceSnippets).toEqual([]);
    expect(Object.keys(retrievalCapture?.questions ?? {}).sort()).toEqual([
      "semantic",
      "structural",
    ]);
    expect(JSON.stringify(pack)).not.toContain(API_KEY);
  });

  it("keeps the exact plan when Jev has no configured key", async () => {
    const root = createRoot();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pack = compileSessionPack(root, true);

    const planned = await compileSessionRetrievalPlanWithJevV1(root, pack);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(planned.retrievalPlanning).toMatchObject({
      source: "deterministic",
      intents: ["exact"],
      fallback: {
        reasonCode: "configuration-missing",
        explanation: expect.any(String),
      },
    });
  });

  it("uses a project deny override even when the Jev key is configured", async () => {
    const root = createRoot("jev:\n  egress: deny\n");
    vi.stubEnv("PACTILE_JEV_API_KEY", API_KEY);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pack = compileSessionPack(root, true);

    const planned = await compileSessionRetrievalPlanWithJevV1(root, pack);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(planned.retrievalPlanning).toMatchObject({
      source: "deterministic",
      intents: ["exact"],
      fallback: {
        reasonCode: "egress-denied",
        explanation: expect.any(String),
      },
    });
  });

  it("fails closed on malformed project config without leaking the parser detail", async () => {
    const root = createRoot("jev:\n  egress: allow\nother: [unterminated\n");
    vi.stubEnv("PACTILE_JEV_API_KEY", API_KEY);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pack = compileSessionPack(root, true);

    const planned = await compileSessionRetrievalPlanWithJevV1(root, pack);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(planned.retrievalPlanning).toMatchObject({
      source: "deterministic",
      intents: ["exact"],
      fallback: {
        reasonCode: "configuration-invalid",
        explanation: expect.any(String),
      },
    });
    expect(JSON.stringify(planned)).not.toContain("unterminated");

    const mergeRoot = createRoot(
      "deny_policy: &deny { egress: deny }\njev:\n  <<: *deny\n",
    );
    const mergePack = compileSessionPack(mergeRoot, true);
    const mergeFetch = vi.fn();
    vi.stubGlobal("fetch", mergeFetch);
    const mergePlanned = await compileSessionRetrievalPlanWithJevV1(
      mergeRoot,
      mergePack,
    );

    expect(mergeFetch).not.toHaveBeenCalled();
    expect(mergePlanned.retrievalPlanning).toMatchObject({
      source: "deterministic",
      intents: ["exact"],
      fallback: {
        reasonCode: "configuration-invalid",
        explanation: expect.any(String),
      },
    });
  });

  it("keeps the exact plan and omits provider errors when transport fails", async () => {
    const root = createRoot();
    vi.stubEnv("PACTILE_JEV_API_KEY", API_KEY);
    const fetchMock = vi.fn(async () => {
      throw new Error("provider detail must not escape");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const pack = compileSessionPack(root, true);

    const planned = await compileSessionRetrievalPlanWithJevV1(root, pack);

    expect(fetchMock).toHaveBeenCalled();
    expect(planned.retrievalPlanning).toMatchObject({
      source: "deterministic",
      intents: ["exact"],
      fallback: {
        reasonCode: "transport-error",
        explanation: expect.any(String),
      },
    });
    expect(JSON.stringify(planned)).not.toContain(API_KEY);
    expect(JSON.stringify(planned)).not.toContain(
      "provider detail must not escape",
    );
  });

  it("does not send a sensitive V2 Task summary", async () => {
    const sensitiveValue = "p34syntheticvalue";
    const root = createRoot(undefined, "Review NPM_TOKEN=" + sensitiveValue);
    vi.stubEnv("PACTILE_SESSION_FACT_GAP", "1");
    vi.stubEnv("PACTILE_JEV_API_KEY", API_KEY);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runContextCliAsync(["--mode", "session", "--json"], root),
    ).toBe(0);
    const planned = parseLastPack(log);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(planned.retrievalPlanning).toMatchObject({
      source: "deterministic",
      intents: ["exact"],
      fallback: {
        reasonCode: "sensitive-content",
        explanation: expect.any(String),
      },
    });
    expect(JSON.stringify(planned.retrievalPlanning)).not.toContain(
      sensitiveValue,
    );
  });

  it("preserves caller-specified intents and skips Jev", async () => {
    const root = createRoot("jev:\n  egress: allow\n");
    vi.stubEnv("PACTILE_JEV_API_KEY", API_KEY);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pack = compileSessionPack(root, true);

    const planned = await compileSessionRetrievalPlanWithJevV1(root, pack, {
      intents: ["exact", "structural"],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(planned.retrievalPlanning).toMatchObject({
      source: "deterministic",
      intents: ["exact", "structural"],
      fallback: null,
    });
  });

  it("falls back without egress when the packed Task is no longer selected", async () => {
    const root = createRoot();
    createTask(root, "session-retrieval-second", "Second retrieval task");
    const pack = compileSessionPack(root, true);
    runTask(root, ["select", "session-retrieval-second"]);
    vi.stubEnv("PACTILE_JEV_API_KEY", API_KEY);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const planned = await compileSessionRetrievalPlanWithJevV1(root, pack);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(planned.retrievalPlanning).toMatchObject({
      source: "deterministic",
      intents: ["exact"],
      fallback: {
        reasonCode: "session-changed",
        explanation: expect.any(String),
      },
    });
  });

  it("discards Jev advice when the selected Task changes in flight", async () => {
    const root = createRoot();
    createTask(root, "session-retrieval-second", "Second retrieval task");
    vi.stubEnv("PACTILE_JEV_API_KEY", API_KEY);
    const captures: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        questions?: Record<string, unknown>;
      };
      captures.push(body as Record<string, unknown>);
      runTask(root, ["select", "session-retrieval-second"]);
      const answers = Object.fromEntries(
        Object.keys(body.questions ?? {}).map((name) => [
          name,
          choice(name === "semantic" ? "include" : "exclude"),
        ]),
      );
      return new Response(
        JSON.stringify({
          model: "jev-test-model",
          answers,
          usage: { input_tokens: 20, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const pack = compileSessionPack(root, true);

    const planned = await compileSessionRetrievalPlanWithJevV1(root, pack);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(captures).toHaveLength(1);
    expect(planned.retrievalPlanning).toMatchObject({
      source: "deterministic",
      intents: ["exact"],
      fallback: {
        reasonCode: "session-changed",
        explanation: expect.any(String),
      },
    });
  });
});
