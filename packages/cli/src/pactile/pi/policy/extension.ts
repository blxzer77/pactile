import fs from "node:fs";
import { Agent, fetch as socketFetch } from "undici";
import { assertPiRoleContract, piRoleContractSchema, piRolePermissionFingerprint, type PiRoleContract } from "./contract.js";
import { authorizePiMcp, authorizePiTool, freezePiToolInput } from "./decision.js";
import { PI_REVIEW_TOOL_CALL_ID_PATTERN, piReviewToolReferenceV1 } from "../../review/evidence.js";

// This narrow structural seam uses Pi's documented ExtensionAPI. Pi remains an optional host.
interface PiPolicyContext { ui: { notify(message: string, type?: "info" | "warning" | "error"): void }; }
interface PiToolCall { type: string; toolName: string; toolCallId: string; input: Record<string, unknown>; }
interface PiToolResult { toolCallId: string; content: unknown[]; isError: boolean; }
interface PiApprovalRequest {
  serverName: string; originalToolName: string; args: Record<string, unknown>;
  claim(handler: () => "allow_once" | "deny"): boolean;
}
export interface PiPolicyExtensionApi {
  on(event: "tool_call", handler: (event: PiToolCall, ctx: PiPolicyContext) => { block: true; reason: string } | undefined): unknown;
  on(event: "tool_result", handler: (event: PiToolResult, ctx: PiPolicyContext) => { content: unknown[] } | undefined): unknown;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: PiPolicyContext): Promise<void> }): void;
  events: { on(channel: string, handler: (event: unknown) => void): unknown };
  getActiveTools(): string[];
  getAllTools(): { name: string }[];
  getCommands(): { name: string; source?: string }[];
}

export const PI_POLICY_PROOF_SOURCE = "pactile-pi-role-policy-v1";

/** No tools/extensions/skills are disabled. This additional extension guards actions. */
export default function piRolePolicy(pi: PiPolicyExtensionApi): void {
  const file = process.env.PACTILE_PI_ROLE_CONTRACT;
  const expected = process.env.PACTILE_PI_ROLE_FINGERPRINT;
  if (!file || !expected) throw new Error("Pactile Pi role policy requires a host-issued contract");
  let contract: PiRoleContract = piRoleContractSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (contract.fingerprint !== expected) throw new Error("Pactile Pi role policy contract was replaced");
  assertPiRoleContract(contract);
  const permissions = piRolePermissionFingerprint(contract);
  if (contract.relay) {
    const relay = contract.relay;
    const dispatcher = new Agent({ connect: { socketPath: relay.socketPath } });
    // Pi's existing HTTP provider implementations and MCP SDK keep their wire protocols.
    // Only their HTTP transport is routed through the private Unix socket in this worker.
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const headers = Object.fromEntries(request.headers);
      headers["x-pactile-role-token"] = relay.token;
      headers["x-pactile-role-target"] = request.url;
      const response = await socketFetch("http://pactile.role/relay", {
        method: request.method, headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer()),
        signal: request.signal, dispatcher,
      });
      return new Response(response.body as unknown as ReadableStream<Uint8Array>, {
        status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers),
      });
    };
  }

  pi.registerCommand("pactile-role-policy", {
    description: "Attest the host-issued Pactile role policy before any worker prompt",
    handler: async (args, ctx) => {
      const [nonce, fingerprint] = args.trim().split(/\s+/u);
      const fresh = piRoleContractSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (fresh.fingerprint !== fingerprint || piRolePermissionFingerprint(fresh) !== permissions)
        throw new Error("Changed Pi authority or permissions require a fresh process");
      contract = fresh;
      assertPiRoleContract(contract);
      if (!/^[a-f0-9]{64}$/u.test(nonce)) throw new Error("Pactile role policy handshake nonce is malformed");
      const capabilities = { activeTools: pi.getActiveTools(), configuredTools: pi.getAllTools().map((tool) => tool.name),
        skillCommands: pi.getCommands().filter((command) => command.source === "skill").map((command) => command.name),
        extensionCommands: pi.getCommands().filter((command) => command.source === "extension").map((command) => command.name) };
      ctx.ui.notify(JSON.stringify({ source: PI_POLICY_PROOF_SOURCE, nonce,
        fingerprint: contract.fingerprint, role: contract.role, backend: contract.backend,
        pid: process.pid, defaultCapabilities: true, capabilities }), "info");
    },
  });

  pi.on("tool_call", (event, ctx) => {
    const decision = authorizePiTool(contract, event.toolName, event.input);
    ctx.ui.notify(JSON.stringify({ source: PI_POLICY_PROOF_SOURCE, kind: "action",
      fingerprint: contract.fingerprint, toolCallId: event.toolCallId,
      allowed: decision.allowed, action: decision.action, reason: decision.reason }), "info");
    if (!decision.allowed) return { block: true, reason: `Pactile role policy: ${decision.reason}` };
    // Pi permits later handlers to replace/mutate inputs without revalidation. Freeze the
    // admitted event recursively so a later target change fails before tool execution.
    freezePiToolInput(event);
    return undefined;
  });

  // Provider wire call IDs may omit Pi's compound identity. Make the exact
  // transport identity visible to the reviewer without changing the result.
  if (contract.role === "check") pi.on("tool_result", (event) => {
    if (!PI_REVIEW_TOOL_CALL_ID_PATTERN.test(event.toolCallId) || !Array.isArray(event.content)) return undefined;
    return { content: [...event.content, { type: "text", text: `Pactile tool evidence: ${JSON.stringify({ toolCallId: event.toolCallId, reviewToolRef: piReviewToolReferenceV1(event.toolCallId), outcome: event.isError ? "error" : "success" })}` }] };
  });

  // The mature adapter also checks script/resource/direct/namespace calls at its final seam.
  // A server/session-wide prior approval never widens the Task's role contract.
  pi.events.on("pi-mcp-adapter:tool-approval-request", (value) => {
    if (!value || typeof value !== "object") throw new Error("Malformed MCP approval request");
    const request = value as PiApprovalRequest;
    if (typeof request.claim !== "function" || typeof request.serverName !== "string" || typeof request.originalToolName !== "string" || !request.args || typeof request.args !== "object")
      throw new Error("Malformed MCP role authorization request");
    if (!request.claim(() => {
      try {
        assertPiRoleContract(contract);
        const decision = authorizePiMcp(contract, request.serverName, request.originalToolName, request.args);
        freezePiToolInput(request.args);
        return decision.allowed ? "allow_once" : "deny";
      } catch { return "deny"; }
    })) throw new Error("Another MCP approval handler claimed the call before Pactile; refusing ambiguous authority");
    freezePiToolInput(request.args);
  });
}
