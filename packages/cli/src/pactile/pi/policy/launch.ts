import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PiRpcClient, PiRpcLaunch } from "../rpc.js";
import { assertPiRoleContract, type PiRoleContract } from "./contract.js";
import { PI_POLICY_PROOF_SOURCE } from "./extension.js";
import { piRolePolicyReceipt, type PiRolePolicyReceipt } from "./receipt.js";

export interface PiGuardedLaunch {
  launch: PiRpcLaunch;
  env: NodeJS.ProcessEnv;
  contractFile: string;
  contract: PiRoleContract;
  readinessProbeRetryMs?: number;
  shutdownGraceMs?: number;
}

export function prepareNativePiRoleLaunch(contract: PiRoleContract, controlDir: string, launch?: PiRpcLaunch): PiGuardedLaunch {
  assertPiRoleContract(contract);
  fs.mkdirSync(controlDir, { recursive: true });
  const file = path.join(controlDir, "active-contract.json");
  const temporary = `${file}.${contract.id}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
  let extension = fileURLToPath(new URL("./extension.js", import.meta.url));
  if (!fs.existsSync(extension)) extension = fileURLToPath(new URL("../../../../dist/pactile/pi/policy/extension.js", import.meta.url));
  if (!fs.existsSync(extension)) throw new Error("Pi role extension is not built; cannot dispatch an unguarded worker");
  const guarded = launch ? { command: launch.command, args: [...launch.args, "--extension", extension] }
    : process.platform === "win32"
      ? { command: "pi.cmd", args: ["--mode", "rpc", "--extension", extension] }
      : { command: "pi", args: ["--mode", "rpc", "--extension", extension] };
  const taskSkills = path.resolve(contract.reads[1].path, "..", "..", "..", ".agents", "skills");
  if (fs.statSync(taskSkills, { throwIfNoEntry: false })?.isDirectory() && contract.cwd !== path.resolve(taskSkills, "..", ".."))
    guarded.args.push("--skill", taskSkills);
  return { launch: guarded, contract, contractFile: file, env: {
    PACTILE_PI_ROLE_CONTRACT: file, PACTILE_PI_ROLE_FINGERPRINT: contract.fingerprint,
  } };
}

export async function attestPiRolePolicy(client: PiRpcClient, contract: PiRoleContract, timeoutMs: number): Promise<PiRolePolicyReceipt> {
  const nonce = randomBytes(32).toString("hex");
  let resolve!: (pid: number) => void;
  let reject!: (error: Error) => void;
  let simulation = false;
  let capabilities: PiRolePolicyReceipt["capabilities"];
  const proof = new Promise<number>((done, failed) => { resolve = done; reject = failed; });
  void proof.catch(() => undefined);
  const timer = setTimeout(() => reject(new Error("Pi role policy did not attest; worker prompt blocked")), Math.max(1, timeoutMs));
  const detach = client.onEvent((event) => {
    if (event.type === "transport_error") return reject(new Error("Pi role policy transport failed before attestation"));
    if (event.type !== "extension_ui_request" || event.method !== "notify" || typeof event.message !== "string") return;
    let value: Record<string, unknown>;
    try { value = JSON.parse(event.message) as Record<string, unknown>; } catch { return; }
    if (value.source !== PI_POLICY_PROOF_SOURCE || value.nonce !== nonce) return;
    if (value.fingerprint !== contract.fingerprint || value.role !== contract.role || value.backend !== contract.backend || value.defaultCapabilities !== true || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1)
      return reject(new Error("Pi role policy proof does not match the admitted contract"));
    simulation = value.simulation === true;
    if (value.capabilities && typeof value.capabilities === "object") {
      const facts = value.capabilities as Record<string, unknown>;
      const keys = ["activeTools", "configuredTools", "skillCommands", "extensionCommands"] as const;
      if (!keys.every((key) => Array.isArray(facts[key]) && facts[key].every((item) => typeof item === "string"))) return reject(new Error("Pi capability observation is malformed"));
      capabilities = facts as PiRolePolicyReceipt["capabilities"];
    } else if (!simulation) return reject(new Error("Pi role policy did not observe its loaded capabilities"));
    resolve(Number(value.pid));
  });
  try {
    await client.request("prompt", { message: `/pactile-role-policy ${nonce} ${contract.fingerprint}` }, timeoutMs);
    const pid = await proof;
    return piRolePolicyReceipt(contract, { attested: true, processId: pid, simulation, capabilities });
  } finally { clearTimeout(timer); detach(); }
}
