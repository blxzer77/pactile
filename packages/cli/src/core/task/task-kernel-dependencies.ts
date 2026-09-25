import { KernelError, requireNonEmptyString } from "./kernel-contract.js";
import { appendMutation, mutateTaskKernel } from "./task-kernel-store-v2.js";
import { fingerprintTaskValue, requireTaskId } from "./task-kernel-schema.js";
import {
  assertDependenciesResolvable,
  assertNoDependencyCycle,
  canonicalProjectRoot,
} from "./task-kernel-paths.js";
import type { AddTaskDependencyRequest, TaskKernelMutationResult } from "./task-kernel-types.js";

export function addTaskDependency(request: AddTaskDependencyRequest): TaskKernelMutationResult {
  const root = canonicalProjectRoot(request.root, request.cwd);
  const actor = requireNonEmptyString(request.actor, "actor");
  const dependencyId = requireTaskId(request.dependencyId, "dependencyId");
  const fingerprint = fingerprintTaskValue({ dependencyId });
  return mutateTaskKernel(root, request.taskDir, request.expectedRevision, actor, request.idempotencyKey, fingerprint, request.cwd, (current, dir) => {
    if (current.phase !== "define") throw new KernelError("INVALID_TRANSITION", "hard dependencies can be changed only while Task is in Define");
    if (dependencyId === current.identity.taskId) throw new KernelError("INVALID_REQUEST", "a Task cannot depend on itself");
    if (current.definition.dependencies.includes(dependencyId)) throw new KernelError("INVALID_REQUEST", `hard dependency already exists: ${dependencyId}`);
    assertDependenciesResolvable(root, current.identity.taskId, [dependencyId], dir);
    const dependencies = [...current.definition.dependencies, dependencyId];
    assertNoDependencyCycle(root, current.identity.taskId, dependencies, dir);
    const definition = { ...current.definition, dependencies };
    return appendMutation(current, actor, request.idempotencyKey, "task.dependency-added", dependencyId, fingerprint, { definition }, "Hard dependency added.");
  });
}
