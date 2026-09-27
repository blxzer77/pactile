import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertMatchingVersions,
  assertPublishProvenance,
  assertReleaseBranch,
  parseReleaseTag,
} from "../scripts/release-guard.js";
import {
  assertCredentialFreePreparation,
  runCandidatePreparation,
  runPreparedPublish,
} from "../scripts/publish-packages.js";
import {
  createPublishPlan,
  releasePackageDefinitions,
  resolveNpmTag,
  validatePackedCliPackage,
} from "../scripts/release-preflight.js";
import {
  readPreparedReleaseArtifacts,
  RELEASE_ARTIFACT_MANIFEST,
} from "../scripts/release-validation.js";
import { validateReleasePackPaths, REQUIRED_RELEASE_FILES } from "../scripts/check-release-pack-contents.js";
import {
  assertSinglePackageContract,
  buildSealedTarballInstallArgs,
  createNodeOnlyInstallEnvironment,
  resolveNpmCliPath,
} from "../scripts/release-conformance.js";
import { assertNoPythonOrPiOnPath } from "../scripts/assert-no-python-on-path.js";
import { readCliPackageFiles } from "../scripts/cli-pack-files-utils.js";

const packageInfo = {
  cliName: "@blxzer/pactile",
  cliVersion: "0.6.0-beta.1",
  cliDir: path.resolve("packages/cli"),
};
const manifestSha256 = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakeGitRunner(calls: string[]) {
  return (command: string, args: string[] = []) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command !== "git") return "";
    if (args[0] === "status") return "";
    if (args[0] === "branch") return "develop";
    if (args[0] === "rev-parse") return "head-sha";
    if (args[0] === "merge-base") return "";
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  };
}

function artifact() {
  return {
    schemaVersion: 2,
    version: packageInfo.cliVersion,
    npmTag: "beta",
    releaseTag: "pactile-v0.6.0-beta.1",
    commit: "head-sha",
    manifestSha256,
    packages: [{
      key: "cli", name: packageInfo.cliName,
      version: packageInfo.cliVersion,
      filename: "blxzer-pactile-0.6.0-beta.1.tgz",
      tarballPath: path.join(os.tmpdir(), "blxzer-pactile-0.6.0-beta.1.tgz"),
    }],
  };
}

