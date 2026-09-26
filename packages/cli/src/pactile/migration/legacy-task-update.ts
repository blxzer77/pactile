/** Automatic, repeatable legacy Task upgrade hook used by `pactile update`. */

import {
  buildLegacyTaskV2Import,
  type LegacyTaskV2ImportSummary,
} from "../../core/task/legacy-task-v2-import.js";
import {
  scanLegacyTaskMigration,
  type LegacyTaskMigrationPlan,
} from "../../core/task/legacy-task-migration.js";
import { assertLegacyTaskMigrationAuthorityOrCleanStore } from "../../core/task/legacy-task-migration-reader.js";
import { assertLegacyTaskKernelMigrationOverlaysIntact } from "../../core/task/task-kernel-store-v2.js";
import {
  canResumeLegacyTaskBatchWithoutAuthority,
  legacyTaskBatchTaskIdConflict,
  readPreparedLegacyTaskBatch,
  runLegacyTaskBatch,
  type LegacyTaskBatchResult,
} from "./legacy-task-batch.js";

export type LegacyTaskUpdateStatus =
  | "none"
  | "ready"
  | "completed"
  | "already-active"
  | "active-source-drift"
  | "blocked"
  | "interrupted";

export interface LegacyTaskUpdateInspection {
  readonly status: LegacyTaskUpdateStatus;
  readonly plan: LegacyTaskMigrationPlan;
  readonly import: LegacyTaskV2ImportSummary;
  readonly activeBatchId: string | null;
  readonly reason: string | null;
}

export interface LegacyTaskUpdateApplyResult extends LegacyTaskUpdateInspection {
  readonly batchResult: LegacyTaskBatchResult | null;
}

function inspectWithCurrentSource(
  projectRoot: string,
): LegacyTaskUpdateInspection {
  const active = readPreparedLegacyTaskBatch(projectRoot);
  const plan = scanLegacyTaskMigration({ projectRoot });
  const imported = buildLegacyTaskV2Import(plan);
  if (!active) {
    try {
      assertLegacyTaskMigrationAuthorityOrCleanStore(projectRoot);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (
        reason !==
          "legacy-task-migration-authority-missing-with-residual-state" ||
        !canResumeLegacyTaskBatchWithoutAuthority({
          projectRoot,
          plan,
          targets: imported.targets,
        })
      ) throw error;
    }
  }
  if (active) assertLegacyTaskKernelMigrationOverlaysIntact(projectRoot);
  if (!active) {
    const taskIdConflict = legacyTaskBatchTaskIdConflict(projectRoot, imported.targets);
    if (taskIdConflict) {
      return {
        status: "blocked",
        plan,
        import: imported,
        activeBatchId: null,
        reason: taskIdConflict,
      };
    }
  }
  if (active) {
    if (
      plan.preflight.status !== "clear-to-review" ||
      plan.sourceFingerprint !== active.sourceFingerprint
    ) {
      return {
        status: "active-source-drift",
        plan,
        import: imported,
        activeBatchId: active.batchId,
        reason: "legacy-source-changed-after-task-import",
      };
    }
    return {
      status: "already-active",
      plan,
      import: imported,
      activeBatchId: active.batchId,
      reason: null,
    };
  }
  if (plan.preflight.status === "blocked") {
    return {
      status: "blocked",
      plan,
      import: imported,
      activeBatchId: null,
      reason: "legacy-task-preflight-blocked",
    };
  }
  if (!plan.tasks.length || !imported.targets.length) {
    return {
      status: "none",
      plan,
      import: imported,
      activeBatchId: null,
      reason: null,
    };
  }
  return {
    status: "ready",
    plan,
    import: imported,
    activeBatchId: null,
    reason: null,
  };
}

export function inspectLegacyTaskUpdate(
  projectRoot: string,
): LegacyTaskUpdateInspection {
  try {
    return inspectWithCurrentSource(projectRoot);
  } catch (error) {
    const plan = scanLegacyTaskMigration({ projectRoot });
    return {
      status: "blocked",
      plan,
      import: buildLegacyTaskV2Import(plan),
      activeBatchId: null,
      reason:
        error instanceof Error
          ? error.message
          : "legacy-task-inspection-failed",
    };
  }
}

/** Re-scan immediately before writing, then let the batch journal recheck source bytes and CAS. */
export async function applyLegacyTaskUpdate(
  projectRoot: string,
): Promise<LegacyTaskUpdateApplyResult> {
  let inspection: LegacyTaskUpdateInspection;
  try {
    inspection = inspectWithCurrentSource(projectRoot);
  } catch (error) {
    const plan = scanLegacyTaskMigration({ projectRoot });
    return {
      status: "blocked",
      plan,
      import: buildLegacyTaskV2Import(plan),
      activeBatchId: null,
      reason:
        error instanceof Error
          ? error.message
          : "legacy-task-inspection-failed",
      batchResult: null,
    };
  }
  if (inspection.status !== "ready") {
    return { ...inspection, batchResult: null };
  }
  const batchResult = await runLegacyTaskBatch(
    {
      projectRoot,
      plan: inspection.plan,
      targets: inspection.import.targets,
    },
    { approved: true },
  );
  if (batchResult.status === "completed") {
    return {
      ...inspection,
      status: "completed",
      activeBatchId: batchResult.batchId,
      reason: null,
      batchResult,
    };
  }
  if (
    inspection.activeBatchId &&
    batchResult.status === "review" &&
    batchResult.reason === "migration-authority-already-committed"
  ) {
    return {
      ...inspection,
      status: "already-active",
      reason: batchResult.reason,
      batchResult,
    };
  }
  return {
    ...inspection,
    status: batchResult.status === "interrupted" ? "interrupted" : "blocked",
    reason:
      batchResult.status === "blocked" ||
      batchResult.status === "review" ||
      batchResult.status === "interrupted"
        ? batchResult.reason
        : "legacy-task-migration-failed",
    batchResult,
  };
}
