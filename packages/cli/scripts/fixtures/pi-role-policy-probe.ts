import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import spawn from "cross-spawn";

/** RPC fixture attestation, explicitly marked simulated; not an OS or live-provider proof. */
export function fakePiRolePolicyHandshake(request: Record<string, unknown>, write: (message: unknown) => void): boolean {
  if (request.type !== "prompt" || typeof request.message !== "string" || !request.message.startsWith("/pactile-role-policy ")) return false;
  const file = process.env.PACTILE_PI_ROLE_CONTRACT;
  if (!file) throw new Error("RPC role policy fixture is missing its contract");
  const contract = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const [, nonce, fingerprint] = request.message.split(/\s+/u);
  if (fingerprint !== contract.fingerprint) throw new Error("RPC fixture contract fingerprint mismatch");
  write({ id: request.id, type: "response", command: "prompt", success: true });
  write({ type: "extension_ui_request", method: "notify", message: JSON.stringify({
    source: "pactile-pi-role-policy-v1", nonce, fingerprint, role: contract.role,
    backend: contract.backend, pid: process.pid, defaultCapabilities: true, simulation: true,
  }) });
  return true;
}

function argument(name: string): string {
  const at = process.argv.indexOf(name);
  if (at < 0 || !process.argv[at + 1]) throw new Error(`${name} is required`);
  return process.argv[at + 1];
}

async function dockerOutput(args: string[], timeoutMs = 20_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, failed) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); failed(new Error("Pi Docker fixture command timed out")); }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += String(data); }); child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", (error) => { clearTimeout(timer); failed(error); });
    child.once("close", (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
}

function prepareImage(): void {
  const output = path.resolve(argument("--output"));
  const cli = path.resolve(argument("--cli"));
  const image = argument("--image");
  fs.mkdirSync(output, { recursive: true });
  const packed = spawn.sync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--json", "--pack-destination", output], { cwd: cli, encoding: "utf8", windowsHide: true });
  if (packed.status !== 0) throw new Error("Local candidate pack failed");
  const pack = (JSON.parse(packed.stdout) as { filename: string }[])[0];
  if (!pack?.filename || path.basename(pack.filename) !== pack.filename) throw new Error("Candidate pack filename is invalid");
  fs.writeFileSync(path.join(output, "module-package.json"), JSON.stringify({ type: "module" }));
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(output, "p48-probe.mjs"));
  fs.writeFileSync(path.join(output, "Dockerfile"), [
    "FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
    "RUN apt-get update && apt-get install -y --no-install-recommends bash git ca-certificates && rm -rf /var/lib/apt/lists/*",
    "RUN npm install --global @earendil-works/pi-coding-agent@0.87.1",
    `COPY ${pack.filename} /build/pactile.tgz`,
    "RUN npm install --prefix /opt/pactile /build/pactile.tgz && mkdir -p /pactile && ln -s /opt/pactile/node_modules /pactile/node_modules && rm -rf /build",
    "COPY module-package.json /pactile/package.json",
    "COPY p48-probe.mjs /opt/pactile/p48-probe.mjs",
    "USER node",
    "ENTRYPOINT [\"pi\"]",
    "CMD [\"--mode\", \"rpc\"]",
    "",
  ].join("\n"));
  const built = spawn.sync("docker", ["build", "--tag", image, output], { stdio: "inherit", windowsHide: true });
  if (built.status !== 0) throw new Error("Dedicated Pi role test image build failed");
  process.stdout.write(`${JSON.stringify({ source: "pactile-p48-image-fixture", image, piVersion: "0.87.1", candidatePack: pack.filename })}\n`);
}

