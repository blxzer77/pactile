/**
 * Prepare and publish one self-contained Pactile tarball across a credential wall.
 *
 * `--prepare-only` must run without publish credentials. It validates the full
 * candidate, creates the tarball once, validates its packed contract, and
 * seals their byte hashes in a manifest. It also returns a SHA-256 receipt that
 * must travel outside the artifact directory. `--publish-only` requires that
 * receipt through `--expected-manifest-sha256`, verifies it before parsing the
 * manifest, and publishes those exact tarballs; it never builds or packs from a
 * source directory. `--dry-run` exercises both phases in one process, passes
 * the generated receipt internally, and performs no registry writes, though
 * the manifest-continuity gate still performs its documented read-only query.
 * A stable release can be staged under `--npm-tag candidate`; publish-only
 * derives the sealed tag from the manifest when the flag is omitted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertCleanTree,
  assertMatchingVersions,
  createCommandRunner,
  inspectLocalRelease,
  inspectPublishRelease,
  parseReleaseTag,
  resolveReleaseTag,
} from "./release-guard.js";
import {
  assertManifestSha256,
  prepareReleaseArtifacts,
  readPreparedReleaseArtifacts,
  runCandidateValidation,
} from "./release-validation.js";
import {
  createPublishPlan,
  npmVersionExists,
  readVersions,
  releasePackageDefinitions,
  resolveNpmTag,
} from "./release-preflight.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CLI_DIR, "../..");

export const PUBLISH_CREDENTIAL_ENV_KEYS = ["NODE_AUTH_TOKEN", "NPM_TOKEN"];

export function readPackageInfo() {
  const cli = readVersions();
  return {
    ...cli,
    cliDir: CLI_DIR,
  };
}

export function assertCredentialFreePreparation(env = process.env) {
  const present = PUBLISH_CREDENTIAL_ENV_KEYS.filter(
    (key) => typeof env[key] === "string" && env[key].trim() !== "",
  );
  if (present.length > 0) {
    throw new Error(
      `Release preparation refuses publish credentials (${present.join(
        ", ",
      )}). Run validation/packing in a credential-free step.`,
    );
  }
}

function validationEnvironment(cliDir, env) {
  const bin = path.join(cliDir, "bin", "pactile.js");
  const quoted = /\s/.test(bin) ? `"${bin}"` : bin;
  return {
    PACTILE_KERNEL_CLI:
      env.PACTILE_KERNEL_CLI ?? `node ${quoted} kernel --json`,
    PACTILE_SKIP_SMART_SEARCH_POSTINSTALL: "1",
    NODE_AUTH_TOKEN: undefined,
    NPM_TOKEN: undefined,
  };
}

function credentialFreeRunner(runner) {
  return (command, args = [], options = {}) =>
    runner(command, args, {
      ...options,
      env: {
        ...options.env,
        // The parent process writes the receipt only after validation and
        // packing finish. Candidate scripts must not be able to pre-seed or
        // replace the GitHub step output used as the independent channel.
        GITHUB_OUTPUT: undefined,
        NODE_AUTH_TOKEN: undefined,
        NPM_TOKEN: undefined,
      },
    });
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function writeManifestReceiptOutput({
  outputPath,
  artifactDir,
  manifestSha256,
}) {
  assertManifestSha256(manifestSha256);
  if (!outputPath) throw new Error("--receipt-output requires a path.");
  if (isPathInside(artifactDir, outputPath)) {
    throw new Error(
      "Manifest receipt output must remain outside the release artifact directory.",
    );
  }
  fs.appendFileSync(
    path.resolve(outputPath),
    `manifest_sha256=${manifestSha256}${os.EOL}`,
    "utf-8",
  );
}

function dryRunPlan(packageInfo, npmTag) {
  const plan = {
    version: packageInfo.cliVersion,
    tag: resolveNpmTag(packageInfo.cliVersion, npmTag),
    registryChecked: false,
  };
  for (const definition of releasePackageDefinitions(packageInfo)) {
    plan[definition.key] = {
      name: definition.name,
      publish: true,
      alreadyOnNpm: null,
    };
  }
  return plan;
}

function statusAfter(runner, repoRoot) {
  return String(
    runner("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repoRoot,
      capture: true,
      env: {
        GITHUB_OUTPUT: undefined,
        NODE_AUTH_TOKEN: undefined,
        NPM_TOKEN: undefined,
      },
    }) ?? "",
  ).trim();
}

/** Credential-free source validation plus creation of the immutable tarball. */
export function runCandidatePreparation({
  dryRun = false,
  explicitTag,
  explicitNpmTag,
  remote = "private",
  artifactDir,
  runner = createCommandRunner(),
  packageInfo = readPackageInfo(),
  repoRoot = REPO_ROOT,
  validateCandidate = runCandidateValidation,
  prepareArtifacts = prepareReleaseArtifacts,
  env = process.env,
  log = console.log,
} = {}) {
  assertCredentialFreePreparation(process.env);
  assertCredentialFreePreparation(env);
  if (!artifactDir)
    throw new Error("Release preparation requires --artifact-dir.");
  const preparationRunner = credentialFreeRunner(runner);
  const version = assertMatchingVersions(packageInfo);
  const provenance = dryRun
    ? inspectLocalRelease({
        runner: preparationRunner,
        cwd: repoRoot,
        version,
        remote,
      })
    : inspectPublishRelease({
        runner: preparationRunner,
        cwd: repoRoot,
        packageVersion: version,
        explicitTag,
        remote,
        env,
      });

  const validationCommands = validateCandidate({
    runner: preparationRunner,
    repoRoot,
    cliDir: packageInfo.cliDir,
    env: validationEnvironment(packageInfo.cliDir, env),
  });
  assertCleanTree(statusAfter(preparationRunner, repoRoot));

  const artifacts = prepareArtifacts({
    runner: preparationRunner,
    repoRoot,
    artifactDir,
    packageInfo,
    provenance,
    npmTag: explicitNpmTag,
  });
  const manifestSha256 = assertManifestSha256(artifacts.manifestSha256);
  assertCleanTree(statusAfter(preparationRunner, repoRoot));
  log(
    `prepared ${artifacts.packages.length} immutable release tarballs for ${version} (${artifacts.npmTag}); manifest receipt ${manifestSha256}.`,
  );
  return { artifacts, manifestSha256, provenance, validationCommands };
}

