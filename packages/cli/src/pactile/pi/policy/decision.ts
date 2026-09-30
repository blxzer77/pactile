import fs from "node:fs";
import { assertPiRoleContract, type PiRoleContract } from "./contract.js";
import { canonicalPiPath, isPiCredentialPath, isPiProtectedWrite, matchesPiGrant, piReadExclusions } from "./paths.js";

export interface PiPolicyDecision { allowed: boolean; action: string; reason: string; }
function allow(action: string): PiPolicyDecision { return { allowed: true, action, reason: "within admitted role scope" }; }
function deny(action: string, reason: string): PiPolicyDecision { return { allowed: false, action, reason }; }

export function authorizePiPath(contract: PiRoleContract, action: "read" | "write", value: unknown): PiPolicyDecision {
  if (typeof value !== "string") return deny(action, "path is required");
  try {
    const target = canonicalPiPath(value, contract.cwd);
    if (isPiCredentialPath(target)) return deny(action, "credentials are not worker evidence");
    if (action === "read") return contract.reads.some((grant) => matchesPiGrant(target, grant)) || matchesPiGrant(target, contract.scratch)
      ? allow(action) : deny(action, "read is outside the admitted sources");
    if (isPiProtectedWrite(target, contract.cwd, contract.protectedRoots, contract.taskRunId !== null))
      return deny(action, "Kernel, existing evidence and Git finalization are protected");
    if (matchesPiGrant(target, contract.scratch)) return allow(action);
    return contract.role === "implement" && contract.writes.some((grant) => matchesPiGrant(target, grant))
      ? allow(action) : deny(action, "write is outside the role's approved write set");
  } catch { return deny(action, "path is ambiguous, missing or follows a link"); }
}

/** The adapter broker supplies original server/tool identity and final arguments. */
export function authorizePiMcp(contract: PiRoleContract, server: string, tool: string, args: Record<string, unknown>): PiPolicyDecision {
  server = server.toLowerCase();
  if (server.toLowerCase() === "codegraph" && tool === "codegraph_explore")
    return authorizePiPath(contract, "read", args.projectPath ?? contract.cwd);
  if (["fastctx", "fast-context"].includes(server)) {
    if (["inspect_local_file", "grep", "glob"].includes(tool)) {
      const targets = Array.isArray(args.files) ? args.files.map((item) => (item as Record<string, unknown>).path)
        : [args.file_path ?? args.path ?? contract.cwd];
      for (const target of targets) { const decision = authorizePiPath(contract, "read", target); if (!decision.allowed) return decision; }
      if (["grep", "glob"].includes(tool)) {
        try {
          const target = canonicalPiPath(args.path as string ?? contract.cwd, contract.cwd);
          if (fs.statSync(target).isDirectory()) {
            const field = tool === "glob" ? "pattern" : "glob";
            const exclusions = piReadExclusions(target);
            const original = args[field] === undefined ? [] : args[field];
            if (!Array.isArray(original) || original.some((item) => typeof item !== "string")) return deny("mcp.read", "aggregate read patterns are malformed");
            if (!exclusions.every((item) => original.includes(item))) {
              if (Object.isFrozen(args)) return deny("mcp.read", "frozen aggregate query lacks the required source exclusions");
              args[field] = [...original, ...exclusions];
            }
          }
        } catch { return deny("mcp.read", "aggregate source could not be bounded; use explicit files"); }
      }
      return allow("mcp.read");
    }
    if (tool === "replace") {
      const decision = authorizePiPath(contract, args.dry_run === true ? "read" : "write", args.path);
      if (!decision.allowed) return decision;
      if (typeof args.path === "string" && fs.statSync(canonicalPiPath(args.path, contract.cwd), { throwIfNoEntry: false })?.isDirectory())
        return deny("mcp.write", "directory-wide replacement needs an explicit bounded adapter");
      return allow(args.dry_run === true ? "mcp.read" : "mcp.write");
    }
  }
  const grant = contract.remoteGrants.find((entry) => entry.server === server && entry.tool === tool &&
    (!entry.actions || typeof args.action === "string" && entry.actions.includes(args.action)) &&
    Object.entries(entry.arguments).every(([key, value]) => args[key] === value));
  return grant ? allow("mcp.approved") : deny("mcp", "this exact remote action/target has no trusted role grant");
}

export function authorizePiTool(contract: PiRoleContract, toolName: string, args: Record<string, unknown>): PiPolicyDecision {
  try { assertPiRoleContract(contract); } catch { return deny("authority", "role contract is invalid, changed, expired or revoked"); }
  if (["read", "grep", "find", "ls"].includes(toolName)) {
    const decision = authorizePiPath(contract, "read", args.path ?? contract.cwd);
    if (!decision.allowed || toolName !== "grep" || contract.backend === "docker") return decision;
    try {
      const target = canonicalPiPath(args.path as string ?? contract.cwd, contract.cwd);
      if (fs.statSync(target).isDirectory() && piReadExclusions(target).length > 3)
        return deny("read", "directory grep includes withheld sources; use explicit files or bounded FastCtx queries");
    } catch { return deny("read", "aggregate source could not be bounded"); }
    return decision;
  }
  if (["write", "edit"].includes(toolName)) return authorizePiPath(contract, "write", args.path);
  if (["bash", "powershell", "mcpScript"].includes(toolName)) return contract.shell === "isolated" && contract.backend === "docker"
    ? allow("process.isolated") : deny("process", "arbitrary Shell requires whole-process isolation; use bounded read/query tools");
  if (toolName === "ask_user_question") return allow("user.interaction");
  if (toolName === "subagent") return contract.backend === "docker"
    ? allow("delegation.inherited-container") : deny("delegation", "delegation requires inherited process/filesystem/network isolation");
  if (toolName === "mcp") {
    if (args.action !== undefined && !["list", "search", "describe", "status", "call", "ui-messages"].includes(String(args.action)))
      return deny("mcp", "MCP installation and authentication changes are outside worker authority");
    if (typeof args.tool === "string") {
      // Adapter 3.0 resolves prefixed/unique names and JSON-string args itself. Its final
      // approval event and the isolated broker recheck original identities and arguments.
      if (typeof args.server === "string" && args.args && typeof args.args === "object") {
        const decision = authorizePiMcp(contract, args.server, args.tool, args.args as Record<string, unknown>);
        if (decision.allowed) return decision;
      }
      return allow("mcp.pending-final-authorization");
    }
    return allow("mcp.discover");
  }
  if (toolName.startsWith("mcp__")) {
    const fields = toolName.slice(5).split("__");
    if (fields.length === 1 && typeof args.tool === "string")
      return authorizePiMcp(contract, fields[0].replaceAll("_", "-"), args.tool, typeof args.args === "object" && args.args ? args.args as Record<string, unknown> : {});
    if (fields.length === 2) return authorizePiMcp(contract, fields[0].replaceAll("_", "-"), fields[1], args);
  }
  for (const server of ["fastctx", "fast-context", "codegraph"]) {
    const prefix = `${server.replaceAll("-", "_")}_`;
    if (toolName.startsWith(prefix)) return authorizePiMcp(contract, server, toolName.slice(prefix.length), args);
  }
  return deny("extension", "no trusted action adapter for this call; capability remains loaded");
}

export function freezePiToolInput(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freezePiToolInput(item);
  Object.freeze(value);
}