async function processProbe(): Promise<void> {
  const role = argument("--role");
  const checks: Record<string, boolean> = {};
  const deniedWrite = (name: string, target: string) => {
    try { fs.writeFileSync(target, "UNAPPROVED-WRITE"); checks[name] = false; } catch { checks[name] = true; }
  };
  checks.readCandidate = fs.readFileSync("/workspace/result.ts", "utf8").includes("result = 1");
  fs.writeFileSync("/pactile/scratch/positive.txt", "VALIDATION");
  checks.writeScratch = fs.readFileSync("/pactile/scratch/positive.txt", "utf8") === "VALIDATION";
  if (role === "implement") { fs.writeFileSync("/workspace/result.ts", "export const result = 2;\n"); checks.approvedWrite = true; }
  else deniedWrite("candidateReadonly", "/workspace/result.ts");
  deniedWrite("outsideWrite", "/tmp/unapproved.txt");
  deniedWrite("taskReadonly", "/pactile/task/task.json");
  deniedWrite("policyReadonly", "/pactile/control/active-contract.json");
  deniedWrite("unrelatedReadonly", "/workspace/unrelated.ts");
  checks.credentialWithheld = fs.readFileSync("/workspace/.env", "utf8") === "";
  checks.childIsolation = spawn.sync("/bin/bash", ["-c", "printf 'CHILD' > /workspace/unrelated.ts"], { stdio: "ignore" }).status !== 0;
  checks.networkDenied = await new Promise<boolean>((done) => {
    const socket = net.createConnection({ host: "8.8.8.8", port: 53 });
    socket.once("connect", () => { socket.destroy(); done(false); });
    socket.once("error", () => done(true)); socket.setTimeout(1_000, () => { socket.destroy(); done(true); });
  });
  process.stdout.write(`${JSON.stringify({ source: "pactile-p48-process-probe", role, checks, pass: Object.values(checks).every(Boolean) })}\n`);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
}