describe("single-package release policy", () => {
  it("publishes only the built package, root README, and license", () => {
    expect(readCliPackageFiles()).toEqual([
      "dist",
      "README.md",
      "LICENSE",
    ]);
  });

  it("routes beta and stable tags to beta and candidate only", () => {
    expect(resolveNpmTag("0.6.0-beta.1")).toBe("beta");
    expect(resolveNpmTag("0.6.0")).toBe("candidate");
    expect(() => resolveNpmTag("0.6.0", "latest")).toThrow(/expected "candidate"/);
    expect(() => resolveNpmTag("0.6.0-beta.1", "candidate")).toThrow(/expected "beta"/);
    expect(() => resolveNpmTag("0.6.0-rc.1")).toThrow(/supports beta and stable/);
    expect(parseReleaseTag("pactile-v0.6.0-beta.1").channel).toBe("beta");
  });

  it("requires exact source branch head and matching package version", () => {
    expect(() => assertReleaseBranch({ branch: "feat/bridge", version: "0.6.0-beta.1" }))
      .toThrow(/Allowed branches: develop/);
    expect(() => assertMatchingVersions({ cliVersion: "0.6.0", expectedVersion: "0.6.0-beta.1" }))
      .toThrow(/Version mismatch/);
    const isAncestor = (a: string, b: string) =>
      [a, b].every((value) => value === "head" || value === "origin/develop");
    expect(assertPublishProvenance({
      tag: "pactile-v0.6.0-beta.1", packageVersion: "0.6.0-beta.1",
      head: "head", tagCommit: "head", remote: "origin", isAncestor,
    }).channel).toBe("beta");
    expect(() => assertPublishProvenance({
      tag: "pactile-v0.6.0", packageVersion: "0.6.0",
      head: "head", tagCommit: "head", remote: "origin", isAncestor,
    })).toThrow(/exactly match origin\/main/);
  });

  it("keeps one public package with bundled Core and no old package dependency", () => {
    expect(releasePackageDefinitions(packageInfo).map((item: { key: string }) => item.key))
      .toEqual(["cli"]);
    expect(createPublishPlan({ versions: packageInfo, exists: () => false }))
      .toMatchObject({ tag: "beta", cli: { publish: true } });
    const packed = {
      name: packageInfo.cliName, version: packageInfo.cliVersion,
      engines: { node: ">=20.0.0" },
      bin: { pactile: "./dist/bin/pactile.js", cstl: "./dist/bin/cstl.js" },
      exports: { "./core": {}, "./core/task": {}, "./core/compat": {} },
      dependencies: { chalk: "^5.3.0" },
    };
    expect(() => validatePackedCliPackage(packed, packageInfo.cliVersion)).not.toThrow();
    expect(assertSinglePackageContract(packed)).toBe(packageInfo.cliVersion);
    expect(() => validatePackedCliPackage({ ...packed, optionalDependencies: { "@blxzer/smart-search": "^0.2.0" } }, packageInfo.cliVersion))
      .toThrow(/external Smart Search Middleware Provider/);
    expect(() => assertSinglePackageContract({ ...packed, dependencies: { "@blxzer/smart-search": "^0.2.0" } }))
      .toThrow(/external Middleware Provider/);
    expect(() => assertSinglePackageContract({ ...packed, bin: { ...packed.bin, "smart-search": "./dist/bin/smart-search.js" } }))
      .toThrow(/external Middleware Provider/);
    expect(() => validatePackedCliPackage({ ...packed, dependencies: { "@blxzer/pactile-core": "0.6.0" } }, packageInfo.cliVersion))
      .toThrow(/retired package/);
    const releasePaths = [
      ...REQUIRED_RELEASE_FILES,
      "dist/migrations/manifests/0.6.0.json",
      "dist/templates/common/bundled-skills/pactile-check/SKILL.md",
    ];
    expect(validateReleasePackPaths(releasePaths)).toEqual([]);
    expect(validateReleasePackPaths(releasePaths.filter((file) => file !== "dist/core/index.js")))
      .toContain("missing required packed file: dist/core/index.js");
    expect(validateReleasePackPaths([...releasePaths, "dist/legacy.py"]))
      .toContain("forbidden packed path: dist/legacy.py");
  });

  it("rejects Cursor IDE residue in packed names and contents", () => {
    const safePaths = [
      ...REQUIRED_RELEASE_FILES,
      "dist/migrations/manifests/0.6.0.json",
      "dist/templates/common/bundled-skills/pactile-check/SKILL.md",
      "dist/bin/cli-cursor.js",
      "dist/bin/restore-cursor.js",
      "dist/pactile/retrieval/pagination.js",
    ];
    const safeContent = new Map([
      ["dist/bin/cli-cursor.js", "cli-cursor is a terminal command."],
      ["dist/bin/restore-cursor.js", "restore-cursor is a terminal command."],
      ["dist/pactile/retrieval/pagination.js", "const cursor = nextPage;"],
    ]);
    expect(
      validateReleasePackPaths(safePaths, (file) => safeContent.get(file) ?? ""),
    ).toEqual([]);

    const forbidden = validateReleasePackPaths(
      [...safePaths, "dist/templates/cursor/commands/pactile.md"],
      (file) =>
        file === "README.md"
          ? "Use Cursor IDE with pactile init --cursor."
          : "",
    );
    expect(forbidden).toEqual(
      expect.arrayContaining([
        "forbidden Cursor IDE packed path: dist/templates/cursor/commands/pactile.md",
        "forbidden Cursor IDE host name in packed file: README.md",
        "forbidden Cursor IDE editor command option in packed file: README.md",
      ]),
    );
  });

  it("checks the sealed install with a private Node-only PATH and default lifecycle scripts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-only-install-"));
    roots.push(root);
    const userConfig = path.join(root, "empty-npmrc");
    fs.writeFileSync(userConfig, "", "utf8");
    const env = createNodeOnlyInstallEnvironment(root, userConfig);
    const pathEntries = env.PATH?.split(path.delimiter) ?? [];
    expect(pathEntries[0]).toBe(path.join(root, "node-only-install-bin"));
    expect(pathEntries).not.toContain(path.dirname(process.execPath));
    expect(fs.readdirSync(pathEntries[0] as string)).toEqual([
      process.platform === "win32" ? "node.exe" : "node",
    ]);
    expect(env.PATH).not.toBe(process.env.PATH);
    expect(env.PACTILE_SKIP_SMART_SEARCH_POSTINSTALL).toBeUndefined();
    expect(env.npm_config_ignore_scripts).toBeUndefined();
    expect(env.NPM_CONFIG_IGNORE_SCRIPTS).toBeUndefined();
    expect(() => assertNoPythonOrPiOnPath({ env })).not.toThrow();
    const npmCliPath = resolveNpmCliPath();
    expect(path.isAbsolute(npmCliPath)).toBe(true);
    expect(path.basename(npmCliPath).toLowerCase()).toBe("npm-cli.js");
    expect(fs.existsSync(npmCliPath)).toBe(true);
    expect(
      execFileSync(process.execPath, [npmCliPath, "config", "get", "ignore-scripts"], {
        cwd: root,
        env,
        encoding: "utf8",
      }).trim(),
    ).toBe("false");

    const args = buildSealedTarballInstallArgs({
      prefix: path.join(root, "install"),
      cacheDir: path.join(root, "cache"),
      tarballPath: path.join(root, "pactile.tgz"),
    });
    expect(args).toContain("install");
    expect(args).not.toContain("--ignore-scripts");
  });

  it("resolves only bounded Windows and Linux npm CLI layouts", () => {
    const windowsNode = "C:\\hostedtoolcache\\windows\\node\\22\\x64\\node.exe";
    const windowsNpm = "C:\\hostedtoolcache\\windows\\node\\22\\x64\\node_modules\\npm\\bin\\npm-cli.js";
    const windowsProbe: string[] = [];
    expect(
      resolveNpmCliPath({
        executablePath: windowsNode,
        platform: "win32",
        isFile: (candidate) => {
          windowsProbe.push(candidate);
          return candidate === windowsNpm;
        },
      }),
    ).toBe(windowsNpm);
    expect(windowsProbe).toEqual([windowsNpm]);

    const linuxNode = "/opt/hostedtoolcache/node/22/x64/bin/node";
    const linuxNpm = "/opt/hostedtoolcache/node/22/x64/lib/node_modules/npm/bin/npm-cli.js";
    const linuxProbe: string[] = [];
    expect(
      resolveNpmCliPath({
        executablePath: linuxNode,
        platform: "linux",
        isFile: (candidate) => {
          linuxProbe.push(candidate);
          return candidate === linuxNpm;
        },
      }),
    ).toBe(linuxNpm);
    expect(linuxProbe).toEqual([
      "/opt/hostedtoolcache/node/22/x64/bin/node_modules/npm/bin/npm-cli.js",
      linuxNpm,
    ]);

    const debianNpm = "/usr/share/nodejs/npm/bin/npm-cli.js";
    const debianProbe: string[] = [];
    expect(
      resolveNpmCliPath({
        executablePath: "/usr/bin/node",
        platform: "linux",
        isFile: (candidate) => {
          debianProbe.push(candidate);
          return candidate === debianNpm;
        },
      }),
    ).toBe(debianNpm);
    expect(debianProbe).toEqual([
      "/usr/bin/node_modules/npm/bin/npm-cli.js",
      "/usr/lib/node_modules/npm/bin/npm-cli.js",
      debianNpm,
    ]);
  });

  it("does not select an npm script outside the supported layouts", () => {
    const probed: string[] = [];
    const arbitrary = "/tmp/arbitrary/npm-cli.js";
    expect(() =>
      resolveNpmCliPath({
        executablePath: "/usr/bin/node",
        platform: "linux",
        isFile: (candidate) => {
          probed.push(candidate);
          return candidate === arbitrary;
        },
      }),
    ).toThrow(/supported layouts/);
    expect(probed.every((candidate) => path.basename(candidate) === "npm-cli.js")).toBe(true);
    expect(probed).not.toContain(arbitrary);
  });
});

