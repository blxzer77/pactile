#!/usr/bin/env python3
"""Tests for Plan A task-level depends_on resolution (declare + soft checks)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.task_dependencies import (
    KIND_CHILD,
    KIND_MISSING,
    KIND_TASK,
    NOT_SATISFIED,
    SATISFIED,
    UNRESOLVED,
    dashboard_deps_line,
    describe_dependencies,
    find_dependency_cycles,
    normalize_dep_list,
    resolve_dep_ref,
    satisfaction_status,
)


def _write_task(tasks_dir: Path, dir_name: str, status: str, depends_on=None) -> Path:
    task_dir = tasks_dir / dir_name
    task_dir.mkdir(parents=True, exist_ok=True)
    data = {
        "id": dir_name,
        "name": dir_name,
        "title": dir_name,
        "description": "",
        "status": status,
    }
    if depends_on is not None:
        data["depends_on"] = depends_on
    (task_dir / "task.json").write_text(json.dumps(data), encoding="utf-8")
    return task_dir


def _tasks_fixture(tmp_path: Path) -> Path:
    tasks_dir = tmp_path / "repo" / ".pactile" / "tasks"
    tasks_dir.mkdir(parents=True)
    return tasks_dir


def test_completed_task_is_satisfied(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    _write_task(tasks_dir, "dep-a", "completed")
    task_dir = _write_task(tasks_dir, "task-x", "planning", ["dep-a"])

    report = describe_dependencies(task_dir, {"depends_on": ["dep-a"]}, tasks_dir=tasks_dir)
    dep = report.deps[0]
    assert dep.kind == KIND_TASK
    assert satisfaction_status(dep)[0] == SATISFIED
    assert report.warnings() == []


def test_archived_task_counts_as_completed(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    archive_dir = tasks_dir / "archive" / "2026-08"
    archive_dir.mkdir(parents=True)
    # Anomaly: archived task.json still says planning — location is the rule.
    _write_task(archive_dir, "dep-archived", "planning")
    task_dir = _write_task(tasks_dir, "task-x", "planning", ["dep-archived"])

    dep = resolve_dep_ref("dep-archived", tasks_dir=tasks_dir)
    assert dep.kind == KIND_TASK
    assert dep.is_archived
    status, note = satisfaction_status(dep)
    assert status == SATISFIED
    assert note == "archived task counts as completed"


def test_cancelled_task_satisfied_with_cancelled_warning(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    _write_task(tasks_dir, "dep-c", "cancelled")
    task_dir = _write_task(tasks_dir, "task-x", "planning", ["dep-c"])

    report = describe_dependencies(task_dir, {"depends_on": ["dep-c"]}, tasks_dir=tasks_dir)
    dep = report.deps[0]
    assert dep.is_cancelled
    assert satisfaction_status(dep)[0] == SATISFIED
    assert any("cancelled" in w for w in report.warnings())


def test_in_progress_dependency_is_not_satisfied(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    _write_task(tasks_dir, "dep-b", "in_progress")
    task_dir = _write_task(tasks_dir, "task-x", "planning", ["dep-b"])

    report = describe_dependencies(task_dir, {"depends_on": ["dep-b"]}, tasks_dir=tasks_dir)
    dep = report.deps[0]
    assert satisfaction_status(dep)[0] == NOT_SATISFIED
    assert any("not satisfied" in w for w in report.warnings())


def test_dangling_reference_is_unresolved_warning(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    task_dir = _write_task(tasks_dir, "task-x", "planning", ["ghost-task"])

    dep = resolve_dep_ref("ghost-task", tasks_dir=tasks_dir)
    assert dep.kind == KIND_MISSING
    assert satisfaction_status(dep)[0] == UNRESOLVED
    report = describe_dependencies(task_dir, {"depends_on": ["ghost-task"]}, tasks_dir=tasks_dir)
    assert any("dangling" in w for w in report.warnings())


def test_cycle_detected_across_tasks(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    task_a = _write_task(tasks_dir, "task-a", "planning", ["task-b"])
    _write_task(tasks_dir, "task-b", "planning", ["task-a"])

    report = describe_dependencies(task_a, {"depends_on": ["task-b"]}, tasks_dir=tasks_dir)
    assert len(report.cycles) == 1
    assert report.cycles[0][0] == report.cycles[0][-1]
    assert any("cycle" in w for w in report.warnings())


def test_self_reference_cycle_detected(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    task_dir = _write_task(tasks_dir, "task-x", "planning", ["task-x"])

    report = describe_dependencies(task_dir, {"depends_on": ["task-x"]}, tasks_dir=tasks_dir)
    assert report.cycles == [["task-x", "task-x"]]


def test_find_dependency_cycles_pure(tmp_path: Path) -> None:
    graph = {"a": ["b"], "b": ["c"], "c": ["a"], "d": []}
    cycles = find_dependency_cycles(graph)
    assert len(cycles) == 1
    cycle = cycles[0]
    assert cycle[0] == cycle[-1]
    assert set(cycle) == {"a", "b", "c"}


def test_scope_child_wins_over_global_task_with_same_name(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    # Global task named "shared" that IS completed — would be satisfied globally.
    _write_task(tasks_dir, "shared", "completed")
    task_dir = _write_task(tasks_dir, "task-x", "planning", ["shared"])
    scope = {"shared": "open"}

    dep = resolve_dep_ref("shared", tasks_dir=tasks_dir, scope_children=scope)
    assert dep.kind == KIND_CHILD
    assert dep.source == "task-map"
    assert satisfaction_status(dep)[0] == NOT_SATISFIED

    report = describe_dependencies(
        task_dir, {"depends_on": ["shared"]}, tasks_dir=tasks_dir, scope_children=scope
    )
    assert report.deps[0].kind == KIND_CHILD
    assert any("not satisfied" in w for w in report.warnings())


def test_child_integrated_is_satisfied_via_scope(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    task_dir = _write_task(tasks_dir, "task-x", "planning", ["child-a"])
    scope = {"child-a": "integrated", "child-b": "cancelled"}

    dep = resolve_dep_ref("child-a", tasks_dir=tasks_dir, scope_children=scope)
    assert dep.kind == KIND_CHILD
    assert satisfaction_status(dep)[0] == SATISFIED

    report = describe_dependencies(
        task_dir, {"depends_on": ["child-a", "child-b"]}, tasks_dir=tasks_dir, scope_children=scope
    )
    assert satisfaction_status(report.deps[0])[0] == SATISFIED
    assert report.deps[1].is_cancelled
    assert any("cancelled" in w for w in report.warnings())


def test_empty_depends_on_has_no_warnings_or_dashboard_line(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    task_dir = _write_task(tasks_dir, "task-x", "planning")
    data = {"id": "task-x", "status": "planning"}

    report = describe_dependencies(task_dir, data, tasks_dir=tasks_dir)
    assert not report.has_deps()
    assert report.warnings() == []
    assert dashboard_deps_line(task_dir, data, tasks_dir=tasks_dir) is None


def test_dashboard_deps_line_renders_badges(tmp_path: Path) -> None:
    tasks_dir = _tasks_fixture(tmp_path)
    _write_task(tasks_dir, "dep-done", "completed")
    _write_task(tasks_dir, "dep-wait", "in_progress")
    _write_task(tasks_dir, "dep-gone", "cancelled")
    task_dir = _write_task(
        tasks_dir, "task-x", "planning", ["dep-done", "dep-wait", "dep-gone"]
    )
    data = {
        "id": "task-x",
        "status": "planning",
        "depends_on": ["dep-done", "dep-wait", "dep-gone"],
    }

    line = dashboard_deps_line(task_dir, data, tasks_dir=tasks_dir)
    assert line is not None
    assert "dep-done ✅" in line
    assert "dep-wait ⏳" in line
    assert "dep-gone ✅已取消" in line


def test_normalize_dep_list_dedupes_and_strips(tmp_path: Path) -> None:
    assert normalize_dep_list(None) == []
    assert normalize_dep_list(["a", " a ", "b", "a", "", 5]) == ["a", "b"]
    assert normalize_dep_list("not-a-list") == []
