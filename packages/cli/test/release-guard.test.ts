import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertMatchingVersions,
  assertPublishProvenance,
  assertReleaseBranch,
  createCommandRunner,
  parseReleaseTag,
} from "../scripts/release-guard.js";
import {
  assertCredentialFreePreparation,
  runCandidatePreparation,
  runPreparedPublish,
  runPublishPipeline,
  writeManifestReceiptOutput,
} from "../scripts/publish-packages.js";
import {
  RELEASE_ARTIFACT_MANIFEST,
  REQUIRED_CORE_RELEASE_FILES,
  validateCorePackPaths,
} from "../scripts/release-validation.js";
import {
  createPublishPlan,
  resolveNpmTag,
} from "../scripts/release-preflight.js";
import {
  computeReleaseTarget,
  runReleaseCandidate,
} from "../scripts/release.js";
import {
  REQUIRED_RELEASE_FILES,
  validateReleasePackPaths,
} from "../scripts/check-release-pack-contents.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");

interface RecordedCall {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

interface FakeGitOptions {
  status?: string;
  branch?: string;
  head?: string;
  tagCommit?: string;
  ancestors?: string[];
}

function fakeRunner(options: FakeGitOptions = {}): {
  calls: RecordedCall[];
  runner: (
    command: string,
    args?: string[],
    run?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ) => string;
} {
  const calls: RecordedCall[] = [];
  const head = options.head ?? "candidate-head";
  const ancestorPairs = new Set(options.ancestors ?? []);
  const runner = (
    command: string,
    args: string[] = [],
    run: {
      cwd?: string;
      env?: Record<string, string | undefined>;
    } = {},
  ): string => {
    calls.push({
      command,
      args: [...args],
      cwd: run.cwd,
      env: run.env === undefined ? undefined : { ...run.env },
    });
    if (command !== "git") return "";
    if (args[0] === "status") return options.status ?? "";
    if (args[0] === "branch") return options.branch ?? "beta";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return head;
    if (args[0] === "rev-parse") return options.tagCommit ?? head;
    if (args[0] === "merge-base") {
      const key = `${args[2]}>${args[3]}`;
      if (ancestorPairs.has(key)) return "";
      throw new Error(`not ancestor: ${key}`);
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
  return { calls, runner };
}

const packageInfo = {
  cliName: "@blxzer/pactile",
  cliVersion: "0.5.0-beta.5",
  cliDir: path.join(REPO_ROOT, "packages/cli"),
  coreName: "@blxzer/pactile-core",
  coreVersion: "0.5.0-beta.5",
  coreDir: path.join(REPO_ROOT, "packages/core"),
  legacyCoreName: "@blxzer/cursor-trellis-core",
  legacyCoreVersion: "0.5.0-beta.5",
  legacyCoreDir: path.join(REPO_ROOT, "packages/cursor-trellis-core-shim"),
  legacyCliName: "@blxzer/cursor-trellis",
  legacyCliVersion: "0.5.0-beta.5",
  legacyCliDir: path.join(REPO_ROOT, "packages/cursor-trellis-shim"),
};

function fakeArtifacts(
  artifactDir = path.join(os.tmpdir(), "release-artifacts"),
) {
  return {
    schemaVersion: 1,
    version: packageInfo.cliVersion,
    npmTag: "beta",
    releaseTag: "pactile-v0.5.0-beta.5",
    commit: "candidate-head",
    manifestSha256: `sha256:${"c".repeat(64)}`,
    packages: [
      {
        key: "core",
        name: packageInfo.coreName,
        version: packageInfo.coreVersion,
        filename: "blxzer-pactile-core-0.5.0-beta.5.tgz",
        size: 100,
        sha256: `sha256:${"a".repeat(64)}`,
        tarballPath: path.join(
          artifactDir,
          "blxzer-pactile-core-0.5.0-beta.5.tgz",
        ),
      },
      {
        key: "cli",
        name: packageInfo.cliName,
        version: packageInfo.cliVersion,
        filename: "blxzer-pactile-0.5.0-beta.5.tgz",
        size: 200,
        sha256: `sha256:${"b".repeat(64)}`,
        tarballPath: path.join(artifactDir, "blxzer-pactile-0.5.0-beta.5.tgz"),
      },
      {
        key: "legacyCore",
        name: packageInfo.legacyCoreName,
        version: packageInfo.legacyCoreVersion,
        filename: "blxzer-cursor-trellis-core-0.5.0-beta.5.tgz",
        size: 80,
        sha256: `sha256:${"d".repeat(64)}`,
        tarballPath: path.join(
          artifactDir,
          "blxzer-cursor-trellis-core-0.5.0-beta.5.tgz",
        ),
      },
      {
        key: "legacyCli",
        name: packageInfo.legacyCliName,
        version: packageInfo.legacyCliVersion,
        filename: "blxzer-cursor-trellis-0.5.0-beta.5.tgz",
        size: 60,
        sha256: `sha256:${"e".repeat(64)}`,
        tarballPath: path.join(
          artifactDir,
          "blxzer-cursor-trellis-0.5.0-beta.5.tgz",
        ),
      },
    ],
  };
}

function sha256File(file: string): string {
  return `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex")}`;
}

describe("release guard negative paths", () => {
  it("allows only the stable candidate staging dist-tag override", () => {
    expect(resolveNpmTag("0.5.0", "candidate")).toBe("candidate");
    expect(resolveNpmTag("0.5.0", undefined)).toBe("latest");
    expect(() => resolveNpmTag("0.5.0-beta.5", "candidate")).toThrow(
      /must use "beta"/,
    );
    expect(() => resolveNpmTag("0.5.0", "staging")).toThrow(
      /only "candidate" or "latest"/,
    );
  });

  it("stops on a dirty tree before branch, build, version, or tag work", () => {
    const fake = fakeRunner({ status: " M package.json" });

    expect(() =>
      runReleaseCandidate({
        type: "beta",
        packageInfo,
        repoRoot: REPO_ROOT,
        cliDir: packageInfo.cliDir,
        runner: fake.runner,
      }),
    ).toThrow(/clean working tree/);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].args[0]).toBe("status");
  });

  it("rejects a beta candidate from a feature branch", () => {
    expect(() =>
      assertReleaseBranch({
        branch: "feat/unsafe-release",
        version: "0.5.0-beta.6",
      }),
    ).toThrow(/cannot be prepared/);
  });

  it("requires the exact pactile tag namespace", () => {
    expect(() => parseReleaseTag("v0.5.0-beta.5")).toThrow(
      /Invalid release tag/,
    );
    expect(() => parseReleaseTag("prefix-pactile-v0.5.0-beta.5")).toThrow(
      /Invalid release tag/,
    );
  });

  it("rejects a stable tag whose commit is not in main", () => {
    expect(() =>
      assertPublishProvenance({
        tag: "pactile-v0.5.0",
        packageVersion: "0.5.0",
        head: "feature-head",
        tagCommit: "feature-head",
        remote: "origin",
        isAncestor: () => false,
      }),
    ).toThrow(/not contained in origin\/main/);
  });

  it("rejects a non-ancestor beta tag", () => {
    expect(() =>
      assertPublishProvenance({
        tag: "pactile-v0.5.0-beta.5",
        packageVersion: "0.5.0-beta.5",
        head: "orphan-head",
        tagCommit: "orphan-head",
        remote: "origin",
        isAncestor: () => false,
      }),
    ).toThrow(/not contained in origin\/beta/);
  });

  it("rejects package and target version mismatch", () => {
    expect(() =>
      assertMatchingVersions({
        coreVersion: "0.5.0-beta.4",
        cliVersion: "0.5.0-beta.5",
        expectedVersion: "0.5.0-beta.5",
      }),
    ).toThrow(/Version mismatch/);
  });

  it("rejects an explicit target version that is not newer", () => {
    expect(() => computeReleaseTarget("0.5.0-beta.5", "0.4.0")).toThrow(
      /must be newer/,
    );
  });

  it("reports missing required CLI and Core tarball files", () => {
    const cliPaths = [
      ...REQUIRED_RELEASE_FILES.filter((file) => file !== "bin/cstl.js"),
      "dist/migrations/manifests/0.5.0.json",
      "dist/templates/common/bundled-skills/example/SKILL.md",
    ];
    expect(validateReleasePackPaths(cliPaths)).toContain(
      "missing required packed file: bin/cstl.js",
    );
    expect(
      validateCorePackPaths(
        REQUIRED_CORE_RELEASE_FILES.filter((file) => file !== "dist/index.js"),
      ),
    ).toContain("missing required packed core file: dist/index.js");
  });
});

describe("credential wall and immutable publish DAG", () => {
  it("removes an inherited publish token from credential-free child commands", () => {
    const runner = createCommandRunner({
      baseEnv: { ...process.env, NODE_AUTH_TOKEN: "inherited-secret" },
    });
    const output = runner(
      process.execPath,
      ["-e", "process.stdout.write(process.env.NODE_AUTH_TOKEN ?? 'absent')"],
      { env: { NODE_AUTH_TOKEN: undefined } },
    );
    expect(output).toBe("absent");
  });

  it("refuses a publish token before the first preparation command", () => {
    const fake = fakeRunner();
    expect(() =>
      runCandidatePreparation({
        dryRun: true,
        artifactDir: path.join(os.tmpdir(), "unused-release-artifacts"),
        runner: fake.runner,
        packageInfo,
        repoRoot: REPO_ROOT,
        env: { NODE_AUTH_TOKEN: "must-not-cross-boundary" },
      }),
    ).toThrow(/refuses publish credentials/);
    expect(fake.calls).toHaveLength(0);
    expect(() =>
      assertCredentialFreePreparation({ NPM_TOKEN: "also-forbidden" }),
    ).toThrow(/NPM_TOKEN/);
  });

  it("finishes every validator before sealing all package artifacts", () => {
    const fake = fakeRunner({
      ancestors: ["candidate-head>private/beta"],
    });
    let callsAtPreparation = -1;
    const artifacts = fakeArtifacts();

    runCandidatePreparation({
      dryRun: false,
      explicitTag: "pactile-v0.5.0-beta.5",
      remote: "private",
      artifactDir: path.join(os.tmpdir(), "release-artifacts"),
      runner: fake.runner,
      packageInfo,
      repoRoot: REPO_ROOT,
      env: { GITHUB_OUTPUT: "must-not-cross-into-candidate-commands" },
      prepareArtifacts: () => {
        callsAtPreparation = fake.calls.length;
        expect(
          fake.calls.some(
            (call) => call.command === "npm" && call.args[0] === "publish",
          ),
        ).toBe(false);
        return artifacts;
      },
      log: () => undefined,
    });

    expect(callsAtPreparation).toBeGreaterThan(0);
    for (const required of [
      "build",
      "typecheck",
      "lint",
      "test",
      "check:pack-files",
      "check:release-pack",
    ]) {
      const index = fake.calls.findIndex((call) =>
        call.args.includes(required),
      );
      expect(index, required).toBeGreaterThan(-1);
      expect(index, required).toBeLessThan(callsAtPreparation);
    }
    const candidateCalls = fake.calls.slice(0, callsAtPreparation);
    expect(
      candidateCalls.every(
        (call) =>
          call.env?.NODE_AUTH_TOKEN === undefined &&
          call.env?.NPM_TOKEN === undefined &&
          call.env?.GITHUB_OUTPUT === undefined,
      ),
    ).toBe(true);
  });

  it("publishes the four validated tarball paths in dependency order without repacking", () => {
    const fake = fakeRunner();
    const artifacts = fakeArtifacts();
    const registryEvents: string[] = [];

    runPreparedPublish({
      dryRun: false,
      explicitTag: "pactile-v0.5.0-beta.5",
      artifactDir: path.dirname(artifacts.packages[0].tarballPath),
      expectedManifestSha256: artifacts.manifestSha256,
      runner: fake.runner,
      packageInfo,
      repoRoot: REPO_ROOT,
      loadArtifacts: () => artifacts,
      npmExists: (name: string) => {
        registryEvents.push(name);
        return false;
      },
      env: {
        GITHUB_SHA: "candidate-head",
        NODE_AUTH_TOKEN: "publish-step-only",
      },
      log: () => undefined,
    });

    expect(registryEvents).toEqual([
      "@blxzer/pactile-core",
      "@blxzer/pactile",
      "@blxzer/cursor-trellis-core",
      "@blxzer/cursor-trellis",
    ]);
    const publishes = fake.calls.filter(
      (call) => call.command === "npm" && call.args[0] === "publish",
    );
    expect(publishes).toHaveLength(4);
    expect(publishes.map((call) => call.args[1])).toEqual(
      artifacts.packages.map((item) => item.tarballPath),
    );
    expect(publishes.every((call) => call.args[1].endsWith(".tgz"))).toBe(true);
    expect(
      fake.calls.some(
        (call) => call.command === "pnpm" && call.args[0] === "publish",
      ),
    ).toBe(false);
  });

  it("derives a stable candidate dist-tag from the sealed manifest", () => {
    const stableInfo = {
      ...packageInfo,
      cliVersion: "0.5.0",
      coreVersion: "0.5.0",
      legacyCoreVersion: "0.5.0",
      legacyCliVersion: "0.5.0",
    };
    const base = fakeArtifacts();
    const artifacts = {
      ...base,
      version: "0.5.0",
      npmTag: "candidate",
      releaseTag: "pactile-v0.5.0",
      packages: base.packages.map((item) => ({
        ...item,
        version: "0.5.0",
        filename: item.filename.replace("0.5.0-beta.5", "0.5.0"),
        tarballPath: item.tarballPath.replace("0.5.0-beta.5", "0.5.0"),
      })),
    };
    const fake = fakeRunner();
    const plan = createPublishPlan({
      versions: stableInfo,
      npmTag: "candidate",
      exists: () => false,
    });
    expect(plan.tag).toBe("candidate");
    runPreparedPublish({
      explicitTag: "pactile-v0.5.0",
      artifactDir: path.dirname(artifacts.packages[0].tarballPath),
      expectedManifestSha256: artifacts.manifestSha256,
      runner: fake.runner,
      packageInfo: stableInfo,
      repoRoot: REPO_ROOT,
      loadArtifacts: () => artifacts,
      npmExists: () => false,
      env: {
        GITHUB_SHA: "candidate-head",
        NODE_AUTH_TOKEN: "publish-step-only",
      },
      log: () => undefined,
    });
    const publishes = fake.calls.filter(
      (call) => call.command === "npm" && call.args[0] === "publish",
    );
    expect(publishes).toHaveLength(4);
    expect(publishes.every((call) => call.args.includes("candidate"))).toBe(
      true,
    );
  });

  it("rejects a changed artifact hash before registry auth or publish", () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-artifact-tamper-"),
    );
    try {
      const artifacts = fakeArtifacts(temporary);
      for (const item of artifacts.packages) {
        fs.writeFileSync(item.tarballPath, "tampered", "utf-8");
        item.size = Buffer.byteLength("tampered");
      }
      fs.writeFileSync(
        path.join(temporary, RELEASE_ARTIFACT_MANIFEST),
        JSON.stringify({
          ...artifacts,
          packages: artifacts.packages.map((artifact) => {
            const { tarballPath, ...item } = artifact;
            void tarballPath;
            return item.key === "core"
              ? { ...item, sha256: `sha256:${"0".repeat(64)}` }
              : item;
          }),
        }),
        "utf-8",
      );
      const expectedManifestSha256 = sha256File(
        path.join(temporary, RELEASE_ARTIFACT_MANIFEST),
      );
      const fake = fakeRunner();
      expect(() =>
        runPreparedPublish({
          explicitTag: "pactile-v0.5.0-beta.5",
          artifactDir: temporary,
          expectedManifestSha256,
          runner: fake.runner,
          packageInfo,
          repoRoot: REPO_ROOT,
          env: { NODE_AUTH_TOKEN: "publish-step-only" },
        }),
      ).toThrow(/hash changed/);
      expect(fake.calls).toHaveLength(0);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("requires an independently supplied manifest receipt before loading artifacts", () => {
    const fake = fakeRunner();
    let loaded = false;
    expect(() =>
      runPreparedPublish({
        explicitTag: "pactile-v0.5.0-beta.5",
        artifactDir: path.join(os.tmpdir(), "release-artifacts"),
        runner: fake.runner,
        packageInfo,
        repoRoot: REPO_ROOT,
        loadArtifacts: () => {
          loaded = true;
          return fakeArtifacts();
        },
        env: { NODE_AUTH_TOKEN: "publish-step-only" },
      }),
    ).toThrow(/Expected manifest SHA-256/);
    expect(loaded).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("checks a mismatched receipt before parsing invalid manifest JSON", () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-manifest-order-"),
    );
    try {
      fs.writeFileSync(
        path.join(temporary, RELEASE_ARTIFACT_MANIFEST),
        "{not-json",
        "utf-8",
      );
      const fake = fakeRunner();
      expect(() =>
        runPreparedPublish({
          explicitTag: "pactile-v0.5.0-beta.5",
          artifactDir: temporary,
          expectedManifestSha256: `sha256:${"0".repeat(64)}`,
          runner: fake.runner,
          packageInfo,
          repoRoot: REPO_ROOT,
          env: { NODE_AUTH_TOKEN: "publish-step-only" },
        }),
      ).toThrow(/manifest SHA-256 receipt mismatch/);
      expect(fake.calls).toHaveLength(0);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects coordinated tarball and manifest tampering against the preparation receipt", () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-coordinated-tamper-"),
    );
    try {
      const artifacts = fakeArtifacts(temporary);
      for (const item of artifacts.packages) {
        fs.writeFileSync(item.tarballPath, `original-${item.key}`, "utf-8");
        item.size = fs.statSync(item.tarballPath).size;
        item.sha256 = sha256File(item.tarballPath);
      }
      const manifestPath = path.join(temporary, RELEASE_ARTIFACT_MANIFEST);
      const storedManifest = {
        schemaVersion: artifacts.schemaVersion,
        version: artifacts.version,
        npmTag: artifacts.npmTag,
        releaseTag: artifacts.releaseTag,
        commit: artifacts.commit,
        packages: artifacts.packages.map(({ tarballPath, ...item }) => {
          void tarballPath;
          return item;
        }),
      };
      fs.writeFileSync(manifestPath, JSON.stringify(storedManifest), "utf-8");
      const preparationReceipt = sha256File(manifestPath);

      const core = artifacts.packages[0];
      fs.writeFileSync(core.tarballPath, "coordinated-tamper", "utf-8");
      storedManifest.packages[0].size = fs.statSync(core.tarballPath).size;
      storedManifest.packages[0].sha256 = sha256File(core.tarballPath);
      fs.writeFileSync(manifestPath, JSON.stringify(storedManifest), "utf-8");

      const fake = fakeRunner();
      expect(() =>
        runPreparedPublish({
          explicitTag: "pactile-v0.5.0-beta.5",
          artifactDir: temporary,
          expectedManifestSha256: preparationReceipt,
          runner: fake.runner,
          packageInfo,
          repoRoot: REPO_ROOT,
          env: { NODE_AUTH_TOKEN: "publish-step-only" },
        }),
      ).toThrow(/manifest SHA-256 receipt mismatch/);
      expect(fake.calls).toHaveLength(0);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("keeps a persisted receipt outside the artifact directory", () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-receipt-output-"),
    );
    try {
      const artifactDir = path.join(temporary, "artifacts");
      fs.mkdirSync(artifactDir);
      const outputPath = path.join(temporary, "github-output.txt");
      const manifestSha256 = `sha256:${"d".repeat(64)}`;
      writeManifestReceiptOutput({
        outputPath,
        artifactDir,
        manifestSha256,
      });
      expect(fs.readFileSync(outputPath, "utf-8")).toContain(
        `manifest_sha256=${manifestSha256}`,
      );
      expect(() =>
        writeManifestReceiptOutput({
          outputPath: path.join(artifactDir, "receipt.txt"),
          artifactDir,
          manifestSha256,
        }),
      ).toThrow(/outside the release artifact directory/);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("supports a tag-free dry-run while retaining read-only continuity", () => {
    const fake = fakeRunner({
      branch: "beta",
      ancestors: ["candidate-head>private/beta", "private/beta>candidate-head"],
    });
    const artifacts = { ...fakeArtifacts(), releaseTag: null };

    runPublishPipeline({
      dryRun: true,
      artifactDir: path.join(os.tmpdir(), "release-artifacts"),
      remote: "private",
      runner: fake.runner,
      packageInfo,
      repoRoot: REPO_ROOT,
      env: {},
      prepareArtifacts: () => artifacts,
      loadArtifacts: () => artifacts,
      npmExists: () => {
        throw new Error("dry-run must not perform the publish-plan lookup");
      },
      log: () => undefined,
    });

    expect(
      fake.calls.some((call) =>
        call.args.some((arg) => arg.endsWith("check-manifest-continuity.js")),
      ),
    ).toBe(true);
    expect(
      fake.calls.some(
        (call) => call.command === "npm" && call.args[0] === "whoami",
      ),
    ).toBe(false);
    const publishes = fake.calls.filter(
      (call) => call.command === "npm" && call.args[0] === "publish",
    );
    expect(publishes).toHaveLength(4);
    expect(publishes.every((call) => call.args.includes("--dry-run"))).toBe(
      true,
    );
    expect(
      publishes.every(
        (call) =>
          call.env?.NODE_AUTH_TOKEN === undefined &&
          call.env?.NPM_TOKEN === undefined,
      ),
    ).toBe(true);
  });

  it("refuses to prepare artifacts if a validator changes the tracked tree", () => {
    let status = "";
    const fake = fakeRunner({
      branch: "beta",
      ancestors: ["candidate-head>private/beta", "private/beta>candidate-head"],
    });
    const runner = (
      command: string,
      args: string[] = [],
      options: {
        cwd?: string;
        env?: Record<string, string | undefined>;
      } = {},
    ): string => {
      if (command === "git" && args[0] === "status") {
        fake.calls.push({ command, args: [...args], cwd: options.cwd });
        return status;
      }
      return fake.runner(command, args, options);
    };

    expect(() =>
      runCandidatePreparation({
        dryRun: true,
        remote: "private",
        artifactDir: path.join(os.tmpdir(), "release-artifacts"),
        runner,
        packageInfo,
        repoRoot: REPO_ROOT,
        env: {},
        validateCandidate: () => {
          status = " M packages/cli/package.json";
          return [];
        },
        prepareArtifacts: () => {
          throw new Error("artifact preparation must not run");
        },
        log: () => undefined,
      }),
    ).toThrow(/clean working tree/);
    expect(
      fake.calls.some(
        (call) => call.command === "npm" && call.args[0] === "publish",
      ),
    ).toBe(false);
  });
});

describe("release workflow wiring", () => {
  it("contains no automatic staging, commit, tag, or push path", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "packages/cli/scripts/release.js"),
      "utf-8",
    );
    expect(source).not.toContain("git add -A");
    expect(source).not.toMatch(/\["commit"|\["tag"|\["push"/);
  });

  it("runs beta/main PR and release-branch checks plus pack smoke on Linux and Windows", () => {
    const ci = fs.readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf-8",
    );
    expect(ci).toContain('branches: [main, beta, "release/**"]');
    expect(ci).toContain("ubuntu-latest");
    expect(ci).toContain("windows-latest");
    expect(ci).toContain("check:release-pack");
    expect(ci).toContain("verify-packed-cli");
  });

  it("keeps publish credentials out of preparation and scopes them to tarball publish", () => {
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, ".github/workflows/publish.yml"),
      "utf-8",
    );
    const provenance = workflow.indexOf("check-provenance");
    const prepare = workflow.indexOf(
      "Validate candidate and prepare immutable tarballs",
    );
    const publish = workflow.indexOf("Publish verified tarballs");
    const token = workflow.indexOf("NODE_AUTH_TOKEN");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(provenance).toBeGreaterThan(-1);
    expect(provenance).toBeLessThan(prepare);
    expect(prepare).toBeLessThan(publish);
    expect(publish).toBeLessThan(token);
    expect(workflow.slice(prepare, publish)).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow.match(/NODE_AUTH_TOKEN/g)?.length ?? 0).toBeGreaterThan(0);
    expect(workflow).toContain("--prepare-only");
    expect(workflow).toContain("--publish-only");
    expect(workflow).toContain("${RUNNER_TEMP}/release-artifacts");
    expect(workflow).toContain("id: prepare");
    expect(workflow).toContain('--receipt-output "${GITHUB_OUTPUT}"');
    expect(workflow).toContain("--expected-manifest-sha256");
    expect(workflow).toContain("${{ steps.prepare.outputs.manifest_sha256 }}");
    expect(workflow).toContain("--npm-tag candidate");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("Create GitHub Latest Release last");
  });
});

describe("promotion registry readback guards", () => {
  function workflowStep(stepName: string): string {
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, ".github/workflows/publish.yml"),
      "utf-8",
    );
    const stepStart = workflow.indexOf(`      - name: ${stepName}`);
    expect(stepStart).toBeGreaterThan(-1);
    const rest = workflow.slice(stepStart);
    const nextStep = rest.slice(1).search(/^ {6}- /m);
    return nextStep < 0 ? rest : rest.slice(0, nextStep + 1);
  }

