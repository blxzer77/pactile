#!/usr/bin/env python3
"""Tests for Plan B depends_mode=block (opt-in hard gates).

Matrix source: 08-09-depends-on-b-research/research/03-recommendation.md §2.7
(T1-T14) adjudicated by 05-adjudication.md (check never fails; only the
mutating --approved path and set-child-state working enforce block mode).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.task_dependencies import (
    KIND_TASK,
    ResolvedDep,
    describe_child_dependencies,
    describe_dependencies,
    read_depends_mode,
)
from common.task_gates import validate_start_execution, validate_start_execution_check
from common.kernel_command import to_kernel_record


# =============================================================================
# Helpers
# =============================================================================

def _write_task(tasks_dir: Path, dir_name: str, status: str, depends_on=None,
                meta=None, **extra) -> Path:
    task_dir = tasks_dir / dir_name
    task_dir.mkdir(parents=True, exist_ok=True)
    data = to_kernel_record(
        {
            "id": dir_name,
            "name": dir_name,
            "title": dir_name,
            "description": "",
            "status": status,
            **extra,
        }
    )
    if depends_on is not None:
        data["depends_on"] = depends_on
    if meta is not None:
        data["meta"] = meta
    (task_dir / "task.json").write_text(json.dumps(data), encoding="utf-8")
    return task_dir


def _ready_task(tasks_dir: Path, dir_name: str, depends_on, mode=None) -> Path:
    """A lite task that passes every start-execution gate except deps policy."""
    meta = {"depends_mode": mode} if mode else None
    task_dir = _write_task(tasks_dir, dir_name, "planning", depends_on, meta)
    (task_dir / "prd.md").write_text(
        "# PRD\n\n## Goal\n\nx\n\n## Acceptance Criteria\n\n- [ ] x\n",
        encoding="utf-8",
    )
    return task_dir


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """Isolated repo where dependency resolution and store commands run."""
    repo = tmp_path / "repo"
    tasks_dir = repo / ".pactile" / "tasks"
    tasks_dir.mkdir(parents=True)
    monkeypatch.setattr("common.task_dependencies.get_repo_root", lambda: repo)
    monkeypatch.setattr("common.task_store.get_repo_root", lambda: repo)
    return repo, tasks_dir


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# =============================================================================
# read_depends_mode (R1)
# =============================================================================

def test_read_depends_mode_defaults_to_warn() -> None:
    assert read_depends_mode(None) == "warn"
    assert read_depends_mode({}) == "warn"
    assert read_depends_mode({"meta": None}) == "warn"
    assert read_depends_mode({"meta": {}}) == "warn"
    assert read_depends_mode({"meta": {"depends_mode": None}}) == "warn"
    assert read_depends_mode({"meta": {"depends_mode": "explode"}}) == "warn"


def test_read_depends_mode_accepts_all_modes() -> None:
    for mode in ("warn", "block", "off"):
        assert read_depends_mode({"meta": {"depends_mode": mode}}) == mode


# =============================================================================
# blocking_errors semantics (T5/T7/T8/T9/T13/T14)
# =============================================================================

def test_blocking_errors_for_statuses(sandbox) -> None:
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-wait", "in_progress")
    _write_task(tasks_dir, "dep-done", "completed")
    _write_task(tasks_dir, "dep-gone", "cancelled")
    task_dir = _write_task(
        tasks_dir,
        "task-x",
        "planning",
        ["dep-wait", "dep-done", "dep-gone", "ghost-task"],
    )
    report = describe_dependencies(task_dir, _read_json(task_dir / "task.json"))
    errors = report.blocking_errors()
    assert any("not satisfied: dep-wait" in e for e in errors)
    assert not any("dep-done" in e for e in errors)
    assert not any("dep-gone" in e for e in errors)
    assert any("dangling dependency: ghost-task" in e for e in errors)


def test_blocking_errors_cycle(sandbox) -> None:
    repo, tasks_dir = sandbox
    task_a = _write_task(tasks_dir, "task-a", "planning", ["task-b"])
    _write_task(tasks_dir, "task-b", "planning", ["task-a"])
    report = describe_dependencies(task_a, _read_json(task_a / "task.json"))
    assert any("cycle detected" in e for e in report.blocking_errors())


def test_blocking_errors_never_for_cancelled_satisfied() -> None:
    dep = ResolvedDep(ref="dep-gone", kind=KIND_TASK, status="cancelled")
    from common.task_dependencies import DependencyReport

    report = DependencyReport(task_id="task-x", deps=[dep])
    assert report.blocking_errors() == []
    assert any("cancelled" in w for w in report.warnings())


def test_blocking_errors_subset_of_warnings(sandbox) -> None:
    """T14: every blocking error string also appears in warnings()."""
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-wait", "in_progress")
    _write_task(tasks_dir, "dep-gone", "cancelled")
    task_dir = _write_task(
        tasks_dir,
        "task-x",
        "planning",
        ["dep-wait", "dep-gone", "ghost-task"],
    )
    report = describe_dependencies(task_dir, _read_json(task_dir / "task.json"))
    warning_set = set(report.warnings())
    assert set(report.blocking_errors()) <= warning_set


# =============================================================================
# describe_child_dependencies: task.json + task-map union (R4, Q11)
# =============================================================================

def test_describe_child_dependencies_merges_task_json_and_task_map(sandbox) -> None:
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-task", "in_progress")
    child_dir = _write_task(tasks_dir, "child-a", "planning", ["dep-task"])
    child_data = _read_json(child_dir / "task.json")
    map_entry = {"id": "child-a", "state": "open", "depends_on": ["dep-map"]}

    report = describe_child_dependencies(child_dir, child_data, map_entry, repo_root=repo)
    refs = [dep.ref for dep in report.deps]
    assert "dep-task" in refs
    assert "dep-map" in refs


def test_describe_child_dependencies_dedupes_sources(sandbox) -> None:
    repo, tasks_dir = sandbox
    child_dir = _write_task(tasks_dir, "child-a", "planning", ["shared"])
    child_data = _read_json(child_dir / "task.json")
    map_entry = {"id": "child-a", "state": "open", "depends_on": ["shared", "shared"]}

    report = describe_child_dependencies(child_dir, child_data, map_entry, repo_root=repo)
    refs = [dep.ref for dep in report.deps]
    assert refs == ["shared"]


# =============================================================================
# start-execution gates (T1-T9, T13)
# =============================================================================

def test_t1_default_warn_approved_unmet_deps_do_not_fail(sandbox) -> None:
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-a", "in_progress")
    task_dir = _ready_task(tasks_dir, "task-x", ["dep-a"])

    guard = validate_start_execution(task_dir, _read_json(task_dir / "task.json"),
                                     approved=True, enforce_deps_block=True)
    assert guard.ok
    assert not any("dep-a" in e for e in guard.errors)
    assert any("dep-a" in w for w in guard.warnings)


def test_t2_block_approved_unmet_deps_fail(sandbox) -> None:
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-a", "in_progress")
    task_dir = _ready_task(tasks_dir, "task-x", ["dep-a"], mode="block")

    guard = validate_start_execution(task_dir, _read_json(task_dir / "task.json"),
                                     approved=True, enforce_deps_block=True)
    assert not guard.ok
    assert any("dependency not satisfied: dep-a" in e for e in guard.errors)


def test_t3_block_approved_ignore_deps_passes(sandbox) -> None:
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-a", "in_progress")
    task_dir = _ready_task(tasks_dir, "task-x", ["dep-a"], mode="block")

    guard = validate_start_execution(task_dir, _read_json(task_dir / "task.json"),
                                     approved=True, enforce_deps_block=True,
                                     ignore_deps=True)
    assert guard.ok
    assert guard.deps_blocking_summary
    assert any("dep-a" in w for w in guard.warnings)


def test_t4_block_check_never_fails(sandbox) -> None:
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-a", "in_progress")
    task_dir = _ready_task(tasks_dir, "task-x", ["dep-a"], mode="block")

    guard = validate_start_execution_check(task_dir, _read_json(task_dir / "task.json"))
    assert guard.ok
    assert any("dep-a" in w for w in guard.warnings)
    assert any("--approved would fail" in w for w in guard.warnings)


def test_t5_block_empty_deps_approved_passes(sandbox) -> None:
    repo, tasks_dir = sandbox
    task_dir = _ready_task(tasks_dir, "task-x", [], mode="block")

    guard = validate_start_execution(task_dir, _read_json(task_dir / "task.json"),
                                     approved=True, enforce_deps_block=True)
    assert guard.ok
    assert guard.deps_blocking_summary == []


def test_t6_off_silences_deps(sandbox) -> None:
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-a", "in_progress")
    task_dir = _ready_task(tasks_dir, "task-x", ["dep-a"], mode="off")

    guard = validate_start_execution(task_dir, _read_json(task_dir / "task.json"),
                                     approved=True, enforce_deps_block=True)
    assert guard.ok
    assert not any("dep-a" in e for e in guard.errors)
    assert not any("dep-a" in w for w in guard.warnings)


def test_t7_block_cycle_fails(sandbox) -> None:
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "task-a", "planning", ["task-b"])
    _write_task(tasks_dir, "task-b", "planning", ["task-a"])
    task_dir = _ready_task(tasks_dir, "task-x", ["task-a"], mode="block")

    guard = validate_start_execution(task_dir, _read_json(task_dir / "task.json"),
                                     approved=True, enforce_deps_block=True)
    assert not guard.ok
    assert any("cycle detected" in e for e in guard.errors)


def test_t8_block_dangling_fails(sandbox) -> None:
    repo, tasks_dir = sandbox
    task_dir = _ready_task(tasks_dir, "task-x", ["ghost-task"], mode="block")

    guard = validate_start_execution(task_dir, _read_json(task_dir / "task.json"),
                                     approved=True, enforce_deps_block=True)
    assert not guard.ok
    assert any("dangling dependency: ghost-task" in e for e in guard.errors)


def test_t13_block_cancelled_dependency_not_blocked(sandbox) -> None:
    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-gone", "cancelled")
    task_dir = _ready_task(tasks_dir, "task-x", ["dep-gone"], mode="block")

    guard = validate_start_execution(task_dir, _read_json(task_dir / "task.json"),
                                     approved=True, enforce_deps_block=True)
    assert guard.ok
    assert guard.deps_blocking_summary == []


# =============================================================================
# set-child-state working (T10-T12) + ignore audit (R4)
# =============================================================================

def _parent_child_pair(sandbox) -> tuple[Path, Path, dict, dict]:
    repo, tasks_dir = sandbox
    parent_dir = _write_task(tasks_dir, "parent-x", "planning", children=["child-a"])
    child_dir = _write_task(tasks_dir, "child-a", "planning", parent="parent-x")
    parent_data = _read_json(parent_dir / "task.json")
    child_data = _read_json(child_dir / "task.json")
    return parent_dir, child_dir, parent_data, child_data


def _child_args(parent_dir: Path, child_dir: Path, state: str,
                ignore_deps: bool = False) -> argparse.Namespace:
    return argparse.Namespace(
        parent_dir=str(parent_dir),
        child_dir=str(child_dir),
        state=state,
        evidence="ev-1",
        reason=None,
        ignore_deps=ignore_deps,
    )


def test_t10_block_child_working_rejected(sandbox) -> None:
    from common.task_store import cmd_set_child_state
    from common.task_map import ensure_task_map, load_task_map

    parent_dir, child_dir, parent_data, child_data = _parent_child_pair(sandbox)
    ensure_task_map(parent_dir, parent_data, ["child-a"])
    child_data["meta"] = {"depends_mode": "block"}
    (child_dir / "task.json").write_text(json.dumps(child_data), encoding="utf-8")
    _write_task(sandbox[1], "dep-a", "in_progress")
    child_data["depends_on"] = ["dep-a"]
    (child_dir / "task.json").write_text(json.dumps(child_data), encoding="utf-8")

    rc = cmd_set_child_state(_child_args(parent_dir, child_dir, "working"))
    assert rc == 1
    # state must remain unchanged in the task-map
    map_data, _ = load_task_map(parent_dir)
    entry = next(c for c in map_data["children"] if c["id"] == "child-a")
    assert entry["state"] == "open"


def test_t10b_block_child_working_rejected_from_task_map_source(sandbox) -> None:
    from common.task_store import cmd_set_child_state
    from common.task_map import (
        ensure_task_map,
        get_child_entry,
        load_task_map,
        write_task_map,
    )

    parent_dir, child_dir, parent_data, child_data = _parent_child_pair(sandbox)
    ensure_task_map(parent_dir, parent_data, ["child-a"])
    child_data["meta"] = {"depends_mode": "block"}
    (child_dir / "task.json").write_text(json.dumps(child_data), encoding="utf-8")

    map_data, map_body = load_task_map(parent_dir)
    child = get_child_entry(map_data, "child-a")
    child["depends_on"] = ["dep-map"]
    write_task_map(parent_dir, map_data, map_body, None)
    _write_task(sandbox[1], "dep-map", "in_progress")

    rc = cmd_set_child_state(_child_args(parent_dir, child_dir, "working"))
    assert rc == 1


def test_t11_block_child_review_not_blocked(sandbox) -> None:
    from common.task_store import cmd_set_child_state
    from common.task_map import load_task_map

    parent_dir, child_dir, parent_data, child_data = _parent_child_pair(sandbox)
    child_data["meta"] = {"depends_mode": "block"}
    child_data["depends_on"] = ["dep-a"]
    (child_dir / "task.json").write_text(json.dumps(child_data), encoding="utf-8")

    rc = cmd_set_child_state(_child_args(parent_dir, child_dir, "review"))
    assert rc == 0
    map_data, _ = load_task_map(parent_dir)
    entry = next(c for c in map_data["children"] if c["id"] == "child-a")
    assert entry["state"] == "review"


def test_t12_warn_child_working_not_blocked(sandbox) -> None:
    from common.task_store import cmd_set_child_state
    from common.task_map import load_task_map

    parent_dir, child_dir, parent_data, child_data = _parent_child_pair(sandbox)
    child_data["depends_on"] = ["dep-a"]
    (child_dir / "task.json").write_text(json.dumps(child_data), encoding="utf-8")

    rc = cmd_set_child_state(_child_args(parent_dir, child_dir, "working"))
    assert rc == 0
    map_data, _ = load_task_map(parent_dir)
    entry = next(c for c in map_data["children"] if c["id"] == "child-a")
    assert entry["state"] == "working"


def test_child_working_ignore_deps_passes_and_audits(sandbox) -> None:
    from common.task_store import cmd_set_child_state
    from common.task_map import ensure_task_map, load_task_map

    parent_dir, child_dir, parent_data, child_data = _parent_child_pair(sandbox)
    ensure_task_map(parent_dir, parent_data, ["child-a"])
    child_data["meta"] = {"depends_mode": "block"}
    child_data["depends_on"] = ["dep-a"]
    (child_dir / "task.json").write_text(json.dumps(child_data), encoding="utf-8")

    rc = cmd_set_child_state(_child_args(parent_dir, child_dir, "working",
                                         ignore_deps=True))
    assert rc == 0

    child_data = _read_json(child_dir / "task.json")
    events = child_data["meta"]["depends_ignore_events"]
    assert len(events) == 1
    assert events[0]["command"] == "set-child-state"
    assert events[0]["mode"] == "block"
    assert any("dep-a" in item for item in events[0]["blocking_summary"])
    assert events[0]["evidence"] == "ev-1"

    map_data, map_body = load_task_map(parent_dir)
    assert "Ignored dependencies (mode=block) for child `child-a`" in map_body
    entry = next(c for c in map_data["children"] if c["id"] == "child-a")
    assert entry["state"] == "working"


# =============================================================================
# start-execution CLI wiring: --ignore-deps event in the same write (R3)
# =============================================================================

def test_start_execution_approved_ignore_deps_writes_event_with_approval(sandbox) -> None:
    from task import cmd_start_execution

    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-a", "in_progress")
    task_dir = _ready_task(tasks_dir, "task-x", ["dep-a"], mode="block")

    args = argparse.Namespace(
        dir=str(task_dir), check=False, approved=True, ignore_deps=True
    )
    rc = cmd_start_execution(args)
    assert rc == 0

    task_data = _read_json(task_dir / "task.json")
    assert task_data["execution_approval"]["transition"] == "start-execution"
    assert task_data["status"] == "in_progress"
    events = task_data["meta"]["depends_ignore_events"]
    assert len(events) == 1
    assert events[0]["command"] == "start-execution"
    assert any("dep-a" in item for item in events[0]["blocking_summary"])


def test_start_execution_approved_block_rejected_without_ignore(sandbox) -> None:
    from task import cmd_start_execution

    repo, tasks_dir = sandbox
    _write_task(tasks_dir, "dep-a", "in_progress")
    task_dir = _ready_task(tasks_dir, "task-x", ["dep-a"], mode="block")

    args = argparse.Namespace(
        dir=str(task_dir), check=False, approved=True, ignore_deps=False
    )
    rc = cmd_start_execution(args)
    assert rc == 1
    task_data = _read_json(task_dir / "task.json")
    assert "execution_approval" not in task_data
    assert task_data["status"] == "planning"


# =============================================================================
# set-depends-mode CLI (R5)
# =============================================================================

def test_set_depends_mode_writes_meta(sandbox) -> None:
    from common.task_store import cmd_set_depends_mode

    repo, tasks_dir = sandbox
    task_dir = _write_task(tasks_dir, "task-x", "planning")

    args = argparse.Namespace(dir=str(task_dir), mode="block")
    assert cmd_set_depends_mode(args) == 0
    assert _read_json(task_dir / "task.json")["meta"]["depends_mode"] == "block"

    args = argparse.Namespace(dir=str(task_dir), mode="off")
    assert cmd_set_depends_mode(args) == 0
    assert _read_json(task_dir / "task.json")["meta"]["depends_mode"] == "off"

    args = argparse.Namespace(dir=str(task_dir), mode="nonsense")
    assert cmd_set_depends_mode(args) == 1
    assert _read_json(task_dir / "task.json")["meta"]["depends_mode"] == "off"
