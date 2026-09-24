import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateReleasePackPaths } from "./check-release-pack-contents.js";
import {
  releasePackageDefinitions,
  resolveNpmTag,
  validatePackedCliPackage,
  validatePackedShimPackage,
} from "./release-preflight.js";

export const RELEASE_ARTIFACT_MANIFEST = "release-artifacts-v1.json";

export const REQUIRED_CORE_RELEASE_FILES = [
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
];

export const REQUIRED_LEGACY_CORE_RELEASE_FILES = [
  "package.json",
  "LICENSE",
  "index.js",
  "index.d.ts",
  "task.js",
  "task.d.ts",
  "testing.js",
  "testing.d.ts",
];

export const REQUIRED_LEGACY_CLI_RELEASE_FILES = [
  "package.json",
  "LICENSE",
  "index.js",
  "index.d.ts",
  "bin/cstl.js",
];

export function candidateValidationCommands({ repoRoot, cliDir }) {
  return [
    {
      command: process.execPath,
      args: [path.join(cliDir, "scripts/check-manifest-continuity.js")],
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
  ];
}

/** Run every fallible candidate check before a publish command is possible. */
export function runCandidateValidation({ runner, repoRoot, cliDir, env = {} }) {
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

export function validateCorePackPaths(inputPaths) {
  const paths = new Set(
    inputPaths.map((file) => String(file).replace(/\\/g, "/")),
  );
  return REQUIRED_CORE_RELEASE_FILES.filter((file) => !paths.has(file)).map(
    (file) => `missing required packed core file: ${file}`,
  );
}

export function validateShimPackPaths(inputPaths, key) {
  const expected =
    key === "legacyCore"
      ? REQUIRED_LEGACY_CORE_RELEASE_FILES
      : key === "legacyCli"
        ? REQUIRED_LEGACY_CLI_RELEASE_FILES
        : null;
  if (!expected) throw new Error(`Unknown shim package key "${key}".`);
  const paths = new Set(
    inputPaths.map((file) => String(file).replace(/\\/g, "/")),
  );
  const errors = expected
    .filter((file) => !paths.has(file))
    .map((file) => `missing required packed ${key} file: ${file}`);
  for (const file of paths) {
    if (!expected.includes(file)) {
      errors.push(`unexpected packed ${key} file: ${file}`);
    }
  }
  return errors;
}

function assertArtifactDirectory({ artifactDir, repoRoot }) {
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

function credentialFreeEnvironment(extra = {}) {
  return {
    ...extra,
    NODE_AUTH_TOKEN: undefined,
    NPM_TOKEN: undefined,
  };
}

function expectedTarballName(packageName, version) {
  return `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function sha256File(file) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex")}`;
}

export function assertManifestSha256(value) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      "Expected manifest SHA-256 must use the form sha256:<64 lowercase hex characters>.",
    );
  }
  return value;
}