  function runWorkflowCheck(stepName: string, args: unknown[], checkIndex = 0) {
    const step = workflowStep(stepName);
    const scripts = [
      ...step.matchAll(/node -[^\n]+<<'NODE'\r?\n([\s\S]*?)^\s*NODE\s*$/gm),
    ];
    let script = scripts[checkIndex]?.[1].replace(/^ {10}/gm, "");
    expect(script).toBeDefined();
    if (stepName === "Deprecate pre-Pactile shim versions") {
      script = `${deprecationFetchMock}\n${script}`;
      args = [...args, "0.5.0"];
    }
    return spawnSync(
      process.execPath,
      [
        "-",
        ...args.map((arg) =>
          typeof arg === "string" ? arg : JSON.stringify(arg),
        ),
      ],
      { input: script, encoding: "utf-8" },
    );
  }

  const stagedStep = "Verify every package is staged under candidate";
  const cleanupStep = "Remove temporary candidate dist-tag";
  const deprecationStep = "Deprecate pre-Pactile shim versions";
  const version = "0.5.0";
  const message = `Use ${packageInfo.cliName}@${version}; the legacy package remains a compatibility bridge.`;

  const deprecationFetchMock = `
    const fixture = JSON.parse(process.argv[2]);
    process.argv.splice(2, 1);
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        name: process.argv[3],
        versions: {
          [process.argv[4]]: { version: process.argv[4] },
          ...Object.fromEntries((Array.isArray(fixture) ? fixture : [fixture]).map((value, index) => [value?.version ?? 'invalid-' + index, value])),
        },
      }),
    });
  `;

