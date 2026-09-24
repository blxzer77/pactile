import { describe, expect, it, vi } from "vitest";
import {
  parseExternalAssetRefV1,
  type ExternalAssetSourceV1,
} from "../../../src/core/index.js";
import {
  buildInventory,
  discoverSnapshot,
} from "../../../src/pactile/adoption/inventory.js";

const context = {
  hostId: "editor-one",
  rootId: "project-tools",
  source: "host-native",
  scope: "project",
  owner: { kind: "host", id: "editor-one" },
};
const asset = { id: "repo-search", kind: "mcp", locatorToken: "search-server" };

describe("explicit snapshot discovery", () => {
  it("returns only canonical M0 assets, without copying secrets or Skill bodies", () => {
    const result = discoverSnapshot({
      context,
      assets: [
        {
          ...asset,
          env: { KEY: "CANARY_PRIVATE_BODY" },
          body: "CANARY_PRIVATE_BODY",
        },
      ],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.assets).toHaveLength(1);
    expect(parseExternalAssetRefV1(result.assets[0]).success).toBe(true);
    expect(result.assets[0]).toMatchObject({
      id: "repo-search",
      kind: "mcp",
      source: "host-native",
      scope: "project",
      readiness: "unknown",
    });
    expect(result.assets[0].locator).toMatch(/^host-native:\/\/inventory\//);
    expect(JSON.stringify(result)).not.toContain("CANARY_PRIVATE_BODY");
  });

  it.each([
    "host-native",
    "user-installed",
    "pactile-bundled",
    "project-vendored",
  ] as const)(
    "retains %s classification across scope and kind",
    (source: ExternalAssetSourceV1) => {
      const owner =
        source === "host-native"
          ? { kind: "host", id: "editor-one" }
          : source === "pactile-bundled"
            ? { kind: "pactile", id: "pactile" }
            : { kind: "user", id: null };
      for (const scope of ["project", "user", "host"]) {
        const result = discoverSnapshot({
          context: { ...context, source, scope, owner },
          assets: ["skill", "mcp", "plugin", "executable", "service"].map(
            (kind) => ({ ...asset, kind, enabled: true, present: true }),
          ),
        });
        expect(result.assets).toHaveLength(5);
        for (const found of result.assets) {
          expect(found).toMatchObject({
            source,
            scope,
            owner,
            readiness: "ready",
          });
          expect(parseExternalAssetRefV1(found).success).toBe(true);
        }
      }
    },
  );

  it("canonicalizes case, order, and duplicate records without losing multi-host or scope origins", () => {
    const first = discoverSnapshot({
      context,
      assets: [
        { ...asset, id: "Repo-Search", tools: ["find", "read"] },
        { ...asset, tools: ["read", "find", "read"] },
      ],
    });
    expect(first.assets).toHaveLength(1);
    expect(first.diagnostics).toEqual([]);
    expect(first.assets[0].id).toBe("repo-search");
    const host = discoverSnapshot({
      context: { ...context, hostId: "editor-two" },
      assets: [asset],
    });
    const user = discoverSnapshot({
      context: { ...context, scope: "user" },
      assets: [asset],
    });
    const otherLocator = discoverSnapshot({
      context,
      assets: [{ ...asset, locatorToken: "second" }],
    });
    const all = [
      ...first.assets,
      ...host.assets,
      ...user.assets,
      ...otherLocator.assets,
    ];
    const result = buildInventory(all);
    expect(result.assets).toHaveLength(4);
    expect(result.diagnostics).toEqual([
      { code: "ambiguous-id", path: "assets" },
    ]);
    expect(buildInventory([...all].reverse())).toEqual(result);
    expect(buildInventory([...all, ...all])).toEqual(result);
    expect(buildInventory(result.assets)).toEqual(result);
    expect(new Set(result.assets.map((item) => item.locator)).size).toBe(3);
  });

  it("does not choose conflicting evidence according to scan order", () => {
    const known = discoverSnapshot({
      context,
      assets: [{ ...asset, present: true, enabled: true, tools: ["find"] }],
    }).assets;
    const conflict = discoverSnapshot({
      context,
      assets: [{ ...asset, present: false, tools: ["edit"] }],
    }).assets;
    const result = buildInventory([...known, ...conflict]);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      readiness: "unknown",
      fingerprint: null,
      installHint: null,
    });
    expect(result.diagnostics).toEqual([
      { code: "identity-conflict", path: "assets" },
    ]);
    expect(buildInventory([...conflict, ...known])).toEqual(result);
  });

  it("uses only sanitized public metadata as fingerprint inputs", () => {
    const run = (extra: object) =>
      discoverSnapshot({ context, assets: [{ ...asset, ...extra }] }).assets[0]
        .fingerprint;
    const baseline = run({ tools: ["find", "read"], transport: "stdio" });
    expect(run({ tools: ["read", "find", "find"], transport: "stdio" })).toBe(
      baseline,
    );
    expect(run({ tools: ["find", "write"], transport: "stdio" })).not.toBe(
      baseline,
    );
    expect(run({ tools: ["find", "read"], transport: "http" })).not.toBe(
      baseline,
    );
    expect(
      run({
        tools: ["find", "read"],
        transport: "stdio",
        publicFingerprint: `sha256:${"a".repeat(64)}`,
      }),
    ).not.toBe(baseline);
    expect(
      run({
        tools: ["find", "read"],
        transport: "stdio",
        body: "CANARY_PRIVATE_BODY",
        env: { KEY: "CANARY_PRIVATE_BODY" },
        headers: { Authorization: "CANARY_PRIVATE_BODY" },
        token: "CANARY_PRIVATE_BODY",
        oauth: "CANARY_PRIVATE_BODY",
        command: "CANARY_PRIVATE_BODY",
      }),
    ).toBe(baseline);
  });

  it("does not access secret getters, Skill body getters, or unknown keys", () => {
    const forbidden = vi.fn(() => {
      throw new Error("CANARY_FORBIDDEN_ACCESS");
    });
    const input = { ...asset };
    for (const key of [
      "env",
      "headers",
      "token",
      "oauth",
      "command",
      "body",
      "skillBody",
      "content",
      "toJSON",
    ])
      Object.defineProperty(input, key, { get: forbidden, enumerable: true });
    const result = discoverSnapshot({ context, assets: [input] });
    expect(result.assets).toHaveLength(1);
    expect(forbidden).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it.each([
    { id: "C:\\CANARY_PRIVATE\\key" },
    { id: "/CANARY_PRIVATE/key" },
    { id: "x".repeat(1000) },
    { id: "name@1.2.3" },
    { id: "full width ｘ" },
    { kind: "CANARY_PRIVATE" },
    { locatorToken: "https://name:CANARY_PRIVATE@example.test" },
    { locatorToken: "../CANARY_PRIVATE" },
    { transport: "CANARY_PRIVATE" },
    { tools: ["/CANARY_PRIVATE/key"] },
    { tools: ["x".repeat(1000)] },
    { publicFingerprint: "CANARY_PRIVATE" },
    { enabled: "CANARY_PRIVATE" },
    { present: "CANARY_PRIVATE" },
  ])(
    "rejects malformed asset metadata with fixed non-echoing diagnostics: %#",
    (patch) => {
      const result = discoverSnapshot({
        context,
        assets: [{ ...asset, ...patch }],
      });
      expect(result).toEqual({
        assets: [],
        diagnostics: [{ code: "invalid-asset", path: "assets" }],
      });
    },
  );

  it.each([
    null,
    {},
    { ...context, hostId: "/CANARY_PRIVATE" },
    { ...context, rootId: "x".repeat(1000) },
    { ...context, source: "https://CANARY_PRIVATE" },
    { ...context, owner: { kind: "user", id: "name" } },
  ])(
    "rejects context errors without echoing root, owner, or host: %#",
    (invalid) => {
      expect(discoverSnapshot({ context: invalid, assets: [asset] })).toEqual({
        assets: [],
        diagnostics: [{ code: "invalid-context", path: "context" }],
      });
    },
  );

  it("handles accessor/proxy errors without throwing or logging their canary", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const explosive = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error("CANARY_THROWN_EXCEPTION");
          },
          ownKeys() {
            throw new Error("CANARY_KEYS");
          },
        },
      );
      expect(discoverSnapshot(explosive)).toEqual({
        assets: [],
        diagnostics: [{ code: "invalid-context", path: "context" }],
      });
      expect(discoverSnapshot({ context, assets: [explosive] })).toEqual({
        assets: [],
        diagnostics: [{ code: "invalid-asset", path: "assets" }],
      });
      expect(buildInventory([explosive])).toEqual({
        assets: [],
        diagnostics: [{ code: "invalid-asset", path: "assets" }],
      });
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("rejects malformed snapshots and unsafe prebuilt locators before building inventory", () => {
    for (const assets of [null, {}, new Array(1025), new Array(1)])
      expect(discoverSnapshot({ context, assets }).assets).toEqual([]);
    const safe = discoverSnapshot({ context, assets: [asset] }).assets[0];
    for (const locator of [
      "/CANARY_PRIVATE",
      "C:\\CANARY_PRIVATE",
      "host-native://secret/value",
      "host-native://user:CANARY_PRIVATE@server",
      "user-installed://wrong-source",
    ])
      expect(buildInventory([{ ...safe, locator }])).toEqual({
        assets: [],
        diagnostics: [{ code: "invalid-asset", path: "assets" }],
      });
  });

  it("never inspects a hostile thrown object's prototype while sanitizing errors", () => {
    const hostileError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("CANARY_ERROR_PROTOTYPE");
        },
      },
    );
    const assets = new Proxy([], {
      getOwnPropertyDescriptor() {
        throw hostileError;
      },
    });
    expect(discoverSnapshot({ context, assets })).toEqual({
      assets: [],
      diagnostics: [{ code: "invalid-input", path: "input" }],
    });
  });
});
