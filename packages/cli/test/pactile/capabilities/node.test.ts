import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOUNDED_CAPABILITY_SCHEMA_VERSION_V1,
  BoundedCapabilityRequestValidationError,
  parseBoundedCapabilityRequestV1,
} from "../../../src/core/index.js";
import { executeNodeCapabilityRequestV1 } from "../../../src/index.js";
import {
  createCapabilityRequestIdV1,
  createDefaultCapabilityPolicyV1,
  defaultCapabilityLimitsV1,
} from "../../../src/pactile/capabilities/node.js";

let root = "";

function request(
  operation: string,
  fields: Record<string, unknown> = {},
  limits: Partial<ReturnType<typeof defaultCapabilityLimitsV1>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: BOUNDED_CAPABILITY_SCHEMA_VERSION_V1,
    requestId: createCapabilityRequestIdV1(),
    operation,
    limits: { ...defaultCapabilityLimitsV1(), ...limits },
    ...fields,
  };
}

async function execute(
  input: unknown,
  allowedCommands: readonly string[] = [],
) {
  return executeNodeCapabilityRequestV1(input, {
    root,
    policy: createDefaultCapabilityPolicyV1(allowedCommands),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-p32-capability-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "Pactile project\n");
  fs.writeFileSync(
    path.join(root, "src", "alpha.ts"),
    "export const answer = 42;\nanswer += 1;\n",
  );
  fs.writeFileSync(path.join(root, "src", "empty.txt"), "");
  fs.writeFileSync(
    path.join(root, "node_modules", "ignored", "secret.js"),
    "excluded content",
  );
  fs.writeFileSync(
    path.join(root, ".git", "objects", "blob"),
    "excluded content",
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded capability request contracts", () => {
  it("rejects workspace traversal, malformed commands, and unknown fields", async () => {
    const outside = parseBoundedCapabilityRequestV1(
      request("read", { path: "../secrets.env" }),
    );
    expect(outside.success).toBe(false);

    const shell = parseBoundedCapabilityRequestV1(
      request("run", {
        command: "git status && node",
        args: [],
      }),
    );
    expect(shell.success).toBe(false);

    const extra = parseBoundedCapabilityRequestV1(
      request("search", {
        query: "answer",
        caseSensitive: true,
        unexpected: "field",
      }),
    );
    expect(extra.success).toBe(false);

    expect(
      parseBoundedCapabilityRequestV1({
        ...request("read", { path: "README.md" }),
        requestId: "request:alternate-stream",
      }).success,
    ).toBe(false);
    expect(
      parseBoundedCapabilityRequestV1({
        ...request("read", { path: "README.md" }),
        requestId: "CON",
      }).success,
    ).toBe(false);
    expect(
      parseBoundedCapabilityRequestV1(
        request("read", { path: "public.txt:private" }),
      ).success,
    ).toBe(false);
    expect(
      parseBoundedCapabilityRequestV1(request("read", { path: "NUL.txt" }))
        .success,
    ).toBe(false);
    await expect(
      executeNodeCapabilityRequestV1(
        {
          ...request("read", { path: "README.md" }),
          path: "../outside",
        },
        { root, policy: createDefaultCapabilityPolicyV1() },
      ),
    ).rejects.toBeInstanceOf(BoundedCapabilityRequestValidationError);
  });

  it("keeps command authority in caller policy and records an out-of-scope receipt", async () => {
    const result = await execute(
      request("run", { command: "node", args: ["--version"] }),
    );
    expect(result.outcome).toBe("out_of_scope");
    expect(result.error?.code).toBe("OUT_OF_SCOPE");
    expect(result.receipt?.errorCode).toBe("OUT_OF_SCOPE");
  });
});

describe("Node workspace capability adapter", () => {
  it("discovers, reads, and literal-searches project files without host-tool output", async () => {
    const discovered = await execute(request("discover"));
    expect(discovered.outcome).toBe("complete");
    expect(
      discovered.data && "files" in discovered.data
        ? discovered.data.files
        : [],
    ).toEqual(
      expect.arrayContaining(["README.md", "src/alpha.ts", "src/empty.txt"]),
    );
    expect(JSON.stringify(discovered)).not.toContain("node_modules");
    expect(JSON.stringify(discovered)).not.toContain(root);

    const read = await execute(request("read", { path: "src/alpha.ts" }));
    expect(read.outcome).toBe("complete");
    expect(
      read.data && "content" in read.data ? read.data.content : "",
    ).toContain("answer = 42");
    expect(read.receipt?.adapterId).toBe("node");

    const found = await execute(
      request("search", {
        query: "answer",
        directory: "src",
        caseSensitive: true,
      }),
    );
    expect(found.outcome).toBe("complete");
    expect(
      found.data && "matches" in found.data ? found.data.matches : [],
    ).toMatchObject([
      { path: "src/alpha.ts", line: 1 },
      { path: "src/alpha.ts", line: 2 },
    ]);
  });

  it("distinguishes no matches from bounded partial results", async () => {
    const empty = await execute(
      request("search", {
        query: "no-such-literal",
        caseSensitive: true,
      }),
    );
    expect(empty.outcome).toBe("empty");
    expect(
      empty.data && "matches" in empty.data ? empty.data.matches : [],
    ).toEqual([]);

    const limited = await execute(
      request("discover", {}, { maxFilesScanned: 1 }),
    );
    expect(limited.outcome).toBe("partial");
    expect(limited.partial).toBe(true);
    expect(limited.error?.code).toBe("SCAN_LIMIT");
    expect(
      limited.data && "files" in limited.data ? limited.data.files : [],
    ).toBeDefined();
  });

  it("does not offer a search page when the scan budget stopped collection", async () => {
    const result = await execute(
      request(
        "search",
        { query: "answer", directory: "src", caseSensitive: true },
        { maxFilesScanned: 1, maxResults: 1 },
      ),
    );
    expect(result.outcome).toBe("partial");
    expect(result.error?.code).toBe("SCAN_LIMIT");
    expect(result.nextPage).toBeNull();
    expect(
      result.data && "matches" in result.data ? result.data.matches : [],
    ).toHaveLength(1);
  });

  it("continues discover and search pages with explicit nextPage offsets", async () => {
    const firstDiscover = await execute(
      request("discover", {}, { maxResults: 2 }),
    );
    expect(firstDiscover.nextPage).toBe(2);
    expect(firstDiscover.outcome).toBe("partial");
    const firstFiles =
      firstDiscover.data && "files" in firstDiscover.data
        ? [...firstDiscover.data.files]
        : [];
    const secondDiscover = await execute(
      request(
        "discover",
        { offset: firstDiscover.nextPage },
        { maxResults: 2 },
      ),
    );
    expect(secondDiscover.nextPage).toBeNull();
    const secondFiles =
      secondDiscover.data && "files" in secondDiscover.data
        ? [...secondDiscover.data.files]
        : [];
    expect([...firstFiles, ...secondFiles]).toEqual([
      "README.md",
      "src/alpha.ts",
      "src/empty.txt",
    ]);

    const firstSearch = await execute(
      request(
        "search",
        { query: "answer", directory: "src", caseSensitive: true },
        { maxResults: 1 },
      ),
    );
    expect(firstSearch.nextPage).toBe(1);
    const secondSearch = await execute(
      request(
        "search",
        {
          query: "answer",
          directory: "src",
          caseSensitive: true,
          offset: firstSearch.nextPage,
        },
        { maxResults: 1 },
      ),
    );
    expect(secondSearch.nextPage).toBeNull();
    expect(
      [firstSearch, secondSearch].flatMap((result) =>
        result.data && "matches" in result.data ? result.data.matches : [],
      ),
    ).toMatchObject([
      { path: "src/alpha.ts", line: 1 },
      { path: "src/alpha.ts", line: 2 },
    ]);
  });

  it("omits transient receipt locks and receipt data from discovery and search", async () => {
    const receiptDirectory = path.join(
      root,
      ".pactile",
      "runtime",
      "receipts",
      "capabilities",
    );
    fs.mkdirSync(receiptDirectory, { recursive: true });
    fs.writeFileSync(path.join(receiptDirectory, "inflight.lock"), "secret");
    const discovered = await execute(request("discover"));
    expect(discovered.outcome).toBe("complete");
    expect(JSON.stringify(discovered)).not.toContain("inflight.lock");
    const searched = await execute(
      request("search", { query: "secret", caseSensitive: true }),
    );
    expect(searched.outcome).toBe("empty");
  });

  it("returns truncated file content and records a durable result fingerprint", async () => {
    fs.writeFileSync(path.join(root, "large.txt"), "x".repeat(1024));
    const result = await execute(
      request(
        "read",
        { path: "large.txt" },
        {
          maxFileBytes: 500,
          maxBytesRead: 500,
          maxOutputBytes: 2_048,
        },
      ),
    );
    expect(result.outcome).toBe("partial");
    expect(result.error?.code).toBe("FILE_TOO_LARGE");
    expect(
      result.data && "content" in result.data ? result.data.truncated : false,
    ).toBe(true);
    expect(result.receipt?.resultFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const receiptFile = path.join(
      root,
      ...(result.receipt?.receiptRef ?? "").split("/"),
    );
    const stored = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      outcome: "partial",
      errorCode: "FILE_TOO_LARGE",
      adapterId: "node",
    });
    expect(JSON.stringify(stored)).not.toContain("x".repeat(64));
  });

  it("keeps escaped file content inside the response byte budget", async () => {
    fs.writeFileSync(path.join(root, "escaped.txt"), "\0".repeat(1024));
    const result = await execute(
      request(
        "read",
        { path: "escaped.txt" },
        {
          maxFileBytes: 1024,
          maxBytesRead: 1024,
          maxOutputBytes: 2_048,
        },
      ),
    );
    expect(result.outcome).toBe("partial");
    expect(result.error?.code).toBe("OUTPUT_LIMIT");
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(2_048);
  });

  it("caps the complete response envelope and receipt within maxOutputBytes", async () => {
    for (let index = 0; index < 80; index += 1) {
      fs.writeFileSync(
        path.join(root, `budget-file-${String(index).padStart(3, "0")}.txt`),
        "x",
      );
    }
    const result = await execute(
      request("discover", {}, { maxOutputBytes: 2_048, maxResults: 1_000 }),
    );
    expect(result.outcome).toBe("partial");
    expect(result.error?.code).toBe("OUTPUT_LIMIT");
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(2_048);
  });

  it("caps command output, distinguishes timeout and cancellation, and never invokes a denied command", async () => {
    const deniedMarker = path.join(root, "denied-command.txt");
    const denied = await execute(
      request("run", {
        command: "node",
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(deniedMarker)}, 'ran')`,
        ],
      }),
    );
    expect(denied.outcome).toBe("out_of_scope");
    expect(fs.existsSync(deniedMarker)).toBe(false);

    const output = await execute(
      request(
        "run",
        {
          command: "node",
          args: ["-e", "process.stdout.write('x'.repeat(20000))"],
        },
        { maxOutputBytes: 2_048 },
      ),
      ["node"],
    );
    expect(output.outcome).toBe("partial");
    expect(output.error?.code).toBe("OUTPUT_LIMIT");
    expect(
      output.data && "truncated" in output.data ? output.data.truncated : false,
    ).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(output), "utf8"),
    ).toBeLessThanOrEqual(2_048);

    const timedOut = await execute(
      request(
        "run",
        {
          command: "node",
          args: ["-e", "setTimeout(() => {}, 5000)"],
        },
        { timeoutMs: 100 },
      ),
      ["node"],
    );
    expect(timedOut.outcome).toBe("timed_out");
    expect(timedOut.error?.code).toBe("TIMEOUT");

    const controller = new AbortController();
    const cancelledRequest = request(
      "run",
      {
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
      },
      { timeoutMs: 5000 },
    );
    const running = executeNodeCapabilityRequestV1(cancelledRequest, {
      root,
      policy: createDefaultCapabilityPolicyV1(["node"]),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("CANCELLED"), 100);
    const cancelled = await running;
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.error?.code).toBe("CANCELLED");
  });

  it("kills command descendants before returning a timeout", async () => {
    const marker = path.join(root, "late-descendant-marker.txt");
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 700)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setTimeout(() => {}, 5000)`;
    const result = await execute(
      request(
        "run",
        { command: "node", args: ["-e", parent] },
        { timeoutMs: 100 },
      ),
      ["node"],
    );
    expect(result.outcome).toBe("timed_out");
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not resolve an allowlisted executable from the workspace PATH", async () => {
    const fakeName = process.platform === "win32" ? "git.exe" : "git";
    const fakeExecutable = path.join(root, fakeName);
    const marker = path.join(root, "fake-git-ran.txt");
    fs.copyFileSync(process.execPath, fakeExecutable);
    const originalPath = process.env.PATH;
    process.env.PATH = [root, originalPath]
      .filter(Boolean)
      .join(path.delimiter);
    try {
      const result = await execute(
        request("run", {
          command: "git",
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'FAKE_GIT_SENTINEL')`,
          ],
        }),
        ["git"],
      );
      expect(result.outcome).not.toBe("complete");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("rechecks command cwd after executable resolution before launching", async () => {
    const working = path.join(root, "work");
    const displaced = `${working}-displaced`;
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "pactile-p32-cwd-outside-"),
    );
    const marker = path.join(outside, "must-not-run.txt");
    fs.mkdirSync(working);
    const originalRealpath = fsp.realpath.bind(fsp);
    let swapped = false;
    const realpathSpy = vi
      .spyOn(fsp, "realpath")
      .mockImplementation(async (...args) => {
        const target = typeof args[0] === "string" ? args[0] : "";
        if (
          !swapped &&
          path.resolve(target) === path.resolve(process.execPath)
        ) {
          swapped = true;
          fs.renameSync(working, displaced);
          fs.symlinkSync(
            outside,
            working,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return originalRealpath(...args);
      });
    try {
      const result = await execute(
        request("run", {
          command: "node",
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
          cwd: "work",
        }),
        ["node"],
      );
      expect(swapped).toBe(true);
      expect(result.outcome).toBe("out_of_scope");
      expect(result.error?.code).toBe("OUT_OF_SCOPE");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      realpathSpy.mockRestore();
      if (fs.lstatSync(working).isSymbolicLink()) fs.unlinkSync(working);
      if (fs.existsSync(displaced)) fs.renameSync(displaced, working);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("enforces the request deadline during receipt claim inspection", async () => {
    const receiptDirectory = path.join(
      root,
      ".pactile",
      "runtime",
      "receipts",
      "capabilities",
    );
    fs.mkdirSync(receiptDirectory, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(receiptDirectory, `slow-${index}.json`), "{}");
    }
    const originalLstat = fsp.lstat.bind(fsp);
    const lstatSpy = vi
      .spyOn(fsp, "lstat")
      .mockImplementation(async (...args) => {
        const target = typeof args[0] === "string" ? args[0] : "";
        if (
          path.dirname(target) === receiptDirectory &&
          /^slow-\d+\.json$/u.test(path.basename(target))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return originalLstat(...args);
      });
    try {
      const result = await execute(
        request("read", { path: "README.md" }, { timeoutMs: 50 }),
      );
      expect(result.outcome).toBe("timed_out");
      expect(result.error?.code).toBe("TIMEOUT");
      expect(result.receipt).toBeNull();
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("rejects a read target swapped to an external symlink before open", async (context) => {
    const target = path.join(root, "swap.txt");
    const outside = `${root}-outside.txt`;
    fs.writeFileSync(target, "public");
    fs.writeFileSync(outside, "PRIVATE_EXTERNAL_CONTENT");
    const originalOpen = fsp.open.bind(fsp);
    let swapped = false;
    const openSpy = vi
      .spyOn(fsp, "open")
      .mockImplementation(async (...args) => {
        const file = typeof args[0] === "string" ? args[0] : "";
        if (!swapped && path.resolve(file) === target) {
          swapped = true;
          fs.unlinkSync(target);
          try {
            fs.symlinkSync(outside, target, "file");
          } catch {
            context.skip();
          }
        }
        return originalOpen(...args);
      });
    try {
      const result = await execute(request("read", { path: "swap.txt" }));
      expect(result.outcome).not.toBe("complete");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_EXTERNAL_CONTENT");
      expect(swapped).toBe(true);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(outside, { force: true });
    }
  });

  it("preserves OUT_OF_SCOPE when search opens a target swapped to an external symlink", async (context) => {
    const target = path.join(root, "swap-search.txt");
    const outside = `${root}-outside-search.txt`;
    fs.writeFileSync(target, "public text");
    fs.writeFileSync(outside, "PRIVATE_EXTERNAL_CONTENT");
    const originalOpen = fsp.open.bind(fsp);
    let swapped = false;
    const openSpy = vi
      .spyOn(fsp, "open")
      .mockImplementation(async (...args) => {
        const file = typeof args[0] === "string" ? args[0] : "";
        if (!swapped && path.resolve(file) === target) {
          swapped = true;
          fs.unlinkSync(target);
          try {
            fs.symlinkSync(outside, target, "file");
          } catch {
            context.skip();
          }
        }
        return originalOpen(...args);
      });
    try {
      const result = await execute(
        request("search", {
          query: "PRIVATE_EXTERNAL_CONTENT",
          caseSensitive: true,
        }),
      );
      expect(result.outcome).toBe("out_of_scope");
      expect(result.error?.code).toBe("OUT_OF_SCOPE");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_EXTERNAL_CONTENT");
      expect(swapped).toBe(true);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(outside, { force: true });
    }
  });

  it("does not execute a duplicate request id twice", async () => {
    const input = request("read", { path: "README.md" });
    expect((await execute(input)).outcome).toBe("complete");
    const duplicate = await execute(input);
    expect(duplicate.outcome).toBe("failed");
    expect(duplicate.error?.code).toBe("REQUEST_ID_REUSED");
    expect(duplicate.receipt).toBeNull();
  });

  it("atomically claims a request id before concurrent commands can run", async () => {
    const marker = path.join(root, "invocations.txt");
    const input = request("run", {
      command: "node",
      args: [
        "-e",
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`,
      ],
    });
    const [left, right] = await Promise.all([
      execute(input, ["node"]),
      execute(input, ["node"]),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual([
      "complete",
      "failed",
    ]);
    expect(
      [left, right].find(
        (result) => result.error?.code === "REQUEST_ID_REUSED",
      ),
    ).toBeDefined();
    expect(fs.readFileSync(marker, "utf8")).toBe("x");
  });

  it("checks that the receipt boundary is writable before running a command", async () => {
    fs.writeFileSync(path.join(root, ".pactile"), "not a directory");
    const marker = path.join(root, "must-not-exist.txt");
    const result = await execute(
      request("run", {
        command: "node",
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
      }),
      ["node"],
    );
    expect(result).toMatchObject({
      outcome: "out_of_scope",
      partial: false,
      error: { code: "OUT_OF_SCOPE" },
      receipt: null,
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not write a receipt through a directory junction swapped at open", async () => {
    const receiptDirectory = path.join(
      root,
      ".pactile",
      "runtime",
      "receipts",
      "capabilities",
    );
    const displacedDirectory = `${receiptDirectory}-displaced`;
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "pactile-p32-receipt-outside-"),
    );
    const requestId = "receipt-junction-race";
    const marker = path.join(root, "command-must-not-run.txt");
    fs.mkdirSync(receiptDirectory, { recursive: true });
    const originalOpen = fsp.open.bind(fsp);
    let swapped = false;
    const openSpy = vi
      .spyOn(fsp, "open")
      .mockImplementation(async (...args) => {
        const file = typeof args[0] === "string" ? args[0] : "";
        if (!swapped && path.basename(file) === `${requestId}.json`) {
          swapped = true;
          fs.renameSync(receiptDirectory, displacedDirectory);
          fs.symlinkSync(
            outside,
            receiptDirectory,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return originalOpen(...args);
      });
    try {
      const result = await executeNodeCapabilityRequestV1(
        request("run", {
          requestId,
          command: "node",
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
        }),
        { root, policy: createDefaultCapabilityPolicyV1(["node"]) },
      );
      expect(result.outcome).toBe("failed");
      expect(result.error?.code).toBe("REQUEST_CLAIM_RETAINED");
      expect(result.receipt).toBeNull();
      expect(swapped).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([`${requestId}.json`]);
      expect(fs.statSync(path.join(outside, `${requestId}.json`)).size).toBe(0);
    } finally {
      openSpy.mockRestore();
      if (fs.lstatSync(receiptDirectory).isSymbolicLink()) {
        fs.unlinkSync(receiptDirectory);
      }
      if (fs.existsSync(displacedDirectory)) {
        fs.renameSync(displacedDirectory, receiptDirectory);
      }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("retains incomplete claims, returns an actionable status, and caps their count", async () => {
    const receiptDirectory = path.join(
      root,
      ".pactile",
      "runtime",
      "receipts",
      "capabilities",
    );
    const requestId = "claim-retained-after-metadata-error";
    const claimPath = path.join(receiptDirectory, `${requestId}.json`);
    const marker = path.join(root, "claim-failure-command-ran.txt");
    fs.mkdirSync(receiptDirectory, { recursive: true });
    const originalLstat = fsp.lstat.bind(fsp);
    let claimStats = 0;
    const lstatSpy = vi
      .spyOn(fsp, "lstat")
      .mockImplementation(async (...args) => {
        const file = typeof args[0] === "string" ? args[0] : "";
        if (path.resolve(file) === claimPath && ++claimStats === 2) {
          throw Object.assign(new Error("simulated metadata access failure"), {
            code: "EACCES",
          });
        }
        return originalLstat(...args);
      });
    try {
      const retained = await executeNodeCapabilityRequestV1(
        request("run", {
          requestId,
          command: "node",
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
        }),
        { root, policy: createDefaultCapabilityPolicyV1(["node"]) },
      );
      expect(retained.outcome).toBe("failed");
      expect(retained.error?.code).toBe("REQUEST_CLAIM_RETAINED");
      expect(retained.error?.message).toMatch(/did not run/i);
      expect(retained.receipt).toBeNull();
      expect(fs.statSync(claimPath).size).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);

      for (let index = 0; index < 31; index += 1) {
        fs.writeFileSync(
          path.join(receiptDirectory, `pending-${index}.json`),
          "",
        );
      }
      const capped = await execute(
        request("run", {
          command: "node",
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
        }),
        ["node"],
      );
      expect(capped.outcome).toBe("failed");
      expect(capped.error?.code).toBe("REQUEST_CLAIM_LIMIT");
      expect(capped.receipt).toBeNull();
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      lstatSpy.mockRestore();
    }
  });
});
