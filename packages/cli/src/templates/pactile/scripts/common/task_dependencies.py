#!/usr/bin/env python3
"""
Task-level depends_on resolution (Plan A: declare + soft checks).

Pure functions only: no task.json writes, no CLI, no repository state changes.
Consumers: start-execution --check warnings (task_gates), dashboard summary
(task_dashboard), set-deps dangling warnings (task_store).

Semantics per adjudication 08-09-depends-on-generalize-research (Plan A):
- Bare ids resolve in scope order: same-Parent task-map children first, then
  global task dirs (.pactile/tasks/<id>, then archive/<month>/<id>).
- Task-level satisfaction: status `completed` (archive counts as completed)
  or `cancelled`. Child-level satisfaction: task-map state in
  PARENT_TERMINAL_STATES (integrated | cancelled). Everything else is
  NOT_SATISFIED.
- Cycles and dangling refs are warning-level only in Plan A; nothing here
  blocks a transition.
- Plan B (opt-in `meta.depends_mode: block`) promotes NOT_SATISFIED /
  UNRESOLVED / cycles to errors at mutation gates via DependencyReport.
  blocking_errors() (never SATISFIED+cancelled); the policy itself lives in
  task_gates / task_store. read_depends_mode() resolves the task-level mode.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .io import read_json
from .paths import get_repo_root, get_tasks_dir
from .task_map import PARENT_TERMINAL_STATES

SATISFIED = "SATISFIED"
NOT_SATISFIED = "NOT_SATISFIED"
UNRESOLVED = "UNRESOLVED"

TASK_SATISFIED_STATUSES = {"completed", "cancelled"}

MAX_GRAPH_NODES = 50

# Kinds of a resolved dependency reference.
KIND_TASK = "task"
KIND_CHILD = "child"
KIND_MISSING = "missing"

# Where a resolved dependency came from (display annotation).
SOURCE_TASK_JSON = "task.json"
SOURCE_TASK_MAP = "task-map"
SOURCE_ARCHIVE = "archive"

# Plan B: meta.depends_mode values (missing / invalid -> warn = Plan A).
DEPENDS_MODE_DEFAULT = "warn"
DEPENDS_MODES = ("warn", "block", "off")

# Cap for meta.depends_ignore_events (append-only, FIFO drop oldest).
MAX_IGNORE_EVENTS = 20


def read_depends_mode(task_data: object) -> str:
    """Resolve meta.depends_mode -> warn|block|off.

    Missing key, null, non-dict meta, or an invalid value all fall back to
    ``warn`` so Plan B is strictly opt-in and never changes Plan A behavior.
    """
    if not isinstance(task_data, dict):
        return DEPENDS_MODE_DEFAULT
    meta = task_data.get("meta")
    if not isinstance(meta, dict):
        return DEPENDS_MODE_DEFAULT
    mode = meta.get("depends_mode")
    if mode in DEPENDS_MODES:
        return mode
    return DEPENDS_MODE_DEFAULT


@dataclass
class ResolvedDep:
    """One declared dependency, resolved as far as Plan A can go."""

    ref: str
    kind: str
    source: str | None = None
    task_dir: Path | None = None
    status: str | None = None
    note: str | None = None

    @property
    def is_cancelled(self) -> bool:
        return self.kind in (KIND_TASK, KIND_CHILD) and self.status == "cancelled"

    @property
    def is_archived(self) -> bool:
        return self.source == SOURCE_ARCHIVE


@dataclass
class DependencyReport:
    """Resolved dependencies plus task-level graph cycles for one task."""

    task_id: str
    deps: list[ResolvedDep] = field(default_factory=list)
    cycles: list[list[str]] = field(default_factory=list)

    def has_deps(self) -> bool:
        return bool(self.deps)

    def warnings(self) -> list[str]:
        """Warning strings for start-execution --check (never errors)."""
        warnings: list[str] = []
        for dep in self.deps:
            status, note = satisfaction_status(dep)
            if status == NOT_SATISFIED:
                warnings.append(
                    f"dependency not satisfied: {dep.ref} ({note})"
                )
            elif status == UNRESOLVED:
                warnings.append(_unresolved_issue_text(dep, note))
            elif dep.is_cancelled:
                warnings.append(
                    f"dependency cancelled: {dep.ref} ({note})"
                )
        for cycle in self.cycles:
            warnings.append(f"dependency cycle detected: {' -> '.join(cycle)}")
        return warnings

    def blocking_errors(self) -> list[str]:
        """Errors for block-mode mutation gates (Plan B).

        NOT_SATISFIED / UNRESOLVED (dangling) / cycles all block;
        SATISFIED deps, including cancelled ones, never block. Every returned
        string is also produced by warnings(), so the blocking set is always
        a subset of the warning set for the same report (T14 invariant).
        """
        errors: list[str] = []
        for dep in self.deps:
            status, note = satisfaction_status(dep)
            if status == NOT_SATISFIED:
                errors.append(
                    f"dependency not satisfied: {dep.ref} ({note})"
                )
            elif status == UNRESOLVED:
                errors.append(_unresolved_issue_text(dep, note))
        for cycle in self.cycles:
            errors.append(f"dependency cycle detected: {' -> '.join(cycle)}")
        return errors

    def summary_parts(self) -> list[str]:
        """Compact per-dep badge strings for the dashboard line."""
        parts: list[str] = []
        for dep in self.deps:
            status, _ = satisfaction_status(dep)
            badge = {
                SATISFIED: "✅",
                NOT_SATISFIED: "⏳",
                UNRESOLVED: "⚠️",
            }[status]
            if dep.is_cancelled:
                badge += "已取消"
            parts.append(f"{dep.ref} {badge}")
        return parts

    def sources(self) -> list[str]:
        """Distinct source annotations, e.g. [task.json, task-map]."""
        seen: list[str] = []
        for dep in self.deps:
            if dep.source and dep.source not in seen:
                seen.append(dep.source)
        return seen


def _unresolved_issue_text(dep: ResolvedDep, note: str | None) -> str:
    """Shared text for UNRESOLVED deps (same wording in warnings and errors)."""
    return f"dangling dependency: {dep.ref} ({note})"


def normalize_dep_list(raw: object) -> list[str]:
    """Normalize a declared depends_on value to a list of non-empty strings."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            continue
        value = item.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized


