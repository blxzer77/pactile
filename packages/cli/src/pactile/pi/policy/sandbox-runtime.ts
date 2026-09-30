import http from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { assertPiRoleContract, type PiRoleContract } from "./contract.js";
import { authorizePiMcp } from "./decision.js";

export const PI_INFERENCE_PROVIDER_HEADER = "x-pactile-inference-provider";
export const PI_RELAY_FAILURE_HEADER = "x-pactile-role-relay-failure";
export interface PiModelRelayTarget { provider?: string; baseUrl: string; headers: Record<string, string>; }
export interface PiMcpRelayTarget { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; transport?: string; }
export interface PiSandboxRelay {
  port: number;
  token: string;
  modelOrigins: string[];
  mcpServers: string[];
  close(): Promise<void>;
}

function modelEndpoint(url: URL, base: URL): boolean {
  if (url.origin !== base.origin || url.username || url.password || url.hash) return false;
  const prefix = base.pathname.replace(/\/$/u, "");
  return ["/chat/completions", "/responses", "/messages"].some((suffix) => url.pathname === `${prefix}${suffix}`)
    && [...url.searchParams.keys()].every((key) => key === "api-version");
}

function relayArguments(args: Record<string, unknown>, contract: PiRoleContract, resources: { runtime: string; host: string }[]): Record<string, unknown> {
  const mappings = [...resources, { runtime: "/workspace", host: contract.cwd }, { runtime: "/pactile/task", host: contract.reads[1].path }, { runtime: "/pactile/scratch", host: contract.scratch.path }].sort((a, b) => b.runtime.length - a.runtime.length);
  const map = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(map);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (["path", "file_path", "projectPath"].includes(key) && typeof item === "string") {
        for (const { runtime, host } of mappings)
          if (item === runtime || item.startsWith(`${runtime}/`)) return [key, `${host}${item.slice(runtime.length)}`];
      }
      return [key, map(item)];
    }));
  };
  return map(args) as Record<string, unknown>;
}

