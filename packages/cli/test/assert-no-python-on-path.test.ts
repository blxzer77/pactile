import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertNoPythonOrPiOnPath,
  BLOCKED_NODE_ONLY_PATH_EXECUTABLES,
} from "../scripts/assert-no-python-on-path.js";

describe("assertNoPythonOrPiOnPath", () => {
  it("checks the supported Python and Pi executable names in every PATH folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pactile-node-only-path-"));
    try {
      for (const executable of BLOCKED_NODE_ONLY_PATH_EXECUTABLES) {
        const folder = path.join(root, executable);
        fs.mkdirSync(folder);
        expect(() =>
          assertNoPythonOrPiOnPath({ env: { PATH: folder } }),
        ).not.toThrow();
        fs.writeFileSync(path.join(folder, executable), "fixture\n");
        expect(() =>
          assertNoPythonOrPiOnPath({ env: { PATH: folder } }),
        ).toThrow(/Node-only conformance PATH contains Python or Pi executables/);
        fs.rmSync(folder, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
