/** Uses the canonical Task Kernel equivalence rule for Run/workspace write sets. */
export function taskRunWorkspaceWriteSetsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalize = (values: readonly string[]): string[] =>
    values
      .map((value) => value.replaceAll("\\", "/").replace(/\/$/u, ""))
      .map((value) => (process.platform === "win32" ? value.toLowerCase() : value))
      .sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
