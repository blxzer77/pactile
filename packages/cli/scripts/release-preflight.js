/** Shared, fail-closed release and publish preflight. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertMatchingVersions,
  createCommandRunner,
  inspectPublishRelease,
  parseReleaseTag,
  resolveReleaseTag,
} from "./release-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI_PKG = path.join(REPO_ROOT, "packages/cli/package.json");
const CORE_DEPENDENCY = "@blxzer/pactile-core";
const LEGACY_DEPENDENCIES = [
  CORE_DEPENDENCY,
  "@blxzer/cursor-trellis-core",
  "@blxzer/cursor-trellis",
];

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

export function readVersions() {
  const cli = readJSON(CLI_PKG);
  const packageRoot = path.join(REPO_ROOT, "packages");
  const otherPublicPackages = fs.readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "cli")
    .map((entry) => path.join(packageRoot, entry.name, "package.json"))
    .filter((file) => fs.existsSync(file) && readJSON(file).private !== true);
  if (otherPublicPackages.length > 0) {
    throw new Error(`Single-package release rejects other public packages: ${otherPublicPackages.join(", ")}`);
  }
  validatePackedCliPackage(cli, cli.version);
  return {
    cliName: cli.name,
    cliVersion: cli.version,
  };
}

export const RELEASE_PACKAGE_DAG = [{ key: "cli", dependsOn: [] }];

export function assertReleasePackageOrder(order) {
  const expectedKeys = RELEASE_PACKAGE_DAG.map((node) => node.key);
  if (!Array.isArray(order) || order.length !== expectedKeys.length) {
    throw new Error(
      `Release publish DAG must contain exactly: ${expectedKeys.join(" -> ")}.`,
    );
  }

  const seen = new Set();
  for (const key of order) {
    const node = RELEASE_PACKAGE_DAG.find((candidate) => candidate.key === key);
    if (!node) throw new Error(`Unknown release package key "${key}".`);
    if (seen.has(key)) {
      throw new Error(
        `Release publish DAG contains duplicate package "${key}".`,
      );
    }
    const missing = node.dependsOn.filter(
      (dependency) => !seen.has(dependency),
    );
    if (missing.length > 0) {
      throw new Error(
        `Release package "${key}" cannot run before ${missing.join(", ")}.`,
      );
    }
    seen.add(key);
  }

  const omitted = expectedKeys.filter((key) => !seen.has(key));
  if (omitted.length > 0) {
    throw new Error(`Release publish DAG omitted: ${omitted.join(", ")}.`);
  }
  return order;
}

export function releasePackageDefinitions(versions) {
  assertMatchingVersions(versions);
  assertReleasePackageOrder(["cli"]);
  return [{ key: "cli", name: versions.cliName, version: versions.cliVersion }];
}

export function computeNpmTag(version) {
  if (/-beta\./.test(version)) return "beta";
  if (/-rc\.|-alpha\./.test(version)) {
    throw new Error("v0.6.0 release workflow supports beta and stable versions only.");
  }
  return "candidate";
}

/**
 * Resolve the npm dist-tag sealed into a release artifact.
 *
 * Beta tags publish to beta and stable tags publish to candidate. Only the
 * separately authorized manual promotion job can move candidate to latest.
 */
export function resolveNpmTag(version, explicitTag) {
  const defaultTag = computeNpmTag(version);
  if (explicitTag === undefined || explicitTag === null || explicitTag === "") {
    return defaultTag;
  }
  if (
    typeof explicitTag !== "string" ||
    !/^[a-z][a-z0-9._-]*$/i.test(explicitTag)
  ) {
    throw new Error(
      `Invalid npm dist-tag "${String(explicitTag)}". Expected a simple npm tag name.`,
    );
  }
  if (explicitTag !== defaultTag) {
    throw new Error(
      `Npm dist-tag "${explicitTag}" is not allowed for ${version}; expected "${defaultTag}".`,
    );
  }
  return defaultTag;
}

function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
  return `${error.message}\n${stderr}`;
}

