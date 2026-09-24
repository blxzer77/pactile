import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTileDirectory,
  loadTileUnit,
  type TileCatalogEntry,
} from "../../../src/pactile/tiles/loader.js";
import {
  buildTileCatalog,
  describeTileCatalog,
  type TileCatalog,
} from "../../../src/pactile/tiles/catalog.js";
import { compileTileComposition } from "../../../src/pactile/tiles/compiler.js";
import {
  type PolicyCeilingV1,
  type ResolvedProviderV1,
  policyWithinCeilingV1,
} from "../../../src/core/index.js";

const YAML = `schemaVersion: 1
identity:
  id: context.read
  version: "1.0.0"
summary: Read context.
trigger:
  mode: both
  intents:
    - exact
  description: Read the given input.
inputs: []
outputs:
  - context
dependencies: []
conflicts: []
permissions:
  filesystem: read
  process: none
  credentials: forbidden
egress:
  network: forbidden
  privacy: local-only
  telemetry: local-only
  destinations: []
cost:
  ceiling: free
fallback:
  allowed: false
  minimumAssurance: null
  policy: null
stop:
  conditions:
    - success
    - blocked
  maxAttempts: 2
minimumAssurance: evidence-backed
evidence:
  - kind: source-reference
    required: true
    description: Cite the source.
`;

function load(yaml = YAML, skill = "# Read\n\nRead the project.\n") {
  return loadTileUnit([
    { name: "tile.yaml", text: yaml },
    { name: "SKILL.md", text: skill },
  ]);
}
function entry(yaml = YAML): TileCatalogEntry {
  const result = load(yaml);
  if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
  return result.data;
}
function catalog(entries: TileCatalogEntry[]): TileCatalog {
  const result = buildTileCatalog(entries);
  if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
  return result.data;
}
function tile(
  id: string,
  dependencies: string[] = [],
  conflicts: string[] = [],
  inputs: string[] = [],
): TileCatalogEntry {
  const list = (values: string[]) =>
    values.length
      ? "\n" + values.map((value) => `  - ${value}`).join("\n")
      : " []";
  return entry(
    YAML.replaceAll("context.read", id)
      .replace("dependencies: []", "dependencies:" + list(dependencies))
      .replace("conflicts: []", "conflicts:" + list(conflicts))
      .replace("inputs: []", "inputs:" + list(inputs)),
  );
}

