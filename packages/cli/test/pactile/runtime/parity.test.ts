import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleRuntimePathRequest } from "../../../src/pactile/runtime/json-api.js";
import { caseFoldComponent } from "../../../src/pactile/runtime/paths.js";
import { normalizeNfc15 } from "../../../src/pactile/runtime/unicode-nfc.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("Node Runtime JSON ABI", () => {
  it("matches the independent malformed and normalization golden corpus", () => {
    const corpus = JSON.parse(
      fs.readFileSync(path.join(here, "path-golden.json"), "utf8"),
    ) as { input: unknown; expected: unknown }[];
    expect(corpus.map(({ input }) => handleRuntimePathRequest(input))).toEqual(
      corpus.map(({ expected }) => expected),
    );
  });

  it("pins representative Unicode 15 composition and case folding boundaries", () => {
    expect(normalizeNfc15("A\u030a\u0301")).toBe("\u01fa");
    expect(normalizeNfc15("\u1100\u1161\u11a8")).toBe("\uac01");
    const post15 = String.fromCodePoint(0x105d2, 0x0307);
    expect(normalizeNfc15(post15)).toBe(post15);
    expect(caseFoldComponent("Straße Σς ﬃ İ ı")).toBe(
      "strasse σσ ffi i\u0307 ı",
    );
  });
});
