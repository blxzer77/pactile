import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const RETRIEVAL_SOURCE_EXTENSIONS = new Set([".ts", ".md", ".json"]);

function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return walk(target);
    return [target];
  });
}

function retrievalProductFiles(root = cliRoot): string[] {
  const direct = [
    path.join(root, "src/pactile/retrieval"),
    path.join(root, "src/utils"),
    path.join(root, "src/templates/common"),
  ];
  return direct.flatMap(walk).filter((file) => {
    if (!RETRIEVAL_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      return false;
    }
    const normalized = file.replace(/\\/g, "/");
    if (normalized.includes("/src/pactile/retrieval/")) return true;
    const name = path.basename(file).toLowerCase();
    return (
      name.includes("retrieval") ||
      name === "semantic-plan-gate.ts" ||
      name === "semantic-plan-gate.ts"
    );
  });
}

function legacyViolations(root = cliRoot): string[] {
  return retrievalProductFiles(root).flatMap((file) => {
    const content = readFileSync(file, "utf8");
    return /BYOK|TRELLIS_CURSOR_BYOK|\.ccursor|routes\.json|cursor\+\+/giu.test(
      content,
    )
      ? [path.relative(root, file).replace(/\\/g, "/")]
      : [];
  });
}

describe("Pactile retrieval V3 live-symbol guard", () => {
  it("contains no legacy route environment or user-global configuration reads", () => {
    expect(legacyViolations()).toEqual([]);
  });

  it("scans Node retrieval source and documentation extensions", () => {
    const fixtureRoot = mkdtempSync(
      path.join(tmpdir(), "pactile-retrieval-guard-"),
    );
    try {
      const directories = [
        "src/pactile/retrieval",
        "src/utils",
        "src/templates/common",
      ];
      for (const directory of directories) {
        mkdirSync(path.join(fixtureRoot, directory), { recursive: true });
      }
      const realSources = [
        "src/pactile/retrieval/fixture.ts",
        "src/templates/common/fixture-retrieval.md",
        "src/templates/common/fixture-retrieval.json",
      ];
      for (const relative of realSources) {
        writeFileSync(path.join(fixtureRoot, relative), "neutral", "utf8");
      }

      expect(legacyViolations(fixtureRoot)).toEqual([]);
      expect(
        retrievalProductFiles(fixtureRoot)
          .map((file) => path.relative(fixtureRoot, file).replace(/\\/g, "/"))
          .sort(),
      ).toEqual([...realSources].sort());

      writeFileSync(
        path.join(fixtureRoot, realSources[0]),
        "const forbidden = 'BYOK';",
        "utf8",
      );
      expect(legacyViolations(fixtureRoot)).toEqual([realSources[0]]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps the Node ABI version fixed at V3", () => {
    const typescript = readFileSync(
      path.join(cliRoot, "src/pactile/retrieval/types.ts"),
      "utf8",
    );
    expect(typescript).toMatch(/RETRIEVAL_ABI_VERSION\s*=\s*3/);
  });
});