const LOCAL_POLICY: PolicyCeilingV1 = {
  filesystem: "read",
  process: "none",
  network: "forbidden",
  credentials: "forbidden",
  privacy: "local-only",
  egressDestinations: [],
  telemetry: "local-only",
  cost: "free",
};
function provider(
  overrides: Partial<ResolvedProviderV1> = {},
): ResolvedProviderV1 {
  return {
    schemaVersion: 1,
    intent: "exact",
    minimumAssurance: "evidence-backed",
    origin: "provider",
    providerId: "tool.optional",
    providerVersion: "1.0.0",
    assurance: "verified",
    readiness: "ready",
    requestedPolicy: LOCAL_POLICY,
    effectivePolicy: LOCAL_POLICY,
    evidenceRefs: ["evidence://probe/1"],
    freshness: "fresh",
    probedAt: "2026-09-09T10:00:00Z",
    probeResult: "passed",
    fallbackFromProviderId: null,
    ...overrides,
  };
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Tile transport", () => {
  it("loads the complete v1 manifest and Skill as a stable logical entry", () => {
    const tile = entry();
    expect(tile.ref).toBe("context.read@1.0.0");
    // Frozen, reviewed YAML/Skill fixture: changes to normalization or ABI are visible.
    expect(tile.fingerprint).toBe(
      "sha256:51bee4cbe822479f88f03d506ac997a80ec11316606d16de02b4dafc81ae660e",
    );
    expect(tile.manifest.evidence).toEqual([
      {
        kind: "source-reference",
        required: true,
        description: "Cite the source.",
      },
    ]);
    expect(
      load(YAML.replace(/\n/g, "\r\n"), "# Read\r\n\r\nRead the project.\r\n"),
    ).toEqual(load());
  });

  it("fingerprint changes when only the Skill content changes", () => {
    const baseline = load();
    const changed = load(YAML, "# Read\n\nChanged Skill content.\n");
    if (!baseline.success || !changed.success)
      throw new Error("expected valid Tile inputs");
    expect(changed.data.fingerprint).not.toBe(baseline.data.fingerprint);
  });

  it("fingerprint changes when only the manifest content changes", () => {
    const baseline = load();
    const changed = load(
      YAML.replace("Read context.", "Read different context."),
    );
    if (!baseline.success || !changed.success)
      throw new Error("expected valid Tile inputs");
    expect(changed.data.fingerprint).not.toBe(baseline.data.fingerprint);
  });

  it("fingerprint is unchanged when the transport file array is reversed", () => {
    const files = [
      { name: "tile.yaml", text: YAML },
      { name: "SKILL.md", text: "# Read\n" },
    ];
    const baseline = loadTileUnit(files);
    const reversed = loadTileUnit([...files].reverse());
    if (!baseline.success || !reversed.success)
      throw new Error("expected valid Tile inputs");
    expect(reversed.data.fingerprint).toBe(baseline.data.fingerprint);
  });

  it.each([
    [
      "anchor",
      YAML.replace("identity:", "identity: &identity"),
      "yaml-unsupported-syntax",
    ],
    [
      "alias",
      YAML.replace("inputs: []", "inputs: *identity"),
      "yaml-unsupported-syntax",
    ],
    [
      "tag",
      YAML.replace("summary: Read context.", "summary: !!str hello"),
      "yaml-unsupported-syntax",
    ],
    [
      "merge key",
      YAML.replace("  id: context.read", "  <<: {}"),
      "yaml-unsupported-syntax",
    ],
    ["multi document", "---\n" + YAML, "yaml-document"],
    ["directive", "%YAML 1.2\n" + YAML, "yaml-document"],
    ["duplicate key", YAML + "summary: changed\n", "yaml-duplicate-key"],
    ["tab", YAML.replace("  id:", "\tid:"), "yaml-tab"],
    [
      "implicit date",
      YAML.replace("Read context.", "2026-09-09"),
      "yaml-implicit-scalar",
    ],
    [
      "implicit yes",
      YAML.replace("Read context.", "yes"),
      "yaml-implicit-scalar",
    ],
    [
      "nonfinite",
      YAML.replace("maxAttempts: 2", "maxAttempts: 1e999"),
      "yaml-number-range",
    ],
    ["complex key", "? [one, two]\n: value\n", "yaml-mapping-required"],
    [
      "flow sequence",
      YAML.replace("inputs: []", "inputs: [one, two]"),
      "yaml-unsupported-syntax",
    ],
    [
      "block scalar",
      YAML.replace("Read context.", "|"),
      "yaml-unsupported-syntax",
    ],
    ["unknown field", YAML + "extra: value\n", "manifest-unknown-field"],
    ["numeric key", "1: value\n", "yaml-complex-key"],
    ["missing value", "identity:\n", "yaml-missing-value"],
    [
      "unterminated quote",
      'summary: "unfinished\n',
      "yaml-unterminated-string",
    ],
    [
      "invalid indentation",
      "identity:\n  id: context.read\n version: 1.0.0\n",
      "yaml-indentation",
    ],
    [
      "mixed collection",
      "inputs:\n  - query\n  key: value\n",
      "yaml-mixed-collection",
    ],
    [
      "depth limit",
      Array.from(
        { length: 66 },
        (_, index) => "  ".repeat(index) + "nested:",
      ).join("\n") +
        "\n" +
        "  ".repeat(66) +
        "value: terminal\n",
      "yaml-depth-limit",
    ],
    ["prototype field", YAML + "__proto__: {}\n", "manifest-unknown-field"],
  ])(
    "rejects %s with a stable code and without echoing contents",
    (_name, yaml, code) => {
      const result = load(yaml);
      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected rejection");
      expect(result.diagnostics[0].code).toBe(code);
      expect(JSON.stringify(result)).not.toContain("Read context.");
    },
  );

  it("supports strings, comments, typed scalars and mapping key reordering", () => {
    const reordered = YAML.replace(
      '  id: context.read\n  version: "1.0.0"',
      "  version: 1.0.0 # version\n  id: context.read",
    );
    expect(load(reordered)).toEqual(load());
    expect(
      load(YAML.replace("summary: Read context.", "summary: 'Read context.'")),
    ).toEqual(load());
    expect(
      load(
        YAML.replace(
          "summary: Read context.",
          '"summary": "Read context." # comment',
        ),
      ),
    ).toEqual(load());
  });

  it("requires one exact-case pair, rejects duplicate units and enforces transport limits", () => {
    expect(loadTileUnit([{ name: "tile.yaml", text: YAML }]).success).toBe(
      false,
    );
    expect(
      loadTileUnit([
        { name: "TILE.YAML", text: YAML },
        { name: "SKILL.md", text: "" },
      ]).success,
    ).toBe(false);
    expect(
      loadTileUnit([
        { name: "tile.yaml", text: YAML },
        { name: "Tile.yaml", text: YAML },
        { name: "SKILL.md", text: "" },
      ]),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-file-collision" }],
    });
    expect(load(YAML, "x".repeat(1_048_577))).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-size-limit" }],
    });
    expect(load("summary: " + "x".repeat(1_048_576))).toMatchObject({
      success: false,
      diagnostics: [{ code: "yaml-size-limit" }],
    });
  });

  it("fails closed for malformed encoding, directories masquerading as files and symbolic links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tiles-"));
    temporary.push(root);
    await writeFile(path.join(root, "tile.yaml"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(root, "SKILL.md"), "safe");
    expect(await loadTileDirectory(root)).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-invalid-encoding" }],
    });
    const nested = path.join(root, "nested");
    await mkdir(nested);
    await mkdir(path.join(nested, "tile.yaml"));
    await writeFile(path.join(nested, "SKILL.md"), "safe");
    expect(await loadTileDirectory(nested)).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-unsafe-file" }],
    });
    const alias = path.join(root, "alias");
    await symlink(nested, alias, "junction");
    expect(await loadTileDirectory(alias)).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-unsafe-file" }],
    });
  });

  it("reads only the required pair, regardless of directory and file enumeration order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tiles-"));
    temporary.push(root);
    const first = path.join(root, "a");
    const second = path.join(root, "b");
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, "tile.yaml"), YAML);
    await writeFile(path.join(first, "SKILL.md"), "# Read\n");
    await writeFile(path.join(second, "SKILL.md"), "# Read\r\n");
    await writeFile(
      path.join(second, "tile.yaml"),
      YAML.replace(/\n/g, "\r\n"),
    );
    await writeFile(
      path.join(first, "private-unrelated"),
      "must not enter output",
    );
    expect(await loadTileDirectory(first)).toEqual(
      await loadTileDirectory(second),
    );
    expect(await loadTileDirectory(first.replace(/\\/g, "/"))).toEqual(
      await loadTileDirectory(first),
    );
    expect(await readFile(path.join(first, "private-unrelated"), "utf8")).toBe(
      "must not enter output",
    );
    expect(JSON.stringify(await loadTileDirectory(first))).not.toContain(root);
  });
});