def satisfaction_status(dep: ResolvedDep) -> tuple[str, str | None]:
    """Return (SATISFIED | NOT_SATISFIED | UNRESOLVED, note_or_None).

    - missing -> UNRESOLVED (dangling; Plan A warns, never errors).
    - task: completed (archive counts as completed) or cancelled -> SATISFIED.
    - child: integrated or cancelled (PARENT_TERMINAL_STATES) -> SATISFIED.
    """
    if dep.kind == KIND_MISSING:
        return (
            UNRESOLVED,
            f"no task or child with id {dep.ref!r} under tasks/ or archive/",
        )

    if dep.kind == KIND_CHILD:
        if dep.status in PARENT_TERMINAL_STATES:
            note = "dependency cancelled" if dep.is_cancelled else None
            return SATISFIED, note
        return (
            NOT_SATISFIED,
            f"state={dep.status!r}, need integrated or cancelled",
        )

    if dep.kind == KIND_TASK and dep.is_archived:
        return SATISFIED, "archived task counts as completed"

    if dep.status in TASK_SATISFIED_STATUSES:
        note = "dependency cancelled" if dep.is_cancelled else None
        return SATISFIED, note
    return (
        NOT_SATISFIED,
        f"status={dep.status!r}, need completed or cancelled",
    )


def find_dependency_cycles(graph: dict[str, list[str]]) -> list[list[str]]:
    """Return simple cycles in a task-level dependency graph.

    Each cycle is a list of node ids in dependency order, e.g.
    ["task-a", "task-b", "task-a"]. Nodes with no outgoing edges are leaves.
    """
    cycles: list[list[str]] = []
    visited: set[str] = set()
    path: list[str] = []
    path_set: set[str] = set()

    def dfs(node: str) -> None:
        visited.add(node)
        path.append(node)
        path_set.add(node)
        for neighbor in graph.get(node, []):
            if neighbor in path_set:
                start = path.index(neighbor)
                cycle = path[start:] + [neighbor]
                if not _has_same_cycle(cycles, cycle):
                    cycles.append(cycle)
            elif neighbor not in visited:
                dfs(neighbor)
        path.pop()
        path_set.discard(node)

    for node in sorted(graph):
        if node not in visited:
            dfs(node)
    return cycles


def _has_same_cycle(cycles: list[list[str]], candidate: list[str]) -> bool:
    """True when candidate is the same directed cycle as an existing one.

    Comparison is rotation-agnostic: ["a","b","a"] == ["b","a","b"].
    """
    for cycle in cycles:
        if len(cycle) != len(candidate):
            continue
        double = cycle + cycle
        for start in range(len(cycle)):
            if all(
                double[start + i] == candidate[i]
                for i in range(len(candidate))
            ):
                return True
    return False