/** Per-execution trusted broker. It uses the official SDK, not a new MCP protocol. */
export async function startPiSandboxRelay(input: {
  contract: PiRoleContract;
  models: PiModelRelayTarget[];
  servers: Record<string, PiMcpRelayTarget>;
  /** Trusted mappings from the actual readonly resource mounts; never worker-supplied. */
  pathMappings?: { runtime: string; host: string }[];
  signal?: AbortSignal;
}): Promise<PiSandboxRelay> {
  const token = randomBytes(32).toString("hex");
  const models = input.models.map((target) => ({ ...target, base: new URL(target.baseUrl) }));
  for (const target of models) {
    if (!["http:", "https:"].includes(target.base.protocol) || target.base.username || target.base.password)
      throw new Error("Pi model relay target is not a configured HTTP inference endpoint");
  }
  const clients = new Map<string, Promise<Client>>();
  const sessions = new Map<string, { target: string; transport: StreamableHTTPServerTransport; server: Server }>();
  const active = new Set<AbortController>();
  let closing = false;
  const clientFor = (name: string): Promise<Client> => {
    const prior = clients.get(name); if (prior) return prior;
    const definition = input.servers[name];
    if (!definition) return Promise.reject(new Error("MCP server is outside the admitted configuration"));
    const connected = (async () => {
      const client = new Client({ name: "pactile-pi-role-broker", version: "1" });
      const transport = definition.url
        ? definition.transport === "sse"
          ? new SSEClientTransport(new URL(definition.url), { requestInit: { headers: definition.headers } })
          : new StreamableHTTPClientTransport(new URL(definition.url), { requestInit: { headers: definition.headers } })
        : new StdioClientTransport({ command: definition.command ?? "", args: definition.args,
          cwd: input.contract.cwd, env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), ...definition.env }, stderr: "pipe" });
      if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => undefined);
      await client.connect(transport, { timeout: Math.min(15_000, Math.max(1, Date.parse(input.contract.expiresAt) - Date.now())), signal: input.signal }); return client;
    })();
    clients.set(name, connected); return connected;
  };

  const createMcpSession = async (name: string): Promise<{ target: string; server: Server; transport: StreamableHTTPServerTransport }> => {
    const upstream = await clientFor(name);
    const server = new Server({ name: `pactile-role-${name}`, version: "1" }, { capabilities: { tools: { listChanged: false } } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      assertPiRoleContract(input.contract);
      const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const result = await upstream.listTools(cursor ? { cursor } : undefined);
        tools.push(...result.tools); cursor = result.nextCursor;
        if (!cursor) return { tools };
      }
      throw new Error("MCP discovery exceeds its page budget");
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      assertPiRoleContract(input.contract);
      const args = relayArguments(request.params.arguments ?? {}, input.contract, input.pathMappings ?? []);
      // Omitted paths must resolve to the admitted candidate, not a server's wider default CWD.
      if (["fastctx", "fast-context"].includes(name) && ["grep", "glob"].includes(request.params.name) && args.path === undefined)
        args.path = input.contract.cwd;
      if (name === "codegraph" && request.params.name === "codegraph_explore" && args.projectPath === undefined)
        args.projectPath = input.contract.cwd;
      const decision = authorizePiMcp(input.contract, name, request.params.name, args);
      if (!decision.allowed) return { isError: true, content: [{ type: "text", text: `Pactile role policy: ${decision.reason}` }] };
      // No arbitrary prompts/resources/sampling are relayed across the trust boundary.
      return upstream.callTool({ name: request.params.name, arguments: args }, undefined, { signal: extra.signal });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomBytes(24).toString("hex"), enableJsonResponse: true });
    await server.connect(transport);
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    return { target: name, server, transport };
  };

  const server = http.createServer(async (request, response) => {
    if (closing || input.signal?.aborted || request.headers["x-pactile-role-token"] !== token) {
      response.writeHead(403, { [PI_RELAY_FAILURE_HEADER]: "admission" }); response.end("Pactile role relay denied"); return;
    }
    let failure: "contract" | "target" | "request-body" | "mcp-action" | "inference-admission" | "upstream-transport" | "upstream-stream" = "contract";
    try {
      assertPiRoleContract(input.contract);
      failure = "target";
      const targetHeader = request.headers["x-pactile-role-target"];
      if (typeof targetHeader !== "string") throw new Error("No admitted relay target");
      const target = new URL(targetHeader);
      failure = "request-body";
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 4 * 1024 * 1024) throw new Error("Pi relay request exceeds 4 MiB");
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks);
      if (target.hostname === "pactile.mcp" && target.protocol === "http:") {
        failure = "mcp-action";
        const name = decodeURIComponent(target.pathname.slice(1));
        if (!(name in input.servers)) throw new Error("MCP relay target is not configured");
        const parsed: unknown = body.length ? JSON.parse(body.toString("utf8")) : undefined;
        const sessionHeader = request.headers["mcp-session-id"];
        let session = typeof sessionHeader === "string" ? sessions.get(sessionHeader) : undefined;
        if (session && session.target !== name) throw new Error("MCP session target changed");
        if (!session) {
          if (request.method !== "POST" || !isInitializeRequest(parsed)) throw new Error("MCP relay requires an SDK initialization");
          session = await createMcpSession(name);
        }
        await session.transport.handleRequest(request, response, parsed);
        if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
        return;
      }
      failure = "inference-admission";
      const selector = request.headers[PI_INFERENCE_PROVIDER_HEADER];
      const candidates = models.filter((candidate) => modelEndpoint(target, candidate.base) && (!candidate.provider || candidate.provider === selector));
      const model = candidates.length === 1 ? candidates[0] : undefined;
      if (!model || request.method !== "POST") throw new Error("Only configured inference endpoints are admitted");
      // Model credentials stay in this trusted process. Worker auth values are ignored.
      const controller = new AbortController(); active.add(controller);
      const abort = (): void => controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      response.once("close", () => { if (!response.writableEnded) abort(); });
      try {
        const allowedHeaders = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta"];
        const headers = Object.fromEntries(allowedHeaders.flatMap((key) => typeof request.headers[key] === "string" ? [[key, request.headers[key] as string]] : []));
        failure = "upstream-transport";
        const upstream = await fetch(target, { method: "POST", headers: { ...headers, ...model.headers }, body, signal: controller.signal, redirect: "error" });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          response.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store", [PI_RELAY_FAILURE_HEADER]: "upstream-response" });
          response.end(JSON.stringify({ error: { message: "Configured inference provider rejected the request", status: upstream.status } }));
          return;
        }
        failure = "upstream-stream";
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
        if (!upstream.body) response.end();
        else await new Promise<void>((done, failed) => {
          const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
          stream.once("error", failed); response.once("finish", done); response.once("close", done); stream.pipe(response);
        });
      } finally { active.delete(controller); input.signal?.removeEventListener("abort", abort); }
    } catch {
      // A failed inference transport is not an authority grant. Keep the original
      // admission gates and expose only fixed categories, never raw errors/keys.
      if (response.headersSent) { response.destroy(); return; }
      const upstreamFailed = failure === "upstream-transport" || failure === "upstream-stream";
      response.writeHead(upstreamFailed ? 502 : 403, { "content-type": "text/plain", "cache-control": "no-store", [PI_RELAY_FAILURE_HEADER]: failure });
      response.end(`Pactile role relay rejected an unavailable or unapproved action; category=${failure}`);
    }
  });
  // Authentication is required before reading a body; the ephemeral port is not an authority.
  await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(0, "0.0.0.0", done); });
  return {
    port: (server.address() as AddressInfo).port, token,
    modelOrigins: [...new Set(models.map((target) => target.base.origin))], mcpServers: Object.keys(input.servers),
    close: async () => {
      closing = true; for (const controller of active) controller.abort();
      for (const session of sessions.values()) { await session.server.close().catch(() => undefined); }
      for (const promise of clients.values()) { try { await (await promise).close(); } catch { /* Already failed upstream. */ } }
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