describe("sealed artifact and credential boundary", () => {
  it("prepares only after validation without a publish credential", () => {
    expect(() => assertCredentialFreePreparation({ NODE_AUTH_TOKEN: "secret" }))
      .toThrow(/refuses publish credentials/);
    const calls: string[] = [];
    const result = runCandidatePreparation({
      dryRun: true, runner: fakeGitRunner(calls), packageInfo,
      repoRoot: path.resolve("."), artifactDir: path.join(os.tmpdir(), "p29-artifacts"),
      env: {}, validateCandidate: () => { calls.push("validate"); return []; },
      prepareArtifacts: () => { calls.push("pack"); return artifact(); }, log: () => undefined,
    });
    expect(result.artifacts.packages.map((item: { key: string }) => item.key)).toEqual(["cli"]);
    expect(calls.indexOf("validate")).toBeLessThan(calls.indexOf("pack"));
    expect(calls.some((call) => call.startsWith("npm publish"))).toBe(false);
  });

  it("publishes exactly the sealed single tarball without rebuilding", () => {
    const calls: string[] = [];
    const result = runPreparedPublish({
      explicitTag: "pactile-v0.6.0-beta.1",
      artifactDir: path.join(os.tmpdir(), "p29-artifacts"),
      expectedManifestSha256: manifestSha256,
      runner: fakeGitRunner(calls), packageInfo,
      loadArtifacts: () => artifact(), npmExists: () => false,
      env: { GITHUB_SHA: "head-sha" }, log: () => undefined,
    });
    expect(result.plan.cli.publish).toBe(true);
    expect(calls).toContain("npm whoami");
    expect(calls.filter((call) => call.startsWith("npm publish "))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("pnpm pack") || call.includes(" build")))
      .toBe(false);
  });

  it("uses GitHub OIDC without a token-only whoami preflight", () => {
    const calls: string[] = [];
    runPreparedPublish({
      explicitTag: "pactile-v0.6.0-beta.1",
      artifactDir: path.join(os.tmpdir(), "p29-artifacts"),
      expectedManifestSha256: manifestSha256,
      runner: fakeGitRunner(calls), packageInfo,
      loadArtifacts: () => artifact(), npmExists: () => false,
      env: {
        GITHUB_SHA: "head-sha",
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "present",
      },
      log: () => undefined,
    });
    expect(calls).not.toContain("npm whoami");
    expect(calls.filter((call) => call.startsWith("npm publish "))).toHaveLength(1);
  });

  it("rejects a changed manifest before tarball inspection or registry access", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p29-receipt-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, RELEASE_ARTIFACT_MANIFEST), "{bad json");
    const calls: string[] = [];
    expect(() => readPreparedReleaseArtifacts({
      runner: fakeGitRunner(calls), artifactDir: root, packageInfo,
      expectedManifestSha256: `sha256:${crypto.createHash("sha256").update("other").digest("hex")}`,
    })).toThrow(/receipt mismatch/);
    expect(calls).toEqual([]);
  });
});