describe("Tile catalog and model-owned composition", () => {
  describe.each([
    ["selection", "$.requestedSelection[0]"],
    ["fallback", "$.fallbackTileIds[0]"],
    ["capability", "$.capabilities[0].id"],
    ["provider capability", "$.providerFacts[0].capabilityIds[0]"],
  ] as const)(
    "rejects malformed %s refs without echoing them",
    (target, fieldPath) => {
      it.each([
        ["Windows absolute path", "C:\\private-fixture\\account"],
        ["POSIX absolute path", "/private-fixture/account"],
        ["overlong logical id", "sensitive" + "a".repeat(300)],
        ["noncanonical id", "Uppercase-Reference"],
        ["invalid exact semver", "context.read@1.0"],
        ["range semver", "context.read@^1.0.0"],
        ["empty version", "context.read@"],
        ["path traversal", "../private-fixture"],
        ["trailing newline", "context.read\n"],
        ["nonstring null", null as unknown as string],
        ["nonstring number", 12 as unknown as string],
        ["leading-zero semver", "context.read@01.0.0"],
        ["extra version separator", "context.read@1.0.0@2.0.0"],
      ])(
        "rejects %s with only a stable code and request position",
        (_name, value) => {
          const result = compileTileComposition(catalog([entry()]), {
            requestedSelection:
              target === "selection" ? [value] : ["context.read"],
            capabilities:
              target === "capability"
                ? [{ id: value, assurance: "verified" }]
                : [],
            fallbackTileIds: target === "fallback" ? [value] : [],
            providerFacts:
              target === "provider capability"
                ? [
                    {
                      capabilityIds: [value],
                      authorized: true,
                      resolution: provider(),
                    },
                  ]
                : [],
          });
          expect(result).toEqual({
            success: false,
            diagnostics: [
              {
                code: "tile-invalid-caller-reference",
                tileRef: null,
                relatedRef: null,
                path: fieldPath,
              },
            ],
          });
          expect(JSON.stringify(result).length).toBeLessThan(256);
        },
      );
    },
  );

  it("accepts canonical names and exact prerelease/build versions without requiring a full caller manifest", () => {
    const id = "scope:part.value_name";
    const ref = id + "@1.2.3-beta.1+build.7";
    const versioned = entry(
      YAML.replace("context.read", id).replace(
        '"1.0.0"',
        '"1.2.3-beta.1+build.7"',
      ),
    );
    expect(
      compileTileComposition(catalog([versioned]), {
        requestedSelection: [ref],
        capabilities: [{ id: "cap:query.value_name", assurance: "verified" }],
      }),
    ).toMatchObject({ success: true, data: { requestedSelection: [ref] } });
    // Capability identifiers have no version syntax, even if that version is valid.
    expect(
      compileTileComposition(catalog([entry()]), {
        requestedSelection: ["context.read"],
        capabilities: [{ id: "query@1.0.0", assurance: "verified" }],
      }),
    ).toEqual({
      success: false,
      diagnostics: [
        {
          code: "tile-invalid-caller-reference",
          tileRef: null,
          relatedRef: null,
          path: "$.capabilities[0].id",
        },
      ],
    });
  });

  it("enforces the 256-character transport bound without truncation or off-by-one rejection", () => {
    const id = "x".repeat(250);
    const ref = id + "@1.0.0";
    expect(ref.length).toBe(256);
    expect(
      compileTileComposition(catalog([tile(id)]), {
        requestedSelection: [ref],
        capabilities: [{ id: "c".repeat(256), assurance: "verified" }],
      }).success,
    ).toBe(true);
    expect(
      compileTileComposition(catalog([entry()]), {
        requestedSelection: ["context.read"],
        capabilities: [{ id: "c".repeat(257), assurance: "verified" }],
      }),
    ).toEqual({
      success: false,
      diagnostics: [
        {
          code: "tile-invalid-caller-reference",
          tileRef: null,
          relatedRef: null,
          path: "$.capabilities[0].id",
        },
      ],
    });
  });
  it("offers a compact model catalog without Skill bodies or full machine policies", () => {
    const brief = describeTileCatalog(catalog([tile("zulu"), tile("alpha")]));
    expect(brief.map((item) => item.ref)).toEqual([
      "alpha@1.0.0",
      "zulu@1.0.0",
    ]);
    expect(brief[0]).toMatchObject({
      summary: "Read context.",
      trigger: { mode: "both", intents: ["exact"] },
      inputs: [],
      outputs: ["context"],
    });
    expect(JSON.stringify(brief)).not.toContain("skillText");
    expect(JSON.stringify(brief)).not.toContain("Read the project.");
    expect(JSON.stringify(brief)).not.toContain("permissions");
  });
  it("expands dependencies first and keeps independent Tiles in a stable layer", () => {
    const alpha = entry(YAML.replaceAll("context.read", "alpha"));
    const beta = entry(YAML.replaceAll("context.read", "beta"));
    const derived = entry(
      YAML.replaceAll("context.read", "derived")
        .replace("dependencies: []", "dependencies:\n  - beta\n  - alpha")
        .replace("inputs: []", "inputs:\n  - context"),
    );
    const first = catalog([derived, beta, alpha]);
    expect(first).toEqual(catalog([alpha, derived, beta]));
    const result = compileTileComposition(first, {
      requestedSelection: ["derived"],
      capabilities: [],
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected accepted composition");
    expect(result.data.requestedSelection).toEqual(["derived@1.0.0"]);
    expect(result.data.expandedSelection).toEqual([
      "alpha@1.0.0",
      "beta@1.0.0",
      "derived@1.0.0",
    ]);
    expect(result.data.policyCeiling).toEqual({
      filesystem: "read",
      process: "none",
      network: "forbidden",
      credentials: "forbidden",
      privacy: "local-only",
      egressDestinations: [],
      telemetry: "local-only",
      cost: "free",
    });
    expect(result.data.evidenceObligations).toEqual([
      {
        kind: "source-reference",
        required: true,
        description: "Cite the source.",
        tileRefs: ["alpha@1.0.0", "beta@1.0.0", "derived@1.0.0"],
      },
    ]);
    expect(result.data.stopObligations).toEqual([
      {
        condition: "blocked",
        tileRefs: ["alpha@1.0.0", "beta@1.0.0", "derived@1.0.0"],
      },
      {
        condition: "success",
        tileRefs: ["alpha@1.0.0", "beta@1.0.0", "derived@1.0.0"],
      },
    ]);
    expect(result).toEqual(
      compileTileComposition(catalog([alpha, beta, derived]), {
        requestedSelection: ["derived"],
        capabilities: [],
      }),
    );
  });

  it("keeps complete topological layers, and never borrows unrelated Tile outputs", () => {
    const choices = catalog([
      tile("alpha", ["beta"]),
      tile("beta"),
      tile("zulu"),
    ]);
    expect(
      compileTileComposition(choices, {
        requestedSelection: ["alpha", "zulu"],
        capabilities: [],
      }),
    ).toMatchObject({
      success: true,
      data: { expandedSelection: ["beta@1.0.0", "zulu@1.0.0", "alpha@1.0.0"] },
    });
    const missing = catalog([
      tile("consumer", [], [], ["context"]),
      tile("producer"),
    ]);
    expect(
      compileTileComposition(missing, {
        requestedSelection: ["producer", "consumer"],
        capabilities: [],
      }),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-missing-capability" }],
    });
  });

  it("does not elevate dependency output assurance or contradictory capability facts", () => {
    const weak = entry(
      YAML.replace("context.read", "weak").replace(
        "minimumAssurance: evidence-backed",
        "minimumAssurance: best-effort",
      ),
    );
    const strong = tile("strong", ["weak"], [], ["context"]);
    expect(
      compileTileComposition(catalog([weak, strong]), {
        requestedSelection: ["strong"],
        capabilities: [],
      }),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-capability-assurance-denied" }],
    });
    const choices = catalog([tile("input", [], [], ["query"])]);
    const facts = [
      { id: "query", assurance: "verified" as const },
      { id: "query", assurance: "best-effort" as const },
    ];
    const first = compileTileComposition(choices, {
      requestedSelection: ["input"],
      capabilities: facts,
    });
    expect(first).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-capability-assurance-denied" }],
    });
    expect(
      compileTileComposition(choices, {
        requestedSelection: ["input"],
        capabilities: [...facts].reverse(),
      }),
    ).toEqual(first);
  });

  it("rejects duplicate identities, missing dependencies and indirect cycles in any scan order", () => {
    expect(buildTileCatalog([tile("alpha"), tile("alpha")])).toMatchObject({
      success: false,
      diagnostics: [
        { code: "tile-duplicate-identity", tileRef: "alpha@1.0.0" },
      ],
    });
    expect(buildTileCatalog([tile("alpha", ["missing"])])).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-missing-dependency", relatedRef: "missing" }],
    });
    const cycle = [
      tile("alpha", ["beta"]),
      tile("beta", ["gamma"]),
      tile("gamma", ["alpha"]),
    ];
    const blocked = buildTileCatalog(cycle);
    expect(blocked).toMatchObject({
      success: false,
      diagnostics: [
        { code: "tile-dependency-cycle", tileRef: "alpha@1.0.0" },
        { code: "tile-dependency-cycle", tileRef: "beta@1.0.0" },
        { code: "tile-dependency-cycle", tileRef: "gamma@1.0.0" },
      ],
    });
    expect(buildTileCatalog([...cycle].reverse())).toEqual(blocked);
  });

  it("indexes versions but never guesses ambiguous versions or permits two versions in one composition", () => {
    const v1 = tile("alpha");
    const v2 = entry(
      YAML.replace("context.read", "alpha").replace('"1.0.0"', '"2.0.0"'),
    );
    const versions = catalog([v2, v1]);
    expect(
      compileTileComposition(versions, {
        requestedSelection: ["alpha"],
        capabilities: [],
      }),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-ambiguous-reference" }],
    });
    expect(
      compileTileComposition(versions, {
        requestedSelection: ["alpha@2.0.0"],
        capabilities: [],
      }),
    ).toMatchObject({
      success: true,
      data: { expandedSelection: ["alpha@2.0.0"] },
    });
    expect(
      compileTileComposition(versions, {
        requestedSelection: ["alpha@1.0.0", "alpha@2.0.0"],
        capabilities: [],
      }),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-version-conflict" }],
    });
    expect(
      buildTileCatalog([v1, v2, tile("consumer", ["alpha"])]),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-ambiguous-dependency" }],
    });
  });

  it("treats a one-sided conflict as symmetric and rejects conflicts inside dependency closures", () => {
    const left = tile("left", [], ["right"]);
    const right = tile("right");
    const alternatives = catalog([right, left]);
    expect(alternatives.conflicts).toEqual([["left@1.0.0", "right@1.0.0"]]);
    const result = compileTileComposition(alternatives, {
      requestedSelection: ["right", "left"],
      capabilities: [],
    });
    expect(result).toMatchObject({
      success: false,
      diagnostics: [
        {
          code: "tile-conflict",
          tileRef: "left@1.0.0",
          relatedRef: "right@1.0.0",
        },
      ],
    });
    expect(
      compileTileComposition(alternatives, {
        requestedSelection: ["left", "right"],
        capabilities: [],
      }),
    ).toEqual(result);
    expect(
      buildTileCatalog([left, right, tile("consumer", ["left", "right"])]),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-conflict" }],
    });
  });

  it("does not auto-select a Tile from capabilities or keywords; checks supplied inputs and assurance", () => {
    const input = tile("input", [], [], ["query"]);
    const choices = catalog([input, tile("unrelated")]);
    expect(
      compileTileComposition(choices, {
        requestedSelection: [],
        capabilities: [{ id: "query", assurance: "verified" }],
      }),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-empty-selection" }],
    });
    expect(
      compileTileComposition(choices, {
        requestedSelection: ["input"],
        capabilities: [],
      }),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-missing-capability", relatedRef: "query" }],
    });
    expect(buildTileCatalog([input], [])).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-missing-capability" }],
    });
    expect(buildTileCatalog([input], ["query"]).success).toBe(true);
    expect(
      compileTileComposition(choices, {
        requestedSelection: ["input"],
        capabilities: [{ id: "query", assurance: "best-effort" }],
      }),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-capability-assurance-denied" }],
    });
    expect(
      compileTileComposition(choices, {
        requestedSelection: ["input"],
        capabilities: [{ id: "query", assurance: "verified" }],
      }),
    ).toMatchObject({
      success: true,
      data: { expandedSelection: ["input@1.0.0"] },
    });
    expect(
      compileTileComposition(choices, {
        requestedSelection: ["input", "input@1.0.0"],
        capabilities: [],
      }).success,
    ).toBe(false);
    expect(
      compileTileComposition(choices, {
        requestedSelection: ["missing"],
        capabilities: [],
      }).success,
    ).toBe(false);
  });

  it("intersects permissions, destination sets, cost, stop attempts and evidence with provenance", () => {
    const open = entry(
      YAML.replace("context.read", "open")
        .replace("filesystem: read", "filesystem: write")
        .replace("process: none", "process: execute")
        .replace("credentials: forbidden", "credentials: project-authorized")
        .replace("network: forbidden", "network: project-authorized")
        .replace("privacy: local-only", "privacy: external")
        .replace("telemetry: local-only", "telemetry: project-authorized")
        .replace(
          "destinations: []",
          "destinations:\n    - https://a.example\n    - https://b.example",
        )
        .replace("ceiling: free", "ceiling: high")
        .replace("maxAttempts: 2", "maxAttempts: 8"),
    );
    const local = tile("local");
    const result = compileTileComposition(catalog([open, local]), {
      requestedSelection: ["open", "local"],
      capabilities: [],
    });
    expect(result).toMatchObject({
      success: true,
      data: { policyCeiling: LOCAL_POLICY, maxAttempts: 2 },
    });
    if (!result.success) throw new Error("expected local common policy");
    expect(policyWithinCeilingV1(result.data.policyCeiling, LOCAL_POLICY)).toBe(
      true,
    );
    const restricted = {
      ...LOCAL_POLICY,
      filesystem: "none" as const,
      cost: "none" as const,
      telemetry: "forbidden" as const,
    };
    expect(
      compileTileComposition(catalog([open, local]), {
        requestedSelection: ["local", "open"],
        capabilities: [],
        policyCeiling: restricted,
      }),
    ).toMatchObject({ success: true, data: { policyCeiling: restricted } });
    const malformed = {
      ...LOCAL_POLICY,
      filesystem: "invented",
    } as PolicyCeilingV1;
    expect(
      compileTileComposition(catalog([local]), {
        requestedSelection: ["local"],
        capabilities: [],
        policyCeiling: malformed,
      }),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-invalid-policy" }],
    });
  });

  it("accepts authorized resolved facts without retaining concrete provider identity", () => {
    const choices = catalog([tile("input", [], [], ["query"])]);
    const result = compileTileComposition(choices, {
      requestedSelection: ["input"],
      capabilities: [],
      providerFacts: [
        { capabilityIds: ["query"], authorized: true, resolution: provider() },
      ],
    });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("tool.optional");
    expect(JSON.stringify(result)).not.toContain("providerVersion");
    expect(JSON.stringify(result)).not.toContain("probedAt");
  });

  it.each([
    ["unauthorized", false, provider(), "tile-provider-unavailable"],
    [
      "wrong intent",
      true,
      provider({ intent: "semantic" }),
      "tile-provider-intent-denied",
    ],
    [
      "stale",
      true,
      provider({ freshness: "stale", assurance: "evidence-backed" }),
      "tile-provider-unavailable",
    ],
    [
      "unavailable",
      true,
      provider({
        origin: "unsupported",
        providerId: null,
        providerVersion: null,
        readiness: "unavailable",
        assurance: null,
        effectivePolicy: null,
        evidenceRefs: [],
        freshness: "not-applicable",
        probedAt: null,
        probeResult: "not-run",
      }),
      "tile-provider-unavailable",
    ],
    [
      "malformed",
      true,
      provider({ readiness: "unavailable" }),
      "tile-invalid-provider-fact",
    ],
    [
      "insufficient assurance",
      true,
      provider({ assurance: "best-effort", minimumAssurance: "best-effort" }),
      "tile-provider-policy-denied",
    ],
    [
      "escalated policy",
      true,
      provider({
        requestedPolicy: { ...LOCAL_POLICY, filesystem: "write" },
        effectivePolicy: { ...LOCAL_POLICY, filesystem: "write" },
      }),
      "tile-provider-policy-denied",
    ],
    [
      "unapproved fallback",
      true,
      provider({ fallbackFromProviderId: "tool.primary" }),
      "tile-provider-fallback-denied",
    ],
  ] as const)(
    "rejects %s provider facts instead of silently falling back",
    (_name, authorized, resolution, code) => {
      const result = compileTileComposition(
        catalog([tile("input", [], [], ["query"])]),
        {
          requestedSelection: ["input"],
          capabilities: [],
          providerFacts: [{ capabilityIds: ["query"], authorized, resolution }],
        },
      );
      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected denial");
      expect(result.diagnostics.map((item) => item.code)).toContain(code);
    },
  );

  it("honors explicit allowed fallback without weakening policy or assurance", () => {
    const fallbackYaml = YAML.replace(
      "inputs: []",
      "inputs:\n  - query",
    ).replace(
      `fallback:
  allowed: false
  minimumAssurance: null
  policy: null`,
      `fallback:
  allowed: true
  minimumAssurance: verified
  policy:
    permissions:
      filesystem: read
      process: none
      credentials: forbidden
    egress:
      network: forbidden
      privacy: local-only
      telemetry: forbidden
      destinations: []
    cost:
      ceiling: free`,
    );
    const choices = catalog([entry(fallbackYaml)]);
    const fallbackResolution = provider({
      fallbackFromProviderId: "tool.primary",
      effectivePolicy: { ...LOCAL_POLICY, telemetry: "forbidden" },
    });
    const accepted = compileTileComposition(choices, {
      requestedSelection: ["context.read"],
      fallbackTileIds: ["context.read"],
      capabilities: [],
      providerFacts: [
        {
          capabilityIds: ["query"],
          authorized: true,
          resolution: fallbackResolution,
        },
      ],
    });
    expect(accepted).toMatchObject({
      success: true,
      data: {
        fallbackSelection: ["context.read@1.0.0"],
        minimumAssurance: "verified",
        policyCeiling: { ...LOCAL_POLICY, telemetry: "forbidden" },
      },
    });
    expect(
      compileTileComposition(choices, {
        requestedSelection: ["context.read"],
        capabilities: [],
        providerFacts: [
          {
            capabilityIds: ["query"],
            authorized: true,
            resolution: fallbackResolution,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      compileTileComposition(catalog([tile("disabled")]), {
        requestedSelection: ["disabled"],
        capabilities: [],
        fallbackTileIds: ["disabled"],
      }),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-fallback-denied" }],
    });
    expect(
      load(
        fallbackYaml.replace(
          "minimumAssurance: verified",
          "minimumAssurance: best-effort",
        ),
      ),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "manifest-policy-violation" }],
    });
    expect(
      load(
        fallbackYaml.replace(
          "      filesystem: read",
          "      filesystem: write",
        ),
      ),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "manifest-policy-violation" }],
    });
  });

  it("is deterministic across all scan and selection permutations of a small dependency graph", () => {
    const entries = [
      tile("root"),
      tile("branch", ["root"]),
      tile("leaf", ["branch"]),
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const reference = compileTileComposition(catalog(entries), {
      requestedSelection: ["leaf", "root"],
      capabilities: [],
    });
    for (const order of orders) {
      const built = catalog(order.map((index) => entries[index]));
      expect(
        compileTileComposition(built, {
          requestedSelection: ["root", "leaf"],
          capabilities: [],
        }),
      ).toEqual(reference);
    }
    const changed = entry(
      YAML.replace("context.read", "root").replace(
        "Read context.",
        "Read updated context.",
      ),
    );
    const changedComposition = compileTileComposition(
      catalog([changed, entries[1], entries[2]]),
      {
        requestedSelection: ["leaf", "root"],
        capabilities: [],
      },
    );
    if (!reference.success || !changedComposition.success)
      throw new Error("expected valid compositions");
    expect(changedComposition.data.fingerprint).not.toBe(
      reference.data.fingerprint,
    );
  });

  it("does not let callers forge an entry fingerprint or reuse a mutated manifest", () => {
    const candidate = tile("alpha");
    expect(
      buildTileCatalog([
        { ...candidate, fingerprint: "sha256:" + "0".repeat(64) },
      ]),
    ).toMatchObject({
      success: false,
      diagnostics: [{ code: "tile-entry-mismatch" }],
    });
    const result = compileTileComposition(catalog([candidate]), {
      requestedSelection: ["alpha"],
      capabilities: [],
    });
    expect(result.success).toBe(true);
    Object.assign(candidate.manifest, { summary: "mutated" });
    if (!result.success) throw new Error("expected composition");
    expect(result.data.tiles[0].manifest.summary).toBe("Read context.");
  });
});
