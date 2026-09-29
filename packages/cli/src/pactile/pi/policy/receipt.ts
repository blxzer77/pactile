import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PiRoleContract } from "./contract.js";

export interface PiRolePolicyReceipt {
  schemaVersion: 1;
  source: "pactile-pi-role-policy-v1";
  contractFingerprint: string;
  runtimeContractFingerprint?: string;
  authorityFingerprint: string;
  taskId: string;
  taskRunId: string | null;
  candidateSnapshotId: string | null;
  candidateFingerprint: string | null;
  role: PiRoleContract["role"];
  backend: PiRoleContract["backend"];
  assurance: "tool-call-policy" | "docker-process-filesystem-and-network";
  defaultCapabilities: true;
  evidenceLevel: "native-extension" | "rpc-fixture";
  attested: boolean;
  processId: number | null;
  containerId: string | null;
  capabilities?: { activeTools: string[]; configuredTools: string[]; skillCommands: string[]; extensionCommands: string[] };
  containerStop?: { stopped: boolean; removed: boolean; exitCode: number | null; stoppedAt: string | null; recordedAt: string };
  recordedAt: string;
}

export function piRolePolicyReceipt(contract: PiRoleContract, input: { attested: boolean; processId?: number; containerId?: string; simulation?: boolean; capabilities?: PiRolePolicyReceipt["capabilities"] }): PiRolePolicyReceipt {
  return {
    schemaVersion: 1, source: "pactile-pi-role-policy-v1", contractFingerprint: contract.fingerprint,
    authorityFingerprint: contract.authorityFingerprint, taskId: contract.taskId, taskRunId: contract.taskRunId,
    candidateSnapshotId: contract.candidateSnapshotId, candidateFingerprint: contract.candidateFingerprint, role: contract.role, backend: contract.backend,
    assurance: contract.backend === "docker" ? "docker-process-filesystem-and-network" : "tool-call-policy",
    defaultCapabilities: true, evidenceLevel: input.simulation ? "rpc-fixture" : "native-extension", attested: input.attested, processId: input.processId ?? null,
    containerId: input.containerId ?? null, recordedAt: new Date().toISOString(),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
  };
}

export function persistPiRolePolicyReceipt(file: string, receipt: PiRolePolicyReceipt): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
}
