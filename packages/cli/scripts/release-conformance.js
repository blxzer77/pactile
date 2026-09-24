/** Verify that one sealed tarball installs and runs with Node as its runtime. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createCommandRunner } from "./release-guard.js";
import {
  inspectReleaseTarball,
  prepareReleaseArtifacts,
  readPreparedReleaseArtifacts,
} from "./release-validation.js";
import { assertCredentialFreePreparation, readPackageInfo } from "./publish-packages.js";

const NODE_ENGINE = ">=18.17.0";
const EXPECTED_BINS = {
  pactile: "bin/pactile.js",
  cstl: "bin/cstl.js",
  "smart-search": "bin/smart-search.js",
};

export function assertSinglePackageContract(packedPackage) {
  if (packedPackage.name !== "@blxzer/pactile") {
    throw new Error(`Expected one @blxzer/pactile tarball, got ${packedPackage.name}.`);
  }
  if (packedPackage.engines?.node !== NODE_ENGINE) {
    throw new Error(`Pactile must declare Node ${NODE_ENGINE}.`);
  }
  for (const [name, target] of Object.entries(EXPECTED_BINS)) {
    if (packedPackage.bin?.[name]?.replace(/^\.\//, "") !== target) {
      throw new Error(`Packed Pactile bin ${name} must point to ${target}.`);
    }
  }
  for (const subpath of ["./core", "./core/task", "./core/compat"]) {
    if (!packedPackage.exports?.[subpath]) {
      throw new Error(`Packed Pactile is missing ${subpath}.`);
    }
  }
  return packedPackage.version;
}

function runtimeEnvironment(root, userConfig) {
  const bin = path.join(root, "node-only-bin");
  fs.mkdirSync(bin);
  const launcher = path.join(bin, process.platform === "win32" ? "node.exe" : "node");
  if (process.platform === "win32") fs.copyFileSync(process.execPath, launcher);
  else fs.symlinkSync(process.execPath, launcher);
  const systemPath = process.platform === "win32"
    ? `${bin};${path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")}`
    : bin;
  return {
    PATH: systemPath,
    Path: systemPath,
    NODE_AUTH_TOKEN: undefined,
    NPM_TOKEN: undefined,
    NPM_CONFIG_USERCONFIG: userConfig,
    PACTILE_SKIP_SMART_SEARCH_POSTINSTALL: "1",
  };
}

export async function verifyReleaseConformance({
  runner = createCommandRunner(),
  packageInfo = readPackageInfo(),
  temporaryRoot,
  log = console.log,
} = {}) {
  assertCredentialFreePreparation(process.env);
  const ownedTemporary = temporaryRoot === undefined;
  const root = temporaryRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "pactile-release-one-"));
  const artifactDir = path.join(root, "artifacts");
  const prefix = path.join(root, "install");
  const cacheDir = path.join(root, "npm-cache");
  const userConfig = path.join(root, "empty-npmrc");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(userConfig, "", "utf8");
  try {
    const prepared = prepareReleaseArtifacts({
      runner,
      repoRoot: path.resolve(packageInfo.cliDir, "../.."),
      artifactDir,
      packageInfo,
      provenance: { head: process.env.GITHUB_SHA ?? "local-conformance", tag: null },
    });
    const sealed = readPreparedReleaseArtifacts({
      runner,
      artifactDir,
      packageInfo,
      expectedReleaseTag: null,
      expectedManifestSha256: prepared.manifestSha256,
    });
    if (sealed.packages.length !== 1 || sealed.packages[0].key !== "cli") {
      throw new Error("Release conformance requires exactly one Pactile tarball.");
    }
    const tarball = sealed.packages[0];
    const { packedPackage } = inspectReleaseTarball({
      runner,
      tarballPath: tarball.tarballPath,
      key: "cli",
      expected: { name: packageInfo.cliName, version: packageInfo.cliVersion },
    });
    assertSinglePackageContract(packedPackage);

    runner("npm", [
      "--prefix", prefix, "install", "--ignore-scripts", "--no-audit", "--no-fund",
      "--no-save", "--package-lock=false", "--cache", cacheDir,
      "--registry=https://registry.npmjs.org/", tarball.tarballPath,
    ], {
      capture: false,
      env: {
        NODE_AUTH_TOKEN: undefined,
        NPM_TOKEN: undefined,
        NPM_CONFIG_USERCONFIG: userConfig,
        PACTILE_SKIP_SMART_SEARCH_POSTINSTALL: "1",
      },
    });
    const installed = path.join(prefix, "node_modules", "@blxzer", "pactile");
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
    if (manifest.version !== packageInfo.cliVersion) {
      throw new Error("Installed Pactile version differs from the sealed tarball.");
    }
    if (fs.existsSync(path.join(prefix, "node_modules", "@blxzer", "pactile-core"))) {
      throw new Error("Single-package install unexpectedly pulled Pactile Core.");
    }
    const taskApi = await import(pathToFileURL(path.join(installed, "dist", "core", "task", "index.js")).href);
    if (typeof taskApi.emptyTaskRecord !== "function") {
      throw new Error("Installed Pactile Core task API is unavailable.");
    }
    const nodeOnly = runtimeEnvironment(root, userConfig);
    const cli = path.join(installed, "bin", "pactile.js");
    const version = String(runner(process.execPath, [cli, "--version"], {
      cwd: prefix, capture: true, env: nodeOnly,
    })).trim();
    if (version !== packageInfo.cliVersion) {
      throw new Error(`Installed Pactile bin returned ${version}, expected ${packageInfo.cliVersion}.`);
    }
    runner(process.execPath, [cli, "task", "--help"], {
      cwd: prefix, capture: true, env: nodeOnly,
    });
    const result = {
      version,
      manifestSha256: sealed.manifestSha256,
      packageOrder: ["cli"],
      nodeOnlyVerified: true,
    };
    log(`ok release conformance ${version}: one sealed tarball, Node-only CLI and task API.`);
    return result;
  } finally {
    if (ownedTemporary && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

const invokedAs = process.argv[1];
if (invokedAs && import.meta.url === pathToFileURL(path.resolve(invokedAs)).href) {
  verifyReleaseConformance().catch((error) => {
    console.error(`x ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