function packageArtifact(artifacts, key) {
  const item = artifacts.packages.find((entry) => entry.key === key);
  if (!item) throw new Error(`Prepared release artifact is missing ${key}.`);
  return item;
}

/** Registry plan/auth and publication of the already-validated byte artifacts. */
export function runPreparedPublish({
  dryRun = false,
  explicitTag,
  explicitNpmTag,
  artifactDir,
  expectedManifestSha256,
  runner = createCommandRunner(),
  packageInfo = readPackageInfo(),
  repoRoot = REPO_ROOT,
  loadArtifacts = readPreparedReleaseArtifacts,
  npmExists = npmVersionExists,
  env = process.env,
  log = console.log,
} = {}) {
  if (!artifactDir)
    throw new Error("Prepared publish requires --artifact-dir.");
  assertManifestSha256(expectedManifestSha256);
  assertMatchingVersions(packageInfo);

  let releaseTag;
  if (!dryRun) {
    releaseTag = resolveReleaseTag({ explicitTag, env });
    const parsed = parseReleaseTag(releaseTag);
    if (parsed.version !== packageInfo.cliVersion) {
      throw new Error(
        `Release tag ${releaseTag} does not match package version ${packageInfo.cliVersion}.`,
      );
    }
  }
  const artifacts = loadArtifacts({
    runner,
    artifactDir,
    packageInfo,
    expectedReleaseTag: releaseTag,
    expectedManifestSha256,
  });
  const requestedNpmTag =
    explicitNpmTag === undefined
      ? artifacts.npmTag
      : resolveNpmTag(packageInfo.cliVersion, explicitNpmTag);
  if (artifacts.npmTag !== requestedNpmTag) {
    throw new Error(
      `Prepared artifact npm tag ${artifacts.npmTag} does not match requested ${requestedNpmTag}.`,
    );
  }
  const currentCommit =
    env.GITHUB_SHA ??
    String(
      runner("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        capture: true,
        env: {
          GITHUB_OUTPUT: undefined,
          NODE_AUTH_TOKEN: undefined,
          NPM_TOKEN: undefined,
        },
      }),
    ).trim();
  if (artifacts.commit !== currentCommit) {
    throw new Error(
      `Prepared artifact commit ${artifacts.commit} does not match checkout ${currentCommit}.`,
    );
  }

  // All artifact parsing, content checks, and checksum verification are above
  // the first registry query and therefore above the first possible publish.
  const plan = dryRun
    ? dryRunPlan(packageInfo, artifacts.npmTag)
    : {
        ...createPublishPlan({
          versions: packageInfo,
          npmTag: artifacts.npmTag,
          exists: (name, version) => npmExists(name, version, { runner }),
        }),
        registryChecked: true,
      };
  if (plan.tag !== artifacts.npmTag || plan.version !== artifacts.version) {
    throw new Error("Prepared artifact manifest does not match publish plan.");
  }

  log(
    `publish plan: ${plan.cli.name}@${plan.version} -> ${plan.tag} ` +
      `(${plan.cli.publish ? "publish" : "skip"})`,
  );
  const orderedPlan = releasePackageDefinitions(packageInfo).map(({ key }) => ({
    key,
    item: plan[key],
  }));
  const hasGitHubOidc =
    env.GITHUB_ACTIONS === "true" &&
    Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL) &&
    Boolean(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  if (!dryRun && !hasGitHubOidc && orderedPlan.some((entry) => entry.item.publish)) {
    try {
      runner("npm", ["whoami"], { cwd: repoRoot, capture: true });
    } catch {
      throw new Error(
        "npm authentication failed after artifact validation; no publish command ran.",
      );
    }
  }

  for (const entry of orderedPlan) {
    if (!entry.item.publish) continue;
    const artifact = packageArtifact(artifacts, entry.key);
    runner(
      "npm",
      [
        "publish",
        artifact.tarballPath,
        ...(dryRun ? ["--dry-run"] : []),
        "--access",
        "public",
        "--ignore-scripts",
        "--tag",
        plan.tag,
      ],
      {
        cwd: repoRoot,
        capture: false,
        env: dryRun
          ? {
              GITHUB_OUTPUT: undefined,
              NODE_AUTH_TOKEN: undefined,
              NPM_TOKEN: undefined,
            }
          : undefined,
      },
    );
    log(
      `${dryRun ? "dry-run" : "published"} ${entry.item.name}@${plan.version} from ${artifact.filename}`,
    );
  }
  return { artifacts, plan };
}