function tarballEntries(runner, tarballPath) {
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

function tarballPackageJson(runner, tarballPath) {
  const output = runner("tar", ["-xOf", tarballPath, "package/package.json"], {
    capture: true,
    env: credentialFreeEnvironment(),
  });
  try {
    return JSON.parse(String(output));
  } catch (error) {
    throw new Error(
      `Packed package.json is not valid JSON in ${tarballPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function validatePackageIdentity(packedPackage, expected) {
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

export function inspectReleaseTarball({ runner, tarballPath, key, expected }) {
  const entries = tarballEntries(runner, tarballPath);
  const packedPackage = tarballPackageJson(runner, tarballPath);
  validatePackageIdentity(packedPackage, expected);

  if (key === "core") {
    const errors = validateCorePackPaths(entries);
    if (errors.length > 0) throw new Error(errors.join("\n"));
  } else if (key === "cli") {
    const errors = validateReleasePackPaths(entries);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    validatePackedCliPackage(packedPackage, expected.version);
  } else if (key === "legacyCore" || key === "legacyCli") {
    const errors = validateShimPackPaths(entries, key);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    validatePackedShimPackage(packedPackage, {
      key,
      expectedVersion: expected.version,
    });
  } else {
    throw new Error(`Unknown release package key "${key}".`);
  }
  return { entries, packedPackage };
}

function packPackage({ runner, packageDir, artifactDir, name, version }) {
  runner("pnpm", ["pack", "--pack-destination", artifactDir], {
    cwd: packageDir,
    capture: true,
    env: credentialFreeEnvironment({
      PACTILE_SKIP_SMART_SEARCH_POSTINSTALL: "1",
    }),
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

function artifactRecord({ key, name, version, tarballPath }) {
  return {
    key,
    name,
    version,
    filename: path.basename(tarballPath),
    size: fs.statSync(tarballPath).size,
    sha256: sha256File(tarballPath),
  };
}

function hydrateManifest(manifest, artifactDir) {
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
}) {
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

  const records = [];
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

  const manifest = {
    schemaVersion: 1,
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

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function validateArtifactRecord(record, expected, artifactDir) {
  requireObject(record, `Release artifact ${expected.key}`);
  if (
    record.key !== expected.key ||
    record.name !== expected.name ||
    record.version !== expected.version
  ) {
    throw new Error(`Release artifact identity mismatch for ${expected.key}.`);
  }
  if (
    typeof record.filename !== "string" ||
    path.basename(record.filename) !== record.filename ||
    record.filename !== expectedTarballName(expected.name, expected.version)
  ) {
    throw new Error(`Unsafe release artifact filename for ${expected.key}.`);
  }
  if (
    typeof record.sha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(record.sha256)
  ) {
    throw new Error(`Invalid release artifact hash for ${expected.key}.`);
  }
  if (!Number.isSafeInteger(record.size) || record.size < 1) {
    throw new Error(`Invalid release artifact size for ${expected.key}.`);
  }
  const tarballPath = path.join(artifactDir, record.filename);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Missing prepared release artifact: ${tarballPath}`);
  }
  if (fs.statSync(tarballPath).size !== record.size) {
    throw new Error(
      `Prepared release artifact size changed: ${record.filename}`,
    );
  }
  if (sha256File(tarballPath) !== record.sha256) {
    throw new Error(
      `Prepared release artifact hash changed: ${record.filename}`,
    );
  }
  return { ...record, tarballPath };
}

/** Re-open and fully validate the sealed package set before any registry operation. */
export function readPreparedReleaseArtifacts({
  runner,
  artifactDir,
  packageInfo,
  expectedReleaseTag,
  expectedManifestSha256,
}) {
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
  let parsedManifest;
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
  if (manifest.schemaVersion !== 1) {
    throw new Error("Unsupported release artifact manifest schemaVersion.");
  }
  if (
    manifest.version !== packageInfo.cliVersion ||
    manifest.version !== packageInfo.coreVersion ||
    manifest.version !== packageInfo.legacyCoreVersion ||
    manifest.version !== packageInfo.legacyCliVersion
  ) {
    throw new Error("Release artifact version no longer matches the checkout.");
  }
  try {
    if (
      typeof manifest.npmTag !== "string" ||
      resolveNpmTag(manifest.version, manifest.npmTag) !== manifest.npmTag
    ) {
      throw new Error("invalid npm tag");
    }
  } catch {
    throw new Error("Release artifact npm tag does not match its version.");
  }
  if (
    expectedReleaseTag !== undefined &&
    manifest.releaseTag !== expectedReleaseTag
  ) {
    throw new Error(
      `Prepared release tag ${manifest.releaseTag ?? "(none)"} does not match ${expectedReleaseTag}.`,
    );
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== 4) {
    throw new Error(
      "Release artifact manifest must contain exactly the four-package release set.",
    );
  }
  const expected = releasePackageDefinitions(packageInfo).map((definition) => ({
    ...definition,
    version: manifest.version,
  }));
  const packages = expected.map((definition) => {
    const matches = manifest.packages.filter(
      (item) => item?.key === definition.key,
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
    ...manifest,
    packages,
    manifestPath,
    manifestSha256: actualManifestSha256,
  };
}
