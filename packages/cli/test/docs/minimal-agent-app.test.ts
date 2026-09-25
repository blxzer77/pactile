import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "../..");
const repoRoot = path.resolve(cliRoot, "../..");
const exampleRoot = path.join(repoRoot, "examples/minimal-agent-app");

function readExampleFile(relativePath: string): string {
  return fs.readFileSync(path.join(exampleRoot, relativePath), "utf8");
}

describe("minimal agent app demo", () => {
  it("documents the supported Node 20 and Codex path in both locales", () => {
    for (const file of ["README.md", "README.zh-CN.md"]) {
      const readme = readExampleFile(file);
      expect(readme, file).toMatch(/Node(?:\.js)? 20/iu);
      expect(readme, file).not.toMatch(/Python\s*3\.9/iu);
      expect(readme, file).toContain(
        "pactile init --codex --yes --skip-readiness --user pactile-demo",
      );
      expect(readme, file).toContain("PACTILE_DEMO_WORKSPACE");
      expect(readme, file).not.toMatch(/pactile init --cursor/iu);
    }
  });

  it("keeps the shell and PowerShell launchers on the compiled current CLI", () => {
    const shell = readExampleFile("demo.sh");
    const powershell = readExampleFile("demo.ps1");

    expect(shell).toContain("packages/cli/dist/bin/pactile.js");
    expect(powershell).toContain("packages\\cli\\dist\\bin\\pactile.js");
    expect(powershell).not.toContain("packages\\cli\\bin\\pactile.js");
    for (const script of [shell, powershell]) {
      expect(script).toContain(
        "init --codex --yes --skip-readiness --user pactile-demo",
      );
      expect(script).toContain("init --help");
      expect(script).toContain("20 or newer");
      expect(script).toContain("PACTILE_DEMO_WORKSPACE");
      expect(script).not.toMatch(/init\s+--cursor/iu);
      expect(script).not.toContain("capability-smoke");
      expect(script).not.toContain("packages/cli/bin/pactile.js");
    }
  });

  it("documents the Bash migration utility as historical and outside the package", () => {
    const rootInstructions = fs.readFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "utf8",
    );
    const migration = fs.readFileSync(
      path.join(cliRoot, "scripts/migrate-features-to-tasks.sh"),
      "utf8",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"),
    ) as { files: string[]; scripts: Record<string, string> };

    expect(rootInstructions).toContain("Historical maintenance exception");
    expect(migration).toContain("HISTORICAL ONLY (P31)");
    expect(migration).toContain("not included in the npm package");
    expect(packageJson.files).not.toContain("scripts");
    expect(Object.values(packageJson.scripts).join("\n")).not.toContain(
      "migrate-features-to-tasks.sh",
    );
  });
});
