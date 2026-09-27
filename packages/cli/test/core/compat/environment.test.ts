import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PACTILE_ENVIRONMENT_KEYS,
  readPactileEnvironment,
  resetPactileEnvironmentWarningsForTest,
  writePactileEnvironment,
} from "../../../src/core/compat/index.js";

describe("Pactile environment compatibility", () => {
  beforeEach(() => resetPactileEnvironmentWarningsForTest());

  it("prefers the canonical key and emits no diagnostic", () => {
    const report = vi.fn();
    const value = readPactileEnvironment(PACTILE_ENVIRONMENT_KEYS.debug, {
      env: {
        PACTILE_DEBUG: "canonical",
        CSTL_DEBUG: "older",
        TRELLIS_DEBUG: "oldest",
      },
      report,
    });

    expect(value).toBe("canonical");
    expect(report).not.toHaveBeenCalled();
  });

  it("reads an inventoried legacy key and reports names without its value", () => {
    const report = vi.fn();
    const secretLikeValue = "do-not-print-this-value";
    const value = readPactileEnvironment(
      PACTILE_ENVIRONMENT_KEYS.pythonCommand,
      {
        env: { TRELLIS_PYTHON_CMD: secretLikeValue },
        report,
      },
    );

    expect(value).toBe(secretLikeValue);
    expect(report).toHaveBeenCalledWith({
      code: "legacy-environment-read",
      canonicalKey: "PACTILE_PYTHON_CMD",
      legacyKey: "TRELLIS_PYTHON_CMD",
      compatibilityWindow: "0.5.x",
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain(secretLikeValue);
  });

  it("warns once per legacy key by default", () => {
    const report = vi.fn();
    const options = { env: { CSTL_DEBUG: "1" }, report };

    expect(readPactileEnvironment(PACTILE_ENVIRONMENT_KEYS.debug, options)).toBe(
      "1",
    );
    expect(readPactileEnvironment(PACTILE_ENVIRONMENT_KEYS.debug, options)).toBe(
      "1",
    );
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("writes only the canonical key", () => {
    const env: Record<string, string | undefined> = {};
    writePactileEnvironment(PACTILE_ENVIRONMENT_KEYS.channelProject, "demo", env);

    expect(env).toEqual({ PACTILE_CHANNEL_PROJECT: "demo" });
  });
});