def resolve_dep_ref(
    ref: str,
    *,
    repo_root: Path | None = None,
    tasks_dir: Path | None = None,
    scope_children: dict[str, str] | None = None,
) -> ResolvedDep:
    """Resolve one declared dependency reference (pure, read-only).

    Scope order: same-Parent task-map children -> global task dirs ->
    archive dirs -> missing.
    """
    value = ref.strip()
    if not value:
        return ResolvedDep(ref=ref, kind=KIND_MISSING)

    if scope_children and value in scope_children:
        state = scope_children.get(value)
        return ResolvedDep(
            ref=value,
            kind=KIND_CHILD,
            source=SOURCE_TASK_MAP,
            status=state if isinstance(state, str) else None,
        )

    if tasks_dir is None:
        if repo_root is None:
            repo_root = get_repo_root()
        tasks_dir = get_tasks_dir(repo_root)

    task_dir = _find_task_dir(value, tasks_dir)
    if task_dir is not None:
        data = read_json(task_dir / "task.json") or {}
        source = (
            SOURCE_ARCHIVE if _is_under_archive(task_dir, tasks_dir) else SOURCE_TASK_JSON
        )
        return ResolvedDep(
            ref=value,
            kind=KIND_TASK,
            source=source,
            task_dir=task_dir,
            status=data.get("status"),
        )

    return ResolvedDep(ref=value, kind=KIND_MISSING)


def _find_task_dir(ref: str, tasks_dir: Path) -> Path | None:
    """Exact dir-name match first, then suffix match, then archive dirs."""
    candidates = [tasks_dir / ref]
    if tasks_dir.is_dir():
        for d in sorted(tasks_dir.iterdir()):
            if d.is_dir() and d.name != "archive" and d.name.endswith(f"-{ref}"):
                candidates.append(d)
    archive_root = tasks_dir / "archive"
    if archive_root.is_dir():
        for month_dir in sorted(archive_root.iterdir()):
            if not month_dir.is_dir():
                continue
            candidates.append(month_dir / ref)
            for d in sorted(month_dir.iterdir()):
                if d.is_dir() and d.name.endswith(f"-{ref}"):
                    candidates.append(d)
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "task.json").is_file():
            return candidate
    return None


def _is_under_archive(task_dir: Path, tasks_dir: Path) -> bool:
    try:
        return task_dir.resolve().is_relative_to(
            (tasks_dir / "archive").resolve()
        )
    except (OSError, ValueError):
        return False


def scope_children_for_task(
    task_dir: Path,
    task_data: dict | None,
    *,
    repo_root: Path | None = None,
    tasks_dir: Path | None = None,
) -> dict[str, str] | None:
    """Build an id->state scope map from the closest Parent task-map.

    A child task resolves against its parent's task-map children; a Parent
    task resolves against its own children (a Parent may depend on a Child).
    Returns None when there is no task-map to scope against.
    """
    from .task_map import load_task_map

    if tasks_dir is None:
        if repo_root is None:
            repo_root = get_repo_root()
        tasks_dir = get_tasks_dir(repo_root)

    parent_name = None
    if isinstance(task_data, dict):
        parent = task_data.get("parent")
        if isinstance(parent, str) and parent.strip():
            parent_name = parent.strip()
    scope_dir = (
        tasks_dir / parent_name if parent_name else task_dir
    )
    if parent_name is not None and not scope_dir.is_dir():
        found = _find_task_dir(parent_name, tasks_dir)
        scope_dir = found if found is not None else scope_dir

    data, _ = load_task_map(scope_dir)
    if not isinstance(data, dict):
        return None
    scope: dict[str, str] = {}
    for child in data.get("children", []):
        if not isinstance(child, dict):
            continue
        child_id = child.get("id")
        if not isinstance(child_id, str) or not child_id:
            continue
        state = child.get("state")
        scope[child_id] = state if isinstance(state, str) else None
    return scope or None


def describe_dependencies(
    task_dir: Path,
    task_data: dict | None,
    *,
    repo_root: Path | None = None,
    tasks_dir: Path | None = None,
    scope_children: dict[str, str] | None = None,
) -> DependencyReport:
    """Describe the declared dependencies of one task (pure, read-only).

    The dependency graph is expanded through resolved task dirs (their own
    task.json depends_on) so cross-task cycles can be detected; the declared
    task's scope applies only to its own refs.
    """
    if repo_root is None:
        repo_root = get_repo_root()
    if tasks_dir is None:
        tasks_dir = get_tasks_dir(repo_root)

    task_id = task_dir.name
    raw = task_data.get("depends_on") if isinstance(task_data, dict) else None
    deps = [resolve_dep_ref(ref, tasks_dir=tasks_dir, scope_children=scope_children) for ref in normalize_dep_list(raw)]

    graph = build_dependency_graph(
        task_id,
        deps,
        tasks_dir=tasks_dir,
        max_nodes=MAX_GRAPH_NODES,
    )
    cycles = find_dependency_cycles(graph)
    return DependencyReport(task_id=task_id, deps=deps, cycles=cycles)


