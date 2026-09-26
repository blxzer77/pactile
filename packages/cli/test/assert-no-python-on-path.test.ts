import { describe, expect, it } from "vitest";

import { assertNoPythonOnPath } from "../scripts/assert-no-python-on-path.js";

describe("assertNoPythonOnPath", () => {
  it("checks all supported Python command names against the supplied PATH", () => {
    const commands: string[] = [];
    const notFound = (command: string) => {
      commands.push(command);
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return { error };
    };

    expect(() =>
      assertNoPythonOnPath({
        cwd: process.cwd(),
        env: { PATH: "node-only-path" },
        probe: notFound,
      }),
    ).not.toThrow();
    expect(commands).toEqual([
      "python",
      "python.exe",
      "python3",
      "python3.exe",
      "py",
      "py.exe",
    ]);
  });

  it("fails closed when a Python command is available", () => {
    const probe = (command: string) => {
      if (command === "python3") return { error: null };
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return { error };
    };

    expect(() =>
      assertNoPythonOnPath({
        cwd: process.cwd(),
        env: { PATH: "node-only-path" },
        probe,
      }),
    ).toThrow("Python command is available on the conformance PATH: python3");
  });
});
