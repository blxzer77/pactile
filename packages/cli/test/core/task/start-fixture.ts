import fs from "node:fs";
import path from "node:path";

import { applyKernelRecordGate, readKernel } from "../../../src/core/task/kernel-store.js";
import { startFingerprints } from "../../../src/core/task/start-authority.js";
import { artifactFingerprint, contractFingerprint, readStrategyContract, requiredGates } from "../../../src/core/task/strategy.js";
import type { PactileTaskRecord } from "../../../src/core/task/schema.js";

export function fixtureApproval(taskDir: string): Record<string, unknown> {
  const live = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")) as PactileTaskRecord;
  const fingerprints = startFingerprints(taskDir, live);
  return {
    schema_version: 1,
    transition: "start-execution",
    approved_at: new Date().toISOString(),
    approved_by: "user",
    assurance: "caller-asserted",
    task_id: live.id,
    approval_source: "test fixture caller assertion",
    contract_fingerprint: fingerprints.contractFingerprint,
    artifact_fingerprint: fingerprints.artifactFingerprint,
  };
}

export function fixturePlanningGates(taskDir: string): void {
  const live = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")) as PactileTaskRecord;
  const parsed = readStrategyContract(taskDir);
  if (!parsed.contract) throw new Error(`Incomplete Full fixture strategy: ${parsed.errors.join("; ")}`);
  for (const gate of requiredGates("start-execution", parsed.contract)) {
    const revision = readKernel({ taskDir }).kernel.revision;
    const record = {
      schema_version: 1,
      transition: "start-execution",
      gate,
      result: "PASS",
      reviewer: "test:planning-review",
      evidence: gate === "requirements-review" ? "prd.md#requirements" : "design.md#architecture",
      checked_at: new Date().toISOString(),
      contract_fingerprint: contractFingerprint(taskDir, live, parsed.contract),
      artifact_fingerprint: artifactFingerprint(taskDir, live, "start-execution", gate),
    };
    applyKernelRecordGate({ taskDir, expectedRevision: revision, actor: "test planning review",
      idempotencyKey: `test-gate:${gate}:r${revision}`, transition: "start-execution", gateName: gate,
      record, evidence: String(record.evidence) });
  }
}
