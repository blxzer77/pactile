import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertMatchingVersions,
  assertPublishProvenance,
  assertReleaseBranch,
  parseReleaseTag,
} from "../../../../scripts/release-guard.js";
import {
  assertReleasePackageOrder,
  releasePackageDefinitions,
  validatePackedCliPackage,
  validatePackedShimPackage,
} from "../../../../scripts/release-preflight.js";
import { assertManifestSha256 } from "../../../../scripts/release-validation.js";
import {
  assertResolvedBinOwnership,
  assertSupportedNodeEngines,
  collectBinClaims,
  createInstallPlan,
} from "../../../../scripts/release-conformance.js";
import { RELEASE_MATRIX_CASES } from "./cases.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../../../..");
const VERSION = "0.5.0-beta.5";
const VERSIONS = {
  coreName: "@blxzer/pactile-core",
  coreVersion: VERSION,
  cliName: "@blxzer/pactile",
  cliVersion: VERSION,
  legacyCoreName: "@blxzer/cursor-trellis-core",
  legacyCoreVersion: VERSION,
  legacyCliName: "@blxzer/cursor-trellis",
  legacyCliVersion: VERSION,
};

const PACKAGES = [
  {
    key: "core",
    packedPackage: {
      name: VERSIONS.coreName,
      version: VERSION,
      engines: { node: ">=18.17.0" },
    },
  },
  {
    key: "cli",
    packedPackage: {
      name: VERSIONS.cliName,
      version: VERSION,
      engines: { node: ">=18.17.0" },
      dependencies: { "@blxzer/pactile-core": VERSION },
      bin: {
        pactile: "./bin/pactile.js",
        cstl: "./bin/cstl.js",
        "smart-search": "./bin/smart-search.js",
      },
    },
  },
  {
    key: "legacyCore",
    packedPackage: {
      name: VERSIONS.legacyCoreName,
      version: VERSION,
      engines: { node: ">=18.17.0" },
      dependencies: { "@blxzer/pactile-core": VERSION },
    },
  },
  {
    key: "legacyCli",
    packedPackage: {
      name: VERSIONS.legacyCliName,
      version: VERSION,
      engines: { node: ">=18.17.0" },
      dependencies: { "@blxzer/pactile": VERSION },
      bin: { cstl: "./bin/cstl.js" },
    },
  },
];

const ARTIFACTS = releasePackageDefinitions(VERSIONS).map((item) => ({
  ...item,
  tarballPath: path.join("artifacts", `${item.key}.tgz`),
}));

