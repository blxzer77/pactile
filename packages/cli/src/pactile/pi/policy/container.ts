import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import spawn from "cross-spawn";
import { assertPiRoleContract, sealPiRoleContract, type PiRoleContract } from "./contract.js";
import { canonicalPiPath, insidePiPath, isPiCredentialPath } from "./paths.js";
import { PI_INFERENCE_PROVIDER_HEADER, startPiSandboxRelay, type PiMcpRelayTarget, type PiModelRelayTarget, type PiSandboxRelay } from "./sandbox-runtime.js";
import type { PiGuardedLaunch } from "./launch.js";

export interface PiDockerOptions {
  /** Prepared trusted image with Node >=22.19 and the configured Pi executable. No automatic pulls. */
  image: string;
  agentDir?: string;
  relayImage?: string;
}
export interface PiDockerLaunch extends PiGuardedLaunch {
  containerId: string;
  mapPrompt(text: string): string;
  toHostPath(value: string): string;
  verifyStarted(): void;
  close(): Promise<PiDockerStop>;
}
export interface PiDockerStop { containerId: string; stopped: boolean; removed: boolean; exitCode: number | null; stoppedAt: string | null; }
interface DockerFacts {
  State: { Running: boolean; ExitCode: number; FinishedAt: string };
  Config: { User: string };
  HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[]; SecurityOpt: string[] };
  Mounts: { Destination: string; RW: boolean }[];
}

/** Inspection facts, not launch arguments, establish the admitted Docker scope. */
export function assertPiDockerIsolation(item: DockerFacts, writes: string[], user: string): void {
  if (!item?.State.Running || item.HostConfig.NetworkMode !== "none" || !item.HostConfig.ReadonlyRootfs || item.HostConfig.Privileged
    || item.Config.User !== user || !item.HostConfig.CapDrop?.some((value) => value.toUpperCase() === "ALL")
    || !item.HostConfig.SecurityOpt?.some((value) => value.startsWith("no-new-privileges"))
    || item.Mounts.some((mount) => mount.Destination === "/var/run/docker.sock" || mount.RW && !writes.includes(mount.Destination)))
    throw new Error("Pi Docker launch does not have the admitted process/filesystem/network isolation");
}

