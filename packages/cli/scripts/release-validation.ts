import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateReleasePackPaths } from "./check-release-pack-contents.js";
import {
  releasePackageDefinitions,
  resolveNpmTag,
  validatePackedCliPackage,
} from "./release-preflight.js";
import type {
  CliPackageManifest,
  CommandRunner,
  PackageInfo,
  PreparedReleaseArtifacts,
  ReleaseArtifactRecord,
  ReleasePackageDefinition,
} from "./types.js";
import { isRecord } from "./types.js";

interface ReleaseArtifactManifest {
  schemaVersion: 2;
  version: string;
  npmTag: string;
  releaseTag: string | null;
  commit: string;
  packages: ReleaseArtifactRecord[];
}

export const RELEASE_ARTIFACT_MANIFEST = "release-artifacts-v1.json";

export function candidateValidationCommands({
  repoRoot,
  cliDir,
}: {
  repoRoot: string;
  cliDir: string;
}) {
  return [
    {
      command: "pnpm",
      args: ["exec", "tsx", "scripts/check-manifest-continuity.ts"],
      cwd: cliDir,
      label: "manifest/npm continuity (registry read only)",
    },
    {
      command: "pnpm",
      args: ["run", "build"],
      cwd: repoRoot,
      label: "build",
    },
    {
      command: "pnpm",
      args: ["run", "typecheck"],
      cwd: repoRoot,
      label: "typecheck",
    },
    {
      command: "pnpm",
      args: ["run", "lint"],
      cwd: repoRoot,
      label: "lint",
    },
    {
      command: "pnpm",
      args: ["run", "test"],
      cwd: repoRoot,
      label: "test",
    },
    {
      command: "pnpm",
      args: ["--filter", "@blxzer/pactile", "run", "check:pack-files"],
      cwd: repoRoot,
      label: "CLI pack file contract",
    },
    {
      command: "pnpm",
      args: ["--filter", "@blxzer/pactile", "run", "check:release-pack"],
      cwd: repoRoot,
      label: "release pack preview",
    },
    {
      command: "pnpm",
      args: ["exec", "tsx", "scripts/release-conformance.ts"],
      cwd: repoRoot,
      label: "single tarball Node-only install",
    },
  ];
}

/** Run every fallible candidate check before a publish command is possible. */
export function runCandidateValidation({
  runner,
  repoRoot,
  cliDir,
  env = {},
}: {
  runner: CommandRunner;
  repoRoot: string;
  cliDir: string;
  env?: NodeJS.ProcessEnv;
}) {
  const commands = candidateValidationCommands({ repoRoot, cliDir });
  for (const item of commands) {
    runner(item.command, item.args, {
      cwd: item.cwd,
      capture: false,
      env,
    });
  }
  return commands;
}

function assertArtifactDirectory({
  artifactDir,
  repoRoot,
}: {
  artifactDir: string;
  repoRoot: string;
}): string {
  const resolvedArtifactDir = path.resolve(artifactDir);
  const relative = path.relative(path.resolve(repoRoot), resolvedArtifactDir);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    throw new Error(
      `Release artifacts must be written outside the repository: ${resolvedArtifactDir}`,
    );
  }
  if (
    fs.existsSync(resolvedArtifactDir) &&
    fs.readdirSync(resolvedArtifactDir).length > 0
  ) {
    throw new Error(
      `Release artifact directory must be empty: ${resolvedArtifactDir}`,
    );
  }
  fs.mkdirSync(resolvedArtifactDir, { recursive: true });
  return resolvedArtifactDir;
}

function credentialFreeEnvironment(
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...extra,
    NODE_AUTH_TOKEN: undefined,
    NPM_TOKEN: undefined,
  };
}

function expectedTarballName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function sha256File(file: string): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex")}`;
}

export function assertManifestSha256(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      "Expected manifest SHA-256 must use the form sha256:<64 lowercase hex characters>.",
    );
  }
  return value;
}

