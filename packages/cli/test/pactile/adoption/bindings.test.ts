import { describe, expect, it } from "vitest";
import {
  parseCapabilityBindingV1,
  parseInstallHintV1,
} from "../../../src/core/index.js";
import { discoverSnapshot } from "../../../src/pactile/adoption/inventory.js";
import {
  createInstallHint,
  planBinding,
} from "../../../src/pactile/adoption/bindings.js";

function external(source = "user-installed", kind = "skill", present = true) {
  return discoverSnapshot({
    context: {
      hostId: "editor-one",
      rootId: "user-tools",
      source,
      scope: "user",
      owner:
        source === "pactile-bundled"
          ? { kind: "pactile", id: "pactile" }
          : source === "host-native"
            ? { kind: "host", id: "editor-one" }
            : { kind: "user", id: null },
    },
    assets: [
      { id: "search", kind, locatorToken: "main", present, enabled: true },
    ],
  }).assets[0];
}

describe("binding and symbolic installation proposals", () => {
  it.each(["skill", "mcp", "plugin", "executable", "service"])(
    "borrows external %s without granting deletion",
    (kind) => {
      const result = planBinding({
        asset: external("user-installed", kind),
        capabilityId: "repo.search",
        providerId: "provider.search",
        intents: ["exact"],
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.binding).toMatchObject({
        mode: "adopted",
        control: "borrowed",
        deleteBoundary: "preserve",
      });
      expect(parseCapabilityBindingV1(result.binding).success).toBe(true);
    },
  );
  it("distinguishes native and Pactile composed ownership", () => {
    expect(
      planBinding({
        asset: external("host-native"),
        capabilityId: "repo.search",
        intents: ["exact"],
      }).binding,
    ).toMatchObject({
      mode: "native",
      control: "borrowed",
      deleteBoundary: "preserve",
    });
    expect(
      planBinding({
        asset: external("pactile-bundled"),
        capabilityId: "repo.search",
        intents: ["exact"],
      }).binding,
    ).toMatchObject({
      mode: "composed",
      control: "pactile-owned",
      deleteBoundary: "remove-when-unclaimed",
    });
  });
  it("missing capability returns only a symbolic hint, never a binding", () => {
    const result = planBinding({
      asset: external("host-native", "mcp", false),
      capabilityId: "repo.search",
      providerId: "provider.search",
      intents: ["external"],
    });
    expect(result.binding).toBeNull();
    expect(result.installHint).toMatchObject({
      mechanism: "host-native",
      label: "install.mcp",
    });
    expect(parseInstallHintV1(result.installHint).success).toBe(true);
  });
  it.each([{}, { providerId: null }])(
    "missing MCP retains its existing hint without inventing a provider: %#",
    (provider) => {
      const asset = external("host-native", "mcp", false);
      const request = {
        asset,
        capabilityId: "repo.search",
        intents: ["external"],
        ...provider,
      };
      const result = planBinding(request);
      expect(result).toEqual({
        binding: null,
        installHint: asset.installHint,
        diagnostics: [],
      });
      expect(parseInstallHintV1(result.installHint).success).toBe(true);
      expect(planBinding(request)).toEqual(result);
      for (const patch of [
        { capabilityId: "/CANARY_REJECTED" },
        { intents: [] },
        { intents: ["CANARY_REJECTED"] },
        { providerId: "https://CANARY_REJECTED" },
        { mode: "CANARY_REJECTED" },
        { asset: { ...asset, source: "pactile-bundled" }, mode: "adopted" },
        { asset: external("pactile-bundled", "mcp", false), mode: "adopted" },
        { asset: external("project-vendored", "mcp", false), mode: "native" },
        { asset: { ...asset, installHint: null } },
      ]) {
        expect(planBinding({ ...request, ...patch })).toEqual({
          binding: null,
          installHint: null,
          diagnostics: [{ code: "invalid-binding", path: "binding" }],
        });
      }
    },
  );
  it.each(["host-native", "package-manager", "manual"])(
    "creates a bounded %s hint with explicit authentication flag",
    (mechanism) => {
      const result = createInstallHint({
        kind: "service",
        mechanism,
        requiresAuthentication: true,
      });
      expect(result.hint).toMatchObject({
        mechanism,
        requiresAuthentication: true,
        label: "install.service",
      });
      expect(parseInstallHintV1(result.hint).success).toBe(true);
    },
  );

  it("keeps composed third-party vendored assets borrowed, with no caller ownership override", () => {
    const result = planBinding({
      asset: external("project-vendored"),
      capabilityId: "repo.search",
      mode: "composed",
      intents: ["exact"],
      control: "pactile-owned",
      deleteBoundary: "remove-when-unclaimed",
    });
    expect(result.binding).toMatchObject({
      mode: "composed",
      control: "borrowed",
      deleteBoundary: "preserve",
    });
  });

  it("permits explicitly Pactile-owned vendored composition only through composed mode", () => {
    const asset = {
      ...external("project-vendored"),
      owner: { kind: "pactile", id: "pactile" },
    };
    expect(
      planBinding({
        asset,
        capabilityId: "repo.search",
        mode: "composed",
        intents: ["exact"],
      }).binding,
    ).toMatchObject({
      control: "pactile-owned",
      deleteBoundary: "remove-when-unclaimed",
    });
    expect(
      planBinding({
        asset,
        capabilityId: "repo.search",
        mode: "adopted",
        intents: ["exact"],
      }).binding,
    ).toMatchObject({ control: "borrowed", deleteBoundary: "preserve" });
  });

  it("keeps binding identity stable for repeated calls and intent permutations", () => {
    const input = {
      asset: external(),
      capabilityId: "repo.search",
      providerId: "provider.search",
      intents: ["exact", "semantic"],
    };
    const result = planBinding(input);
    expect(
      planBinding({ ...input, intents: ["semantic", "exact", "exact"] }),
    ).toEqual(result);
    expect(planBinding(input)).toEqual(result);
    expect(
      planBinding({ ...input, capabilityId: "repo.other" }).binding?.id,
    ).not.toBe(result.binding?.id);
  });

  it.each(["unknown", "degraded"])(
    "does not probe or automatically install a %s asset",
    (readiness) => {
      expect(
        planBinding({
          asset: { ...external(), readiness },
          capabilityId: "repo.search",
          intents: ["exact"],
        }),
      ).toEqual({
        binding: null,
        installHint: null,
        diagnostics: [{ code: "unavailable", path: "binding" }],
      });
    },
  );

  it.each([
    { capabilityId: "/CANARY_REJECTED/path" },
    { capabilityId: "C:\\CANARY_REJECTED" },
    { capabilityId: "x".repeat(1000) },
    { providerId: "https://CANARY_REJECTED" },
    { providerId: "x@1.2.3" },
    { intents: ["CANARY_REJECTED"] },
    { intents: [] },
    { mode: "CANARY_REJECTED" },
  ])("redacts invalid binding request fields: %#", (patch) => {
    const result = planBinding({
      asset: external(),
      capabilityId: "repo.search",
      intents: ["exact"],
      ...patch,
    });
    expect(result).toEqual({
      binding: null,
      installHint: null,
      diagnostics: [{ code: "invalid-binding", path: "binding" }],
    });
  });

  it("requires a provider for MCP and rejects source-incompatible modes", () => {
    for (const readiness of ["ready", "degraded", "unknown"]) {
      for (const provider of [{}, { providerId: null }]) {
        expect(
          planBinding({
            asset: { ...external("user-installed", "mcp"), readiness },
            capabilityId: "repo.search",
            intents: ["external"],
            ...provider,
          }),
        ).toEqual({
          binding: null,
          installHint: null,
          diagnostics: [{ code: "invalid-binding", path: "binding" }],
        });
      }
    }
    expect(
      planBinding({
        asset: external("pactile-bundled"),
        capabilityId: "repo.search",
        mode: "adopted",
        intents: ["exact"],
      }).binding,
    ).toBeNull();
    expect(
      planBinding({
        asset: external("project-vendored"),
        capabilityId: "repo.search",
        mode: "native",
        intents: ["exact"],
      }).binding,
    ).toBeNull();
  });

  it("has no public throw or diagnostic echo for hostile nested refs and hint values", () => {
    const bomb = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("CANARY_THROWN");
        },
      },
    );
    const expected = {
      binding: null,
      installHint: null,
      diagnostics: [{ code: "invalid-binding", path: "binding" }],
    };
    expect(planBinding(bomb)).toEqual(expected);
    expect(
      planBinding({
        asset: { ...external(), owner: bomb },
        capabilityId: "repo.search",
        intents: ["exact"],
      }),
    ).toEqual(expected);
    expect(
      planBinding({
        asset: { ...external(), locator: "host-native://secret/CANARY_THROWN" },
        capabilityId: "repo.search",
        intents: ["exact"],
      }),
    ).toEqual(expected);
    expect(createInstallHint(bomb)).toEqual({
      hint: null,
      diagnostics: [{ code: "invalid-input", path: "hint" }],
    });
    expect(
      createInstallHint({ kind: "skill", mechanism: "CANARY_THROWN" }),
    ).toEqual({
      hint: null,
      diagnostics: [{ code: "invalid-input", path: "hint" }],
    });
  });
});