export function npmVersionExists(
  packageName,
  version,
  { runner = createCommandRunner() } = {},
) {
  try {
    const out = String(
      runner(
        "npm",
        [
          "view",
          `${packageName}@${version}`,
          "version",
          "--json",
          "--registry=https://registry.npmjs.org/",
        ],
        { capture: true },
      ),
    ).trim();
    return out !== "" && JSON.parse(out) === version;
  } catch (error) {
    const text = errorText(error);
    if (text.includes("E404") || text.toLowerCase().includes("not found")) {
      return false;
    }
    throw error;
  }
}

function npmViewJSON(args, runner) {
  const out = String(
    runner(
      "npm",
      ["view", ...args, "--json", "--registry=https://registry.npmjs.org/"],
      { capture: true },
    ),
  ).trim();
  return out === "" ? null : JSON.parse(out);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(label, fn) {
  const attempts = 6;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      console.error(
        `! ${label} not visible yet; retrying (${attempt}/${attempts})`,
      );
      await sleep(10_000);
    }
  }
  throw lastError;
}

function inferredTag({ explicitTag, env }) {
  const candidate = resolveReleaseTag({ explicitTag, env });
  if (explicitTag) return candidate;
  if (env.GITHUB_REF?.startsWith("refs/tags/")) return candidate;
  if (env.GITHUB_REF_TYPE === "tag") return candidate;
  if (candidate.startsWith("pactile-v")) return candidate;
  return "";
}

export function checkVersions({
  requireTag = false,
  quiet = false,
  explicitTag,
  env = process.env,
  versions = readVersions(),
} = {}) {
  assertMatchingVersions(versions);
  const tag = inferredTag({ explicitTag, env });
  let tagVersion = null;
  if (tag) tagVersion = parseReleaseTag(tag).version;
  if (requireTag && !tag) {
    throw new Error(
      `Expected an exact pactile-v${versions.cliVersion} tag, but no release tag was provided.`,
    );
  }
  if (tagVersion !== null && tagVersion !== versions.cliVersion) {
    throw new Error(
      `Git tag version (${tagVersion}) does not match package version (${versions.cliVersion}).`,
    );
  }
  if (!quiet) {
    console.log(
      `ok release package: ${versions.cliName}@${versions.cliVersion}` +
        (tag ? ` = git tag ${tag}` : ""),
    );
  }
  return { ...versions, tag, tagVersion };
}

export function checkPublishProvenance({
  runner = createCommandRunner(),
  remote = "origin",
  explicitTag,
  env = process.env,
  versions = readVersions(),
  repoRoot = REPO_ROOT,
} = {}) {
  const checked = checkVersions({
    requireTag: true,
    quiet: true,
    explicitTag,
    env,
    versions,
  });
  const provenance = inspectPublishRelease({
    runner,
    cwd: repoRoot,
    packageVersion: checked.cliVersion,
    explicitTag: checked.tag,
    remote,
    env,
  });
  console.log(
    `ok ${checked.tag} matches package version and ${provenance.channel} provenance (${provenance.head}).`,
  );
  return { ...checked, ...provenance };
}

export function createPublishPlan({
  versions,
  npmTag,
  exists = npmVersionExists,
}) {
  assertMatchingVersions(versions);
  const tag = resolveNpmTag(versions.cliVersion, npmTag);
  const plan = {
    version: versions.cliVersion,
    tag,
  };
  for (const definition of releasePackageDefinitions(versions)) {
    const alreadyOnNpm = exists(definition.name, definition.version);
    plan[definition.key] = {
      name: definition.name,
      publish: !alreadyOnNpm,
      alreadyOnNpm,
    };
  }
  return plan;
}

