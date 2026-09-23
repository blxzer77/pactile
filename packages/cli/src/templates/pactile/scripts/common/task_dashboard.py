#!/usr/bin/env python3
"""Task dashboard rendering for framework entry routing."""

from __future__ import annotations

import json
from pathlib import Path

from .active_task import resolve_selected_task
from .paths import DIR_TASKS, DIR_WORKFLOW, get_developer, get_repo_root, get_tasks_dir
from .task_dependencies import dashboard_deps_line
from .task_gates import verify_evidence_status
from .task_map import get_child_state
from .tasks import (
    children_progress,
    format_child_task_display,
    iter_active_tasks,
    load_parent_child_integration_states,
)


_KERNEL_PHASE_ORDER = (
    "open",
    "define",
    "approve",
    "execute",
    "verify",
    "integrate",
    "close",
)

_KERNEL_PHASE_HUMAN = {
    "open": "Open",
    "define": "Define",
    "approve": "Approve",
    "execute": "Execute",
    "verify": "Verify",
    "integrate": "Integrate",
    "close": "Close",
}

_STATUS_TO_KERNEL_PHASE = {
    "planning": "define",
    "in_progress": "execute",
    "review": "verify",
    "completed": "close",
    "done": "close",
}

_PHASE_DEFAULT_CONDITION = {
    "open": "ready",
    "define": "ready",
    "approve": "waiting",
    "execute": "active",
    "verify": "waiting",
    "integrate": "waiting",
    "close": "ready",
}

_VALID_CONDITIONS = frozenset({"ready", "active", "waiting", "blocked"})
_VALID_OUTCOMES = frozenset({"completed", "cancelled", "failed"})


def _task_path(dir_name: str) -> str:
    return f"{DIR_WORKFLOW}/{DIR_TASKS}/{dir_name}"


def format_verify_summary(task_dir: Path, task_data: dict) -> str:
    """Return a compact verify evidence label for dashboard task lines."""
    verify_path = task_dir / "verify.md"
    if not verify_path.is_file():
        return "[verify: missing]"
    status = verify_evidence_status(task_dir, task_data)
    if all(status.values()):
        return "[verify: ok]"
    if any(status.values()):
        return "[verify: partial]"
    return "[verify: missing]"


def project_kernel_surface(task_dir: Path, task_data: dict | None = None) -> dict:
    """Read-only Kernel projection: phase, condition, outcome, human title.

    Prefers `kernel.json` when present. Does not mutate `task.json.status`.
    Integrate is a visible slot only when topology is parent-child or the
    task is already in that phase.
    """
    data = task_data if isinstance(task_data, dict) else {}
    kernel = _load_kernel_json(task_dir)
    phase: str | None = None
    condition: str | None = None
    outcome = None
    if isinstance(kernel, dict):
        raw_phase = kernel.get("phase")
        if raw_phase in _KERNEL_PHASE_HUMAN:
            phase = raw_phase
            condition = kernel.get("condition")
            outcome = kernel.get("outcome")
    status = data.get("status") if isinstance(data.get("status"), str) else ""
    if phase is None:
        phase = _STATUS_TO_KERNEL_PHASE.get(status, "open")
        condition = _PHASE_DEFAULT_CONDITION.get(phase, "ready")
        outcome = "completed" if phase == "close" else None
    if condition not in _VALID_CONDITIONS:
        condition = _PHASE_DEFAULT_CONDITION.get(phase, "ready")
    if outcome not in _VALID_OUTCOMES and outcome is not None:
        outcome = None
    topology_kind = _topology_kind(data, kernel)
    return {
        "phase": phase,
        "condition": condition,
        "outcome": outcome,
        "status": status,
        "humanPhase": _KERNEL_PHASE_HUMAN[phase],
        "showIntegrate": phase == "integrate" or topology_kind == "parent-child",
    }


def _load_kernel_json(task_dir: Path) -> dict | None:
    path = task_dir / "kernel.json"
    if not path.is_file():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _topology_kind(task_data: dict, kernel: dict | None) -> str | None:
    topo = task_data.get("topology")
    if isinstance(topo, dict) and isinstance(topo.get("kind"), str):
        return topo["kind"]
    if not isinstance(kernel, dict):
        return None
    projection = kernel.get("projection")
    extras = projection.get("extras") if isinstance(projection, dict) else None
    extra_topo = extras.get("topology") if isinstance(extras, dict) else None
    if isinstance(extra_topo, dict) and isinstance(extra_topo.get("kind"), str):
        return extra_topo["kind"]
    return None


