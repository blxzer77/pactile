import { describe, expect, it } from "vitest";

import { buildReleaseCandidatePlan } from "../scripts/release.js";

describe("release candidate usage", () => {
  it("points to current pnpm release scripts and the authorized tag workflow", () => {
    let message = "";
    try {
      buildReleaseCandidatePlan({
        type: "invalid-release-type",
        packageInfo: {
          cliName: "@blxzer/pactile",
          cliVersion: "0.6.0-beta.2",
        },
        git: { branch: "develop", head: "test-head", remote: "private" },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("pnpm --filter @blxzer/pactile run release:beta");
    expect(message).toContain(
      "pnpm --filter @blxzer/pactile run release:promote",
    );
    expect(message).toContain("docs/governance/releasing.md");
    expect(message).not.toContain("release.js");
  });
});
