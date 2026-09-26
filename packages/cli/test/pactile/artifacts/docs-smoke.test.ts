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

    expect(guide).toContain("## 轻量 Task");
    expect(guide).toContain("## 重型 Task");
    expect(guide).toContain("section:design:decision");
    expect(guide).toContain("section:prd:legacy-task-map:scope");
    expect(guide).toContain("pactile update --dry-run");
    expect(guide).toContain("pactile update`");

    const links = [...guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)];
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const [, destination] of links) {
      if (!destination) throw new Error("Markdown link has no destination");
      const relativePath = destination.split("#", 1)[0];
      expect(
        fs.existsSync(path.resolve(path.dirname(guidePath), relativePath)),
        destination,
      ).toBe(true);
    }
  });
});