  function runShellCheck(stepName: string, overrides: Record<string, string>) {
    const step = workflowStep(stepName);
    const runStart = step.search(/^ {8}run: \|\r?\n/m);
    expect(runStart).toBeGreaterThan(-1);
    const script = step
      .slice(runStart)
      .replace(/^ {8}run: \|\r?\n/, "")
      .replace(/^ {10}/gm, "");
    const bash =
      process.platform === "win32"
        ? path.join(
            process.env.ProgramFiles ?? "C:/Program Files",
            "Git/bin/bash.exe",
          )
        : "bash";
    const mock = [
      "node() {",
      '  if [[ -n "${MOCK_FETCH_PREFIX:-}" ]]; then',
      '    local program; program="$(</dev/stdin)"',
      '    printf "%s\\n" "$MOCK_FETCH_PREFIX" "$program" | command node "$@"',
      '  else command node "$@"; fi',
      "}",
      "npm() {",
      '  if [[ "$1" == "view" ]]; then',
      '    if [[ "${MOCK_VIEW_STATUS:-0}" != "0" ]]; then return "$MOCK_VIEW_STATUS"; fi',
      '    if [[ "$3" == "dist-tags" ]]; then',
      '      printf "%s\\n" "$MOCK_TAGS"',
      '    elif [[ "$3" == "version" && "$4" == "deprecated" ]]; then',
      '      if [[ "$2" == "$MOCK_CORE_PACKAGE@<$VERSION" ]]; then',
      '        printf "%s\\n" "$MOCK_CORE_DEPRECATIONS"',
      "      else",
      '        printf "%s\\n" "$MOCK_DEPRECATIONS"',
      "      fi",
      "    else return 91; fi",
      '  elif [[ "$1" == "deprecate" ]]; then',
      "    return 22",
      '  elif [[ "$1" == "dist-tag" && "$2" == "rm" ]]; then',
      "    echo __DELETE_CALLED__",
      '    MOCK_TAGS="${MOCK_AFTER_TAGS:-$MOCK_TAGS}"',
      "  else return 92; fi",
      "}",
    ].join("\n");
    return spawnSync(bash, ["-s"], {
      input: `${mock}\n${script}\necho __STEP_COMPLETED__\n`,
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: "",
        NPM_TOKEN: "",
        VERSION: version,
        CORE_PACKAGE: packageInfo.coreName,
        CLI_PACKAGE: packageInfo.cliName,
        LEGACY_CORE_PACKAGE: packageInfo.legacyCoreName,
        LEGACY_CLI_PACKAGE: packageInfo.legacyCliName,
        MOCK_VIEW_STATUS: "0",
        MOCK_TAGS: JSON.stringify({ latest: version }),
        MOCK_CORE_PACKAGE: packageInfo.legacyCoreName,
        MOCK_FETCH_PREFIX:
          stepName === deprecationStep
            ? `
          globalThis.fetch = async () => {
            if (process.env.MOCK_VIEW_STATUS !== '0') throw new Error('mock registry read failed');
            const raw = process.argv[3] === process.env.MOCK_CORE_PACKAGE ? process.env.MOCK_CORE_DEPRECATIONS : process.env.MOCK_DEPRECATIONS;
            const fixture = JSON.parse(raw);
            return { ok: true, json: async () => ({ name: process.argv[3], versions: {
              [process.argv[4]]: { version: process.argv[4] },
              ...Object.fromEntries((Array.isArray(fixture) ? fixture : [fixture]).map((value, index) => [value?.version ?? 'invalid-' + index, value])),
            } }) };
          };
        `
            : "",
        MOCK_CORE_DEPRECATIONS: JSON.stringify({
          version: "0.4.3",
          deprecated: message.replace(
            packageInfo.cliName,
            packageInfo.coreName,
          ),
        }),
        MOCK_DEPRECATIONS: JSON.stringify({
          version: "0.4.3",
          deprecated: message,
        }),
        ...overrides,
      },
    });
  }

  it.each([stagedStep, cleanupStep, deprecationStep])(
    "fails closed when npm readback fails: %s",
    (step) => {
      const result = runShellCheck(step, { MOCK_VIEW_STATUS: "21" });
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stdout).not.toContain("__STEP_COMPLETED__");
      expect(result.stdout).not.toContain("__DELETE_CALLED__");
    },
  );

  it("skips deletion only after successful absent-candidate reads", () => {
    const result = runShellCheck(cleanupStep, {});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("__STEP_COMPLETED__");
    expect(result.stdout).not.toContain("__DELETE_CALLED__");
  });

  it("rejects a successful DELETE that did not remove candidate", () => {
    const result = runShellCheck(cleanupStep, {
      MOCK_TAGS: JSON.stringify({ latest: version, candidate: version }),
    });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stdout).toContain("__DELETE_CALLED__");
    expect(result.stdout).not.toContain("__STEP_COMPLETED__");
  });

  it("accepts cleanup only after removal readback matches", () => {
    const result = runShellCheck(cleanupStep, {
      MOCK_TAGS: JSON.stringify({
        latest: version,
        candidate: version,
        beta: "0.5.0-beta.5",
      }),
      MOCK_AFTER_TAGS: JSON.stringify({
        latest: version,
        beta: "0.5.0-beta.5",
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("__DELETE_CALLED__");
    expect(result.stdout).toContain("__STEP_COMPLETED__");
  });

  it("accepts a non-zero deprecation request only with complete readback", () => {
    const result = runShellCheck(deprecationStep, {});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("deprecation request returned non-zero");
    expect(result.stdout).toContain("__STEP_COMPLETED__");
  });

  it("rejects a non-zero deprecation request with a missing deprecated field", () => {
    const result = runShellCheck(deprecationStep, {
      MOCK_DEPRECATIONS: JSON.stringify([
        { version: "0.4.2", deprecated: message },
        { version: "0.4.3" },
      ]),
    });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stdout).not.toContain("__STEP_COMPLETED__");
  });

  it.each([{ candidate: version, latest: "0.4.3" }, { latest: version }])(
    "accepts a staged or already-promoted version: %j",
    (tags) => {
      const result = runWorkflowCheck(stagedStep, [
        tags,
        version,
        packageInfo.cliName,
      ]);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    { candidate: "0.5.1", latest: version },
    { candidate: null, latest: version },
    { latest: "0.4.3" },
    {},
    [],
    null,
    "invalid json",
  ])("rejects mismatched or invalid staging metadata: %j", (tags) => {
    expect(
      runWorkflowCheck(stagedStep, [tags, version, packageInfo.cliName]).status,
    ).not.toBe(0);
  });

  it("uses successful dist-tags reads instead of swallowing lookup failures", () => {
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, ".github/workflows/publish.yml"),
      "utf-8",
    );
    expect(workflow).not.toContain('if staged="$(npm view');
    expect(workflow).not.toContain('if npm view "${package_name}@candidate"');
    expect(workflow).toContain(
      'tags="$(npm view "$package_name" dist-tags --json)"',
    );
    expect(workflow).toContain("Object.entries(metadata.versions)");
    expect(workflow).toContain("AbortSignal.timeout(30000)");
  });

  it.each([
    { version: "0.4.3", deprecated: message },
    { version: "0.5.0-beta.5", deprecated: message },
    [{ version: "0.4.3", deprecated: message }, { version: "0.5.1" }],
    [
      { version: "0.4.2", deprecated: message },
      { version: "0.4.3", deprecated: message },
    ],
  ])("accepts complete deprecation readback: %j", (metadata) => {
    const result = runWorkflowCheck(deprecationStep, [
      metadata,
      message,
      packageInfo.legacyCliName,
    ]);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [{ version: "0.4.2", deprecated: message }, { version: "0.4.3" }],
    [{ version: "0.4.3", deprecated: message }, { version: "0.5.0-beta.5" }],
    { version: "0.4.3", deprecated: "different message" },
    { version: "0.5.0", deprecated: message },
    { deprecated: message },
    [],
    null,
    [message],
    "invalid json",
  ])("rejects incomplete or invalid deprecation readback: %j", (metadata) => {
    expect(
      runWorkflowCheck(deprecationStep, [
        metadata,
        message,
        packageInfo.legacyCliName,
      ]).status,
    ).not.toBe(0);
  });

  it.each([
    [{ latest: version, candidate: version }, "present"],
    [{ latest: version }, "absent"],
  ])(
    "classifies candidate cleanup from a successful snapshot: %j",
    (tags, expected) => {
      const result = runWorkflowCheck(cleanupStep, [
        tags,
        version,
        packageInfo.cliName,
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    },
  );

  it.each([
    { latest: version, candidate: "0.5.1" },
    { latest: "0.4.3", candidate: version },
    null,
    [],
    "invalid json",
  ])("refuses cleanup of mismatched or invalid registry state: %j", (tags) => {
    expect(
      runWorkflowCheck(cleanupStep, [tags, version, packageInfo.cliName])
        .status,
    ).not.toBe(0);
  });

  it("verifies candidate removal while preserving other tags", () => {
    const before = {
      latest: version,
      beta: "0.5.0-beta.5",
      candidate: version,
    };
    const after = { latest: version, beta: "0.5.0-beta.5" };
    const result = runWorkflowCheck(
      cleanupStep,
      [before, after, packageInfo.cliName],
      1,
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    { latest: version, beta: "0.5.0-beta.5", candidate: version },
    { latest: "0.5.1", beta: "0.5.0-beta.5" },
    { latest: version },
    { latest: version, beta: "0.5.0-beta.5", extra: version },
    null,
    [],
    "invalid json",
  ])("rejects failed removal or changes to other tags: %j", (after) => {
    const before = {
      latest: version,
      beta: "0.5.0-beta.5",
      candidate: version,
    };
    expect(
      runWorkflowCheck(cleanupStep, [before, after, packageInfo.cliName], 1)
        .status,
    ).not.toBe(0);
  });
});
