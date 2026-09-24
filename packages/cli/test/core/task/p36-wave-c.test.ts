import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyTaskRecord } from "../../../src/core/task/index.js";
import {
  formatWaveCVernacular,
  isWaveCConfirmed,
  planWaveC,
  readWaveCState,
  WAVE_C_STATE_REL,
  writeWaveCConfirmed,
} from "../../../src/core/task/p36-wave-c.js";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("P36 wave C confirm-gated stop-read", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p36-c-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not treat leftover as stopped until confirm is written", () => {
    expect(isWaveCConfirmed(tmp)).toBe(false);
    expect(readWaveCState(tmp).confirmed).toBe(false);
    expect(fs.existsSync(path.join(tmp, WAVE_C_STATE_REL))).toBe(false);
  });

  it("writes confirm only through writeWaveCConfirmed", () => {
    const at = new Date("2026-08-29T00:00:00.000Z");
    writeWaveCConfirmed(tmp, at);
    expect(isWaveCConfirmed(tmp)).toBe(true);
    expect(readWaveCState(tmp).confirmedAt).toBe(at.toISOString());
  });

  it("vernacular names leftover stop-read and keeps Continue/Close on refuse", () => {
    const taskDir = path.join(tmp, ".pactile", "tasks", "legacy");
    writeJson(path.join(taskDir, "task.json"), {
      ...emptyTaskRecord({
        id: "legacy",
        name: "legacy",
        title: "Legacy",
        status: "in_progress",
      }),
      kind: "full",
      meta: { classification: "parent" },
    });
    const plan = planWaveC({ root: tmp });
    const text = plan.vernacular.join("\n");
    expect(plan.confirmed).toBe(false);
    expect(plan.leftoverCloseout).toBeGreaterThan(0);
    expect(text).toMatch(/确认后才会停读旧形状/);
    expect(text).toMatch(/Continue \/ Close/);
    expect(text).not.toMatch(/Stage\s*[0-7]/);
    expect(text).not.toMatch(/MyHarness/);
    expect(text).not.toMatch(/write-artifacts/);
  });

  it("confirmed vernacular does not re-offer leftover as authority", () => {
    writeWaveCConfirmed(tmp);
    const text = formatWaveCVernacular({
      confirmed: true,
      scanned: 2,
      leftoverCloseout: 0,
      alreadyNewShape: 2,
    }).join("\n");
    expect(text).toMatch(/已确认停读旧形状/);
    expect(text).toMatch(/required_controls/);
  });
});
