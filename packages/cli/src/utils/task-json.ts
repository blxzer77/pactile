/**
 * Canonical task.json shape — single source of truth shared by all TS
 * writers. The canonical types and factory now live in the
 * `@blxzer/pactile/core/task` API; this module re-exports them under
 * the legacy `TaskJson` / `emptyTaskJson` names for CLI call sites.
 *
 * New code should prefer `PactileTaskRecord` / `emptyTaskRecord` from
 * `@blxzer/pactile/core/task` directly.
 */

import {
  emptyTaskRecord,
  type PactileTaskRecord,
} from "../core/task/index.js";

export type TaskJson = PactileTaskRecord;

export const emptyTaskJson = emptyTaskRecord;