/** Credential/tag-free rehearsal; registry continuity is read-only, not skipped. */
export function runPublishDryRun({ artifactDir, ...options } = {}) {
  const ownDirectory = !artifactDir;
  const target =
    artifactDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "pactile-release-dry-"));
  try {
    const preparation = runCandidatePreparation({
      ...options,
      dryRun: true,
      artifactDir: target,
    });
    const publication = runPreparedPublish({
      ...options,
      dryRun: true,
      artifactDir: target,
      expectedManifestSha256: preparation.manifestSha256,
    });
    return { ...preparation, plan: publication.plan };
  } finally {
    if (ownDirectory) fs.rmSync(target, { recursive: true, force: true });
  }
}

/** Backwards-compatible programmatic entry point: only safe dry-run is combined. */
export function runPublishPipeline(options = {}) {
  if (!options.dryRun) {
    throw new Error(
      "Real release requires separate --prepare-only and --publish-only invocations.",
    );
  }
  return runPublishDryRun(options);
}

function optionValue(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

function main() {
  try {
    const args = process.argv.slice(2);
    const prepareOnly = args.includes("--prepare-only");
    const publishOnly = args.includes("--publish-only");
    const dryRun = args.includes("--dry-run");
    if ([prepareOnly, publishOnly, dryRun].filter(Boolean).length !== 1) {
      throw new Error(
        "Choose exactly one mode: --prepare-only, --publish-only, or --dry-run.",
      );
    }
    const remote = optionValue(args, "--remote", "private");
    const explicitTag = optionValue(args, "--tag");
    const explicitNpmTag = optionValue(args, "--npm-tag");
    const artifactDir = optionValue(args, "--artifact-dir");
    const receiptOutput = optionValue(args, "--receipt-output");
    const expectedManifestSha256 = optionValue(
      args,
      "--expected-manifest-sha256",
    );
    if (!remote) throw new Error("--remote requires a remote name.");
    if (args.includes("--tag") && !explicitTag) {
      throw new Error("--tag requires an exact pactile-v<semver> value.");
    }
    if (args.includes("--npm-tag") && !explicitNpmTag) {
      throw new Error("--npm-tag requires a non-empty npm dist-tag.");
    }
    if (args.includes("--receipt-output") && !receiptOutput) {
      throw new Error("--receipt-output requires a path.");
    }
    if (
      args.includes("--expected-manifest-sha256") &&
      !expectedManifestSha256
    ) {
      throw new Error("--expected-manifest-sha256 requires a digest.");
    }

    if (prepareOnly) {
      if (expectedManifestSha256) {
        throw new Error(
          "--expected-manifest-sha256 is only valid with --publish-only.",
        );
      }
      const result = runCandidatePreparation({
        explicitTag,
        explicitNpmTag,
        remote,
        artifactDir,
      });
      if (receiptOutput) {
        writeManifestReceiptOutput({
          outputPath: receiptOutput,
          artifactDir,
          manifestSha256: result.manifestSha256,
        });
      }
      console.log(
        `ok release artifacts prepared for ${result.artifacts.version}; manifest receipt ${result.manifestSha256}; no publish credential was available.`,
      );
      return;
    }
    if (publishOnly) {
      if (receiptOutput) {
        throw new Error("--receipt-output is only valid with --prepare-only.");
      }
      if (!expectedManifestSha256) {
        throw new Error(
          "Real publish-only requires --expected-manifest-sha256 from the independent preparation receipt.",
        );
      }
      const result = runPreparedPublish({
        explicitTag,
        explicitNpmTag,
        artifactDir,
        expectedManifestSha256,
      });
      console.log(`ok publish completed for ${result.plan.version}.`);
      return;
    }
    if (receiptOutput || expectedManifestSha256) {
      throw new Error(
        "--dry-run creates and consumes its manifest receipt in the same process; receipt flags are not accepted.",
      );
    }
    const result = runPublishDryRun({
      remote,
      artifactDir,
      explicitNpmTag,
    });
    console.log(
      `ok publish dry-run completed for ${result.plan.version}; registry continuity was read only and no registry state changed.`,
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
