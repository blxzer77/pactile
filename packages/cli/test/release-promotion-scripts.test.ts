import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractReleaseNotes,
  writeReleaseNotes,
} from "../scripts/create-release-notes.js";
import { verifyPromotionReadback } from "../scripts/verify-promotion-readback.js";
import {
  resolveCliPackageRoot,
  resolveRepositoryRoot,
} from "../scripts/script-paths.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("release promotion scripts", () => {
  it("runs compiled TypeScript promotion tools and has no inline Node workflow blocks", () => {
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, ".github/workflows/publish.yml"),
      "utf8",
    );
    const packageManifest = JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, "packages/cli/package.json"),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };

    expect(workflow).toContain(
      "pnpm --filter @blxzer/pactile run build:script-artifacts",
    );
    expect(workflow).toContain(
      "node packages/cli/.tmp/p31-script-build/verify-promotion-readback.js",
    );
    expect(workflow).toContain(
      "node packages/cli/.tmp/p31-script-build/create-release-notes.js",
    );
    expect(workflow).not.toContain("node --input-type=module - <<'NODE'");
    expect(workflow).not.toContain("node - \"$notes_file\" <<'NODE'");
    const ciWorkflow = fs.readFileSync(
      path.join(repositoryRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(ciWorkflow).toContain(
      "node packages/cli/.tmp/p31-script-build/release-conformance.js",
    );
    const conformanceJobStart = ciWorkflow.indexOf("  release-conformance:");
    expect(conformanceJobStart).toBeGreaterThanOrEqual(0);
    const conformanceJob = ciWorkflow.slice(conformanceJobStart);
    expect(conformanceJob).toContain('node: ["20.0.0", "lts/*", "current"]');
    expect(conformanceJob).toContain("run: pnpm typecheck");
    expect(conformanceJob).toContain(
      "Test Node-only and package release contracts",
    );
    expect(conformanceJob).toContain("if: ${{ matrix.node != '20.0.0' }}");
    expect(conformanceJob).toContain("vitest run --maxWorkers=2");
    expect(conformanceJob).toContain("test/release-guard.test.ts");
    expect(conformanceJob).toContain("test/assert-no-python-on-path.test.ts");
    expect(packageManifest.scripts.clean).toBe(
      "pnpm run build:script-artifacts && node .tmp/p31-script-build/clean.js",
    );
    expect(packageManifest.scripts.build).toContain(
      "node .tmp/p31-script-build/copy-templates.js",
    );
  });

  it("resolves package roots from both source and compiled script locations", () => {
    const cliRoot = path.join(repositoryRoot, "packages/cli");
    const sourceModuleUrl = new URL(
      "../scripts/script-paths.ts",
      import.meta.url,
    ).href;
    const compiledModuleUrl = pathToFileURL(
      path.join(cliRoot, ".tmp/p31-script-build/script-paths.js"),
    ).href;

    expect(resolveCliPackageRoot(sourceModuleUrl)).toBe(cliRoot);
    expect(resolveCliPackageRoot(compiledModuleUrl)).toBe(cliRoot);
    expect(resolveRepositoryRoot(sourceModuleUrl)).toBe(repositoryRoot);
    expect(resolveRepositoryRoot(compiledModuleUrl)).toBe(repositoryRoot);
  });

  it("extracts only the selected changelog section and retains one final newline", () => {
    expect(
      extractReleaseNotes(
        "# Changelog\n\n## [1.2.3]\n\nRelease notes.\n\n## [1.2.2]\nOld notes.\n",
        "1.2.3",
      ),
    ).toBe("## [1.2.3]\n\nRelease notes.\n");
  });

  it("rejects a missing changelog section", () => {
    expect(() => extractReleaseNotes("# Changelog\n", "1.2.3")).toThrow(
      "CHANGELOG.md has no ## [1.2.3] section",
    );
  });

  it("writes release notes only for the package version selected for promotion", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-promotion-"));
    temporaryDirectories.push(root);
    const packagePath = path.join(root, "package.json");
    const changelogPath = path.join(root, "CHANGELOG.md");
    const outputPath = path.join(root, "release-notes.md");
    fs.writeFileSync(packagePath, JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(
      changelogPath,
      "## [1.2.3]\n\nRelease notes.\n\n## [1.2.2]\nOld notes.\n",
    );

    expect(() =>
      writeReleaseNotes({
        outputPath,
        packagePath,
        changelogPath,
        expectedVersion: "1.2.4",
      }),
    ).toThrow("VERSION 1.2.4 does not match package version 1.2.3.");
    expect(fs.existsSync(outputPath)).toBe(false);

    writeReleaseNotes({
      outputPath,
      packagePath,
      changelogPath,
      expectedVersion: "1.2.3",
    });
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "## [1.2.3]\n\nRelease notes.\n",
    );
  });

  it("accepts a latest readback only after candidate is absent", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ latest: "1.2.3", beta: "1.2.3-beta.1" })),
      );

    await expect(
      verifyPromotionReadback({ version: "1.2.3", fetchImpl }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.npmjs.org/-/package/%40blxzer%2Fpactile/dist-tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("fails closed on registry errors, version drift, and a remaining candidate tag", async () => {
    const httpError = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(
      verifyPromotionReadback({ version: "1.2.3", fetchImpl: httpError }),
    ).rejects.toThrow("Registry HTTP 503");

    const drift = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ latest: "1.2.2" })));
    await expect(
      verifyPromotionReadback({ version: "1.2.3", fetchImpl: drift }),
    ).rejects.toThrow("Registry readback did not confirm");

    const candidate = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ latest: "1.2.3", candidate: "1.2.3" })),
      );
    await expect(
      verifyPromotionReadback({ version: "1.2.3", fetchImpl: candidate }),
    ).rejects.toThrow("Registry readback did not confirm");
  });
});
