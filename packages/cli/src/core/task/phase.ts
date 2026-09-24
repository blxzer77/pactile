import type { PactileTaskRecord } from "./schema.js";

/**
 * Coarse-grained Pactile task phase derived from task status.
 *
 * This mapping is a **legacy machine alias** of {@link PactileTaskRecord.status}
 * (`plan` / `implement` / …). Humans and agents should use Kernel Phase
 * titles from `projectKernelSurface` (Open / Define / Approve / Execute /
 * Verify / Integrate? / Close) — not these names, and not `planning`.
 *
 * Mapping:
 *
 *   status              | phase
 *   --------------------|-----------
 *   planning            | plan
 *   in_progress         | implement
 *   review              | review
 *   completed | done    | completed
 *   <anything else>     | unknown
 */
export type PactileTaskPhase =
  | "plan"
  | "implement"
  | "review"
  | "completed"
  | "unknown";

/**
 * Infer the phase of a task from either its parsed record or its raw
 * status string. Accepts a record so callers that already have one don't
 * need to re-pluck `status` first.
 */
export function inferTaskPhase(
  recordOrStatus: PactileTaskRecord | string | null | undefined,
): PactileTaskPhase {
  const status =
    typeof recordOrStatus === "string"
      ? recordOrStatus
      : recordOrStatus?.status;
  switch (status) {
    case "planning":
      return "plan";
    case "in_progress":
      return "implement";
    case "review":
      return "review";
    case "completed":
    case "done":
      return "completed";
    default:
      return "unknown";
  }
}
