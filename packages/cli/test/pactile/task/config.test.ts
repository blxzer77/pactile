import { describe, expect, it } from "vitest";
import {
  configBoolean,
  configCommitMessage,
  parseSimpleConfig,
} from "../../../src/pactile/task/config.js";

describe("configuration scalar contracts", () => {
  it.each(["true", "yes", "1", "on", "TRUE", "Yes", "On"])(
    "recognizes an explicit enabled spelling: %s",
    (value) => expect(configBoolean(parseSimpleConfig(`enabled: ${value}\n`).enabled, false)).toBe(true),
  );

  it.each(["false", "no", "0", "off", "FALSE", "No", "Off"])(
    "recognizes an explicit disabled spelling: %s",
    (value) => expect(configBoolean(parseSimpleConfig(`enabled: ${value}\n`).enabled, true)).toBe(false),
  );

  it("uses a safe default for missing, invalid or structured values", () => {
    expect(configBoolean(undefined, false)).toBe(false);
    expect(configBoolean("invalid", false)).toBe(false);
    expect(configBoolean({}, false)).toBe(false);
    expect(configBoolean([], false)).toBe(false);
    expect(configBoolean(undefined, true)).toBe(true);
  });

  it("keeps configured commit text and falls back for empty or structured values", () => {
    expect(configCommitMessage(" docs: record work ", "fallback")).toBe("docs: record work");
    expect(configCommitMessage(undefined, "fallback")).toBe("fallback");
    expect(configCommitMessage(" ", "fallback")).toBe("fallback");
    expect(configCommitMessage({}, "fallback")).toBe("fallback");
  });
});
