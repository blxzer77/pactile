import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapabilityCli } from "../../src/commands/capability.js";
import { defaultCapabilityLimitsV1 } from "../../src/pactile/capabilities/node.js";

const cliEntry = fileURLToPath(
  new URL("../../dist/bin/pactile.js", import.meta.url),
);
let root = "";
let output: string[] = [];

function sameReceiptEntry(left: string, right: string): boolean {
  const leftName = path.basename(left);
  const rightName = path.basename(right);
  if (process.platform === "win32" ? leftName.toLowerCase() !== rightName.toLowerCase() : leftName !== rightName) return false;
  try {
    const a = fs.statSync(path.dirname(left), { bigint: true });
    const b = fs.statSync(path.dirname(right), { bigint: true });
    return a.isDirectory() && b.isDirectory() && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p32-cli-"));
  fs.writeFileSync(path.join(root, "note.txt"), "bounded capability request\n");
  output = [];
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    output.push(values.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("pactile capability CLI", () => {
  it("executes a JSON request and returns the brand-neutral result and receipt", async () => {
    const requestFile = path.join(root, "request.json");
    fs.writeFileSync(
      requestFile,
      JSON.stringify({
        schemaVersion: 1,
        requestId: "cli-search-01",
        operation: "search",
        query: "bounded",
        directory: null,
        caseSensitive: true,
        limits: defaultCapabilityLimitsV1(),
      }),
    );

    const code = await runCapabilityCli([requestFile], root);
    expect(code).toBe(0);
    expect(
      Buffer.byteLength(`${output[0] ?? ""}\n`, "utf8"),
    ).toBeLessThanOrEqual(defaultCapabilityLimitsV1().maxOutputBytes);
    const result = JSON.parse(output[0] ?? "{}") as Record<string, unknown>;
    expect(result).toMatchObject({
      schemaVersion: 1,
      requestId: "cli-search-01",
      operation: "search",
      outcome: "complete",
      partial: false,
    });
    expect(result).toHaveProperty(
      "receipt.receiptRef",
      ".pactile/runtime/receipts/capabilities/cli-search-01.json",
    );
  });

  it("writes one JSON line when the project version is older than the CLI", () => {
    const pactileRoot = path.join(root, ".pactile");
    fs.mkdirSync(pactileRoot, { recursive: true });
    fs.writeFileSync(path.join(pactileRoot, ".version"), "0.0.1\n");
    fs.writeFileSync(
      path.join(root, "request.json"),
      JSON.stringify({
        schemaVersion: 1,
        requestId: "cli-version-skew",
        operation: "search",
        query: "bounded",
        directory: null,
        caseSensitive: true,
        limits: defaultCapabilityLimitsV1(),
      }),
    );

    const child = spawnSync(
      process.execPath,
      [cliEntry, "capability", "request.json"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout.trimEnd().split(/\r?\n/u)).toHaveLength(1);
    expect(JSON.parse(child.stdout)).toMatchObject({
      schemaVersion: 1,
      requestId: "cli-version-skew",
      operation: "search",
      outcome: "complete",
    });
  });

  it("returns a structured receipt-boundary failure without running the command", () => {
    fs.writeFileSync(path.join(root, ".pactile"), "not a directory");
    const marker = path.join(root, "must-not-exist.txt");
    fs.writeFileSync(
      path.join(root, "request.json"),
      JSON.stringify({
        schemaVersion: 1,
        requestId: "cli-receipt-boundary",
        operation: "run",
        command: "node",
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
        cwd: null,
        limits: defaultCapabilityLimitsV1(),
      }),
    );

    const child = spawnSync(
      process.execPath,
      [cliEntry, "capability", "request.json", "--allow-command", "node"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toBe("");
    expect(child.stdout.trimEnd().split(/\r?\n/u)).toHaveLength(1);
    expect(JSON.parse(child.stdout)).toMatchObject({
      outcome: "out_of_scope",
      partial: false,
      error: { code: "OUT_OF_SCOPE" },
      receipt: null,
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("returns one structured result when receipt persistence fails after execution", async () => {
    const requestId = "cli-receipt-write-failure";
    const marker = path.join(root, "command-ran.txt");
    const claimPath = path.join(
      root,
      ".pactile",
      "runtime",
      "receipts",
      "capabilities",
      `${requestId}.json`,
    );
    const requestFile = path.join(root, "request.json");
    fs.writeFileSync(
      requestFile,
      JSON.stringify({
        schemaVersion: 1,
        requestId,
        operation: "run",
        command: "node",
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
        cwd: null,
        limits: defaultCapabilityLimitsV1(),
      }),
    );
    const originalRealpath = fsp.realpath.bind(fsp);
    const realpathSpy = vi
      .spyOn(fsp, "realpath")
      .mockImplementation(async (...args) => {
        const target = typeof args[0] === "string" ? args[0] : "";
        if (sameReceiptEntry(target, claimPath) && fs.existsSync(marker)) {
          throw Object.assign(new Error("injected receipt failure"), {
            code: "EACCES",
          });
        }
        return originalRealpath(...args);
      });
    try {
      const code = await runCapabilityCli(
        [requestFile, "--allow-command", "node"],
        root,
      );
      expect(code).toBe(1);
      expect(fs.existsSync(marker)).toBe(true);
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
        outcome: "failed",
        partial: false,
        error: { code: "RECEIPT_UNAVAILABLE" },
        receipt: null,
      });
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("keeps commands denied by default and requires the explicit allowlist flag", async () => {
    const requestFile = path.join(root, "request.json");
    fs.writeFileSync(
      requestFile,
      JSON.stringify({
        schemaVersion: 1,
        requestId: "cli-run-denied",
        operation: "run",
        command: "node",
        args: ["--version"],
        cwd: null,
        limits: defaultCapabilityLimitsV1(),
      }),
    );

    const code = await runCapabilityCli([requestFile], root);
    expect(code).toBe(1);
    const result = JSON.parse(output[0] ?? "{}") as Record<string, unknown>;
    expect(result).toMatchObject({
      outcome: "out_of_scope",
      error: { code: "OUT_OF_SCOPE" },
    });
  });

  it("does not return the CLI request file as a search match", async () => {
    const emptyWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "pactile-p32-cli-empty-"),
    );
    const requestFile = path.join(emptyWorkspace, "request.json");
    const query = "P32_SELF_MATCH_LITERAL_8143";
    try {
      fs.writeFileSync(
        requestFile,
        JSON.stringify({
          schemaVersion: 1,
          requestId: "cli-empty-search",
          operation: "search",
          query,
          directory: null,
          caseSensitive: true,
          limits: defaultCapabilityLimitsV1(),
        }),
      );

      const code = await runCapabilityCli([requestFile], emptyWorkspace);
      expect(code).toBe(0);
      expect(
        Buffer.byteLength(`${output[0] ?? ""}\n`, "utf8"),
      ).toBeLessThanOrEqual(defaultCapabilityLimitsV1().maxOutputBytes);
      const result = JSON.parse(output[0] ?? "{}") as Record<string, unknown>;
      expect(result).toMatchObject({
        outcome: "empty",
        partial: false,
        nextPage: null,
        data: { matches: [] },
      });
    } finally {
      fs.rmSync(emptyWorkspace, { recursive: true, force: true });
    }
  });

  it("rejects request files outside the workspace and oversized JSON before parsing", async () => {
    const outsideFile = `${root}-outside.json`;
    fs.writeFileSync(outsideFile, JSON.stringify({ invalid: true }));
    try {
      expect(await runCapabilityCli([outsideFile], root)).toBe(2);
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }

    const oversized = path.join(root, "oversized.json");
    fs.writeFileSync(oversized, " ".repeat(256 * 1024 + 1));
    expect(await runCapabilityCli([oversized], root)).toBe(2);
  });
});