function tarballEntries(runner: CommandRunner, tarballPath: string): string[] {
  const output = String(
    runner("tar", ["-tzf", tarballPath], {
      capture: true,
      env: credentialFreeEnvironment(),
    }),
  );
  return output
    .split(/\r?\n/)
    .map((entry) =>
      entry
        .trim()
        .replace(/^\.\/package\//, "")
        .replace(/^package\//, ""),
    )
    .filter((entry) => entry !== "" && !entry.endsWith("/"));
}

function tarballPackageJson(
  runner: CommandRunner,
  tarballPath: string,
): CliPackageManifest {
  const output = runner("tar", ["-xOf", tarballPath, "package/package.json"], {
    capture: true,
    env: credentialFreeEnvironment(),
  });
  try {
    const parsed: unknown = JSON.parse(String(output));
    if (
      !isRecord(parsed) ||
      typeof parsed.name !== "string" ||
      typeof parsed.version !== "string"
    ) {
      throw new Error("Packed package.json is missing name or version.");
    }
    return parsed as CliPackageManifest;
  } catch (error) {
    throw new Error(
      `Packed package.json is not valid JSON in ${tarballPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function validatePackageIdentity(
  packedPackage: CliPackageManifest,
  expected: { name: string; version: string },
): void {
  if (packedPackage.name !== expected.name) {
    throw new Error(
      `Packed package name is "${packedPackage.name ?? "missing"}"; expected "${expected.name}".`,
    );
  }
  if (packedPackage.version !== expected.version) {
    throw new Error(
      `Packed ${expected.name} version is "${packedPackage.version ?? "missing"}"; expected "${expected.version}".`,
    );
  }
}

export function inspectReleaseTarball({
  runner,
  tarballPath,
  key,
  expected,
}: {
  runner: CommandRunner;
  tarballPath: string;
  key: "cli";
  expected: { name: string; version: string };
}): { entries: string[]; packedPackage: CliPackageManifest } {
  if (key !== "cli") throw new Error(`Unknown release package key "${key}".`);
  const entries = tarballEntries(runner, tarballPath);
  const packedPackage = tarballPackageJson(runner, tarballPath);
  validatePackageIdentity(packedPackage, expected);
  const errors = validateReleasePackPaths(entries);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  validatePackedCliPackage(packedPackage, expected.version);
  return { entries, packedPackage };
}

function packPackage({
  runner,
  packageDir,
  artifactDir,
  name,
  version,
}: {
  runner: CommandRunner;
  packageDir: string;
  artifactDir: string;
  name: string;
  version: string;
}): string {
  runner("pnpm", ["pack", "--pack-destination", artifactDir], {
    cwd: packageDir,
    capture: true,
    env: credentialFreeEnvironment(),
  });
  const tarballPath = path.join(
    artifactDir,
    expectedTarballName(name, version),
  );
  if (!fs.existsSync(tarballPath)) {
    throw new Error(
      `pnpm pack did not produce the deterministic tarball ${tarballPath}.`,
    );
  }
  return tarballPath;
}

function artifactRecord({
  key,
  name,
  version,
  tarballPath,
}: {
  key: "cli";
  name: string;
  version: string;
  tarballPath: string;
}): ReleaseArtifactRecord {
  return {
    key,
    name,
    version,
    filename: path.basename(tarballPath),
    size: fs.statSync(tarballPath).size,
    sha256: sha256File(tarballPath),
  };
}

function hydrateManifest(
  manifest: ReleaseArtifactManifest,
  artifactDir: string,
): Omit<ReleaseArtifactManifest, "packages"> & {
  packages: (ReleaseArtifactRecord & { tarballPath: string })[];
} {
  return {
    ...manifest,
    packages: manifest.packages.map((item) => ({
      ...item,
      tarballPath: path.join(artifactDir, item.filename),
    })),
  };
}

/** Build all immutable package artifacts, validate their bytes, then seal hashes. */
export function prepareReleaseArtifacts({
  runner,
  repoRoot,
  artifactDir,
  packageInfo,
  provenance,
  npmTag,
}: {
  runner: CommandRunner;
  repoRoot: string;
  artifactDir: string;
  packageInfo: PackageInfo;
  provenance: { head: string; tag: string | null };
  npmTag?: string;
}): PreparedReleaseArtifacts {
  const resolvedArtifactDir = assertArtifactDirectory({
    artifactDir,
    repoRoot,
  });
  const version = packageInfo.cliVersion;
  const resolvedNpmTag = resolveNpmTag(version, npmTag);
  const definitions = releasePackageDefinitions(packageInfo).map(
    (definition) => ({
      ...definition,
      version,
      packageDir: packageInfo[`${definition.key}Dir`],
    }),
  );

  const records: ReleaseArtifactRecord[] = [];
  for (const definition of definitions) {
    const tarballPath = packPackage({
      runner,
      packageDir: definition.packageDir,
      artifactDir: resolvedArtifactDir,
      name: definition.name,
      version,
    });
    inspectReleaseTarball({
      runner,
      tarballPath,
      key: definition.key,
      expected: definition,
    });
    records.push(artifactRecord({ ...definition, tarballPath }));
  }

  const manifest: ReleaseArtifactManifest = {
    schemaVersion: 2,
    version,
    npmTag: resolvedNpmTag,
    releaseTag: provenance.tag ?? null,
    commit: provenance.head,
    packages: records,
  };
  const manifestPath = path.join(
    resolvedArtifactDir,
    RELEASE_ARTIFACT_MANIFEST,
  );
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
  const manifestSha256 = sha256File(manifestPath);
  return {
    ...hydrateManifest(manifest, resolvedArtifactDir),
    manifestPath,
    manifestSha256,
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function validateArtifactRecord(
  record: unknown,
  expected: ReleasePackageDefinition,
  artifactDir: string,
): ReleaseArtifactRecord & { tarballPath: string } {
  const value = requireObject(record, `Release artifact ${expected.key}`);
  if (
    value.key !== expected.key ||
    value.name !== expected.name ||
    value.version !== expected.version
  ) {
    throw new Error(`Release artifact identity mismatch for ${expected.key}.`);
  }
  if (
    typeof value.filename !== "string" ||
    path.basename(value.filename) !== value.filename ||
    value.filename !== expectedTarballName(expected.name, expected.version)
  ) {
    throw new Error(`Unsafe release artifact filename for ${expected.key}.`);
  }
  if (
    typeof value.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error(`Invalid release artifact hash for ${expected.key}.`);
  }
  if (
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1
  ) {
    throw new Error(`Invalid release artifact size for ${expected.key}.`);
  }
  const filename = value.filename;
  const size = value.size;
  const sha256 = value.sha256;
  const tarballPath = path.join(artifactDir, filename);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Missing prepared release artifact: ${tarballPath}`);
  }
  if (fs.statSync(tarballPath).size !== size) {
    throw new Error(`Prepared release artifact size changed: ${filename}`);
  }
  if (sha256File(tarballPath) !== sha256) {
    throw new Error(`Prepared release artifact hash changed: ${filename}`);
  }
  return {
    key: expected.key,
    name: expected.name,
    version: expected.version,
    filename,
    size,
    sha256,
    tarballPath,
  };
}

/** Re-open and fully validate the sealed package set before any registry operation. */
export function readPreparedReleaseArtifacts({
  runner,
  artifactDir,
  packageInfo,
  expectedReleaseTag,
  expectedManifestSha256,
}: {
  runner: CommandRunner;
  artifactDir: string;
  packageInfo: PackageInfo;
  expectedReleaseTag?: string | null;
  expectedManifestSha256: string;
}): PreparedReleaseArtifacts {
  assertManifestSha256(expectedManifestSha256);
  const resolvedArtifactDir = path.resolve(artifactDir);
  const manifestPath = path.join(
    resolvedArtifactDir,
    RELEASE_ARTIFACT_MANIFEST,
  );
  // Hash the exact bytes that will be parsed. The independently transported
  // receipt is checked before JSON parsing, tar inspection, or registry access,
  // so coordinated edits to a tarball and its colocated manifest fail closed.
  const manifestBytes = fs.readFileSync(manifestPath);
  const actualManifestSha256 = `sha256:${crypto
    .createHash("sha256")
    .update(manifestBytes)
    .digest("hex")}`;
  if (actualManifestSha256 !== expectedManifestSha256) {
    throw new Error(
      `Release artifact manifest SHA-256 receipt mismatch: expected ${expectedManifestSha256}, actual ${actualManifestSha256}.`,
    );
  }
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestBytes.toString("utf-8"));
  } catch (error) {
    throw new Error(
      `Release artifact manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const manifest = requireObject(parsedManifest, "Release artifact manifest");
  if (manifest.schemaVersion !== 2) {
    throw new Error("Unsupported release artifact manifest schemaVersion.");
  }
  if (
    typeof manifest.version !== "string" ||
    manifest.version !== packageInfo.cliVersion
  ) {
    throw new Error("Release artifact version no longer matches the checkout.");
  }
  const version = manifest.version;
  const npmTag = manifest.npmTag;
  const releaseTag = manifest.releaseTag;
  const commit = manifest.commit;
  try {
    if (
      typeof npmTag !== "string" ||
      resolveNpmTag(version, npmTag) !== npmTag
    ) {
      throw new Error("invalid npm tag");
    }
  } catch {
    throw new Error("Release artifact npm tag does not match its version.");
  }
  if (expectedReleaseTag !== undefined && releaseTag !== expectedReleaseTag) {
    throw new Error(
      `Prepared release tag ${releaseTag ?? "(none)"} does not match ${expectedReleaseTag}.`,
    );
  }
  const packageRecords = manifest.packages;
  if (!Array.isArray(packageRecords) || packageRecords.length !== 1) {
    throw new Error(
      "Release artifact manifest must contain exactly the single Pactile package.",
    );
  }
  if (
    typeof commit !== "string" ||
    (releaseTag !== null && typeof releaseTag !== "string")
  ) {
    throw new Error("Release artifact manifest provenance fields are invalid.");
  }
  if (typeof npmTag !== "string") {
    throw new Error("Release artifact npm tag does not match its version.");
  }
  const validatedReleaseTag =
    typeof releaseTag === "string" ? releaseTag : null;
  const expected = releasePackageDefinitions(packageInfo).map((definition) => ({
    ...definition,
    version,
  }));
  const packages = expected.map((definition) => {
    const matches = packageRecords.filter(
      (item) => isRecord(item) && item.key === definition.key,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Release artifact manifest must contain exactly one ${definition.key} package.`,
      );
    }
    const record = validateArtifactRecord(
      matches[0],
      definition,
      resolvedArtifactDir,
    );
    inspectReleaseTarball({
      runner,
      tarballPath: record.tarballPath,
      key: definition.key,
      expected: definition,
    });
    return record;
  });
  return {
    schemaVersion: 2,
    version,
    npmTag,
    releaseTag: validatedReleaseTag,
    commit,
    packages,
    manifestPath,
    manifestSha256: actualManifestSha256,
  };
}