def _selected_line(
    repo_root: Path,
    platform_input: dict | None = None,
    platform: str | None = None,
) -> str:
    selected = resolve_selected_task(repo_root, platform_input, platform)
    if selected.task_path:
        suffix = f" ({selected.source})" if selected.source else ""
        return f"Selected task: {selected.task_path}{suffix}"
    return (
        "Selected task: none "
        "(no session pointer — use task.py select <task> or task.py list)"
    )


def render_task_dashboard(
    repo_root: Path | None = None,
    platform_input: dict | None = None,
    platform: str | None = None,
) -> str:
    """Render a compact, non-mutating Task Dashboard."""
    if repo_root is None:
        repo_root = get_repo_root()

    tasks_dir = get_tasks_dir(repo_root)
    developer = get_developer(repo_root)
    all_tasks = {task.dir_name: task for task in iter_active_tasks(tasks_dir)}
    all_statuses = {name: task.status for name, task in all_tasks.items()}
    surfaces = {
        name: project_kernel_surface(task.directory, task.raw or {})
        for name, task in all_tasks.items()
    }
    selected = resolve_selected_task(repo_root, platform_input, platform)

    lines: list[str] = [
        "Task Dashboard",
        "Pactile framework: active",
        _selected_line(repo_root, platform_input, platform),
        "",
    ]

    if not all_tasks:
        lines.append("Tasks: none")
    else:
        printed: set[str] = set()
        show_integrate = any(item["showIntegrate"] for item in surfaces.values())
        phase_order = (
            _KERNEL_PHASE_ORDER
            if show_integrate
            else tuple(phase for phase in _KERNEL_PHASE_ORDER if phase != "integrate")
        )
        for phase in phase_order:
            names = [
                name
                for name, task in sorted(all_tasks.items())
                if surfaces[name]["phase"] == phase and not task.parent
            ]
            if not names:
                continue
            lines.append(f"{_KERNEL_PHASE_HUMAN[phase]}:")
            for name in names:
                _append_task(
                    lines, name, all_tasks, all_statuses, printed, surfaces
                )
            lines.append("")

        other_names = [
            name
            for name, task in sorted(all_tasks.items())
            if name not in printed and not task.parent
        ]
        if other_names:
            lines.append("Other:")
            for name in other_names:
                _append_task(
                    lines, name, all_tasks, all_statuses, printed, surfaces
                )
            lines.append("")

    lines.append("Suggested actions:")
    lines.append("  - Select a task: python ./.pactile/scripts/task.py select <task>")
    lines.append("  - Create a task: python ./.pactile/scripts/task.py create \"<title>\" --slug <slug>")
    lines.append("  - Inspect raw list: python ./.pactile/scripts/task.py list")
    if not selected.task_path:
        lines.append(
            "  - No selected task: Intake — direct answer, clarify, or Open Proposal"
        )
    if developer:
        lines.append(f"Developer: {developer}")

    return "\n".join(line.rstrip() for line in lines).rstrip()


def _append_task(
    lines: list[str],
    name: str,
    all_tasks: dict,
    all_statuses: dict[str, str],
    printed: set[str],
    surfaces: dict[str, dict],
    indent: int = 0,
    parent_dir: Path | None = None,
) -> None:
    task = all_tasks[name]
    printed.add(name)
    integration_states = None
    if task.children:
        integration_states = load_parent_child_integration_states(
            task.directory, task.children
        )
    progress = children_progress(
        task.children, all_statuses, integration_states
    )
    integration_state = None
    if parent_dir is not None:
        integration_state = get_child_state(parent_dir, name)
    human_phase = surfaces.get(name, {}).get("humanPhase") or "Open"
    status_display = format_child_task_display(human_phase, integration_state)
    assignee = task.assignee or "-"
    verify_summary = format_verify_summary(task.directory, task.raw or {})
    prefix = "  " * indent + "  - "
    lines.append(
        f"{prefix}{_task_path(name)} ({status_display}){progress} [{assignee}] {verify_summary}"
    )
    deps_line = dashboard_deps_line(
        task.directory,
        task.raw or {},
        parent_dir=parent_dir,
    )
    if deps_line:
        lines.append(f"{prefix}{deps_line}")
    for child_name in task.children:
        if child_name in all_tasks:
            _append_task(
                lines,
                child_name,
                all_tasks,
                all_statuses,
                printed,
                surfaces,
                indent + 1,
                parent_dir=task.directory,
            )
