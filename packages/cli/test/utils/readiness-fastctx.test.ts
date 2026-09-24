import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { probeFastCtxCapability } from "../../src/utils/readiness.js";

/**
 * FastCtx readiness is decided by exactly one thing: whether the upstream
 * `fastctx apply` flow has materialized its stable binary.
 *
 * These cases pass an explicit `homeDir` so both branches are covered without
 * reading or writing the real user profile — the probe must never depend on
 * whether the machine running the suite happens to have adopted FastCtx.
 */

const temporaryHomes: string[] = [];

function makeTemporaryHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-fastctx-"));
  temporaryHomes.push(homeDir);
  return homeDir;
}

function installStableBinary(homeDir: string): string {
  const binaryPath = path.join(homeDir, ".fastctx", "bin", "fastctx.exe");
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, "");
  return binaryPath;
}

afterEach(() => {
  for (const homeDir of temporaryHomes.splice(0)) {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

describe("probeFastCtxCapability", () => {
  it("reports ready when the official stable binary is present", () => {
    const homeDir = makeTemporaryHome();
    const binaryPath = installStableBinary(homeDir);

    const probe = probeFastCtxCapability({ homeDir });

    expect(probe.id).toBe("fastctx");
    expect(probe.failures).toEqual([]);
    expect(probe.infos.join("\n")).toContain(binaryPath);
    // The path check is not a server start; that limit must stay declared.
    expect(probe.warnings.join("\n")).toContain("did not start the FastCtx server");
  });

  it("reports not-adopted with the official path when the binary is absent", () => {
    const homeDir = makeTemporaryHome();

    const probe = probeFastCtxCapability({ homeDir });

    expect(probe.id).toBe("fastctx");
    expect(probe.failures.join("\n")).toContain(
      path.join(homeDir, ".fastctx", "bin", "fastctx.exe"),
    );
    expect(probe.failures.join("\n")).toContain("has not been applied");
  });

  it("points at the upstream adopt flow and the declared host difference", () => {
    const homeDir = makeTemporaryHome();

    const warnings = probeFastCtxCapability({ homeDir }).warnings.join("\n");

    expect(warnings).toContain("fastctx apply");
    expect(warnings).toContain("~/.codex/AGENTS.md");
    expect(warnings).toContain("normal un-adopted state");
  });

  it("never resolves a version-manager or npm launcher path", () => {
    const homeDir = makeTemporaryHome();
    // A launcher that exists elsewhere must not be mistaken for adoption.
    fs.mkdirSync(path.join(homeDir, "nvm4w", "nodejs", "node_modules", "fastctx"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(homeDir, "nvm4w", "nodejs", "node_modules", "fastctx", "launcher.js"),
      "",
    );

    const probe = probeFastCtxCapability({ homeDir });

    expect(probe.failures).not.toEqual([]);
    expect(probe.infos).toEqual([]);
  });
});
