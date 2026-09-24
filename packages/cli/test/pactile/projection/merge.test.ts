import { describe, expect, it } from "vitest";
import {
  mergeJsonPointers,
  mergeTomlKeys,
} from "../../../src/pactile/projection/structured-merge.js";
import {
  inspectManagedBlock,
  mergeManagedBlock,
  patchManagedBlock,
} from "../../../src/pactile/projection/managed-block.js";

const block = (body: string) =>
  `<!-- PACTILE:START -->\n${body}\n<!-- PACTILE:END -->`;
describe("projection managed block spans", () => {
  it("preserves BOM, CRLF and every byte outside the block", () => {
    const before = "\ufeff# foreign\r\n\r\n",
      after = "\r\n\r\n# ending  \r\n";
    expect(
      mergeManagedBlock(
        before + block("old") + after,
        block("old"),
        block("new"),
      ),
    ).toEqual({ status: "merged", text: before + block("new") + after });
    expect(patchManagedBlock(before + block("old") + after, null)).toEqual({
      status: "merged",
      text: before + after,
    });
  });
  it.each([
    block("one") + block("two"),
    "<!-- PACTILE:START -->",
    "<!-- PACTILE:END -->",
    `<!-- PACTILE:START -->${block("nested")}<!-- PACTILE:END -->`,
    "<!-- PACTILE:END --><!-- PACTILE:START -->",
  ])("reviews ambiguous markers: %s", (current) => {
    expect(inspectManagedBlock(current).status).toBe("review");
    expect(mergeManagedBlock(current, null, block("new")).status).toBe(
      "review",
    );
  });
  it("does not overwrite user-owned block edits even while foreign text also changed", () => {
    expect(
      mergeManagedBlock("changed\n" + block("user"), block("old"), block("new"))
        .status,
    ).toBe("review");
  });
  it("is idempotent after insertion without trimming trailing foreign whitespace", () => {
    const first = mergeManagedBlock("user  \r\n\r\n", null, block("new"));
    expect(first.status).toBe("merged");
    if (first.status === "merged")
      expect(mergeManagedBlock(first.text, block("new"), block("new"))).toEqual(
        first,
      );
  });
  it("normalizes only inserted CRLF block bytes and stays idempotent", () => {
    const desired = block("new").replace(/\n/g, "\r\n");
    const first = mergeManagedBlock("foreign\r\n", null, desired);
    expect(first.status).toBe("merged");
    if (first.status === "merged")
      expect(mergeManagedBlock(first.text, desired, desired)).toEqual(first);
  });
});
describe("projection JSON pointer spans", () => {
  it("patches only owned values, preserving order, BOM, CRLF, unknown keys and prototype-like data", () => {
    const current =
      '\ufeff{\r\n  "__proto__" : {"keep":true}, "foreign" : [1,  2],\r\n "owned" : 1\r\n}\r\n';
    expect(
      mergeJsonPointers(current, '{"owned":1}', '{"owned":2}', ["/owned"]),
    ).toEqual({
      status: "merged",
      text: current.replace('"owned" : 1', '"owned" : 2'),
    });
  });
  it("inserts missing owned leaves without reserializing surrounding data", () => {
    const current = '{ "foreign" : true }\r\n';
    expect(mergeJsonPointers(current, null, '{"owned":2}', ["/owned"])).toEqual(
      { status: "merged", text: '{ "foreign" : true ,"owned":2}\r\n' },
    );
  });
  it("supports escaped pointer keys and stable semantic comparisons", () => {
    expect(
      mergeJsonPointers(
        '{"a/b":{"~x":1}}',
        '{"a/b":{"~x":1}}',
        '{"a/b":{"~x":2}}',
        ["/a~1b/~0x"],
      ),
    ).toEqual({ status: "merged", text: '{"a/b":{"~x":2}}' });
  });
  it.each([
    '{"owned":1,"owned":2}',
    '{"owned":1,"own\\u0065d":2}',
    '{"owned":1,}',
    '{"owned":01}',
    '{"owned":NaN}',
    '{"owned":1} trailing',
    '{"owned":1,"foreign":{"x":1,"x":2}}',
  ])("rejects invalid/duplicate documents", (current) => {
    expect(
      mergeJsonPointers(current, '{"owned":1}', '{"owned":2}', ["/owned"])
        .status,
    ).toBe("review");
  });
  it("reviews owned/foreign divergence, missing parents, array indices and overlapping claims", () => {
    expect(
      mergeJsonPointers(
        '{"owned":99,"foreign":3}',
        '{"owned":1}',
        '{"owned":2}',
        ["/owned"],
      ).status,
    ).toBe("review");
    expect(
      mergeJsonPointers("{}", null, '{"a":{"b":2}}', ["/a/b"]).status,
    ).toBe("review");
    expect(
      mergeJsonPointers('{"a":[1]}', '{"a":[1]}', '{"a":[2]}', ["/a/0"]).status,
    ).toBe("review");
    expect(
      mergeJsonPointers('{"a":{"b":1}}', null, '{"a":{"b":2}}', ["/a", "/a/b"])
        .status,
    ).toBe("review");
  });
});
describe("projection TOML span patches", () => {
  const owned = [{ table: ["tool", "pactile"], key: "enabled" }];
  const old = "[tool.pactile]\nenabled = false\n",
    next = "[tool.pactile]\nenabled = true\n";
  it.each([
    '"\\/"',
    '"\\uD800"',
    '"\\uDFFF"',
    '"\\uD83D\\uDE00"',
    '"\\U00110000"',
    '"\\x41"',
    '"\\q"',
    '"\u007f"',
    "'\u0001'",
    "'\u007f'",
    '["\\/"]',
  ])(
    "review F4 rejects TOML-invalid strings: %s",
    (value) => {
      const current = `foreign = ${value}\n${old}`;
      expect(mergeTomlKeys(current, old, next, owned).status).toBe("review");
    },
  );
  it.each([
    String.raw`"\u0000\b\t\n\f\r\"\\"`,
    '"\\U0001F600"',
    '"😀"',
    "'literal\\slash\tvalue'",
    "[\"\\u0061\", [true, 'literal',],]",
  ])("review F4 preserves valid TOML strings and arrays: %s", (value) => {
    const current = `foreign = ${value}\n${old}`;
    expect(mergeTomlKeys(current, old, next, owned)).toEqual({
      status: "merged",
      text: `foreign = ${value}\n${next}`,
    });
  });
  it.each(['"\ud800"', "'\udfff'"])(
    "review F4 rejects raw unpaired Unicode surrogates",
    (value) => {
      expect(
        mergeTomlKeys(`foreign = ${value}\n${old}`, old, next, owned).status,
      ).toBe("review");
    },
  );
  it("preserves foreign tables, comments, BOM, CRLF and spacing", () => {
    const current =
      '\ufeff# user\r\n[foreign]\r\nvalue = "a#b" # keep\r\n\r\n[tool.pactile] # keep table\r\nenabled  = false  # keep tail\r\n';
    expect(mergeTomlKeys(current, old, next, owned)).toEqual({
      status: "merged",
      text: current.replace("= false", "= true"),
    });
  });
  it("inserts a missing owned key/table without reordering foreign bytes", () => {
    const current = '# keep\r\n[foreign]\r\nvalue = "x"\r\n';
    expect(mergeTomlKeys(current, null, next, owned)).toEqual({
      status: "merged",
      text: current + next,
    });
  });
  it.each([
    "[tool.pactile]\nenabled = false\nenabled = true\n",
    "[tool.pactile]\nenabled = false\n[tool.pactile]\n",
    '[tool.pactile]\nenabled = "unterminated\n',
    "[[tool.pactile]]\nenabled = false\n",
    "[tool.pactile]\nenabled = { x = 1 }\n",
    "[tool.pactile]\nenabled = false trailing\n",
  ])("reviews malformed/ambiguous/unsupported syntax", (current) => {
    expect(mergeTomlKeys(current, old, next, owned).status).toBe("review");
  });
  it("does not overwrite an edited owned scalar", () => {
    expect(
      mergeTomlKeys(
        '[foreign]\nx = true\n[tool.pactile]\nenabled = "user"\n',
        old,
        next,
        owned,
      ).status,
    ).toBe("review");
  });
  it.each([
    "a = 1\n[a]\nx = false\n[tool.pactile]\nenabled = false\n",
    "[a]\nb = false\n[a.b]\nx = 1\n[tool.pactile]\nenabled = false\n",
    "invalid = 01\n[tool.pactile]\nenabled = false\n",
    "invalid = [null]\n[tool.pactile]\nenabled = false\n",
  ])("rejects TOML namespace/type invalidity before patching", (current) => {
    expect(mergeTomlKeys(current, old, next, owned).status).toBe("review");
  });
});