describe("P45 release conformance matrix", () => {
  it("registers unique artifact/runtime/install/guard rows", () => {
    expect(new Set(RELEASE_MATRIX_CASES.map((item) => item.id)).size).toBe(
      RELEASE_MATRIX_CASES.length,
    );
    expect(new Set(RELEASE_MATRIX_CASES.map((item) => item.lane))).toEqual(
      new Set(["artifact", "runtime", "install", "guard"]),
    );
    expect(RELEASE_MATRIX_CASES).toHaveLength(19);
  });

  it("binds package preparation and publication to the canonical DAG", () => {
    const order = releasePackageDefinitions(VERSIONS).map((item) => item.key);
    expect(assertReleasePackageOrder(order)).toEqual([
      "core",
      "cli",
      "legacyCore",
      "legacyCli",
    ]);
    expect(() => assertReleasePackageOrder([...order].reverse())).toThrow(
      /cannot run before/,
    );

    const publishSource = fs.readFileSync(
      path.join(REPO_ROOT, "packages/cli/scripts/publish-packages.js"),
      "utf-8",
    );
    expect(publishSource).toContain(
      "releasePackageDefinitions(packageInfo).map(({ key })",
    );
  });

  it("accepts only exact internal semver dependencies and expected bins", () => {
    validatePackedCliPackage(PACKAGES[1].packedPackage, VERSION);
    validatePackedShimPackage(PACKAGES[2].packedPackage, {
      key: "legacyCore",
      expectedVersion: VERSION,
    });
    validatePackedShimPackage(PACKAGES[3].packedPackage, {
      key: "legacyCli",
      expectedVersion: VERSION,
    });

    const drifted = structuredClone(PACKAGES[1].packedPackage);
    drifted.dependencies["@blxzer/pactile-core"] = "workspace:*";
    expect(() => validatePackedCliPackage(drifted, VERSION)).toThrow(
      /workspace:/,
    );
  });

  it("rejects an ambiguous shared cstl bin with actionable recovery", () => {
    const claims = collectBinClaims(PACKAGES, [
      "core",
      "cli",
      "legacyCore",
      "legacyCli",
    ]);
    expect(() =>
      assertResolvedBinOwnership({
        claims,
        owners: {},
        profile: "ambiguous-shared-prefix",
      }),
    ).toThrow(/No installation started.*canonical profile.*legacy profile/);
  });

  it("builds deterministic canonical and legacy recovery profiles", () => {
    const canonical = createInstallPlan({
      packages: PACKAGES,
      artifacts: ARTIFACTS,
      profileName: "canonical",
    });
    expect(canonical.keys).toEqual(["core", "cli"]);
    expect(canonical.owners.cstl).toBe("cli");

    const legacy = createInstallPlan({
      packages: PACKAGES,
      artifacts: ARTIFACTS,
      profileName: "legacy",
    });
    expect(legacy.keys).toEqual(["core", "cli", "legacyCore", "legacyCli"]);
    expect(legacy.owners.cstl).toBe("legacyCli");
    expect(legacy.tarballs).toHaveLength(4);
    expect(() =>
      createInstallPlan({
        packages: PACKAGES.slice(1),
        artifacts: ARTIFACTS,
        profileName: "legacy",
      }),
    ).toThrow(/must contain exactly/);
  });

  it("requires the declared minimum Node engine on all four tarballs", () => {
    expect(assertSupportedNodeEngines(PACKAGES)).toBe(">=18.17.0");
    const drifted = structuredClone(PACKAGES);
    drifted[3].packedPackage.engines.node = ">=20";
    expect(() => assertSupportedNodeEngines(drifted)).toThrow(/legacyCli=>=20/);
  });

  it.each([
    ["ubuntu-latest", '"18.17.0"'],
    ["ubuntu-latest", '"lts/*"'],
    ["ubuntu-latest", '"current"'],
    ["windows-latest", '"18.17.0"'],
    ["windows-latest", '"lts/*"'],
    ["windows-latest", '"current"'],
  ])("wires %s with Node %s to executable CI", (osName, nodeName) => {
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf-8",
    );
    expect(workflow).toContain(osName);
    expect(workflow).toContain(nodeName);
    expect(workflow).toContain(
      "node packages/cli/scripts/release-conformance.js",
    );
  });

  it("fails closed for wrong branch, tag, version, receipt, and provenance", () => {
    expect(() =>
      assertReleaseBranch({ branch: "feat/p45", version: VERSION }),
    ).toThrow(/Allowed branches: develop/);
    expect(() => parseReleaseTag("v0.5.0-beta.5")).toThrow(
      /Expected pactile-v/,
    );
    expect(() =>
      assertMatchingVersions({
        coreVersion: VERSION,
        cliVersion: VERSION,
        legacyCoreVersion: VERSION,
        legacyCliVersion: "0.5.0-beta.4",
      }),
    ).toThrow(/Version mismatch/);
    expect(() => assertManifestSha256(`sha256:${"f".repeat(63)}`)).toThrow(
      /64 lowercase hex/,
    );
    expect(() =>
      assertPublishProvenance({
        tag: `pactile-v${VERSION}`,
        packageVersion: VERSION,
        head: "candidate",
        tagCommit: "candidate",
        remote: "private",
        isAncestor: () => false,
      }),
    ).toThrow(/not contained in private\/develop/);
  });
});