def describe_child_dependencies(
    child_task_dir: Path,
    child_data: dict | None,
    task_map_entry: dict | None,
    *,
    repo_root: Path | None = None,
    tasks_dir: Path | None = None,
) -> DependencyReport:
    """Describe the union of a Child's dependency edges (Plan B, set-child-state).

    Both sources are combined into one report so the blocking check and cycle
    detection see the merged graph:
      1. Child task.json `depends_on` (task-level, may cross Parents).
      2. Parent task-map `children[].depends_on` (Child-level ordering).

    Either source blocking blocks the mutation (AND semantics); duplicates
    between the sources are resolved once.
    """
    merged = dict(child_data) if isinstance(child_data, dict) else {}
    task_json_deps = normalize_dep_list(merged.get("depends_on"))
    map_deps = normalize_dep_list((task_map_entry or {}).get("depends_on"))
    merged["depends_on"] = task_json_deps + [
        ref for ref in map_deps if ref not in task_json_deps
    ]
    return describe_dependencies(
        child_task_dir,
        merged,
        repo_root=repo_root,
        tasks_dir=tasks_dir,
    )


def build_dependency_graph(
    start_id: str,
    start_deps: list[ResolvedDep],
    *,
    tasks_dir: Path,
    max_nodes: int = MAX_GRAPH_NODES,
) -> dict[str, list[str]]:
    """Expand a task-level dependency graph starting from start_deps.

    Neighbor ids are task dir names (kind=task) or scoped child ids
    (kind=child). Each newly discovered task node is itself expanded from its
    task.json depends_on so cross-task cycles are visible. Scoped children
    are leaves (their ordering lives in the Parent task-map, not task.json).
    """
    graph: dict[str, list[str]] = {}
    seen: set[str] = set()
    queue: list[tuple[str, list[ResolvedDep]]] = [(start_id, start_deps)]

    while queue and len(seen) < max_nodes:
        node_id, node_deps = queue.pop(0)
        if node_id in seen:
            continue
        seen.add(node_id)
        neighbors: list[str] = []
        for dep in node_deps:
            neighbor_id = None
            if dep.kind == KIND_TASK and dep.task_dir is not None:
                neighbor_id = dep.task_dir.name
            elif dep.kind == KIND_CHILD:
                neighbor_id = dep.ref
            if neighbor_id is None:
                continue
            neighbors.append(neighbor_id)
            if neighbor_id in seen or neighbor_id == node_id:
                continue
            if dep.kind == KIND_TASK and dep.task_dir is not None:
                data = read_json(dep.task_dir / "task.json") or {}
                nested = [
                    resolve_dep_ref(ref, tasks_dir=tasks_dir)
                    for ref in normalize_dep_list(data.get("depends_on"))
                ]
                queue.append((neighbor_id, nested))
        graph[node_id] = neighbors
    return graph


def dashboard_deps_line(
    task_dir: Path,
    task_data: dict,
    *,
    repo_root: Path | None = None,
    tasks_dir: Path | None = None,
    parent_dir: Path | None = None,
) -> str | None:
    """One dashboard summary line for non-empty dependencies, else None.

    Combines task.json depends_on with the Parent task-map child depends_on
    when parent_dir is provided (Child level keeps task-map as single source
    of truth; sources are annotated on the line).
    """
    if repo_root is None:
        repo_root = get_repo_root()
    if tasks_dir is None:
        tasks_dir = get_tasks_dir(repo_root)

    scope = scope_children_for_task(
        task_dir, task_data, tasks_dir=tasks_dir
    )
    report = describe_dependencies(
        task_dir,
        task_data,
        tasks_dir=tasks_dir,
        scope_children=scope,
    )
    if not report.has_deps() and parent_dir is None:
        return None

    from .task_map import load_task_map

    if parent_dir is not None:
        map_data, _ = load_task_map(parent_dir)
        if isinstance(map_data, dict):
            child_entry = next(
                (
                    child
                    for child in map_data.get("children", [])
                    if isinstance(child, dict)
                    and child.get("id") == task_dir.name
                ),
                None,
            )
            if isinstance(child_entry, dict):
                for raw_ref in normalize_dep_list(child_entry.get("depends_on")):
                    dep = resolve_dep_ref(
                        raw_ref,
                        tasks_dir=tasks_dir,
                        scope_children=scope,
                    )
                    if not any(existing.ref == dep.ref for existing in report.deps):
                        report.deps.append(dep)

    if not report.has_deps():
        return None

    parts = report.summary_parts()
    sources = report.sources()
    suffix = f" [{', '.join(sources)}]" if sources else ""
    return f"deps: {' · '.join(parts)}{suffix}"
