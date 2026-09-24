import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyOfficialRetire,
  composeP36Plan,
  planOfficialSurfaceA,
} from "../../src/utils/p36-upgrade.js";
import { fileURLToPath } from "node:url";

import { computeHash } from "../../src/utils/template-hash.js";
import { planArtifactMigration } from "../../src/core/task/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPGRADE_MD = path.join(
  HERE,
  "../../src/templates/markdown/framework/upgrade.md.txt",
);
const CONTINUE_MD = path.join(
  HERE,
  "../../src/templates/common/commands/continue.md",
);

const TRIAGE = `---
description: "old triage"
alwaysApply: true
---

# old triage
`;

describe("P36 official-surface A planner", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cstl-p36-a-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("retires unmodified known always-on and preserves user edits", () => {
    const triage = path.join(tmp, ".cursor", "rules", "cstl-triage.mdc");
    const routing = path.join(tmp, ".cursor", "rules", "retrieval-routing.mdc");
    fs.mkdirSync(path.dirname(triage), { recursive: true });
    fs.writeFileSync(triage, TRIAGE, "utf-8");
    fs.writeFileSync(routing, `${TRIAGE}\nuser change\n`, "utf-8");

    const hashes = {
      ".cursor/rules/cstl-triage.mdc": computeHash(TRIAGE),
      ".cursor/rules/retrieval-routing.mdc": computeHash(TRIAGE),
    };
    const official = planOfficialSurfaceA({
      cwd: tmp,
      hashes,
      refresh: [".cstl/workflow.md"],
      preserved: ["AGENTS.md"],
    });
    expect(official.retire.map((item) => item.path)).toEqual([
      ".cursor/rules/cstl-triage.mdc",
    ]);
    expect(official.preserve.map((item) => item.path)).toEqual([
      ".cursor/rules/retrieval-routing.mdc",
    ]);

    const artifacts = planArtifactMigration({ root: tmp });
    const plan = composeP36Plan({
      official,
      artifacts,
      writeArtifacts: false,
      waveC: {
        confirmed: false,
        scanned: 0,
        leftoverCloseout: 0,
        alreadyNewShape: 0,
        vernacular: [
          "确认后才会停读旧形状：不再把 leftover kind/mode/classification 当 Rigor/Parent 唯一真相。",
        ],
      },
    });
    const text = plan.vernacular.join("\n");
    expect(text).toMatch(/官方面/);
    expect(text).toMatch(/--force \/ --skip-all \/ --create-new/);
    expect(text).toMatch(/\.p36-wave-c\.json/);
    expect(text).toMatch(/确认后才会停读旧形状/);
    expect(text).not.toMatch(/Stage\s*[0-7]/);
    expect(text).not.toMatch(/MyHarness/);
    expect(text).not.toMatch(/手搬/);
    expect(text).not.toMatch(/write-artifacts/);
    expect(text).not.toMatch(/artifact_locale\.py/);

    const deleted = applyOfficialRetire(tmp, official);
    expect(deleted).toBe(1);
    expect(fs.existsSync(triage)).toBe(false);
    expect(fs.existsSync(routing)).toBe(true);
  });

  it("user upgrade page stays half-page and gates stop-read on confirm", () => {
    const text = fs.readFileSync(UPGRADE_MD, "utf-8");
    expect(text).toMatch(/确认后才会停读旧形状/);
    expect(text).toMatch(/--force/);
    expect(text).toMatch(/--skip-all/);
    expect(text).toMatch(/--create-new/);
    expect(text).toMatch(/不算这次确认/);
    expect(text).not.toMatch(/Stage\s*[0-7]/);
    expect(text).not.toMatch(/MyHarness/);
    expect(text).not.toMatch(/write-artifacts/);
    expect(text).not.toMatch(/artifact_locale\.py/);
    expect(text.split("\n").length).toBeLessThan(20);
  });

  it("continue.md routes by required_controls and topology, not file presence", () => {
    const text = fs.readFileSync(CONTINUE_MD, "utf-8");
    expect(text).toMatch(/required_controls\.rigor/);
    expect(text).toMatch(/topology\.kind/);
    expect(text).not.toMatch(/Route by `status` \+ artifact presence/);
    expect(text).toContain("parent_id` alone does **not**");
  });
});
