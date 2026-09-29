import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertPiRoleContract, buildPiRoleContract, sealPiRoleContract, type PiRoleContract } from "../../../src/pactile/pi/policy/contract.js";
import { authorizePiMcp, authorizePiTool, freezePiToolInput } from "../../../src/pactile/pi/policy/decision.js";
import piRolePolicy, { type PiPolicyExtensionApi } from "../../../src/pactile/pi/policy/extension.js";
import { assertPiDockerIsolation, mapPiDockerPrompt, piDockerGitConfig, readPiRoleConfiguration, resolvePiInferenceTargets } from "../../../src/pactile/pi/policy/container.js";
import { PI_INFERENCE_PROVIDER_HEADER, PI_RELAY_FAILURE_HEADER, startPiSandboxRelay } from "../../../src/pactile/pi/policy/sandbox-runtime.js";
import { piReviewToolReferenceV1 } from "../../../src/pactile/review/evidence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(role: PiRoleContract["role"] = "implement") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p48-role-policy-")); roots.push(root);
  const workdir = path.join(root, "project"); const taskDir = path.join(root, "tasks", "approved"); const scratchDir = path.join(root, "scratch");
  for (const dir of [workdir, taskDir, scratchDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(workdir, "result.ts"), "export const result = 1;\n");
  fs.writeFileSync(path.join(workdir, "unrelated.ts"), "export const untouched = true;\n");
  fs.writeFileSync(path.join(workdir, ".env"), "PRIVATE_KEY=fixture\n");
  fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({ status: "in_progress", execution_approval: { approved_by: "user" } }));
  fs.writeFileSync(path.join(taskDir, "implement.md"), "Only result.ts.\n");
  fs.writeFileSync(path.join(taskDir, "approval.md"), "Approved fixture write set only.\n");
  const contract = buildPiRoleContract({ root, taskDir, workdir, scratchDir, role, timeoutMs: 60_000, writeSet: ["result.ts", "new.ts"] });
  return { root, workdir, taskDir, scratchDir, contract };
}

