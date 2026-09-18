import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "../..");
const repoRoot = path.resolve(cliRoot, "../..");
const checkerPath = path.join(
  cliRoot,
  "scripts/check-pactile-brand-surface.js",
);
const contractDir = path.join(repoRoot, "docs/pactile");

interface CheckReport {
  ok: boolean;
  errors: string[];
  documentationSourceCount: number;
  filesByClassification: Record<string, string[]>;
}

interface CheckRun {
  status: number | null;
  stderr: string;
  report: CheckReport;
}

interface DocumentationMap {
  sourceMappings: { path: string; classification: string }[];
  p23CursorPlusPlus: {
    canonicalTargetPage: string;
    routes: { sourcePath: string; targetPage: string }[];
  };
  plannedGitHubSurfaces: { path: string; status: string }[];
}

interface BrandInventory {
  baselineSnapshot: BrandSnapshot;
  tokenRules: unknown[];
}

interface BrandSnapshot {
  sha256: string;
  occurrences: number;
  files: number;
  byClassification: Record<string, number>;
  byToken: Record<string, number>;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function runChecker(root: string, extraArgs: string[] = []): CheckRun {
  const result = spawnSync(
    process.execPath,
    [checkerPath, "--root", root, "--json", ...extraArgs],
    { encoding: "utf8" },
  );

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.stdout.trim() === "") {
    throw new Error(`Brand checker produced no JSON. stderr: ${result.stderr}`);
  }

  return {
    status: result.status,
    stderr: result.stderr,
    report: JSON.parse(result.stdout) as CheckReport,
  };
}

