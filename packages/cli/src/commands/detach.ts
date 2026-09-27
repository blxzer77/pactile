import chalk from "chalk";
import {
  PactileExitManager,
  type DetachApplyResult,
  type DetachPlan,
} from "../pactile/exit/service.js";
import {
  homedirBypassEnabled,
  homedirGuardMessage,
  isCwdHomedir,
} from "../utils/cwd-guard.js";

export interface DetachOptions {
  readonly adapter: string;
  readonly dryRun?: boolean;
}

function adapterId(value: string): string {
  if (value === "codex" || value === "adapter.codex") return "adapter.codex";
  throw new Error(`Unsupported Adapter: ${value}`);
}

export function detach(options: DetachOptions): DetachPlan | DetachApplyResult {
  if (isCwdHomedir() && !homedirBypassEnabled())
    throw new Error(homedirGuardMessage("detach"));
  const id = adapterId(options.adapter);
  const manager = new PactileExitManager(process.cwd());
  const planned = manager.planDetach(id);
  if (planned.status !== "ready")
    throw new Error(`Cannot safely detach Adapter: ${planned.reason}`);

  if (options.dryRun) {
    console.log(chalk.bold("\nPactile Adapter detach preview\n"));
    console.log(`  Adapter: ${planned.adapterId}`);
    console.log(`  Decisions: ${planned.preview.decisions.length}`);
    console.log(`  Preview fingerprint: ${planned.previewFingerprint}`);
    console.log(chalk.gray("\nDry run — no files or state were modified."));
    return planned;
  }
  const result = manager.applyDetach(planned);
  if ("reason" in result)
    throw new Error(`Adapter detach stopped safely: ${result.reason}`);
  console.log(chalk.green(`Detached ${result.adapterId}.`));
  console.log(chalk.gray(`Exit receipt: ${result.receipt.fingerprint}`));
  return result;
}
