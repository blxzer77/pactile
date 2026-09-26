import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, "../../../../..");

describe("structured task artifacts help and guide", () => {
  it("documents the same logical-fact and section-read entry points shown by task help", () => {
    const helpSource = fs.readFileSync(
      path.join(repositoryRoot, "packages/cli/src/cli/index.ts"),
      "utf8",
    );
    const guide = fs.readFileSync(
      path.join(
        repositoryRoot,
        "docs/capabilities/structured-task-artifacts.zh-CN.md",
      ),
      "utf8",
    );

    expect(helpSource).toContain(
      "--fact <id|artifact://tasks/<task>/kernel#/selector>",
    );
    expect(helpSource).toContain("--section <section-id>@<fingerprint>");
    expect(guide).toContain("`artifact://tasks/<safe-task-id>/kernel`");
    expect(guide).toContain("`--section <section-id>@<contentFingerprint>`");
    expect(guide).toContain("migration generation/overlay");
    expect(guide).toContain("`task-map.md` 和 `handoff.md`");
  });

  it("covers light and heavy Task reads with resolvable lifecycle and P36 links", () => {
    const guidePath = path.join(
      repositoryRoot,
      "docs/capabilities/structured-task-artifacts.zh-CN.md",
    );
    const guide = fs.readFileSync(guidePath, "utf8");
    const migrationGuidePath = path.join(
      repositoryRoot,
      "docs/lifecycle/upgrade-and-migrate.zh-CN.md",
    );
    const migrationGuide = fs.readFileSync(migrationGuidePath, "utf8");

    expect(guide).toContain("## 轻量 Task");
    expect(guide).toContain("## 重型 Task");
    expect(guide).toContain("section:design:decision");
    expect(guide).toContain("section:prd:legacy-task-map:scope");
    expect(guide).toContain("--actor implementer");
    expect(guide).toContain("`--write-set <path>`");
    expect(guide).toContain("`--candidate <path>=<sha256>`");
    expect(guide).toContain("Run 写入范围内的普通文件");
    expect(guide).toContain("P41 Core 会重新检查项目状态");
    expect(guide).toContain(
      "packages/cli/src/pactile/artifacts/reader.ts=<actual-reader-file-sha256>",
    );
    expect(guide).toContain(
      "--delivery-ref packages/cli/src/pactile/artifacts/reader.ts",
    );
    expect(guide).toContain(
      "--reviewer independent-reviewer --actor independent-reviewer",
    );
    expect(guide).toContain(
      "upgrade-and-migrate.zh-CN.md#p36-held-task-reconciliation",
    );
    expect(migrationGuide).toContain("pactile update --dry-run --json");
    expect(migrationGuide).toContain("pactile update --skip-all --json");
    expect(migrationGuide).toContain(
      '<a id="p36-held-task-reconciliation"></a>',
    );
    expect(migrationGuide).toContain("pactile legacy-task reconcile");

    const links = [...guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)];
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const [, destination] of links) {
      if (!destination) throw new Error("Markdown link has no destination");
      const relativePath = destination.split("#", 1)[0];
      const fragment = destination.split("#", 2)[1];
      const target = path.resolve(path.dirname(guidePath), relativePath);
      expect(fs.existsSync(target), destination).toBe(true);
      if (fragment) {
        expect(fs.readFileSync(target, "utf8"), destination).toContain(
          `<a id="${fragment}"></a>`,
        );
      }
    }
  });
});