function captureSnapshot(root: string): BrandSnapshot {
  const result = spawnSync(
    process.execPath,
    [checkerPath, "--root", root, "--print-snapshot"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Brand snapshot failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as BrandSnapshot;
}

function runGit(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

function writeEmptyFile(root: string, relativePath: string): void {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, "", "utf8");
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function refreshSnapshot(root: string): void {
  const inventoryPath = path.join(root, "docs/pactile/brand-inventory.json");
  const inventory = readJson<BrandInventory>(inventoryPath);
  inventory.baselineSnapshot = captureSnapshot(root);
  writeJson(inventoryPath, inventory);
}

function mutateContract<T>(
  root: string,
  fileName: string,
  mutate: (contract: T) => void,
): void {
  const filePath = path.join(root, "docs/pactile", fileName);
  const contract = readJson<T>(filePath);
  mutate(contract);
  writeJson(filePath, contract);
}

function createMinimalContractRepository(): string {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pactile-brand-"),
  );
  temporaryRoots.push(temporaryRoot);

  const temporaryContractDir = path.join(temporaryRoot, "docs/pactile");
  fs.mkdirSync(temporaryContractDir, { recursive: true });
  for (const name of [
    "brand-inventory.json",
    "documentation-map.json",
    "rename-map.json",
  ]) {
    fs.copyFileSync(
      path.join(contractDir, name),
      path.join(temporaryContractDir, name),
    );
  }

  const documentationMap = readJson<DocumentationMap>(
    path.join(temporaryContractDir, "documentation-map.json"),
  );
  for (const mapping of documentationMap.sourceMappings) {
    writeEmptyFile(temporaryRoot, mapping.path);
  }

  for (const route of documentationMap.p23CursorPlusPlus.routes) {
    fs.writeFileSync(
      path.join(temporaryRoot, ...route.sourcePath.split("/")),
      "Cursor++\n",
      "utf8",
    );
  }

  const inventoryPath = path.join(temporaryContractDir, "brand-inventory.json");

  runGit(temporaryRoot, ["init", "--quiet"]);
  runGit(temporaryRoot, ["add", "-A"]);

  const inventory = readJson<BrandInventory>(inventoryPath);
  inventory.baselineSnapshot = captureSnapshot(temporaryRoot);
  writeJson(inventoryPath, inventory);
  return temporaryRoot;
}

describe("Pactile Batch 0 brand and documentation surface", () => {
  it("keeps the checked-in inventory and every public documentation source exact", () => {
    const result = runChecker(repoRoot);
    const documentationMap = readJson<DocumentationMap>(
      path.join(contractDir, "documentation-map.json"),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.errors).toEqual([]);
    expect(result.report.documentationSourceCount).toBe(
      documentationMap.sourceMappings.length,
    );
    expect(result.report.filesByClassification.history).toContain(
      "packages/cli/CHANGELOG.md",
    );
    expect(result.report.filesByClassification.attribution).toContain(
      "COPYRIGHT",
    );
    expect(result.report.filesByClassification.compat).toContain(
      "docs/pactile/brand-contract.md",
    );
  });

  it("routes every live Cursor++ tail to one canonical history page", () => {
    const documentationMap = readJson<DocumentationMap>(
      path.join(contractDir, "documentation-map.json"),
    );
    const routes = documentationMap.p23CursorPlusPlus.routes;

    expect(routes).toHaveLength(14);
    expect(new Set(routes.map((route) => route.sourcePath)).size).toBe(
      routes.length,
    );
    expect(new Set(routes.map((route) => route.targetPage))).toEqual(
      new Set([documentationMap.p23CursorPlusPlus.canonicalTargetPage]),
    );
    expect(documentationMap.plannedGitHubSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "CONTRIBUTING.md", status: "create" }),
        expect.objectContaining({ path: "SECURITY.md", status: "create" }),
        expect.objectContaining({
          path: ".github/PULL_REQUEST_TEMPLATE.md",
          status: "create",
        }),
        expect.objectContaining({
          path: ".github/ISSUE_TEMPLATE/config.yml",
          status: "create",
        }),
      ]),
    );
  });

  it("preserves scoped compatibility, history, and attribution with no live debt", () => {
    const result = runChecker(repoRoot, ["--release"]);

    expect(result.status, JSON.stringify(result.report.errors)).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.errors).toEqual([]);
    expect(result.report.filesByClassification.live ?? []).toEqual([]);
    expect(result.report.filesByClassification.compat).toContain(
      "docs/pactile/compatibility-inputs.md",
    );
    expect(result.report.filesByClassification.history).toContain(
      "packages/cli/CHANGELOG.md",
    );
    expect(result.report.filesByClassification.attribution).toContain(
      "COPYRIGHT",
    );
  });

  it("detects new legacy tokens and newly exposed documentation paths", () => {
    const temporaryRoot = createMinimalContractRepository();
    const initial = runChecker(temporaryRoot);

    expect(initial.status, JSON.stringify(initial.report.errors)).toBe(0);
    expect(initial.report.ok).toBe(true);

    fs.appendFileSync(
      path.join(temporaryRoot, "README.md"),
      "Install cursor-trellis here.\n",
      "utf8",
    );
    const changedLiveSurface = runChecker(temporaryRoot);
    expect(changedLiveSurface.status).toBe(1);
    expect(changedLiveSurface.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/brand inventory snapshot drift/),
      ]),
    );

    fs.writeFileSync(
      path.join(temporaryRoot, "README.md"),
      "Cursor++\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(temporaryRoot, "SURPRISE.md"),
      "Install cursor-trellis here.\n",
      "utf8",
    );
    runGit(temporaryRoot, ["add", "SURPRISE.md"]);
    const newSurface = runChecker(temporaryRoot);
    expect(newSurface.status).toBe(1);
    expect(newSurface.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unclassified legacy token/),
        expect.stringMatching(/documentation source map missing: SURPRISE\.md/),
      ]),
    );
  });

  it("scans tracked legacy path names even when file contents are binary", () => {
    const temporaryRoot = createMinimalContractRepository();
    const relativePath = "assets/cursor-trellis-logo.bin";
    const absolutePath = path.join(temporaryRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, Buffer.from([0, 255, 1, 2, 3]));
    runGit(temporaryRoot, ["add", relativePath]);

    const result = runChecker(temporaryRoot);

    expect(result.status).toBe(1);
    expect(result.report.filesByClassification.live).toContain(relativePath);
    expect(result.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/brand inventory snapshot drift/),
      ]),
    );
  });

  it("scans non-ignored untracked files during an uncommitted rebrand", () => {
    const temporaryRoot = createMinimalContractRepository();
    const relativePath = "packages/untracked-cstl-surface.txt";
    const absolutePath = path.join(temporaryRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, "legacy surface\n", "utf8");

    const result = runChecker(temporaryRoot);

    expect(result.status).toBe(1);
    expect(result.report.filesByClassification.live).toContain(relativePath);
    expect(result.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/brand inventory snapshot drift/),
      ]),
    );
  });

  it("requires a mapping for newly tracked Pactile contract documentation", () => {
    const temporaryRoot = createMinimalContractRepository();
    const relativePath = "docs/pactile/future-contract.md";
    writeEmptyFile(temporaryRoot, relativePath);
    runGit(temporaryRoot, ["add", relativePath]);

    const result = runChecker(temporaryRoot);

    expect(result.status).toBe(1);
    expect(result.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /documentation source map missing: docs\/pactile\/future-contract\.md/,
        ),
      ]),
    );
  });

  it("keeps documentation-map and inventory classifications aligned", () => {
    const temporaryRoot = createMinimalContractRepository();
    mutateContract<{
      pathClassifiers: {
        pathRegex: string;
        classification: string;
      }[];
    }>(temporaryRoot, "brand-inventory.json", (inventory) => {
      const controlDocuments = inventory.pathClassifiers.find(
        (classifier) =>
          classifier.pathRegex ===
          "^docs/pactile/(?:brand-contract|documentation-map)\\.md$",
      );
      expect(controlDocuments).toBeDefined();
      if (controlDocuments !== undefined) {
        controlDocuments.pathRegex = "^docs/pactile/.*\\.md$";
      }
    });
    const result = runChecker(temporaryRoot);

    expect(result.status).toBe(1);
    expect(result.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /documentation source classification mismatch for docs\/pactile\/contracts-v1\.md: map=live, inventory=compat/,
        ),
      ]),
    );
  });

  it("does not let broad history, attribution, or migration words exempt a live token", () => {
    const temporaryRoot = createMinimalContractRepository();
    const documentationMap = readJson<DocumentationMap>(
      path.join(temporaryRoot, "docs/pactile/documentation-map.json"),
    );
    for (const route of documentationMap.p23CursorPlusPlus.routes) {
      fs.writeFileSync(
        path.join(temporaryRoot, ...route.sourcePath.split("/")),
        "",
        "utf8",
      );
    }
    refreshSnapshot(temporaryRoot);
    const initialStrict = runChecker(temporaryRoot, ["--release"]);
    expect(
      initialStrict.status,
      JSON.stringify(initialStrict.report.errors),
    ).toBe(0);
    const livePath = ".github/workflows/ci.yml";
    fs.writeFileSync(
      path.join(temporaryRoot, ...livePath.split("/")),
      "# Historical copyright migration: install cursor-trellis now.\n",
      "utf8",
    );
    refreshSnapshot(temporaryRoot);

    const result = runChecker(temporaryRoot);

    expect(result.status, JSON.stringify(result.report.errors)).toBe(0);
    expect(result.report.filesByClassification.live).toContain(livePath);
    expect(result.report.filesByClassification.history ?? []).not.toContain(
      livePath,
    );
    expect(result.report.filesByClassification.attribution ?? []).not.toContain(
      livePath,
    );
    const strict = runChecker(temporaryRoot, ["--release"]);
    expect(strict.status).toBe(1);
    expect(strict.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /stable-release mode rejects .* live legacy-token occurrences/,
        ),
        expect.stringContaining(".github/workflows/ci.yml"),
      ]),
    );
  });

  it("fails closed when inventory token policy is emptied", () => {
    const temporaryRoot = createMinimalContractRepository();
    mutateContract<BrandInventory>(
      temporaryRoot,
      "brand-inventory.json",
      (inventory) => {
        inventory.tokenRules = [];
      },
    );

    const result = runChecker(temporaryRoot);

    expect(result.status).toBe(1);
    expect(result.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/canonical policy digest mismatch/),
        expect.stringMatching(/brand inventory token rules missing/),
      ]),
    );
  });

  it("locks rename sources and Native adoption safety fields", () => {
    const temporaryRoot = createMinimalContractRepository();
    mutateContract<{
      entities: { id: string; sources: string[] }[];
      nativeAdoptionModel: {
        resourceIdentity: string;
        absencePolicy?: {
          externalNative?: { pactileMayInstall?: boolean };
        };
        detachPolicy: { deleteBorrowed: boolean };
        states: { operation: string; observed: string }[];
      };
    }>(temporaryRoot, "rename-map.json", (renameMap) => {
      const product = renameMap.entities.find(
        (entry) => entry.id === "product-name",
      );
      if (product !== undefined) product.sources = [];
      renameMap.nativeAdoptionModel.resourceIdentity =
        "host + resource kind + stable logical id";
      if (renameMap.nativeAdoptionModel.absencePolicy?.externalNative) {
        renameMap.nativeAdoptionModel.absencePolicy.externalNative.pactileMayInstall = true;
      }
      renameMap.nativeAdoptionModel.detachPolicy.deleteBorrowed = true;
      const install = renameMap.nativeAdoptionModel.states.find(
        (state) => state.operation === "install",
      );
      if (install !== undefined) install.observed = "external-native-absent";
    });

    const result = runChecker(temporaryRoot);

    expect(result.status).toBe(1);
    expect(result.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/canonical contract digest mismatch/),
        expect.stringMatching(/product-name needs at least one source/),
        expect.stringMatching(/resourceIdentity must be/),
        expect.stringMatching(
          /absencePolicy\.externalNative\.pactileMayInstall must be false/,
        ),
        expect.stringMatching(/detachPolicy\.deleteBorrowed must be false/),
        expect.stringMatching(
          /native adoption install must use observed state/,
        ),
      ]),
    );
  });

  it("locks canonical sources, topics, pages, P23 history, language, navigation, status, and paths", () => {
    const temporaryRoot = createMinimalContractRepository();
    mutateContract<{
      discovery: {
        includePathRegexes: string[];
        excludePathRegexes: string[];
      };
      languagePolicy: { firstClassLocales: string[] };
      requiredTopics: string[];
      targetPages: {
        id: string;
        navigationGroup: string;
        status: string;
        paths: Record<string, string>;
      }[];
      sourceMappings: unknown[];
      p23CursorPlusPlus: {
        canonicalTargetPage: string;
        routes: unknown[];
      };
    }>(temporaryRoot, "documentation-map.json", (documentationMap) => {
      documentationMap.discovery.includePathRegexes = [];
      documentationMap.discovery.excludePathRegexes = [];
      documentationMap.languagePolicy.firstClassLocales = ["en"];
      documentationMap.requiredTopics = [];
      documentationMap.sourceMappings = [];
      documentationMap.targetPages = documentationMap.targetPages.filter(
        (page) => page.id !== "history.cursor-plus-plus",
      );
      const codex = documentationMap.targetPages.find(
        (page) => page.id === "hosts.codex",
      );
      if (codex !== undefined) {
        codex.navigationGroup = "misc";
        codex.status = "maybe";
        codex.paths.en = "README.md";
      }
      documentationMap.p23CursorPlusPlus.canonicalTargetPage = "hosts.cursor";
      documentationMap.p23CursorPlusPlus.routes = [];
    });

    const result = runChecker(temporaryRoot);

    expect(result.status).toBe(1);
    expect(result.report.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/canonical contract digest mismatch/),
        expect.stringMatching(/canonical documentation sources missing/),
        expect.stringMatching(/documentation required topics missing/),
        expect.stringMatching(/canonical target pages missing/),
        expect.stringMatching(/documentation first-class locales missing/),
        expect.stringMatching(/invalid navigation group misc/),
        expect.stringMatching(/invalid status maybe/),
        expect.stringMatching(
          /target path must be globally unique: README\.md/,
        ),
        expect.stringMatching(/P23 canonical target must be/),
        expect.stringMatching(
          /canonical P23 live documentation routes missing/,
        ),
        expect.stringMatching(/P23 canonical target page is absent/),
      ]),
    );
  });
});
