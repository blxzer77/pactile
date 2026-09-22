import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";

import {
  getProjectCapability,
  type ProjectCapabilityId,
} from "./project-capabilities.js";
import type { UpdateReadinessSnapshot } from "./update-rollout-report.js";

export const SMART_SEARCH_READINESS_COMMAND =
  "smart-search doctor --format json";
const CODEBASE_REQUIRED_EXACT_COMMAND = "rg";
/**
 * The single path the upstream `fastctx apply` flow materializes.
 * Pactile checks this exact location and never resolves npm / nvm /
 * version-manager candidates: guessing a launcher path is what silently
 * broke this capability before, and a missing stable binary is the normal
 * "not adopted yet" state rather than a broken install.
 */
const FASTCTX_STABLE_BINARY_RELATIVE_PATH = ".fastctx/bin/fastctx.exe";
const CODEGRAPH_INDEX_MARKERS = [
  ".codegraph",
  "codegraph.json",
  ".codegraph/index.json",
];
const CODEBASE_GENERATED_ADAPTER_SERVERS = [
  {
    label: "semantic fast-context adapter",
    serverName: "fast-context",
    missing:
      "Generated semantic MCP server `fast-context` is not launchable; remove the server from generated config or fix `npx fast-context-mcp` availability before claiming semantic recall output. Treat semantic recall as unavailable, not as proof.",
  },
  {
    label: "AST CodeGraph adapter",
    serverName: "codegraph",
    missing:
      "Generated AST MCP server `codegraph` is not launchable; remove the server from generated config or fix `npx @colbymchenry/codegraph serve --mcp` availability before claiming structural graph output. Treat graph evidence as unavailable, not as proof.",
  },
] as const;

interface SmartSearchDoctorResult {
  ok?: unknown;
  minimum_profile_ok?: unknown;
  minimum_profile_missing?: unknown;
  error_type?: unknown;
  error?: unknown;
}

interface ExecSyncFailure {
  stdout?: unknown;
  status?: unknown;
  code?: unknown;
  signal?: unknown;
}

export interface ProjectCapabilityProbe {
  id: ProjectCapabilityId;
  infos: string[];
  failures: string[];
  warnings: string[];
}

function childOutputToString(output: unknown): string {
  if (typeof output === "string") return output;
  if (Buffer.isBuffer(output)) return output.toString("utf-8");
  return "";
}

function parseSmartSearchDoctorOutput(
  output: string,
): SmartSearchDoctorResult | undefined {
  if (!output.trim()) return undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SmartSearchDoctorResult;
    }
  } catch {
    // Command success is the primary readiness signal; JSON is parsed only
    // when available so we can reject explicit ok=false diagnostics.
  }
  return undefined;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function smartSearchDoctorDetails(
  result: SmartSearchDoctorResult | undefined,
): string[] {
  if (!result) return [];

  const details: string[] = [];
  if (typeof result.error_type === "string" && result.error_type.trim()) {
    details.push(`error_type=${singleLine(result.error_type)}`);
  }
  if (Array.isArray(result.minimum_profile_missing)) {
    const missing = result.minimum_profile_missing
      .filter((item): item is string => typeof item === "string")
      .map(singleLine)
      .filter(Boolean);
    if (missing.length > 0) {
      details.push(`missing=${missing.join(", ")}`);
    }
  }
  if (typeof result.error === "string" && result.error.trim()) {
    details.push(`error=${singleLine(result.error)}`);
  }
  return details;
}

function smartSearchReadinessError(
  details: string[],
  skipReadinessCommand: string,
): Error {
  const detailLine =
    details.length > 0
      ? `Details: ${details.join("; ")}`
      : "Details: smart-search doctor did not complete successfully.";
  const lines = [
    "Smart Search readiness failed.",
    detailLine,
    "Recovery:",
    `  ${SMART_SEARCH_READINESS_COMMAND}`,
    "  smart-search setup",
    `  ${skipReadinessCommand}`,
  ];
  return new Error(lines.join("\n"));
}