/** Stale attachment PIDs do not prove the Docker worker stopped. Observe its owned identity. */
export function observePiDockerRole(containerId: string, fingerprint: string): { running: boolean; present: boolean } {
  if (!/^[a-f0-9]{64}$/u.test(containerId) || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error("Pi Docker recovery identity is malformed");
  const ids = docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${containerId}`]).split(/\r?\n/u);
  if (!ids.includes(containerId)) return { running: false, present: false };
  const facts = JSON.parse(docker(["inspect", containerId])) as { State: { Running: boolean }; Config: { Labels: Record<string, string> } }[];
  if (facts[0]?.Config.Labels["pactile.pi-role"] !== "owned" || facts[0].Config.Labels["pactile.pi-contract"] !== fingerprint)
    throw new Error("Pi Docker recovery cannot act on an unrelated container");
  return { running: facts[0].State.Running, present: true };
}

export function stopOwnedPiDockerRole(containerId: string, fingerprint: string): void {
  if (observePiDockerRole(containerId, fingerprint).running) docker(["stop", "--time", "2", containerId]);
  if (observePiDockerRole(containerId, fingerprint).running) throw new Error("Pi Docker recovery did not verify worker termination");
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function readPiRoleConfiguration(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("Pi configuration could not be read as JSON; launch blocked"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi configuration must be an object");
  return value as Record<string, unknown>;
}
function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key.toLowerCase() === "env" ? {} : /^(?:apiKey|key|access|refresh|accessToken|refreshToken|authorization|token|password)$/iu.test(key) ? "pactile-inference-relay" : redactConfig(item)]));
}
type PiConfigResolver = (value: string, env?: Record<string, string>) => string | undefined;
async function hostPiConfigResolver(): Promise<PiConfigResolver> {
  // Reuse the installed Pi 0.87 configuration resolver; its command/template semantics
  // belong to the optional host. Never implement a second credential shell/parser.
  const roots = [path.join(path.dirname(process.execPath), "node_modules"), path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules")];
  let modulePath = roots.map((root) => path.join(root, "@earendil-works", "pi-coding-agent", "dist", "core", "resolve-config-value.js")).find((file) => fs.existsSync(file));
  if (!modulePath) {
    const result = spawn.sync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "--global"], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    if (result.status === 0) {
      const candidate = path.join(result.stdout.trim(), "@earendil-works", "pi-coding-agent", "dist", "core", "resolve-config-value.js");
      if (fs.existsSync(candidate)) modulePath = candidate;
    }
  }
  if (!modulePath) return (value: string): string => {
    if (value.startsWith("!") || value.includes("$")) throw new Error("Configured Pi credential references require the installed host resolver");
    return value;
  };
  const sdk: unknown = await import(pathToFileURL(modulePath).href);
  if (!sdk || typeof sdk !== "object" || typeof (sdk as Record<string, unknown>).resolveConfigValue !== "function") throw new Error("Installed Pi credential resolver is incompatible");
  return (sdk as { resolveConfigValue: PiConfigResolver }).resolveConfigValue;
}

/** Trusted existing configuration only; resolved credentials never enter worker files or receipts. */
export function resolvePiInferenceTargets(models: Record<string, unknown>, auth: Record<string, unknown>, resolver: PiConfigResolver): PiModelRelayTarget[] {
  const resolve = (value: unknown, env?: Record<string, string>): string | null => {
    if (typeof value !== "string" || !value) return null;
    try { const result = resolver(value, env); if (!result) throw new Error("empty"); return result; }
    catch { throw new Error("Configured Pi credential helper failed; inference launch blocked"); }
  };
  return Object.entries((models.providers ?? {}) as Record<string, Record<string, unknown>>).flatMap(([name, item]) => {
    if (typeof item.baseUrl !== "string") return [];
    if (Array.isArray(item.models) && item.models.some((model: Record<string, unknown>) => model.headers && Object.keys(model.headers as object).length))
      throw new Error("Pi Docker inference currently requires provider-level custom headers; per-model headers are unsupported");
    const stored = auth[name] as Record<string, unknown> | undefined;
    const key = resolve(item.apiKey, item.env as Record<string, string> | undefined) ?? resolve(stored?.key, stored?.env as Record<string, string> | undefined);
    const headers = new Headers();
    const setHeader = (header: string, value: string): void => {
      try { headers.set(header, value); }
      catch { throw new Error("Configured Pi inference headers are invalid; launch blocked"); }
    };
    if (key) setHeader(item.api === "anthropic-messages" ? "x-api-key" : "authorization", item.api === "anthropic-messages" ? key : `Bearer ${key}`);
    for (const [header, value] of Object.entries((item.headers ?? {}) as Record<string, unknown>)) {
      const resolved = resolve(value, item.env as Record<string, string> | undefined);
      if (resolved) setHeader(header, resolved);
    }
    return [{ provider: name, baseUrl: item.baseUrl, headers: Object.fromEntries(headers) }];
  });
}

/** Preserve format and checkout semantics without exposing remote/auth/hooks configuration. */
export function piDockerGitConfig(cwd: string): string {
  const rules: Record<string, RegExp> = {
    "core.repositoryformatversion": /^(?:0|1)$/u, "core.autocrlf": /^(?:true|false|input)$/u,
    "core.eol": /^(?:lf|crlf|native)$/u, "core.ignorecase": /^(?:true|false)$/u, "core.symlinks": /^(?:true|false)$/u,
    "core.sparsecheckout": /^(?:true|false)$/u, "core.sparsecheckoutcone": /^(?:true|false)$/u,
    "extensions.objectformat": /^(?:sha1|sha256)$/u, "extensions.refstorage": /^(?:files|reftable)$/u,
  };
  const query = `^(${Object.keys(rules).map((key) => key.replaceAll(".", "\\.")).join("|")})$`;
  const result = spawn.sync("git", ["-C", cwd, "config", "--null", "--get-regexp", query], { encoding: "utf8", windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 && result.status !== 1) throw new Error("Pi Docker Git configuration could not be observed");
  const values = new Map<string, string>();
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n"); const key = record.slice(0, at).toLowerCase(); const value = record.slice(at + 1).toLowerCase();
    if (at < 0 || !rules[key]?.test(value)) throw new Error("Pi Docker Git checkout configuration is unsupported");
    values.set(key, value);
  }
  return ["[core]", "\tbare = false", "\tfilemode = false", ...[...values].filter(([key]) => key.startsWith("core.")).map(([key, value]) => `\t${key.slice(5)} = ${value}`),
    "[extensions]", ...[...values].filter(([key]) => key.startsWith("extensions.")).map(([key, value]) => `\t${key.slice(11)} = ${value}`), ""].join("\n");
}

/** Translate admitted path tokens without rewriting sibling paths or prose escapes. */
export function mapPiDockerPrompt(text: string, mappings: readonly { host: string; runtime: string }[]): string {
  const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...mappings].sort((left, right) => right.host.length - left.host.length).reduce((result, entry) => {
    const prefixes = [...new Set([entry.host, entry.host.replaceAll("\\", "/")])].map(escaped).join("|");
    const token = new RegExp(`(?:${prefixes})((?:[/\\\\][^\\s"'\x60<>]*)?)(?=$|[\\s"'\x60<>])`, process.platform === "win32" ? "giu" : "gu");
    return result.replace(token, (_match, suffix: string) => `${entry.runtime}${suffix.replaceAll("\\", "/")}`);
  }, text);
}

/** Docker owns process/child isolation; this adapter owns bounded mounts and exact broker actions. */
export async function prepareDockerPiRoleLaunch(contract: PiRoleContract, options: PiDockerOptions, signal?: AbortSignal): Promise<PiDockerLaunch> {
  assertPiRoleContract(contract);
  if (signal?.aborted) throw new Error("Pi Docker launch cancelled before preparation");
  if (!options.image || options.image.startsWith("-") || /\s/u.test(options.image)) throw new Error("A prepared Pi Docker image is required");
  const engine = JSON.parse(docker(["version", "--format", "{{json .Server}} "])) as { Os?: string };
  if (engine.Os !== "linux") throw new Error("Pi role Docker backend requires a reachable Linux engine");
  docker(["image", "inspect", options.image]);
  const relayImage = options.relayImage ?? "alpine/socat:latest";
  docker(["image", "inspect", relayImage]);
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const settings = readPiRoleConfiguration(path.join(agentDir, "settings.json"));
  const models = readPiRoleConfiguration(path.join(agentDir, "models.json"));
  const auth = readPiRoleConfiguration(path.join(agentDir, "auth.json"));
  const adapter = readPiRoleConfiguration(path.join(agentDir, "mcp-adapter.json"));
  const projectMcp = readPiRoleConfiguration(path.join(contract.reads[1].path, "..", "..", "..", ".mcp.json"));
  const allowProject = (adapter.settings as Record<string, unknown> | undefined)?.projectServers === "allow";
  const sources = { ...((adapter.mcpServers ?? {}) as Record<string, PiMcpRelayTarget>), ...(allowProject ? (projectMcp.mcpServers ?? {}) as Record<string, PiMcpRelayTarget> : {}) };
  const servers = Object.fromEntries(Object.entries(sources).filter(([, entry]) => entry && !(entry as Record<string, unknown>).disabled && Boolean(entry.command ?? entry.url)));
  const targets = resolvePiInferenceTargets(models, auth, await hostPiConfigResolver());
  const relayPaths: { runtime: string; host: string }[] = [];
  const relay: PiSandboxRelay = await startPiSandboxRelay({ contract, models: targets, servers, signal, pathMappings: relayPaths });
  const id = randomUUID().replaceAll("-", "");
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-pi-docker-"));
  const volume = `pactile-pi-relay-${id}`;
  const relayName = `pactile-pi-relay-${id}`;
  let containerId = "";
  let closed: PiDockerStop | undefined;
  let relayCreated = false;
  let volumeCreated = false;
  const mounts: string[] = [];
  const mounted = new Set<string>();
  const bind = (source: string, target: string, readonly = true): void => {
    if (source.includes(",") || target.includes(",")) throw new Error("Docker mount paths with commas are unsupported");
    if (mounted.has(target)) throw new Error(`Pi Docker mount target is duplicated: ${target}`);
    mounted.add(target);
    mounts.push("--mount", `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`);
  };
  const mappings = [{ host: contract.cwd, runtime: "/workspace" }, { host: contract.reads[1].path, runtime: "/pactile/task" }, { host: contract.scratch.path, runtime: "/pactile/scratch" }];
  for (const [index, grant] of contract.reads.slice(2).entries()) {
    if (mappings.some((entry) => insidePiPath(grant.path, entry.host))) continue;
    const relative = path.relative(canonicalPiPath(agentDir, agentDir), grant.path).replaceAll("\\", "/");
    mappings.push({ host: grant.path, runtime: insidePiPath(grant.path, canonicalPiPath(agentDir, agentDir)) ? `/pactile/scratch/agent/${relative}` : `/pactile/resources/${index}` });
  }
  relayPaths.push(...mappings.slice(3)); Object.freeze(relayPaths);
  const map = (value: string): string => {
    for (const entry of mappings) if (insidePiPath(value, entry.host)) return `${entry.runtime}/${path.relative(entry.host, value).replaceAll("\\", "/")}`.replace(/\/$/u, "");
    return `/pactile/unmounted/${Buffer.from(value).toString("hex")}`;
  };
  const workerAgent = "/pactile/scratch/agent";
  const readonlyResources = [...mappings.slice(3)];
  const close = async (): Promise<PiDockerStop> => {
    if (closed) return closed;
    let stopped = !containerId; let removed = !containerId;
    let exitCode: number | null = null; let stoppedAt: string | null = null;
    if (containerId) {
      try {
        const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", containerId])) as { Running: boolean };
        if (state.Running) docker(["stop", "--time", "2", containerId]);
        const final = JSON.parse(docker(["inspect", "--format", "{{json .State}}", containerId])) as { Running: boolean; ExitCode: number; FinishedAt: string };
        stopped = final.Running === false;
        if (stopped) { exitCode = final.ExitCode; stoppedAt = final.FinishedAt; }
        if (stopped) { docker(["rm", containerId]); removed = true; }
      } catch { /* Missing/unreachable engine is not a verified stop. */ }
    }
    if (relayCreated) { try { docker(["rm", "--force", relayName]); } catch { /* Receipt remains bounded to the worker. */ } }
    if (volumeCreated) { try { docker(["volume", "rm", volume]); } catch { /* Retained owned resource for recovery. */ } }
    await relay.close();
    if (stopped && removed) {
      const resolved = fs.realpathSync(control);
      if (!insidePiPath(resolved, fs.realpathSync(os.tmpdir())) || !path.basename(resolved).startsWith("pactile-pi-docker-"))
        throw new Error("Pi Docker control cleanup target is not the owned temporary directory");
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    const result = { containerId, stopped, removed, exitCode, stoppedAt };
    if (stopped && removed) closed = result;
    return result;
  };
  try {
    fs.mkdirSync(path.join(contract.scratch.path, "agent"), { recursive: true });
    fs.mkdirSync(path.join(contract.scratch.path, "tmp"), { recursive: true });
    fs.chmodSync(control, 0o755);
    bind(contract.cwd, "/workspace"); bind(contract.reads[1].path, "/pactile/task");
    bind(contract.scratch.path, "/pactile/scratch", false); bind(control, "/pactile/control");
    for (const grant of contract.writes) {
      if (!fs.existsSync(grant.path)) {
        fs.mkdirSync(path.dirname(grant.path), { recursive: true });
        fs.writeFileSync(grant.path, "", { flag: "wx" });
      }
      bind(grant.path, map(grant.path), false);
    }
    for (const entry of mappings.slice(3)) bind(entry.host, entry.runtime);
    const configuredResources = (values: unknown): string[] => Array.isArray(values) ? values.map((value) => {
      if (typeof value !== "string") throw new Error("Pi configured resource path is malformed");
      const negate = value.startsWith("!") ? "!" : ""; const pattern = value.slice(negate.length);
      const wildcard = pattern.search(/[*?[{]/u); const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard).replace(/[\\/]$/u, "");
      return path.isAbsolute(prefix) ? `${negate}${map(canonicalPiPath(prefix, agentDir))}${wildcard < 0 ? "" : `/${pattern.slice(wildcard)}`}` : value;
    }) : [];
    const taskSkills = path.resolve(contract.reads[1].path, "..", "..", "..", ".agents", "skills");
    const stagedSkills = configuredResources(settings.skills);
    if (fs.statSync(taskSkills, { throwIfNoEntry: false })?.isDirectory()) stagedSkills.push(map(canonicalPiPath(taskSkills, taskSkills)));
    const stagedSettings = { ...settings, shellPath: "/bin/bash", skills: stagedSkills,
      extensions: [...configuredResources(settings.extensions), "/pactile/product/pactile/pi/policy/extension.js"] };
    const stagedAdapter = { ...adapter, mcpServers: Object.fromEntries(relay.mcpServers.map((name) => [name, { url: `http://pactile.mcp/${encodeURIComponent(name)}`, transport: "http", directTools: (sources[name] as Record<string, unknown>).directTools }])) };
    const stagedModels = redactConfig(models) as Record<string, unknown>;
    for (const [name, provider] of Object.entries((stagedModels.providers ?? {}) as Record<string, Record<string, unknown>>)) provider.headers = { [PI_INFERENCE_PROVIDER_HEADER]: name };
    for (const [name, value] of Object.entries({ "settings.json": redactConfig(stagedSettings), "models.json": stagedModels, "auth.json": redactConfig(auth), "mcp-adapter.json": stagedAdapter })) {
      const file = path.join(control, name); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o444 }); bind(file, `${workerAgent}/${name}`);
    }
    if (fs.existsSync(path.join(contract.cwd, ".mcp.json"))) bind(path.join(control, "mcp-adapter.json"), "/workspace/.mcp.json");
    for (const name of ["npm", "skills", "extensions", "AGENTS.md"]) {
      const source = path.join(agentDir, name);
      if (fs.existsSync(source) && !mounted.has(`${workerAgent}/${name}`)) {
        bind(source, `${workerAgent}/${name}`);
        if (name !== "AGENTS.md") readonlyResources.push({ host: source, runtime: `${workerAgent}/${name}` });
      }
    }
    // A readonly secret is still readable by Bash/extensions. Hide known credential and
    // local control surfaces before admitting whole-process access. Budgets fail closed.
    const emptyFile = path.join(control, "withheld"); fs.writeFileSync(emptyFile, "", { mode: 0o444 });
    const emptyDir = path.join(control, "withheld-directory"); fs.mkdirSync(emptyDir, { mode: 0o555 });
    let visited = 0;
    const maskTree = (source: string, target: string, resource = false): void => {
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (++visited > 50_000) throw new Error("Pi Docker source masking exceeds its file budget");
        const local = path.join(source, entry.name); const runtime = `${target}/${entry.name}`;
        if (mounted.has(runtime)) continue;
        const linked = entry.isSymbolicLink();
        const withheld = linked || isPiCredentialPath(local) || (!resource && [".git", ".pactile", ".codex", ".pi", "node_modules"].includes(entry.name));
        if (withheld) {
          const directory = entry.isDirectory() || linked && fs.statSync(local, { throwIfNoEntry: false })?.isDirectory();
          bind(directory ? emptyDir : emptyFile, runtime);
        } else if (entry.isDirectory()) maskTree(local, runtime, resource);
      }
    };
    maskTree(contract.cwd, "/workspace"); maskTree(contract.reads[1].path, "/pactile/task");
    for (const resource of readonlyResources) {
      if (fs.statSync(resource.host).isDirectory()) maskTree(resource.host, resource.runtime, true);
      else if (isPiCredentialPath(resource.host)) throw new Error("Pi Docker resource is a withheld credential file");
    }
    const gitEnvironment: string[] = [];
    try {
      const gitPath = (args: string[]): string => execFileSync("git", ["-C", contract.cwd, "rev-parse", ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
      const gitDir = gitPath(["--absolute-git-dir"]); const commonDir = gitPath(["--path-format=absolute", "--git-common-dir"]);
      bind(gitDir, "/pactile/gitdir"); bind(commonDir, "/pactile/gitcommon");
      const config = path.join(control, "git-config"); fs.writeFileSync(config, piDockerGitConfig(contract.cwd), { mode: 0o444 });
      if (fs.existsSync(path.join(commonDir, "config"))) bind(config, "/pactile/gitcommon/config");
      if (gitDir !== commonDir) {
        // Git's ref backend also reads this file. A Windows/relative host pointer
        // cannot describe the two independent readonly mounts inside Linux.
        const commondir = path.join(control, "git-commondir"); fs.writeFileSync(commondir, "/pactile/gitcommon\n", { mode: 0o444 });
        if (!fs.existsSync(path.join(gitDir, "commondir"))) throw new Error("Pi Docker linked Git directory lacks its common-directory pointer");
        bind(commondir, "/pactile/gitdir/commondir");
      }
      gitEnvironment.push("--env", `GIT_DIR=${gitDir === commonDir ? "/pactile/gitcommon" : "/pactile/gitdir"}`, "--env", "GIT_COMMON_DIR=/pactile/gitcommon", "--env", "GIT_WORK_TREE=/workspace", "--env", "GIT_OPTIONAL_LOCKS=0");
    } catch (error) {
      if (gitEnvironment.length || mounted.has("/pactile/gitdir")) throw error;
      // A non-Git Task remains eligible. It does not receive synthetic Git evidence.
    }
    let dist = fileURLToPath(new URL("../../../", import.meta.url));
    if (!fs.existsSync(path.join(dist, "pactile", "pi", "policy", "extension.js")))
      dist = fileURLToPath(new URL("../../../../dist/", import.meta.url));
    if (!fs.existsSync(path.join(dist, "pactile", "pi", "policy", "extension.js")))
      throw new Error("Pi Docker role extension must be built before dispatch");
    bind(dist, "/pactile/product");
    const { fingerprint: _fingerprint, ...body } = contract;
    const worker = sealPiRoleContract({ ...body, cwd: "/workspace", workspaceIdentity: null, authorityFile: map(contract.authorityFile),
      reads: contract.reads.map((grant) => ({ ...grant, path: map(grant.path) })),
      writes: contract.writes.map((grant) => ({ ...grant, path: map(grant.path) })), scratch: { path: "/pactile/scratch", kind: "directory" },
      protectedRoots: ["/pactile/task", "/pactile/control", "/pactile/product", "/pactile/resources", "/pactile/gitdir", "/pactile/gitcommon", "/workspace/.git", "/workspace/.pactile", ...["settings.json", "models.json", "auth.json", "mcp-adapter.json", "npm", "skills", "extensions", "AGENTS.md"].map((name) => `${workerAgent}/${name}`)],
      sourceGuards: contract.sourceGuards.map((guard) => ({ ...guard, path: map(guard.path) })),
      backend: "docker", shell: "isolated", relay: { socketPath: "/pactile/relay/http.sock", token: relay.token, modelOrigins: relay.modelOrigins },
    });
    const file = path.join(control, "active-contract.json"); fs.writeFileSync(file, `${JSON.stringify(worker, null, 2)}\n`, { mode: 0o444 });
    docker(["volume", "create", "--label", "pactile.pi-role=owned", volume]); volumeCreated = true;
    docker(["run", "--detach", "--name", relayName, "--label", "pactile.pi-role=owned", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--mount", `type=volume,src=${volume},dst=/role`, relayImage,
      "UNIX-LISTEN:/role/http.sock,fork,mode=666,unlink-early", `TCP:host.docker.internal:${relay.port}`]); relayCreated = true;
    if (signal?.aborted) throw new Error("Pi Docker launch cancelled before worker creation");
    const user = process.platform === "win32" ? "1000:1000" : `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    containerId = docker(["create", "--interactive", "--attach", "stdin", "--attach", "stdout", "--attach", "stderr", "--init", "--name", `pactile-pi-${id}`, "--label", "pactile.pi-role=owned", "--label", `pactile.pi-contract=${contract.fingerprint}`, "--read-only", "--network", "none", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--user", user, "--workdir", "/workspace", ...mounts, ...gitEnvironment,
      "--mount", `type=volume,src=${volume},dst=/pactile/relay,readonly`, "--env", `PI_CODING_AGENT_DIR=${workerAgent}`,
      "--env", "TMPDIR=/pactile/scratch/tmp", "--env", "XDG_CACHE_HOME=/pactile/scratch/cache",
      "--env", "PI_CODING_AGENT_SESSION_DIR=/pactile/scratch/sessions", "--env", "PACTILE_PI_ROLE_CONTRACT=/pactile/control/active-contract.json", "--env", `PACTILE_PI_ROLE_FINGERPRINT=${worker.fingerprint}`,
      "--entrypoint", "pi", options.image, "--mode", "rpc"]);
    return { launch: { command: "docker", args: ["start", "--attach", "--interactive", containerId] }, env: {}, contractFile: file, contract: worker, containerId, readinessProbeRetryMs: 1_000, shutdownGraceMs: 30_000,
      mapPrompt: (text) => mapPiDockerPrompt(text, mappings),
      toHostPath: (value) => value.startsWith("/pactile/scratch/") ? path.join(contract.scratch.path, value.slice("/pactile/scratch/".length)) : value,
      verifyStarted: () => {
        const facts = JSON.parse(docker(["inspect", containerId])) as DockerFacts[];
        assertPiDockerIsolation(facts[0], ["/pactile/scratch", ...worker.writes.map((entry) => entry.path)], user);
        if (contract.workspaceIdentity?.git && docker(["exec", containerId, "git", "rev-parse", "--verify", "HEAD"]) !== contract.workspaceIdentity.git.headSha)
          throw new Error("Pi Docker Git HEAD differs from the admitted host workspace");
      }, close,
    };
  } catch (error) { await close(); throw error; }
}
