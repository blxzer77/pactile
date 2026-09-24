/**
 * Task directory naming.
 *
 * User-created task dirs follow the `MM-DD-slug` pattern produced by
 * `.pactile/scripts/common/task_store.py::cmd_create`:
 *
 *     <tasks-dir>/05-13-pactile-core-sdk-package/
 *
 * Pactile also creates system onboarding tasks during `pactile init` using a
 * `00-slug` prefix, such as `00-bootstrap-guidelines` and `00-join-new-developer`.
 *
 * `MM` is the two-digit month, `DD` is the two-digit day, and `slug` is
 * a lower-kebab-case identifier composed of `[a-z0-9-]+` characters.
 */

const DATED_TASK_DIR_RE =
  /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const SYSTEM_TASK_DIR_RE =
  /^00-(bootstrap-guidelines|join-[a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface TaskDirParts {
  /**
   * The directory prefix. Dated tasks use `MM-DD`; Pactile system onboarding
   * tasks use `00`.
   */
  prefix: string;
  /** Two-digit month for dated tasks, or `null` for `00-*` system tasks. */
  month: string | null;
  /** Two-digit day for dated tasks, or `null` for `00-*` system tasks. */
  day: string | null;
  slug: string;
}

/**
 * Validate a task directory base name (no slashes). Returns the parsed
 * components when valid, or `null` when the name does not match a canonical
 * task dir shape.
 *
 * Throws `TypeError` if `name` is not a string — guards downstream code
 * from accidentally validating `Buffer`, `Path`, or other inputs.
 */
export function validateTaskDirName(name: string): TaskDirParts | null {
  if (typeof name !== "string") {
    throw new TypeError("task directory name must be a string");
  }
  const dated = DATED_TASK_DIR_RE.exec(name);
  if (dated) {
    const [, month, day, slug] = dated;
    if (month === undefined || day === undefined || slug === undefined) {
      return null;
    }
    return { prefix: `${month}-${day}`, month, day, slug };
  }

  const system = SYSTEM_TASK_DIR_RE.exec(name);
  if (system) {
    const [, slug] = system;
    if (slug === undefined) return null;
    return { prefix: "00", month: null, day: null, slug };
  }

  return null;
}

export function isValidTaskDirName(name: string): boolean {
  return validateTaskDirName(name) !== null;
}
