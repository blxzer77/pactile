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
});
