/**
 * Fail-closed release candidate planner.
 *
 * This command intentionally does not bump package files, stage, commit, tag,
 * or push. It proves that the current integrated source is clean and releasable,
 * runs the complete candidate validation set, and prints the exact next version
 * and tag for a maintainer-controlled release change.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertMatchingVersions,
  compareReleaseVersions,
  createCommandRunner,
  inspectLocalRelease,
  parseReleaseVersion,
  RELEASE_TAG_PREFIX,
} from "./release-guard.js";
import { runCandidateValidation } from "./release-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CLI_DIR, "../..");

const RELEASE_TYPES = new Set([
  "patch",
  "minor",
  "major",
  "beta",
  "promote",
]);
const EXPLICIT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

export function computeReleaseTarget(current, type) {
  let target;
  if (EXPLICIT_VERSION.test(type)) {
    parseReleaseVersion(type);
    target = type;
  } else {
    const parsed = parseReleaseVersion(current);
    const [major, minor, patch] = parsed.baseVersion.split(".").map(Number);
    if (type === "patch") {
      target =
        parsed.channel === "stable"
          ? `${major}.${minor}.${patch + 1}`
          : parsed.baseVersion;
    } else if (type === "minor") {
      target = `${major}.${minor + 1}.0`;
    } else if (type === "major") {
      target = `${major + 1}.0.0`;
    } else if (type === "promote") {
      if (parsed.channel === "stable") {
        throw new Error(
          `promote requires a prerelease version (got ${current}).`,
        );
      }
      target = parsed.baseVersion;
    } else if (type === "beta") {
      if (parsed.channel === type) {
        const currentNumber = Number(
          current.slice(current.lastIndexOf(".") + 1),
        );
        target = `${parsed.baseVersion}-${type}.${currentNumber + 1}`;
      } else {
        const base =
          parsed.channel === "stable"
            ? `${major}.${minor}.${patch + 1}`
            : parsed.baseVersion;
        target = `${base}-${type}.0`;
      }
    } else {
      throw new Error(`unknown release type: ${type}`);
    }
  }
  if (compareReleaseVersions(target, current) <= 0) {
    throw new Error(
      `Target version ${target} must be newer than current version ${current}.`,
    );
  }
  return target;
}

function readPackageInfo() {
  const cli = JSON.parse(
    fs.readFileSync(path.join(CLI_DIR, "package.json"), "utf-8"),
  );
  return {
    cliName: cli.name,
    cliVersion: cli.version,
  };
}

export function buildReleaseCandidatePlan({ type, packageInfo, git }) {
  assertMatchingVersions(packageInfo);
  if (!RELEASE_TYPES.has(type) && !EXPLICIT_VERSION.test(type)) {
    throw new Error(
      "usage: release.js <patch|minor|major|beta|promote|x.y.z[-beta.N]>",
    );
  }
  const targetVersion = computeReleaseTarget(packageInfo.cliVersion, type);
  const parsed = parseReleaseVersion(targetVersion);
  return {
    mode: "validated-candidate-plan",
    currentVersion: packageInfo.cliVersion,
    targetVersion,
    channel: parsed.channel,
    tag: `${RELEASE_TAG_PREFIX}${targetVersion}`,
    branch: git.branch,
    head: git.head,
    remote: git.remote,
    mutationsPerformed: [],
  };
}

export function runReleaseCandidate({
  type = "patch",
  remote = "private",
  runner = createCommandRunner(),
  packageInfo = readPackageInfo(),
  repoRoot = REPO_ROOT,
  cliDir = CLI_DIR,
  validate = true,
}) {
  assertMatchingVersions(packageInfo);
  if (!RELEASE_TYPES.has(type) && !EXPLICIT_VERSION.test(type)) {
    throw new Error(
      "usage: release.js <patch|minor|major|beta|promote|x.y.z[-beta.N]>",
    );
  }
  const targetVersion = computeReleaseTarget(packageInfo.cliVersion, type);
  parseReleaseVersion(targetVersion);

  // Git facts and provenance are checked before the first build/test command.
  const git = inspectLocalRelease({
    runner,
    cwd: repoRoot,
    version: targetVersion,
    remote,
  });
  if (validate) {
    const kernelBin = path.join(cliDir, "bin", "pactile.js");
    const quoted = /\s/.test(kernelBin) ? `"${kernelBin}"` : kernelBin;
    runCandidateValidation({
      runner,
      repoRoot,
      cliDir,
      env: {
        PACTILE_KERNEL_CLI: `node ${quoted} kernel --json`,
        PACTILE_SKIP_SMART_SEARCH_POSTINSTALL: "1",
      },
    });
  }
  return buildReleaseCandidatePlan({ type, packageInfo, git });
}

function parseArgs(argv) {
  let type = "patch";
  let remote = "private";
  let sawType = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") continue;
    if (arg === "--remote") {
      remote = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    if (sawType) throw new Error(`unexpected argument: ${arg}`);
    type = arg;
    sawType = true;
  }
  return {
    type,
    remote,
    json: argv.includes("--json"),
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.remote) throw new Error("--remote requires a remote name.");
    const plan = runReleaseCandidate(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return;
    }
    console.log(
      [
        `ok release candidate validated at ${plan.head}`,
        `  source: ${plan.branch} (remote ${plan.remote})`,
        `  current: ${plan.currentVersion}`,
        `  target:  ${plan.targetVersion}`,
        `  tag:     ${plan.tag}`,
        "No package file, index, commit, tag, remote, or registry state was changed.",
      ].join("\n"),
    );
  } catch (error) {
    console.error(
      `x ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

const invokedAs = process.argv[1];
if (
  invokedAs &&
  import.meta.url === pathToFileURL(path.resolve(invokedAs)).href
) {
  main();
}