function quoteForLookup(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandLookupCommand(command: string): string {
  if (process.platform === "win32") {
    return `where ${quoteForLookup(command)}`;
  }
  return `command -v ${quoteForLookup(command)}`;
}

function commandIsAvailable(command: string): boolean {
  try {
    execSync(commandLookupCommand(command), {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function npxPackageName(args: readonly string[]): string | undefined {
  return args.find((arg) => arg.trim() && !arg.startsWith("-"));
}

function safeVisibilitySmokeCommand(
  command: string,
  args: readonly string[] = [],
): string | undefined {
  if (command === "npx") {
    const packageName = npxPackageName(args);
    return packageName
      ? `npm view ${shellQuote(packageName)} bin --json`
      : undefined;
  }

  return `${shellQuote(command)} --help`;
}

function runSafeVisibilitySmoke(
  command: string,
  args: readonly string[] = [],
): { info?: string; warning?: string; failure?: string } {
  const smokeCommand = safeVisibilitySmokeCommand(command, args);
  if (!smokeCommand) {
    return {
      warning:
        "No safe non-starting host-level MCP visibility smoke is available from ordinary init/update; run an explicit host MCP smoke before claiming this capability.",
    };
  }

  try {
    execSync(smokeCommand, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
    });
    return {
      info: `host-level command/package visibility smoke passed with \`${smokeCommand}\``,
    };
  } catch {
    return {
      failure: `Host-level command/package visibility smoke failed for \`${smokeCommand}\`; generated MCP server startup is not verified.`,
    };
  }
}

export function existingRelativePaths(
  cwd: string,
  relativePaths: string[],
): string[] {
  return relativePaths.filter((relativePath) =>
    fs.existsSync(path.join(cwd, ...relativePath.split("/"))),
  );
}

export function probeProjectCapability(
  cwd: string,
  id: ProjectCapabilityId,
): ProjectCapabilityProbe {
  if (id === "codebase-retrieval") {
    return probeCodebaseRetrievalCapability(cwd);
  }

  if (id === "fastctx") {
    return probeFastCtxCapability();
  }

  const capability = getProjectCapability(id);
  const [server] = capability.mcpServers;
  if (!server) {
    return {
      id,
      infos: [],
      failures: ["capability has no MCP server template to probe"],
      warnings: [],
    };
  }

  const command = server.command;
  const commandAvailable = commandIsAvailable(command);
  const infos: string[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!commandAvailable) {
    failures.push(`command \`${command}\` is not available on PATH`);
  }

  if (commandAvailable) {
    const smoke = runSafeVisibilitySmoke(command, server.args);
    if (smoke.info) {
      infos.push(smoke.info);
    }
    if (smoke.warning) {
      warnings.push(smoke.warning);
    }
    if (smoke.failure) {
      failures.push(smoke.failure);
    }
  }

  return { id, infos, failures, warnings };
}

export function probeCodebaseRetrievalCapability(
  cwd: string,
): ProjectCapabilityProbe {
  const id: ProjectCapabilityId = "codebase-retrieval";
  const infos: string[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!commandIsAvailable(CODEBASE_REQUIRED_EXACT_COMMAND)) {
    failures.push(
      `required exact search command \`${CODEBASE_REQUIRED_EXACT_COMMAND}\` is not available on PATH`,
    );
  } else {
    const smoke = runSafeVisibilitySmoke(CODEBASE_REQUIRED_EXACT_COMMAND);
    if (smoke.info) {
      infos.push(smoke.info);
    }
    if (smoke.warning) {
      warnings.push(smoke.warning);
    }
  }

  const capability = getProjectCapability(id);
  const serversByName = new Map(
    capability.mcpServers.map((server) => [server.name, server]),
  );

  for (const adapter of CODEBASE_GENERATED_ADAPTER_SERVERS) {
    const server = serversByName.get(adapter.serverName);
    if (!server) {
      warnings.push(adapter.missing);
      continue;
    }

    const commandAvailable = commandIsAvailable(server.command);
    if (!commandAvailable) {
      failures.push(
        `${adapter.missing} Missing command: \`${server.command}\`.`,
      );
      continue;
    }

    const smoke = runSafeVisibilitySmoke(server.command, server.args);
    if (smoke.info) {
      infos.push(`${adapter.label}: ${smoke.info}`);
    }
    if (smoke.warning) {
      warnings.push(`${adapter.label}: ${smoke.warning}`);
    }
    if (smoke.failure) {
      failures.push(`${adapter.label}: ${smoke.failure}`);
    }

    if (adapter.serverName === "fast-context") {
      warnings.push(
        "fast-context host MCP visibility and a project-scoped smoke search still require host-level confirmation; semantic recall remains candidate evidence until exact source/Git/test verification.",
      );
    }

    if (adapter.serverName === "codegraph") {
      const markers = existingRelativePaths(cwd, CODEGRAPH_INDEX_MARKERS);
      if (markers.length === 0) {
        warnings.push(
          "No common CodeGraph index marker was found; initialize or refresh the index after explicit approval, or fall back to source reads before graph-derived impact claims. Structural graph output remains unverified.",
        );
      } else {
        warnings.push(
          `CodeGraph index marker found (${markers.join(", ")}), but Pactile has not verified index freshness; run a host-level status/query smoke or confirm with Git/source evidence before graph-derived impact claims. Structural graph output remains unverified until then.`,
        );
      }
    }
  }

  warnings.push(
    "LSP adapter readiness is host-specific; Pactile does not start language servers during ordinary init/update, and navigation output remains candidate evidence until confirmed by source reads.",
  );

  return { id, infos, failures, warnings };
}

export function getCodegraphIndexMarkers(cwd: string): string[] {
  return existingRelativePaths(cwd, CODEGRAPH_INDEX_MARKERS);
}

/**
 * Probe the FastCtx tool runtime.
 *
 * Readiness is exactly one question: does the upstream-managed stable binary
 * exist? Pactile deliberately does not look for a launcher inside npm, nvm,
 * or any version-manager tree, because that resolution is what left a stale
 * path behind before.
 *
 * `probeOptions.homeDir` exists so tests can drive both branches without
 * reading or writing a real user profile.
 */
export function probeFastCtxCapability(probeOptions?: {
  homeDir?: string;
}): ProjectCapabilityProbe {
  const id: ProjectCapabilityId = "fastctx";
  const homeDir = probeOptions?.homeDir ?? os.homedir();
  const stableBinaryPath = path.join(
    homeDir,
    ...FASTCTX_STABLE_BINARY_RELATIVE_PATH.split("/"),
  );

  if (fs.existsSync(stableBinaryPath)) {
    return {
      id,
      infos: [
        `official stable binary found at \`${stableBinaryPath}\``,
        "output tiers are compact / standard / high; `standard` matches the declared default host budget",
      ],
      failures: [],
      warnings: [
        "Pactile verified the stable binary path only; it did not start the FastCtx server or confirm that the current host session exposes its tools.",
      ],
    };
  }

  return {
    id,
    infos: [],
    failures: [
      `official stable binary is not present at \`${stableBinaryPath}\`; FastCtx has not been applied in this profile`,
    ],
    warnings: [
      "This is the normal un-adopted state, not a broken install: the capability is declared and selectable, but its tools are unavailable until the upstream flow runs. Adopt it with `fastctx apply` (Codex path; it writes the stable binary, a Codex profile, and a managed block in `~/.codex/AGENTS.md`). The upstream flow does not cover Cursor: register `fastctx serve` through user-level host MCP configuration, pointing the command at the stable binary path.",
    ],
  };
}

function projectCapabilityReadinessError(
  probes: ProjectCapabilityProbe[],
  skipReadinessCommand: string,
): Error {
  const failed = probes.filter((probe) => probe.failures.length > 0);
  const lines = [
    "Selected project capability readiness failed.",
    "Failed capabilities:",
  ];

  for (const probe of failed) {
    lines.push(`- ${probe.id}: ${probe.failures.join("; ")}`);
  }

  lines.push("", "Fallback:");
  for (const probe of failed) {
    const capability = getProjectCapability(probe.id);
    for (const fallback of capability.fallback) {
      lines.push(`  - ${probe.id}: ${fallback}`);
    }
  }

  lines.push(
    "",
    "Recovery:",
    "  Fix the selected capability setup, remove the capability selection, or use the explicit repair/debug bypass.",
    `  ${skipReadinessCommand}`,
    "  Skipped capability readiness is not ready and must not be claimed as used.",
  );

  return new Error(lines.join("\n"));
}

export function checkSmartSearchReadiness(options: {
  skipReadiness?: boolean;
  skipReadinessCommand: string;
}): void {
  if (options.skipReadiness) {
    console.warn(
      chalk.yellow(
        "⚠ Smart Search readiness skipped (--skip-readiness); framework readiness is not verified.",
      ),
    );
    return;
  }

  console.log(chalk.blue("🔎 Checking Smart Search readiness..."));

  try {
    const output = execSync(SMART_SEARCH_READINESS_COMMAND, {
      encoding: "utf-8",
      stdio: "pipe",
    });
    const doctor = parseSmartSearchDoctorOutput(output);
    if (doctor?.ok === false || doctor?.minimum_profile_ok === false) {
      throw smartSearchReadinessError(
        smartSearchDoctorDetails(doctor),
        options.skipReadinessCommand,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Smart Search")) {
      throw error;
    }

    const failure = error as ExecSyncFailure;
    const stdout = childOutputToString(failure.stdout);
    const doctor = parseSmartSearchDoctorOutput(stdout);
    const details = smartSearchDoctorDetails(doctor);

    if (details.length === 0) {
      if (typeof failure.status === "number") {
        details.push(`exit_status=${failure.status}`);
      } else if (typeof failure.code === "string") {
        details.push(`code=${failure.code}`);
      } else if (typeof failure.signal === "string") {
        details.push(`signal=${failure.signal}`);
      } else if (error instanceof Error && error.message.trim()) {
        details.push(singleLine(error.message));
      }
    }

    throw smartSearchReadinessError(details, options.skipReadinessCommand);
  }

  console.log(chalk.green("✓ Smart Search readiness verified"));
}

export function checkProjectCapabilityReadiness(options: {
  cwd: string;
  selected: readonly ProjectCapabilityId[];
  skipReadiness?: boolean;
  skipReadinessCommand: string;
}): void {
  if (options.selected.length === 0) {
    return;
  }

  if (options.skipReadiness) {
    console.warn(
      chalk.yellow(
        "⚠ Selected project capability readiness skipped (--skip-readiness); selected capabilities are not verified.",
      ),
    );
    return;
  }

  console.log(chalk.blue("🔌 Checking selected project capabilities..."));
  const probes = options.selected.map((id) =>
    probeProjectCapability(options.cwd, id),
  );

  for (const probe of probes) {
    if (probe.failures.length === 0) {
      console.log(
        chalk.green(`✓ ${probe.id} capability readiness baseline checked`),
      );
    }
    for (const info of probe.infos) {
      console.log(chalk.gray(`  ${probe.id}: ${info}`));
    }
    for (const warning of probe.warnings) {
      console.warn(chalk.yellow(`⚠ ${probe.id}: ${warning}`));
    }
  }

  if (probes.some((probe) => probe.failures.length > 0)) {
    throw projectCapabilityReadinessError(probes, options.skipReadinessCommand);
  }
}

function smokeCommandsForCapability(
  command: string,
  args: readonly string[],
): string[] {
  const smoke = safeVisibilitySmokeCommand(command, args);
  return smoke ? [smoke] : [];
}

function printReadinessReport(
  snapshot: UpdateReadinessSnapshot,
  options: {
    continueHint: string;
    warnCapabilitySkipWhenEmpty: boolean;
  },
): void {
  if (snapshot.skipped) {
    console.warn(
      chalk.yellow(
        "⚠ Smart Search readiness skipped (--skip-readiness); framework readiness is not verified.",
      ),
    );
    if (
      options.warnCapabilitySkipWhenEmpty ||
      snapshot.capabilities.length > 0
    ) {
      console.warn(
        chalk.yellow(
          "⚠ Selected project capability readiness skipped (--skip-readiness); selected capabilities are not verified.",
        ),
      );
    }
    return;
  }

  console.log(chalk.blue("🔎 Checking Smart Search readiness..."));
  if (snapshot.smartSearch.ok) {
    console.log(chalk.green("✓ Smart Search readiness verified"));
  } else {
    console.warn(
      chalk.yellow(
        `⚠ Smart Search readiness unverified; ${options.continueHint}`,
      ),
    );
    for (const detail of snapshot.smartSearch.details) {
      console.warn(chalk.yellow(`  ${detail}`));
    }
  }

  if (snapshot.capabilities.length === 0) {
    return;
  }

  console.log(chalk.blue("🔌 Checking selected project capabilities..."));
  for (const cap of snapshot.capabilities) {
    if (cap.ok) {
      console.log(
        chalk.green(`✓ ${cap.id} capability readiness baseline checked`),
      );
    } else {
      console.warn(
        chalk.yellow(
          `⚠ ${cap.id} capability unverified; ${options.continueHint}`,
        ),
      );
      for (const failure of cap.failures) {
        console.warn(chalk.yellow(`  ${failure}`));
      }
    }
    for (const warning of cap.warnings) {
      console.warn(chalk.yellow(`⚠ ${cap.id}: ${warning}`));
    }
  }
}

/**
 * Print update readiness. Failures are unverified warnings, not a hard stop.
 * `--skip-readiness` remains a maintainer hatch, not the Cursor-user default.
 */
export function reportUpdateReadiness(snapshot: UpdateReadinessSnapshot): void {
  printReadinessReport(snapshot, {
    continueHint: "official files can still update after confirmation.",
    warnCapabilitySkipWhenEmpty: true,
  });
}

/**
 * Print init readiness. Failures are unverified warnings, not a hard stop.
 * `--skip-readiness` remains a maintainer hatch, not the Cursor-user default.
 */
export function reportInitReadiness(snapshot: UpdateReadinessSnapshot): void {
  printReadinessReport(snapshot, {
    continueHint: "official files can still be written.",
    warnCapabilitySkipWhenEmpty: false,
  });
}

/** Non-throwing readiness snapshot for structured update/rollout evidence. */
export function snapshotReadinessForRollout(options: {
  cwd: string;
  selected: readonly ProjectCapabilityId[];
  skipReadiness?: boolean;
}): UpdateReadinessSnapshot {
  if (options.skipReadiness) {
    return {
      skipped: true,
      smartSearch: {
        command: SMART_SEARCH_READINESS_COMMAND,
        ok: false,
        details: ["readiness skipped via --skip-readiness"],
      },
      capabilities: options.selected.map((id) => ({
        id,
        ok: false,
        failures: [],
        warnings: ["readiness skipped via --skip-readiness"],
        smokeCommands: [],
      })),
    };
  }

  let smartSearchOk = true;
  const smartDetails: string[] = [];
  try {
    const output = execSync(SMART_SEARCH_READINESS_COMMAND, {
      encoding: "utf-8",
      stdio: "pipe",
    });
    const doctor = parseSmartSearchDoctorOutput(output);
    if (doctor?.ok === false || doctor?.minimum_profile_ok === false) {
      smartSearchOk = false;
      smartDetails.push(...smartSearchDoctorDetails(doctor));
    }
  } catch (error) {
    smartSearchOk = false;
    const failure = error as ExecSyncFailure;
    const stdout = childOutputToString(failure.stdout);
    const doctor = parseSmartSearchDoctorOutput(stdout);
    const details = smartSearchDoctorDetails(doctor);
    if (details.length > 0) {
      smartDetails.push(...details);
    } else if (error instanceof Error && error.message.trim()) {
      smartDetails.push(singleLine(error.message));
    } else {
      smartDetails.push("smart-search doctor did not complete successfully");
    }
  }

  const capabilities = options.selected.map((id) => {
    const probe = probeProjectCapability(options.cwd, id);
    const capability = getProjectCapability(id);
    const smokeCommands = capability.mcpServers.flatMap((server) =>
      smokeCommandsForCapability(server.command, server.args),
    );
    if (id === "codebase-retrieval") {
      const rgSmoke = safeVisibilitySmokeCommand(
        CODEBASE_REQUIRED_EXACT_COMMAND,
      );
      if (rgSmoke) smokeCommands.unshift(rgSmoke);
    }
    return {
      id,
      ok: probe.failures.length === 0,
      failures: probe.failures,
      warnings: probe.warnings,
      smokeCommands: [...new Set(smokeCommands)],
    };
  });

  return {
    skipped: false,
    smartSearch: {
      command: SMART_SEARCH_READINESS_COMMAND,
      ok: smartSearchOk,
      details: smartDetails,
    },
    capabilities,
  };
}