describe("Pi role action authorization", () => {
  it("allows only the implement write set and declared scratch, retaining safe reads", () => {
    const { workdir, taskDir, scratchDir, contract } = fixture();
    expect(authorizePiTool(contract, "read", { path: "unrelated.ts" }).allowed).toBe(true);
    expect(authorizePiTool(contract, "write", { path: "result.ts" }).allowed).toBe(true);
    expect(authorizePiTool(contract, "write", { path: "new.ts" }).allowed).toBe(true);
    expect(authorizePiTool(contract, "edit", { path: "unrelated.ts" }).allowed).toBe(false);
    expect(authorizePiTool(contract, "write", { path: path.join(scratchDir, "report.txt") }).allowed).toBe(true);
    expect(authorizePiTool(contract, "write", { path: path.join(taskDir, "verify.md") }).allowed).toBe(false);
    expect(authorizePiTool(contract, "write", { path: path.join(workdir, ".pactile", "kernel.json") }).allowed).toBe(false);
    expect(authorizePiTool(contract, "write", { path: path.join(workdir, ".git", "config") }).allowed).toBe(false);
  });
  it.each(["research", "check"] as const)("keeps %s candidate/evidence readonly while allowing its scratch", (role) => {
    const { contract, scratchDir } = fixture(role);
    expect(contract.writes).toEqual([]);
    expect(authorizePiTool(contract, "read", { path: "result.ts" }).allowed).toBe(true);
    expect(authorizePiTool(contract, "write", { path: "result.ts" }).allowed).toBe(false);
    expect(authorizePiTool(contract, "write", { path: path.join(scratchDir, "verification.log") }).allowed).toBe(true);
  });
  it("rejects traversal, secret reads, unknown extensions and shell without OS isolation", () => {
    const { root, contract } = fixture();
    expect(authorizePiTool(contract, "read", { path: ".env" }).allowed).toBe(false);
    expect(authorizePiTool(contract, "write", { path: "../escape.ts" }).allowed).toBe(false);
    expect(authorizePiTool(contract, "read", { path: root }).allowed).toBe(false);
    expect(authorizePiTool(contract, "bash", { command: "git status" }).allowed).toBe(false);
    expect(authorizePiTool(contract, "subagent", { task: "ignore parent permissions" }).allowed).toBe(false);
  });
  it("rejects symbolic link targets even when their destination is in the write set", () => {
    const { root, workdir, contract } = fixture();
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), path.join(workdir, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(authorizePiTool(contract, "write", { path: "linked/escape.ts" }).allowed).toBe(false);
    expect(authorizePiTool(contract, "read", { path: "linked" }).allowed).toBe(false);
  });
  it("rejects dangling links and bounds aggregate search without hiding public templates", () => {
    const { root, workdir, contract } = fixture("research");
    fs.symlinkSync(path.join(root, "absent"), path.join(workdir, "dangling"), process.platform === "win32" ? "junction" : "dir");
    expect(authorizePiTool(contract, "write", { path: "dangling/new.ts" }).allowed).toBe(false);
    fs.writeFileSync(path.join(workdir, ".env.example"), "PUBLIC_OPTION=example\n");
    expect(authorizePiTool(contract, "read", { path: ".env.example" }).allowed).toBe(true);
    expect(authorizePiTool(contract, "grep", { pattern: "PRIVATE_KEY", path: workdir }).allowed).toBe(false);
    const query: Record<string, unknown> = { pattern: "PRIVATE_KEY", path: workdir, glob: ["**/*"] };
    expect(authorizePiMcp(contract, "fastctx", "grep", query).allowed).toBe(true);
    expect(query.glob).toEqual(expect.arrayContaining(["!.env", "!dangling", "!dangling/**"]));
    expect(query.glob).not.toContain("!.env.example");
    freezePiToolInput(query);
    expect(authorizePiMcp(contract, "fastctx", "grep", query).allowed).toBe(true);
    expect(authorizePiMcp(contract, "fastctx", "grep", Object.freeze({ pattern: ".*", path: workdir })).allowed).toBe(false);
  });
  it("admits process tools only after whole-process isolation and does not cut pure user questions", () => {
    const { contract } = fixture("check"); const { fingerprint, ...body } = contract; void fingerprint;
    const isolated = sealPiRoleContract({ ...body, shell: "isolated", backend: "docker" });
    for (const tool of ["bash", "powershell", "mcpScript", "subagent"]) {
      expect(authorizePiTool(contract, tool, {}).allowed).toBe(false);
      expect(authorizePiTool(isolated, tool, {}).allowed).toBe(true);
    }
    expect(authorizePiTool(contract, "ask_user_question", {}).allowed).toBe(true);
  });
  it("observes actual Docker scope and refuses unexpected writable or privileged mounts", () => {
    const facts = { State: { Running: true, ExitCode: 0, FinishedAt: "" }, Config: { User: "1000:1000" },
      HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] },
      Mounts: [{ Destination: "/workspace", RW: false }, { Destination: "/pactile/scratch", RW: true }] };
    expect(() => assertPiDockerIsolation(facts, ["/pactile/scratch"], "1000:1000")).not.toThrow();
    expect(() => assertPiDockerIsolation({ ...facts, Mounts: [...facts.Mounts, { Destination: "/etc", RW: true }] }, ["/pactile/scratch"], "1000:1000")).toThrow(/isolation/u);
    expect(() => assertPiDockerIsolation({ ...facts, HostConfig: { ...facts.HostConfig, NetworkMode: "bridge" } }, ["/pactile/scratch"], "1000:1000")).toThrow(/isolation/u);
    expect(() => assertPiDockerIsolation({ ...facts, Config: { User: "root" } }, ["/pactile/scratch"], "1000:1000")).toThrow(/isolation/u);
  });
  it("does not treat directory-wide replacement or discovery as remote write approval", () => {
    const { workdir, contract } = fixture();
    expect(authorizePiMcp(contract, "fastctx", "inspect_local_file", { file_path: "result.ts" }).allowed).toBe(true);
    expect(authorizePiMcp(contract, "fastctx", "replace", { path: "result.ts", pattern: "1", replacement: "2" }).allowed).toBe(true);
    expect(authorizePiMcp(contract, "fastctx", "replace", { path: workdir, pattern: ".*", replacement: "" }).allowed).toBe(false);
    expect(authorizePiTool(contract, "mcp", { action: "list" }).allowed).toBe(true);
    expect(authorizePiTool(contract, "mcp", { search: "file query" }).allowed).toBe(true);
    expect(authorizePiTool(contract, "mcp", { describe: "codegraph_explore" }).allowed).toBe(true);
    expect(authorizePiTool(contract, "mcp", { tool: "codegraph_explore", args: "{}" }).allowed).toBe(true);
    expect(authorizePiTool(contract, "mcp", { action: "auth-start", server: "plane" }).allowed).toBe(false);
    expect(authorizePiTool(contract, "mcp", { action: "install" }).allowed).toBe(false);
    expect(authorizePiMcp(contract, "plane", "workitem", { action: "update" }).allowed).toBe(false);
  });
  it("checks exact remote actions and target constraints, independent of model declarations", () => {
    const { contract } = fixture("check"); const { fingerprint, ...body } = contract; void fingerprint;
    const granted = sealPiRoleContract({ ...body, remoteGrants: [{ server: "plane", tool: "workitem", actions: ["retrieve"], arguments: { project_id: "approved-project" } }] });
    expect(authorizePiMcp(granted, "plane", "workitem", { action: "retrieve", project_id: "approved-project" }).allowed).toBe(true);
    expect(authorizePiMcp(granted, "plane", "workitem", { action: "update", project_id: "approved-project", approved: true }).allowed).toBe(false);
    expect(authorizePiMcp(granted, "plane", "workitem", { action: "retrieve", project_id: "another-project" }).allowed).toBe(false);
  });
  it("revokes calls on approval document or Task state changes", () => {
    const { contract, taskDir } = fixture();
    fs.writeFileSync(path.join(taskDir, "approval.md"), "Expanded, unapproved scope.\n");
    expect(authorizePiTool(contract, "write", { path: "result.ts" }).allowed).toBe(false);
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({ status: "cancelled" }));
    expect(() => assertPiRoleContract(contract)).toThrow(/authority|changed/u);
  });
  it("revokes a directory replaced at the same path", () => {
    const { workdir, contract } = fixture("check");
    fs.renameSync(workdir, `${workdir}-original`); fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, "result.ts"), "export const result = 1;\n");
    expect(authorizePiTool(contract, "read", { path: "result.ts" }).allowed).toBe(false);
  });
  it("revokes a Git workspace after its baseline changes", () => {
    const { root, workdir, taskDir, scratchDir } = fixture("check");
    const git = (args: string[]) => execFileSync("git", ["-C", workdir, ...args], { stdio: "ignore", windowsHide: true });
    git(["init", "--quiet"]); git(["add", "result.ts"]);
    git(["-c", "user.name=P48 Fixture", "-c", "user.email=p48@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    const contract = buildPiRoleContract({ root, taskDir, workdir, scratchDir, role: "check", timeoutMs: 60_000, writeSet: [] });
    git(["checkout", "--quiet", "-b", "different-fixture-branch"]);
    expect(authorizePiTool(contract, "read", { path: "result.ts" }).allowed).toBe(false);
  });
  it("preserves Git checkout semantics without relaying credential or executable settings", () => {
    const { workdir } = fixture("check");
    const git = (args: string[]) => execFileSync("git", ["-C", workdir, ...args], { stdio: "ignore", windowsHide: true });
    git(["init", "--quiet"]); git(["config", "core.autocrlf", "true"]);
    git(["config", "remote.origin.url", "https://private-fixture@example.invalid/repo"]);
    git(["config", "core.hooksPath", "private-fixture-hooks"]);
    const config = piDockerGitConfig(workdir);
    expect(config).toContain("autocrlf = true"); expect(config).toContain("filemode = false");
    expect(config).not.toMatch(/origin|private-fixture|hooks/iu);
  });
  it("maps nested Windows prompt paths and distinct mounts without touching sibling paths", () => {
    const root = "D:\\fixture root\\repo";
    const mappings = [{ host: root, runtime: "/workspace" }, { host: `${root}\\task`, runtime: "/pactile/task" }];
    const input = `Read "${root}\\src\\result.ts" and "D:/fixture root/repo/src/result.ts".\nTask "${root}\\task\\verify.md".\nSibling "${root}-copy\\src\\result.ts"; prose \\n.`;
    expect(mapPiDockerPrompt(input, mappings)).toBe('Read "/workspace/src/result.ts" and "/workspace/src/result.ts".\nTask "/pactile/task/verify.md".\nSibling "D:\\fixture root\\repo-copy\\src\\result.ts"; prose \\n.');
  });
  it("rejects tampered/expired contracts and refreshes bindings on resume", () => {
    const { contract, root, workdir, taskDir, scratchDir } = fixture();
    expect(() => assertPiRoleContract({ ...contract, writes: [] })).toThrow(/fingerprint/u);
    expect(() => assertPiRoleContract(contract, Date.parse(contract.expiresAt))).toThrow(/expired/u);
    const resumed = buildPiRoleContract({ root, taskDir, workdir, scratchDir, role: "implement", timeoutMs: 60_000, writeSet: ["new.ts"] });
    expect(resumed.id).not.toBe(contract.id);
    expect(resumed.fingerprint).not.toBe(contract.fingerprint);
    expect(authorizePiTool(resumed, "write", { path: "result.ts" }).allowed).toBe(false);
  });
  it("never grants a readonly role a scratch alias of the candidate or authority", () => {
    const { contract, root, workdir } = fixture("check"); const { fingerprint, ...body } = contract; void fingerprint;
    expect(() => assertPiRoleContract(sealPiRoleContract({ ...body, scratch: { path: root, kind: "directory" } }))).toThrow(/scratch/u);
    expect(() => assertPiRoleContract(sealPiRoleContract({ ...body, scratch: { path: workdir, kind: "directory" } }))).toThrow(/scratch/u);
  });
  it("freezes nested targets so a later Pi handler cannot change admitted inputs", () => {
    const event = { input: { path: "result.ts", files: [{ path: "result.ts" }] } };
    freezePiToolInput(event);
    expect(() => { event.input.path = "unrelated.ts"; }).toThrow(TypeError);
    expect(() => { event.input.files[0].path = "unrelated.ts"; }).toThrow(TypeError);
    expect(() => { event.input = { path: "unrelated.ts", files: [] }; }).toThrow(TypeError);
  });
  it("native extension checks the final MCP broker request and refuses competing authority", async () => {
    const { contract, root } = fixture("check");
    const file = path.join(root, "contract.json"); fs.writeFileSync(file, JSON.stringify(contract));
    const oldFile = process.env.PACTILE_PI_ROLE_CONTRACT; const oldFp = process.env.PACTILE_PI_ROLE_FINGERPRINT;
    process.env.PACTILE_PI_ROLE_CONTRACT = file; process.env.PACTILE_PI_ROLE_FINGERPRINT = contract.fingerprint;
    let handler: ((event: unknown) => void) | undefined;
    const api: PiPolicyExtensionApi = { on: () => undefined, registerCommand: () => undefined, events: { on: (_channel, callback) => { handler = callback; } }, getActiveTools: () => [], getAllTools: () => [], getCommands: () => [] };
    try {
      piRolePolicy(api);
      let decision: (() => string) | undefined;
      handler?.({ serverName: "fastctx", originalToolName: "replace", args: { path: "result.ts" }, claim: (callback: () => string) => { decision = callback; return true; } });
      expect(decision?.()).toBe("deny");
      handler?.({ serverName: "fastctx", originalToolName: "inspect_local_file", args: { file_path: "result.ts" }, claim: (callback: () => string) => { decision = callback; return true; } });
      expect(decision?.()).toBe("allow_once");
      expect(() => handler?.({ serverName: "fastctx", originalToolName: "inspect_local_file", args: {}, claim: () => false })).toThrow(/claimed/u);
    } finally {
      if (oldFile === undefined) delete process.env.PACTILE_PI_ROLE_CONTRACT; else process.env.PACTILE_PI_ROLE_CONTRACT = oldFile;
      if (oldFp === undefined) delete process.env.PACTILE_PI_ROLE_FINGERPRINT; else process.env.PACTILE_PI_ROLE_FINGERPRINT = oldFp;
    }
  });

  it.each(["check", "implement"] as const)("exposes exact native tool IDs only to the %s review role and preserves the error", (role) => {
    const { contract, root } = fixture(role);
    const file = path.join(root, "result-contract.json"); fs.writeFileSync(file, JSON.stringify(contract));
    const oldFile = process.env.PACTILE_PI_ROLE_CONTRACT; const oldFp = process.env.PACTILE_PI_ROLE_FINGERPRINT;
    process.env.PACTILE_PI_ROLE_CONTRACT = file; process.env.PACTILE_PI_ROLE_FINGERPRINT = contract.fingerprint;
    type ResultHandler = Parameters<PiPolicyExtensionApi["on"]>[1];
    let handler: ResultHandler | undefined;
    const api: PiPolicyExtensionApi = { on: (name, callback) => { if (name === "tool_result") handler = callback as ResultHandler; }, registerCommand: () => undefined, events: { on: () => undefined }, getActiveTools: () => [], getAllTools: () => [], getCommands: () => [] };
    try {
      piRolePolicy(api);
      const original = { toolCallId: "call_native_0|fc_native_1", content: [{ type: "text", text: "Command exited with code 1" }], isError: true, details: { exitCode: 1 } };
      const result = handler?.(original, { ui: { notify: () => undefined } });
      if (role === "check") {
        expect(result?.content).toEqual([...original.content, { type: "text", text: `Pactile tool evidence: ${JSON.stringify({ toolCallId: original.toolCallId, reviewToolRef: piReviewToolReferenceV1(original.toolCallId), outcome: "error" })}` }]);
        expect(handler?.({ ...original, toolCallId: "unsafe\nidentity" }, { ui: { notify: () => undefined } })).toBeUndefined();
      } else expect(handler).toBeUndefined();
      expect(original).toEqual({ toolCallId: "call_native_0|fc_native_1", content: [{ type: "text", text: "Command exited with code 1" }], isError: true, details: { exitCode: 1 } });
    } finally {
      if (oldFile === undefined) delete process.env.PACTILE_PI_ROLE_CONTRACT; else process.env.PACTILE_PI_ROLE_CONTRACT = oldFile;
      if (oldFp === undefined) delete process.env.PACTILE_PI_ROLE_FINGERPRINT; else process.env.PACTILE_PI_ROLE_FINGERPRINT = oldFp;
    }
  });
});

