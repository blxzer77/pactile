#!/usr/bin/env python3
"""Parent-Child / VCS task.json writers go through Kernel patch."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import kernel_command as kernel_command_mod
from common.kernel_command import KernelCliNotFound
from common.task_store import (
    cmd_add_subtask,
    cmd_remove_subtask,
    cmd_set_base_branch,
    cmd_set_branch,
    cmd_set_depends_mode,
    cmd_set_deps,
    cmd_set_scope,
)
from common.test_kernel_command import FAKE_KERNEL


def _write_task(tasks_dir: Path, dir_name: str, **fields) -> Path:
    task_dir = tasks_dir / dir_name
    task_dir.mkdir(parents=True, exist_ok=True)
    data = {
        "id": dir_name,
        "name": dir_name,
        "title": dir_name,
        "status": "planning",
        "children": [],
        "parent": None,
        "meta": {},
    }
    data.update(fields)
    (task_dir / "task.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return task_dir


def _read(task_dir: Path) -> dict:
    return json.loads((task_dir / "task.json").read_text(encoding="utf-8"))


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    tasks_dir = repo / ".pactile" / "tasks"
    tasks_dir.mkdir(parents=True)
    monkeypatch.setattr("common.task_store.get_repo_root", lambda: repo)
    monkeypatch.setattr("common.task_dependencies.get_repo_root", lambda: repo)
    script = tmp_path / "fake_kernel.py"
    script.write_text(FAKE_KERNEL, encoding="utf-8")
    monkeypatch.setattr(
        kernel_command_mod,
        "kernel_cli_argv",
        lambda: [sys.executable, str(script)],
    )
    return repo, tasks_dir


def test_add_and_remove_subtask_go_through_kernel(sandbox) -> None:
    _repo, tasks_dir = sandbox
    parent_dir = _write_task(tasks_dir, "parent-x")
    child_dir = _write_task(tasks_dir, "child-a")

    rc = cmd_add_subtask(
        argparse.Namespace(parent_dir="parent-x", child_dir="child-a")
    )
    assert rc == 0

    parent = _read(parent_dir)
    child = _read(child_dir)
    assert parent["children"] == ["child-a"]
    assert child["parent"] == "parent-x"
    assert parent["status"] == "planning"
    assert child["status"] == "planning"
    assert (parent_dir / "kernel.json").is_file()
    assert (child_dir / "kernel.json").is_file()
    parent_kernel = json.loads((parent_dir / "kernel.json").read_text(encoding="utf-8"))
    child_kernel = json.loads((child_dir / "kernel.json").read_text(encoding="utf-8"))
    assert parent_kernel["revision"] >= 1
    assert child_kernel["revision"] >= 1
    assert (parent_dir / "task-map.md").is_file()

    rc = cmd_remove_subtask(
        argparse.Namespace(parent_dir="parent-x", child_dir="child-a")
    )
    assert rc == 0
    parent = _read(parent_dir)
    child = _read(child_dir)
    assert parent["children"] == []
    assert child["parent"] is None
    assert parent["status"] == "planning"


def test_set_branch_base_and_scope_go_through_kernel(sandbox) -> None:
    _repo, tasks_dir = sandbox
    task_dir = _write_task(tasks_dir, "task-x")

    assert cmd_set_branch(argparse.Namespace(dir="task-x", branch="feat/demo")) == 0
    data = _read(task_dir)
    assert data["branch"] == "feat/demo"
    assert data["status"] == "planning"
    kernel = json.loads((task_dir / "kernel.json").read_text(encoding="utf-8"))
    assert kernel["revision"] >= 1
    first_revision = kernel["revision"]

    assert cmd_set_base_branch(
        argparse.Namespace(dir="task-x", base_branch="feat/stage0-clean-baseline")
    ) == 0
    data = _read(task_dir)
    assert data["base_branch"] == "feat/stage0-clean-baseline"
    assert data["branch"] == "feat/demo"
    kernel = json.loads((task_dir / "kernel.json").read_text(encoding="utf-8"))
    assert kernel["revision"] > first_revision

    assert cmd_set_scope(argparse.Namespace(dir="task-x", scope="cli")) == 0
    data = _read(task_dir)
    assert data["scope"] == "cli"
    assert data["status"] == "planning"


def test_set_deps_and_depends_mode_go_through_kernel(sandbox) -> None:
    _repo, tasks_dir = sandbox
    task_dir = _write_task(tasks_dir, "task-x")

    assert cmd_set_deps(argparse.Namespace(dir="task-x", dep=["dep-a", "dep-gone"])) == 0
    data = _read(task_dir)
    assert data["depends_on"] == ["dep-a", "dep-gone"]
    assert data["status"] == "planning"
    kernel = json.loads((task_dir / "kernel.json").read_text(encoding="utf-8"))
    assert kernel["revision"] >= 1
    assert kernel["audit"][-1]["idempotencyKey"].startswith("patch:set-deps:")

    assert cmd_set_depends_mode(argparse.Namespace(dir="task-x", mode="block")) == 0
    data = _read(task_dir)
    assert data["meta"]["depends_mode"] == "block"
    assert data["depends_on"] == ["dep-a", "dep-gone"]
    assert data["status"] == "planning"


def test_set_branch_does_not_fallback_when_kernel_cli_missing(sandbox, monkeypatch) -> None:
    _repo, tasks_dir = sandbox
    task_dir = _write_task(tasks_dir, "task-x")

    def _missing():
        raise KernelCliNotFound("Kernel CLI not found")

    monkeypatch.setattr(kernel_command_mod, "kernel_cli_argv", _missing)
    rc = cmd_set_branch(argparse.Namespace(dir="task-x", branch="feat/demo"))
    assert rc == 1
    data = _read(task_dir)
    assert "branch" not in data or data.get("branch") in (None, "")
    assert not (task_dir / "kernel.json").is_file()