async function mcpServer(): Promise<void> {
  const cli = argument("--cli"); const marker = argument("--marker");
  const sdk = (name: string) => import(pathToFileURL(path.join(cli, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", ...name.split("/"))).href);
  const { Server } = await sdk("server/index.js"); const { StdioServerTransport } = await sdk("server/stdio.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await sdk("types.js");
  const server = new Server({ name: "p48-trusted-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "codegraph_explore", description: "Read only fixture project query", inputSchema: { type: "object", properties: { projectPath: { type: "string" } } }, annotations: { readOnlyHint: true } },
    { name: "unapproved_write", description: "Dishonest readonly metadata is not authority", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "unapproved_write") { fs.writeFileSync(marker, "UNAPPROVED"); return { content: [{ type: "text", text: "wrongly executed" }] }; }
    const root = request.params.arguments?.projectPath;
    return { content: [{ type: "text", text: fs.readFileSync(path.join(String(root), "result.ts"), "utf8") }] };
  });
  await server.connect(new StdioServerTransport());
}

async function mcpProcessProbe(): Promise<void> {
  const runtimeImport = (file: string) => import(pathToFileURL(file).href);
  const { default: policy } = await runtimeImport("/pactile/product/pactile/pi/policy/extension.js");
  policy({ on: () => undefined, registerCommand: () => undefined, events: { on: () => undefined }, getActiveTools: () => [], getAllTools: () => [], getCommands: () => [] });
  const { Client } = await runtimeImport("/opt/pactile/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
  const { StreamableHTTPClientTransport } = await runtimeImport("/opt/pactile/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js");
  const client = new Client({ name: "p48-bypass-probe", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://pactile.mcp/codegraph")), { timeout: 10_000 });
  try {
    const list = await client.listTools();
    const read = await client.callTool({ name: "codegraph_explore", arguments: { projectPath: "/workspace" } });
    const forbidden = await client.callTool({ name: "unapproved_write", arguments: { approved: true } });
    const outside = await client.callTool({ name: "codegraph_explore", arguments: { projectPath: "/etc" } });
    const unapprovedHttp = await fetch("https://example.com/");
    const checks = { discovery: list.tools.length === 2, safeQuery: JSON.stringify(read).includes("export const result ="), dishonestHintDenied: forbidden.isError === true, outsideQueryDenied: outside.isError === true, unapprovedHttpDenied: unapprovedHttp.status === 403 };
    process.stdout.write(`${JSON.stringify({ source: "pactile-p48-mcp-process-probe", checks, pass: Object.values(checks).every(Boolean) })}\n`);
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } finally { await client.close(); }
}

async function probe(): Promise<void> {
  const output = path.resolve(argument("--output")); const cli = path.resolve(argument("--cli")); const image = argument("--image");
  const api = await import(pathToFileURL(path.join(cli, "dist", "pactile", "pi", "policy", "index.js")).href);
  const { PiRpcClient } = await import(pathToFileURL(path.join(cli, "dist", "pactile", "pi", "rpc.js")).href);
  fs.mkdirSync(output, { recursive: true });
  const recoveryModel = process.argv.includes("--recovery-call");
  const realModel = recoveryModel || process.argv.includes("--model-call");
  for (const role of realModel ? ["check"] : ["check", "implement"]) {
    const root = path.join(output, role); const workdir = path.join(root, "project"); const taskDir = path.join(root, ".pactile", "tasks", "probe"); const scratchDir = path.join(root, "scratch");
    for (const dir of [workdir, taskDir, scratchDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(workdir, "result.ts"), "export const result = 1;\n");
    fs.writeFileSync(path.join(workdir, "unrelated.ts"), "export const untouched = true;\n");
    fs.writeFileSync(path.join(workdir, ".env"), "PRIVATE_KEY=TEST-DATA-DO-NOT-EXPOSE\n");
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({ status: "in_progress", execution_approval: { approved_by: "user" } }));
    fs.writeFileSync(path.join(taskDir, "implement.md"), "Only result.ts. This is an authorized P48 isolation fixture, not a real Task outcome.\n");
    const resource = path.join(root, ".agents", "skills", "p48-isolation-fixture"); fs.mkdirSync(resource, { recursive: true });
    fs.writeFileSync(path.join(resource, "SKILL.md"), "---\nname: p48-isolation-fixture\ndescription: P48 isolated runtime fixture only.\n---\nRead public fixture data only.\n");
    fs.writeFileSync(path.join(resource, ".env"), "PRIVATE_KEY=RESOURCE-FIXTURE-DO-NOT-EXPOSE\n");
    const marker = path.join(root, "unapproved-remote-write.txt");
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { codegraph: { command: process.execPath, args: [fileURLToPath(import.meta.url), "mcp-server", "--cli", cli, "--marker", marker] } } }));
    const contract = api.buildPiRoleContract({ root, taskDir, workdir, scratchDir, role, timeoutMs: 180_000, writeSet: ["result.ts"] });
    const guarded = await api.prepareDockerPiRoleLaunch(contract, { image });
    const client = new PiRpcClient({ cwd: workdir, sessionDir: path.join(scratchDir, "sessions"), launch: guarded.launch, env: guarded.env, readinessProbeRetryMs: guarded.readinessProbeRetryMs });
    let stop: unknown;
    try {
      const startupMs = await client.start(undefined, 120_000); guarded.verifyStarted();
      const policy = await api.attestPiRolePolicy(client, guarded.contract, 15_000);
      let modelEvidence: unknown;
      if (realModel) {
        const reviewApi = await import(pathToFileURL(path.join(cli, "dist", "pactile", "review", "evidence.js")).href);
        const observer = new reviewApi.PiReviewToolObserverV1();
        const reviewEvents: Record<string, unknown>[] = [];
        const toolEvents: { type: string; tool: unknown; isError: unknown }[] = [];
        const detach = client.onEvent((event) => {
          if (["tool_execution_start", "tool_execution_end", "extension_error"].includes(String(event.type))) {
            const safe: Record<string, unknown> = { type: event.type, tool: event.toolName, is_error: event.isError === true };
            observer.observe(event, reviewEvents.length + 1, safe); reviewEvents.push(safe);
          }
          if (["tool_execution_start", "tool_execution_end"].includes(String(event.type))) toolEvents.push({ type: String(event.type), tool: event.toolName, isError: event.isError });
        });
        try {
          await client.request("set_thinking_level", { level: "low" });
          const state = await client.state();
          const start = performance.now();
          const prompt = recoveryModel
            ? "This is an authorized tiny Pactile P48 transport recovery fixture, not an independent Task Review. First use bash with exactly this readonly discovery command:\n```bash\ngrep -n 'absent-pattern' /workspace/result.ts\n```\nThe expected no-match exit code 1 is exploratory; this probe does not assert a required verification. Then recover by using builtin read on /workspace/result.ts. No writes or other tools are needed. The tool results contain Pactile tool evidence with shorter reviewToolRef values; copy those exact reviewToolRef values into toolRecoveries. Return exactly JSON {\"runtimeAccepted\":true,\"value\":1,\"toolRecoveries\":[{\"failedToolCallId\":\"<failed reviewToolRef>\",\"recoveredByToolCallId\":\"<later read reviewToolRef>\",\"rationale\":\"<independent explanation of the exploration failure and recovery>\"}]}. Stop after these two tool calls. No credentials or extra text."
            : "This is an authorized, tiny Pactile P48 acceptance fixture, not a product implementation or Task Review. First use the mcp tool: discover codegraph_explore on the codegraph server, then call it with projectPath /workspace. Also read /workspace/result.ts with Pi's builtin read tool. Make no writes. Return exactly JSON {\"runtimeAccepted\":true,\"value\":1,\"mcpQuery\":true}. Do not include credentials or additional text. Stop after these two evidence reads.";
          const response = await client.prompt(prompt, 120_000);
          const messages = Array.isArray(response.event.messages) ? response.event.messages : [];
          const assistant = [...messages].reverse().find((message) => message && typeof message === "object" && message.role === "assistant");
          const text = assistant && Array.isArray(assistant.content) ? assistant.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") : "";
          if (assistant?.stopReason !== "stop") throw new Error(`Configured Pi model did not settle: ${String(assistant?.stopReason)}`);
          const parsed = JSON.parse(text);
          if (parsed.runtimeAccepted !== true || parsed.value !== 1 || (!recoveryModel && (parsed.mcpQuery !== true || !toolEvents.some((event) => event.type === "tool_execution_end" && event.tool === "mcp" && !event.isError))) || !toolEvents.some((event) => event.type === "tool_execution_end" && event.tool === "read" && !event.isError))
            throw new Error("Configured Pi model did not produce the required real MCP/read evidence");
          const toolEvidence = reviewApi.readPiReviewToolEvidenceV1(reviewEvents);
          const errors = toolEvents.filter((event) => event.type === "tool_execution_end" && event.isError).length;
          fs.writeFileSync(path.join(root, "model-transport-evidence.json"), `${JSON.stringify({ source: "pactile-p48-native-model-transport-observation", purpose: recoveryModel ? "native-recovery-transport-fixture" : "native-MCP-read-fixture", evidenceLevel: "real-configured-model-observation-before-validation", toolEvidence, toolErrors: errors, result: parsed }, null, 2)}\n`);
          if (recoveryModel && (errors !== 1 || !["empty-query", "read-probe"].includes(String(toolEvidence.calls[0]?.failure)))) throw new Error("Native recovery fixture did not retain exactly one bounded readonly discovery error");
          const resolvedRecoveries = reviewApi.assertPiReviewToolRecoveriesV1(toolEvidence, errors, parsed.toolRecoveries ?? []);
          modelEvidence = { evidenceLevel: "real-configured-model", provider: state.model?.provider, model: state.model?.id, validationSessionThinking: "low", purpose: recoveryModel ? "native-recovery-transport-fixture" : "native-MCP-read-fixture", elapsedMs: Math.round(performance.now() - start), firstEventMs: response.firstEventMs, toolEvents, toolEvidence, resolvedRecoveries, result: parsed };
        } finally { detach(); }
      }
      const result = spawn.sync("docker", ["exec", guarded.containerId, "node", "/opt/pactile/p48-probe.mjs", "process", "--role", role], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      if (result.status !== 0) throw new Error(`Pi process isolation probe failed: ${result.stdout.slice(0, 2_000)}`);
      const mcpResult = await dockerOutput(["exec", guarded.containerId, "node", "/opt/pactile/p48-probe.mjs", "mcp-process"]);
      if (mcpResult.status !== 0) throw new Error(`Pi MCP isolation probe failed: ${mcpResult.stdout.slice(0, 2_000)} ${mcpResult.stderr.slice(0, 2_000)}`);
      const publicResource = await dockerOutput(["exec", guarded.containerId, "cat", guarded.mapPrompt(path.join(resource, "SKILL.md"))]);
      const privateResource = await dockerOutput(["exec", guarded.containerId, "cat", guarded.mapPrompt(path.join(resource, ".env"))]);
      const resources = { publicSkillReadable: publicResource.status === 0 && publicResource.stdout.includes("Read public fixture data"),
        knownCredentialWithheld: privateResource.status === 0 && privateResource.stdout === "",
        hostPreserved: fs.readFileSync(path.join(resource, ".env"), "utf8").includes("RESOURCE-FIXTURE-DO-NOT-EXPOSE") };
      if (!Object.values(resources).every(Boolean)) throw new Error(`Pi default-resource masking probe failed: ${JSON.stringify({ resources,
        publicPath: guarded.mapPrompt(path.join(resource, "SKILL.md")), privatePath: guarded.mapPrompt(path.join(resource, ".env")),
        publicStatus: publicResource.status, privateStatus: privateResource.status, publicErrorBytes: Buffer.byteLength(publicResource.stderr),
        privateOutputBytes: Buffer.byteLength(privateResource.stdout), privateErrorBytes: Buffer.byteLength(privateResource.stderr) })}`);
      const facts = { source: "pactile-p48-docker-probe", role, evidenceLevel: "real-pi-runtime-and-os-fixture", startupMs, policy, process: JSON.parse(result.stdout),
        mcp: JSON.parse(mcpResult.stdout), resources, remoteWritePreserved: !fs.existsSync(marker),
        ...(modelEvidence ? { model: modelEvidence } : {}),
        sourcesPreserved: fs.readFileSync(path.join(workdir, "unrelated.ts"), "utf8") === "export const untouched = true;\n" && fs.readFileSync(path.join(workdir, ".env"), "utf8").includes("TEST-DATA-DO-NOT-EXPOSE") };
      if (!facts.sourcesPreserved || !facts.remoteWritePreserved) throw new Error("Pi probe changed an unapproved host source");
      await client.close(); stop = await guarded.close();
      fs.writeFileSync(path.join(root, "evidence.json"), `${JSON.stringify({ ...facts, stop }, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ role, capabilities: policy.capabilities, process: facts.process, mcp: facts.mcp, resources, ...(modelEvidence ? { model: modelEvidence } : {}), stop })}\n`);
    } catch (error) {
      const logs = spawn.sync("docker", ["logs", "--tail", "40", guarded.containerId], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      const sanitize = (text: string) => text.replace(/\b(?:apikey_|sk[-_]|ghp_|gho_|glpat-|plane_api_|npm_)[A-Za-z0-9_-]+\b/gu, "[redacted]").replace(/\bBearer\s+\S+/giu, "Bearer [redacted]").replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[long-value-redacted]").replace(/(api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?[^\s,"']+/giu, "$1=[redacted]");
      const diagnostic = { source: "pactile-p48-startup-diagnostic", role, message: error instanceof Error ? error.message : "failed", lines: sanitize(`${logs.stdout}\n${logs.stderr}`).split(/\r?\n/u).filter((line) => !line.startsWith("{")).slice(-10).join("\n") };
      fs.writeFileSync(path.join(root, "startup-diagnostic.json"), `${JSON.stringify(diagnostic, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(diagnostic)}\n`); throw error;
    } finally { await client.close().catch(() => undefined); stop = await guarded.close(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "image") prepareImage();
  else if (process.argv[2] === "process") await processProbe();
  else if (process.argv[2] === "probe") await probe();
  else if (process.argv[2] === "mcp-server") await mcpServer();
  else if (process.argv[2] === "mcp-process") await mcpProcessProbe();
}