function publishPlan({ output, npmTag, runner = createCommandRunner() }) {
  const versions = checkVersions({ quiet: output === "json" });
  const plan = createPublishPlan({
    versions,
    npmTag,
    exists: (name, version) => npmVersionExists(name, version, { runner }),
  });
  if (output === "json") {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }
  if (output === "github") {
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (!githubOutput) throw new Error("--github requires GITHUB_OUTPUT.");
    fs.appendFileSync(
      githubOutput,
      [
        `version=${plan.version}`,
        `tag=${plan.tag}`,
        `cli_publish=${plan.cli.publish}`,
        `cli_already_on_npm=${plan.cli.alreadyOnNpm}`,
      ].join("\n") + "\n",
    );
  }
  const status = (pkg) => (pkg.publish ? "publish" : "skip (already on npm)");
  console.log(
    `plan for ${plan.version} -> npm tag "${plan.tag}":\n` +
      `  ${plan.cli.name}@${plan.version}: ${status(plan.cli)}`,
  );
  return plan;
}

function packWorkspacePackage(packageDir, destinationDir, runner) {
  const out = String(
    runner("pnpm", ["pack", "--pack-destination", destinationDir], {
      cwd: packageDir,
      capture: true,
      env: { PACTILE_SKIP_SMART_SEARCH_POSTINSTALL: "1" },
    }),
  );
  const filename = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  let packed = filename
    ? path.isAbsolute(filename)
      ? filename
      : path.join(destinationDir, filename)
    : "";
  if (!packed || !fs.existsSync(packed)) {
    const tarball = fs
      .readdirSync(destinationDir)
      .find((file) => file.endsWith(".tgz"));
    if (!tarball) {
      throw new Error(
        `pnpm pack did not produce a tarball in ${destinationDir}.`,
      );
    }
    packed = path.join(destinationDir, tarball);
  }
  return packed;
}

