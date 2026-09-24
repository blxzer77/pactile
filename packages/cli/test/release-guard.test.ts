import crypto from "node:crypto";
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
import { assertSinglePackageContract } from "../scripts/release-conformance.js";

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
      engines: { node: ">=18.17.0" },
      bin: { pactile: "./bin/pactile.js", cstl: "./bin/cstl.js", "smart-search": "./bin/smart-search.js" },
      exports: { "./core": {}, "./core/task": {}, "./core/compat": {} },
      dependencies: { chalk: "^5.3.0" },
    };
    expect(() => validatePackedCliPackage(packed, packageInfo.cliVersion)).not.toThrow();
    expect(assertSinglePackageContract(packed)).toBe(packageInfo.cliVersion);
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
    expect(calls.filter((call) => call.startsWith("npm publish "))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("pnpm pack") || call.includes(" build")))
      .toBe(false);
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
