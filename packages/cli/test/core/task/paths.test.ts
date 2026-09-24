import { describe, expect, it } from "vitest";

import {
  isValidTaskDirName,
  validateTaskDirName,
} from "../../../src/core/task/index.js";

describe("validateTaskDirName", () => {
  it("accepts canonical MM-DD-slug names", () => {
    expect(validateTaskDirName("05-13-pactile-core-sdk-package")).toEqual({
      prefix: "05-13",
      month: "05",
      day: "13",
      slug: "pactile-core-sdk-package",
    });
    expect(validateTaskDirName("01-01-x")).toEqual({
      prefix: "01-01",
      month: "01",
      day: "01",
      slug: "x",
    });
  });

  it("accepts Pactile system onboarding task names", () => {
    expect(validateTaskDirName("00-bootstrap-guidelines")).toEqual({
      prefix: "00",
      month: null,
      day: null,
      slug: "bootstrap-guidelines",
    });
    expect(validateTaskDirName("00-join-new-developer")).toEqual({
      prefix: "00",
      month: null,
      day: null,
      slug: "join-new-developer",
    });
  });

  it("rejects invalid months and days", () => {
    expect(validateTaskDirName("13-01-foo")).toBeNull();
    expect(validateTaskDirName("00-15-foo")).toBeNull();
    expect(validateTaskDirName("02-32-foo")).toBeNull();
    expect(validateTaskDirName("02-00-foo")).toBeNull();
  });

  it("rejects malformed slugs and prefixes", () => {
    expect(validateTaskDirName("5-13-foo")).toBeNull();
    expect(validateTaskDirName("05-13-Foo")).toBeNull();
    expect(validateTaskDirName("05-13-")).toBeNull();
    expect(validateTaskDirName("05-13-foo-")).toBeNull();
    expect(validateTaskDirName("05-13--foo")).toBeNull();
    expect(validateTaskDirName("00-Join-New-Developer")).toBeNull();
    expect(validateTaskDirName("00-join-")).toBeNull();
    expect(validateTaskDirName("00-join--new-developer")).toBeNull();
    expect(validateTaskDirName("foo-bar")).toBeNull();
    expect(validateTaskDirName("")).toBeNull();
  });

  it("isValidTaskDirName mirrors validateTaskDirName truthiness", () => {
    expect(isValidTaskDirName("05-13-foo")).toBe(true);
    expect(isValidTaskDirName("bad")).toBe(false);
  });

  it("throws on non-string input", () => {
    // @ts-expect-error - runtime guard
    expect(() => validateTaskDirName(undefined)).toThrow(TypeError);
    // @ts-expect-error - runtime guard
    expect(() => validateTaskDirName(123)).toThrow(TypeError);
  });
});