function normalizeBin(value) {
  return typeof value === "string" ? value.replace(/^\.\//, "") : value;
}

function hasWorkspaceProtocol(value) {
  if (typeof value === "string") return value.startsWith("workspace:");
  if (Array.isArray(value)) return value.some(hasWorkspaceProtocol);
  if (value && typeof value === "object") {
    return Object.values(value).some(hasWorkspaceProtocol);
  }
  return false;
}

export function assertPackedManifestUsesSemver(packedPackage) {
  if (hasWorkspaceProtocol(packedPackage)) {
    throw new Error(
      `packed ${packedPackage.name ?? "package"} contains a workspace: protocol`,
    );
  }
}

export function validatePackedCliPackage(packedPackage, expectedVersion) {
  const errors = [];
  assertPackedManifestUsesSemver(packedPackage);
  if (packedPackage.name !== "@blxzer/pactile" || packedPackage.version !== expectedVersion) {
    errors.push(`packed CLI identity must be @blxzer/pactile@${expectedVersion}`);
  }
  if (packedPackage.engines?.node !== ">=18.17.0") {
    errors.push("packed Pactile must declare Node >=18.17.0");
  }
  for (const subpath of ["./core", "./core/task", "./core/compat"]) {
    if (!packedPackage.exports?.[subpath]) {
      errors.push(`packed Pactile is missing ${subpath} export`);
    }
  }
  for (const dependency of LEGACY_DEPENDENCIES) {
    if (packedPackage.dependencies?.[dependency] || packedPackage.optionalDependencies?.[dependency]) {
      errors.push(`packed CLI must not depend on retired package ${dependency}`);
    }
  }
  const bins = packedPackage.bin ?? {};
  if (normalizeBin(bins.pactile) !== "bin/pactile.js") {
    errors.push(`packed CLI bin "pactile" does not resolve to bin/pactile.js`);
  }
  if (normalizeBin(bins.cstl) !== "bin/cstl.js") {
    errors.push(`packed CLI bin "cstl" does not resolve to bin/cstl.js`);
  }
  if (normalizeBin(bins["smart-search"]) !== "bin/smart-search.js") {
    errors.push(
      `packed CLI bin "smart-search" does not resolve to bin/smart-search.js`,
    );
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

export function verifyPackedCli({
  runner = createCommandRunner(),
  versions = readVersions(),
} = {}) {
  assertMatchingVersions(versions);
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-pack-verify-"),
  );
  try {
    const packed = packWorkspacePackage(
      path.join(REPO_ROOT, "packages/cli"),
      temporary,
      runner,
    );
    const extractDir = path.join(temporary, "extract");
    fs.mkdirSync(extractDir);
    runner("tar", ["-xzf", packed, "-C", extractDir, "package/package.json"], {
      capture: true,
    });
    const packedPackage = readJSON(
      path.join(extractDir, "package/package.json"),
    );
    validatePackedCliPackage(packedPackage, versions.cliVersion);
    console.log(
      `ok packed ${versions.cliName}@${versions.cliVersion} has no external Core dependency and exposes its bins.`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function verifyNpm({
  packageFilter,
  npmTag,
  runner = createCommandRunner(),
}) {
  const versions = checkVersions();
  const tag = resolveNpmTag(versions.cliVersion, npmTag);
  const packages = releasePackageDefinitions(versions).filter(
    (pkg) => packageFilter === "all" || pkg.key === packageFilter,
  );
  if (packages.length !== 1) throw new Error(`Unknown release package ${packageFilter}.`);

  for (const pkg of packages) {
    await retry(`${pkg.name}@${versions.cliVersion}`, () => {
      const version = npmViewJSON(
        [`${pkg.name}@${versions.cliVersion}`, "version"],
        runner,
      );
      if (version !== versions.cliVersion) {
        throw new Error(
          `${pkg.name}@${versions.cliVersion} is not visible on npm.`,
        );
      }
      const taggedVersion = npmViewJSON(
        [`${pkg.name}@${tag}`, "version"],
        runner,
      );
      if (taggedVersion !== versions.cliVersion) {
        throw new Error(
          `${pkg.name}@${tag} resolves to ${taggedVersion ?? "nothing"}, expected ${versions.cliVersion}.`,
        );
      }
      console.log(
        `ok ${pkg.name}@${versions.cliVersion} visible on npm tag "${tag}".`,
      );
    });
  }
}

function optionValue(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const runner = createCommandRunner();
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(
      "release-preflight <command>\n\n" +
        "commands:\n" +
        "  check-versions [--require-tag] [--tag pactile-vX.Y.Z]\n" +
        "  check-provenance [--tag pactile-vX.Y.Z] [--remote origin]\n" +
        "  npm-tag\n" +
        "  publish-plan [--json|--github] [--npm-tag candidate|beta]\n" +
        "  verify-packed-cli\n" +
        "  verify-npm [--package all|cli] [--npm-tag candidate|beta]",
    );
    return;
  }
  if (command === "check-versions") {
    checkVersions({
      requireTag: args.includes("--require-tag"),
      explicitTag: optionValue(args, "--tag"),
    });
    return;
  }
  if (command === "check-provenance") {
    checkPublishProvenance({
      runner,
      explicitTag: optionValue(args, "--tag"),
      remote: optionValue(args, "--remote", "origin"),
    });
    return;
  }
  if (command === "npm-tag") {
    process.stdout.write(`${computeNpmTag(readVersions().cliVersion)}\n`);
    return;
  }
  if (command === "publish-plan") {
    publishPlan({
      output: args.includes("--json")
        ? "json"
        : args.includes("--github")
          ? "github"
          : "text",
      npmTag: optionValue(args, "--npm-tag"),
      runner,
    });
    return;
  }
  if (command === "verify-packed-cli") {
    verifyPackedCli({ runner });
    return;
  }
  if (command === "verify-npm") {
    const packageFilter = optionValue(args, "--package", "all");
    if (
      !["all", "cli"].includes(packageFilter)
    ) {
      throw new Error(
        "--package must be one of: all, cli.",
      );
    }
    await verifyNpm({
      packageFilter,
      npmTag: optionValue(args, "--npm-tag"),
      runner,
    });
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

const invokedAs = process.argv[1];
if (
  invokedAs &&
  import.meta.url === pathToFileURL(path.resolve(invokedAs)).href
) {
  main().catch((error) => {
    console.error(
      `x ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
