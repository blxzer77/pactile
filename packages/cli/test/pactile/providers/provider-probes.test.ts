import { describe, expect, it } from "vitest";
import {
  PACTILE_PROVIDER_PROBE_IDS,
  runProviderProbeMatrix,
  type PactileProviderProbeId,
  type ProviderProbeRunnerResult,
} from "../../../src/pactile/providers/probes.js";

describe("provider probe matrix public seam", () => {
  it("normalizes active providers across ready/degraded/unavailable/stale and drops raw secret output", async () => {
    const now = "2026-09-10T00:00:00.000Z";
    const cases: Record<PactileProviderProbeId, ProviderProbeRunnerResult> = {
      rg: { exitCode: 0, observedAt: now, capabilityAvailable: true },
      "codex-explorer": {
        exitCode: 127,
        observedAt: now,
        stderr: "TOKEN=canary-super-secret C:\\Users\\private\\state.json",
      },
      codegraph: {
        exitCode: 0,
        observedAt: "2026-09-09T22:00:00.000Z",
        stdout: "oauth_state=canary-state",
      },
      "fast-context": { exitCode: 0, observedAt: now, capabilityAvailable: false },
      "smart-search": {
        exitCode: 0,
        observedAt: now,
        stdout: "PASSWORD=canary-password",
        stderr: "secret bearer canary-bearer",
      },
    };
    const result = await runProviderProbeMatrix(
      { providerIds: [...PACTILE_PROVIDER_PROBE_IDS].reverse() },
      {
        now: () => now,
        run: ({ providerId }) => cases[providerId],
      },
    );
    expect(result.ok).toBe(true);
    expect(result.probes.map(({ providerId }) => providerId)).toEqual([
      "codegraph",
      "codex-explorer",
      "fast-context",
      "rg",
      "smart-search",
    ]);
    expect(
      Object.fromEntries(result.probes.map(({ providerId, status }) => [providerId, status])),
    ).toEqual({
      codegraph: "stale",
      "codex-explorer": "unavailable",
      "fast-context": "degraded",
      rg: "ready",
      "smart-search": "ready",
    });
    expect(result.runtimeFacts).toEqual(
      result.probes.map(({ runtimeFact }) => runtimeFact),
    );
    expect(
      result.runtimeFacts.every(
        ({ providerVersion, evidenceRefs }) =>
          providerVersion === "1.0.0" &&
          evidenceRefs.every((ref) => /^evidence:\/\/probe\/[a-z0-9-]+\/(passed|failed)$/.test(ref)),
      ),
    ).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/canary|password|secret|bearer|oauth|token/i);
    expect(serialized).not.toContain("C:\\\\Users");
  });
});
