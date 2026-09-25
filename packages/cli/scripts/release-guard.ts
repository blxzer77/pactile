import { execFileSync } from "node:child_process";

import type { CommandOptions, CommandRunner } from "./types.js";

type ReleaseChannel = "alpha" | "beta" | "rc" | "stable";
interface ReleaseVersion {
  version: string;
  baseVersion: string;
  channel: ReleaseChannel;
  major: number;
  minor: number;
  patch: number;
  prereleaseNumber: number | null;
}
type ReleaseTag = ReleaseVersion & { tag: string };
type AncestryCheck = (ancestor: string, descendant: string) => boolean;

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|rc|alpha)\.(0|[1-9]\d*))?$/;

export const RELEASE_TAG_PREFIX = "pactile-v";

function commandName(command: string): string {
  if (process.platform !== "win32") return command;
  if (command === "pnpm") return "pnpm.cmd";
  if (command === "npm") return "npm.cmd";
  return command;
}

function quoteCmdArgument(value: string): string {
  const text = String(value);
  if (!/[\s"&|<>^()%!]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Default command seam for release scripts. Tests inject a recorder instead,
 * so no credential, tag, push, or publish is needed to exercise the gates.
 */
export function createCommandRunner({
  baseEnv = process.env,
}: { baseEnv?: NodeJS.ProcessEnv } = {}): CommandRunner {
  return (
    command: string,
    args: string[] = [],
    options: CommandOptions = {},
  ) => {
    const windowsPackageShim =
      process.platform === "win32" && (command === "pnpm" || command === "npm");
    const executable = windowsPackageShim
      ? process.env.ComSpec || "cmd.exe"
      : commandName(command);
    const executableArgs = windowsPackageShim
      ? [
          "/d",
          "/s",
          "/c",
          [commandName(command), ...args].map(quoteCmdArgument).join(" "),
        ]
      : args;
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries({ ...baseEnv, ...options.env })) {
      if (value !== undefined) env[key] = value;
    }
    // `undefined` is an explicit request to remove a value inherited by the
    // parent process. Release preparation uses this to keep registry publish
    // credentials out of every build/test/pack child process.
    return execFileSync(executable, executableArgs, {
      cwd: options.cwd,
      encoding: "utf-8",
      env,
      stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    });
  };
}

function outputOf(result: string | Buffer | null | undefined): string {
  if (result === undefined || result === null) return "";
  return Buffer.isBuffer(result) ? result.toString("utf-8") : String(result);
}

function capture(
  runner: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
): string {
  return outputOf(runner(command, args, { cwd, capture: true })).trim();
}

function commandSucceeds(
  runner: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
): boolean {
  try {
    runner(command, args, { cwd, capture: true });
    return true;
  } catch {
    return false;
  }
}

export function parseReleaseVersion(version: string): ReleaseVersion {
  const match = VERSION_RE.exec(version);
  if (!match) {
    throw new Error(
      `Unsupported release version "${version}". Expected stable semver or ` +
        `a beta.N, rc.N, or alpha.N prerelease.`,
    );
  }
  return {
    version,
    baseVersion: `${match[1]}.${match[2]}.${match[3]}`,
    channel:
      (match[4] as Exclude<ReleaseChannel, "stable"> | undefined) ?? "stable",
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prereleaseNumber: match[5] === undefined ? null : Number(match[5]),
  };
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  const channelRank: Record<ReleaseChannel, number> = {
    alpha: 0,
    beta: 1,
    rc: 2,
    stable: 3,
  };
  if (channelRank[a.channel] !== channelRank[b.channel]) {
    return channelRank[a.channel] < channelRank[b.channel] ? -1 : 1;
  }
  if (a.channel === "stable") return 0;
  if (a.prereleaseNumber === b.prereleaseNumber) return 0;
  return a.prereleaseNumber < b.prereleaseNumber ? -1 : 1;
}

export function parseReleaseTag(tag: string): ReleaseTag {
  const prefix = RELEASE_TAG_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${prefix}(.+)$`).exec(tag);
  if (!match) {
    throw new Error(
      `Invalid release tag "${tag}". Expected ${RELEASE_TAG_PREFIX}<semver>.`,
    );
  }
  const parsed = parseReleaseVersion(match[1]);
  return { ...parsed, tag };
}

export function resolveReleaseTag({
  explicitTag,
  env = process.env,
}: { explicitTag?: string; env?: NodeJS.ProcessEnv } = {}): string {
  let raw = explicitTag ?? "";
  if (!raw && env.GITHUB_REF?.startsWith("refs/tags/")) {
    raw = env.GITHUB_REF;
  } else if (!raw && env.GITHUB_REF_TYPE === "tag") {
    raw = env.GITHUB_REF_NAME ?? "";
  } else if (!raw && env.GITHUB_REF_NAME?.startsWith(RELEASE_TAG_PREFIX)) {
    raw = env.GITHUB_REF_NAME;
  }
  if (raw.startsWith("refs/tags/")) return raw.slice("refs/tags/".length);
  return raw;
}

export function assertMatchingVersions({
  cliVersion,
  cliName,
  expectedVersion,
}: {
  cliVersion: string;
  cliName?: string;
  expectedVersion?: string;
}): string {
  parseReleaseVersion(cliVersion);
  if (cliName !== undefined && cliName !== "@blxzer/pactile") {
    throw new Error(`Release package must be @blxzer/pactile, got ${cliName}.`);
  }
  if (expectedVersion !== undefined && cliVersion !== expectedVersion) {
    throw new Error(
      `Version mismatch: tag/target=${expectedVersion}, package=${cliVersion}.`,
    );
  }
  return cliVersion;
}

export function assertCleanTree(status: string): void {
  if (status.trim() !== "") {
    throw new Error(
      `Release requires a clean working tree. Commit, stash, or discard these ` +
        `changes before retrying:\n${status}`,
    );
  }
}

/**
 * Which branch may prepare a candidate at this channel.
 *
 * Two long-lived branches: `main` is the release line, `develop` is the
 * development line. A stable candidate is cut from `main` (it is the thing
 * being released); every prerelease candidate is cut from `develop`, which is
 * where iteration happens and where a `-beta.N` / `-rc.N` version is allowed
 * to be tested before it earns a place on the release line.
 */
export function allowedReleaseBranches(
  version: string,
): ("main" | "develop")[] {
  const { channel } = parseReleaseVersion(version);
  return channel === "stable" ? ["main"] : ["develop"];
}

export function assertReleaseBranch({
  branch,
  version,
}: {
  branch: string;
  version: string;
}): void {
  const allowed = allowedReleaseBranches(version);
  if (!allowed.some((candidate) => candidate === branch)) {
    throw new Error(
      `Release ${version} cannot be prepared from branch "${branch || "(detached)"}". ` +
        `Allowed branches: ${allowed.join(", ")}.`,
    );
  }
}

function requireSameCommit(
  isAncestor: AncestryCheck,
  head: string,
  remoteRef: string,
): void {
  if (!isAncestor(head, remoteRef) || !isAncestor(remoteRef, head)) {
    throw new Error(
      `Release branch HEAD (${head}) must exactly match ${remoteRef}; refusing ` +
        `an unintegrated, ahead, or stale candidate.`,
    );
  }
}

/** Validate a local release candidate before any build or file mutation. */
export function assertLocalReleaseAncestry({
  branch,
  head,
  version,
  remote,
  isAncestor,
}: {
  branch: string;
  head: string;
  version: string;
  remote: string;
  isAncestor: AncestryCheck;
}): void {
  const developRef = `${remote}/develop`;
  const mainRef = `${remote}/main`;

  if (branch === "develop") {
    requireSameCommit(isAncestor, head, developRef);
    return;
  }
  if (branch === "main") {
    requireSameCommit(isAncestor, head, mainRef);
    return;
  }

  throw new Error(`No ancestry policy for ${version} on ${branch}.`);
}

/** Validate an immutable tag's channel provenance in CI or local publish. */
export function assertPublishProvenance({
  tag,
  packageVersion,
  head,
  tagCommit,
  remote,
  isAncestor,
}: {
  tag: string;
  packageVersion: string;
  head: string;
  tagCommit: string;
  remote: string;
  isAncestor: AncestryCheck;
}): ReleaseTag {
  const parsed = parseReleaseTag(tag);
  assertMatchingVersions({
    cliVersion: packageVersion,
    expectedVersion: parsed.version,
  });
  if (tagCommit !== head) {
    throw new Error(
      `Release tag ${tag} resolves to ${tagCommit}, but checked-out HEAD is ${head}.`,
    );
  }

  const developRef = `${remote}/develop`;
  const mainRef = `${remote}/main`;
  if (parsed.channel === "stable") {
    requireSameCommit(isAncestor, head, mainRef);
    return parsed;
  }
  requireSameCommit(isAncestor, head, developRef);
  return parsed;
}

export function inspectLocalRelease({
  runner,
  cwd,
  version,
  remote = "private",
}: {
  runner: CommandRunner;
  cwd: string;
  version: string;
  remote?: string;
}): { branch: string; head: string; remote: string; status: string } {
  const status = capture(
    runner,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd,
  );
  // Deliberately stop here: a dirty tree does not need any more Git facts and
  // certainly must not reach build, bump, stage, tag, or publish commands.
  assertCleanTree(status);

  const branch = capture(runner, "git", ["branch", "--show-current"], cwd);
  assertReleaseBranch({ branch, version });
  const head = capture(runner, "git", ["rev-parse", "HEAD"], cwd);
  const isAncestor = (ancestor, descendant) =>
    commandSucceeds(
      runner,
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      cwd,
    );
  assertLocalReleaseAncestry({
    branch,
    head,
    version,
    remote,
    isAncestor,
  });
  return { branch, head, remote, status };
}

export function inspectPublishRelease({
  runner,
  cwd,
  packageVersion,
  explicitTag,
  remote = "origin",
  env = process.env,
}: {
  runner: CommandRunner;
  cwd: string;
  packageVersion: string;
  explicitTag?: string;
  remote?: string;
  env?: NodeJS.ProcessEnv;
}): ReleaseTag & { head: string; remote: string; status: string } {
  const status = capture(
    runner,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd,
  );
  assertCleanTree(status);
  const tag = resolveReleaseTag({ explicitTag, env });
  // Parsing before additional Git calls gives malformed tags the smallest
  // possible blast radius and a deterministic error.
  parseReleaseTag(tag);
  const head = capture(runner, "git", ["rev-parse", "HEAD"], cwd);
  const tagCommit = capture(
    runner,
    "git",
    ["rev-parse", `${tag}^{commit}`],
    cwd,
  );
  const isAncestor = (ancestor, descendant) =>
    commandSucceeds(
      runner,
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      cwd,
    );
  const parsed = assertPublishProvenance({
    tag,
    packageVersion,
    head,
    tagCommit,
    remote,
    isAncestor,
  });
  return { ...parsed, head, remote, status };
}