describe("Pi isolated inference broker", () => {
  it("does not expose malformed private configuration in JSON parse errors", () => {
    const { root } = fixture("check");
    const file = path.join(root, "invalid-auth.json");
    fs.writeFileSync(file, 'PRIVATE-CONFIGURATION-FIXTURE {"token":"fixture"}');
    expect(() => readPiRoleConfiguration(file)).toThrow("Pi configuration could not be read as JSON; launch blocked");
    fs.writeFileSync(file, '{"configured":true}');
    expect(readPiRoleConfiguration(file)).toEqual({ configured: true });
  });
  it("does not expose resolved credentials in invalid inference header errors", () => {
    const models = { providers: { fixture: { baseUrl: "https://provider.example.invalid/v1", apiKey: "PRIVATE-HEADER-FIXTURE\ninvalid" } } };
    expect(() => resolvePiInferenceTargets(models, {}, (value) => value)).toThrow("Configured Pi inference headers are invalid; launch blocked");
    const custom = { providers: { fixture: { baseUrl: "https://provider.example.invalid/v1", headers: { "x-private-header": "PRIVATE-HEADER-FIXTURE\ninvalid" } } } };
    expect(() => resolvePiInferenceTargets(custom, {}, (value) => value)).toThrow("Configured Pi inference headers are invalid; launch blocked");
  });
  it("uses the trusted Pi resolver for credential helpers and case-insensitive header overrides", () => {
    const values = new Map([["!configured-helper", "private-fixture-key"], ["$CUSTOM_HEADER", "Bearer custom-fixture-key"]]);
    const targets = resolvePiInferenceTargets({ providers: { fixture: { baseUrl: "https://provider.example.invalid/v1", api: "openai-responses", apiKey: "!configured-helper", headers: { Authorization: "$CUSTOM_HEADER" } } } }, {}, (value) => values.get(value));
    expect(targets).toEqual([{ provider: "fixture", baseUrl: "https://provider.example.invalid/v1", headers: { authorization: "Bearer custom-fixture-key" } }]);
    expect(() => resolvePiInferenceTargets({ providers: { fixture: { baseUrl: "https://provider.example.invalid/v1", apiKey: "!failing-helper" } } }, {}, () => { throw new Error("private-fixture-key"); })).toThrow("Configured Pi credential helper failed; inference launch blocked");
  });
  it("binds same-origin providers to distinct trusted credentials and refuses an ambiguous target", async () => {
    const { contract } = fixture("check"); const calls: (string | undefined)[] = [];
    const provider = http.createServer((request, response) => { calls.push(request.headers.authorization); request.resume(); response.end("{}"); });
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
    const relay = await startPiSandboxRelay({ contract, models: [
      { provider: "primary", baseUrl, headers: { authorization: "Bearer primary-fixture" } },
      { provider: "child", baseUrl, headers: { authorization: "Bearer child-fixture" } },
    ], servers: {} });
    const invoke = (selector?: string) => fetch(`http://127.0.0.1:${relay.port}/relay`, { method: "POST", headers: {
      "x-pactile-role-token": relay.token, "x-pactile-role-target": `${baseUrl}/responses`,
      ...(selector ? { [PI_INFERENCE_PROVIDER_HEADER]: selector } : {}),
    }, body: "{}" });
    try {
      expect((await invoke("primary")).status).toBe(200); expect((await invoke("child")).status).toBe(200);
      const ambiguous = await invoke();
      expect(ambiguous.status).toBe(403); expect(ambiguous.headers.get(PI_RELAY_FAILURE_HEADER)).toBe("inference-admission");
      expect(calls).toEqual(["Bearer primary-fixture", "Bearer child-fixture"]);
    } finally { await relay.close(); await new Promise<void>((done) => provider.close(() => done())); }
  });
  it("keeps fixture credentials on the host, rejects unapproved endpoints and revokes on cancellation", async () => {
    const { contract } = fixture("check"); const controller = new AbortController();
    const calls: { url: string; authorization: string | undefined }[] = [];
    const provider = http.createServer((request, response) => {
      calls.push({ url: request.url ?? "", authorization: request.headers.authorization });
      request.resume(); response.setHeader("content-type", "application/json");
      if (calls.length === 2) { response.statusCode = 401; response.end(JSON.stringify({ error: "Bearer private-fixture-key-must-stay-host" })); }
      else response.end(JSON.stringify({ fixture: "model-response" }));
    });
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
    const relay = await startPiSandboxRelay({ contract, models: [{ baseUrl, headers: { authorization: "Bearer private-fixture-key-must-stay-host" } }], servers: {}, signal: controller.signal });
    const endpoint = `http://127.0.0.1:${relay.port}/relay`;
    const request = (target: string, token = relay.token) => fetch(endpoint, { method: "POST", headers: { "x-pactile-role-token": token, "x-pactile-role-target": target, authorization: "Bearer model-supplied-key", "content-type": "application/json" }, body: "{}" });
    try {
      expect((await request(`${baseUrl}/chat/completions`, "wrong-token")).status).toBe(403);
      expect((await request(`${baseUrl}/admin`)).status).toBe(403);
      expect(calls).toEqual([]);
      const positive = await request(`${baseUrl}/chat/completions`);
      expect(await positive.json()).toEqual({ fixture: "model-response" });
      expect(calls[0].authorization).toBe("Bearer private-fixture-key-must-stay-host");
      const rejected = await request(`${baseUrl}/chat/completions`);
      expect(rejected.status).toBe(401);
      expect(await rejected.text()).not.toContain("private-fixture-key-must-stay-host");
      controller.abort();
      expect((await request(`${baseUrl}/chat/completions`)).status).toBe(403);
      expect(calls).toHaveLength(2);
    } finally { await relay.close(); provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done())); }
  });
  it("reports a broken authorized upstream transport without widening endpoint admission or leaking credentials", async () => {
    const { contract } = fixture("check"); let calls = 0;
    const provider = http.createServer((request) => { calls++; request.resume(); request.socket.destroy(); });
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
    const relay = await startPiSandboxRelay({ contract, models: [{ baseUrl, headers: { authorization: "Bearer private-transport-fixture" } }], servers: {} });
    const invoke = (target: string) => fetch(`http://127.0.0.1:${relay.port}/relay`, { method: "POST", headers: { "x-pactile-role-token": relay.token, "x-pactile-role-target": target }, body: "{}" });
    try {
      const failed = await invoke(`${baseUrl}/responses`);
      expect(failed.status).toBe(502); expect(failed.headers.get(PI_RELAY_FAILURE_HEADER)).toBe("upstream-transport");
      const text = await failed.text(); expect(text).toContain("category=upstream-transport"); expect(text).not.toContain("private-transport-fixture");
      const priorCalls = calls; const denied = await invoke(`${baseUrl}/admin`);
      expect(denied.status).toBe(403); expect(denied.headers.get(PI_RELAY_FAILURE_HEADER)).toBe("inference-admission"); expect(calls).toBe(priorCalls);
    } finally { await relay.close(); provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done())); }
  });
  it("still denies revoked source authority before sending an inference request", async () => {
    const { contract } = fixture("check"); let calls = 0;
    const provider = http.createServer((request, response) => { calls++; request.resume(); response.end("{}"); });
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
    const relay = await startPiSandboxRelay({ contract, models: [{ baseUrl, headers: {} }], servers: {} });
    try {
      fs.appendFileSync(contract.sourceGuards[0].path, "\nREVOKED\n");
      const denied = await fetch(`http://127.0.0.1:${relay.port}/relay`, { method: "POST", headers: { "x-pactile-role-token": relay.token, "x-pactile-role-target": `${baseUrl}/responses` }, body: "{}" });
      expect(denied.status).toBe(403); expect(denied.headers.get(PI_RELAY_FAILURE_HEADER)).toBe("contract"); expect(calls).toBe(0);
    } finally { await relay.close(); provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done())); }
  });
  it("terminates a broken upstream stream without appending a fabricated relay response", async () => {
    const { contract } = fixture("check"); let breakStream: (() => void) | undefined;
    const provider = http.createServer((request, response) => { request.resume(); response.writeHead(200, { "content-type": "text/event-stream" }); response.write('data: {"fixture":"partial"}\n\n'); breakStream = () => response.destroy(); });
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
    const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
    const relay = await startPiSandboxRelay({ contract, models: [{ baseUrl, headers: {} }], servers: {} });
    try {
      const result = await fetch(`http://127.0.0.1:${relay.port}/relay`, { method: "POST", headers: { "x-pactile-role-token": relay.token, "x-pactile-role-target": `${baseUrl}/responses` }, body: "{}" });
      expect(result.status).toBe(200);
      if (!result.body || !breakStream) throw new Error("Upstream stream fixture did not become ready");
      const reader = result.body.getReader(); const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"fixture":"partial"');
      expect(breakStream).toBeTypeOf("function"); breakStream();
      await expect(reader.read()).rejects.toThrow();
      reader.releaseLock();
    } finally { await relay.close(); provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done())); }
  });
});
