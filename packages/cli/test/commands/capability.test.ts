import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapabilityCli } from "../../src/commands/capability.js";
import { defaultCapabilityLimitsV1 } from "../../src/pactile/capabilities/node.js";

let root = "";
let output: string[] = [];

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
