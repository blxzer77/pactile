#!/usr/bin/env python3
"""Characterization tests for Stage 2 Python → Kernel Command shim."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import kernel_command as kernel_command_mod
from common.kernel_command import (
    KERNEL_PROJECTION_EXTRA_KEYS,
    KernelCommandError,
    kernel_archive,
    kernel_create,
    kernel_expected_revision,
    kernel_patch,
    kernel_projection_extras,
    kernel_record_gate,
    kernel_start,
    run_kernel_command,
    to_kernel_record,
)
from common.artifact_locale import set_task_artifact_locale
from common.task_gates import (
    KERNEL_PROJECTION_EXTRA_KEYS as GATES_PROJECTION_EXTRA_KEYS,
    collect_kernel_projection_extras,
    write_gate_record,
)

FAKE_KERNEL = r"""
import json
import sys
from pathlib import Path

req = json.loads(sys.stdin.read())
op = req.get("op")
task_dir = Path(req["taskDir"])
task_dir.mkdir(parents=True, exist_ok=True)
kernel_path = task_dir / "kernel.json"
task_path = task_dir / "task.json"

def dump(payload, code=0):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.exit(code)

def read_kernel():
    if kernel_path.is_file():
        return json.loads(kernel_path.read_text(encoding="utf-8"))
    return {
        "schemaVersion": 1,
        "identity": {"taskId": "missing"},
        "revision": 0,
        "phase": "define",
        "condition": "ready",
        "outcome": None,
        "audit": [],
        "gates": {"schemaVersion": 1, "transitions": {}},
        "projection": None,
    }

if op == "read":
    kernel = read_kernel()
    status = "planning"
    if task_path.is_file():
        status = json.loads(task_path.read_text(encoding="utf-8")).get("status", "planning")
    dump({
        "ok": True,
        "op": "read",
        "kernel": kernel,
        "persisted": kernel_path.is_file(),
        "legacy": {
            "status": status,
            "id": kernel["identity"]["taskId"],
            "name": kernel["identity"]["taskId"],
            "title": "",
        },
    })

record = req.get("record") or {}
existing_task = {}
if task_path.is_file():
    existing_task = json.loads(task_path.read_text(encoding="utf-8"))

status_by_op = {
    "create": "planning",
    "start": "in_progress",
    "archive": "completed",
}
if op == "patch":
    status = existing_task.get("status") or (record.get("status") if isinstance(record, dict) else None) or "planning"
elif op == "record-gate" and existing_task:
    status = existing_task.get("status", "planning")
else:
    status = status_by_op.get(op, "planning")

prev = read_kernel()
revision = int(prev.get("revision") or 0) + 1
task_id = "task"
if isinstance(record, dict) and record.get("id"):
    task_id = record["id"]
elif prev.get("identity", {}).get("taskId"):
    task_id = prev["identity"]["taskId"]

phase_by_op = {
    "create": "define",
    "start": "execute",
    "archive": "close",
    "record-gate": prev.get("phase", "define"),
    "patch": prev.get("phase", "define"),
}
kernel = {
    "schemaVersion": 1,
    "identity": {"taskId": task_id},
    "revision": revision,
    "phase": phase_by_op.get(op, "define"),
    "condition": "ready",
    "outcome": "completed" if op == "archive" else None,
    "audit": list(prev.get("audit") or []) + [{
        "id": "a1",
        "idempotencyKey": req.get("idempotencyKey"),
        "actor": req.get("actor"),
    }],
    "gates": prev.get("gates") or {"schemaVersion": 1, "transitions": {}},
    "projection": {"status": status, "record": record, "extras": req.get("extras") or {}},
}
if op == "record-gate":
    kernel["gates"].setdefault("transitions", {}).setdefault(req["transition"], {})[req["gate"]] = req["record"]

kernel_path.write_text(json.dumps(kernel, indent=2), encoding="utf-8")
projected = dict(existing_task)
if op != "record-gate" and isinstance(record, dict) and record:
    projected.update(record)
    if isinstance(record.get("meta"), dict) and isinstance(existing_task.get("meta"), dict):
        projected["meta"] = {**existing_task["meta"], **record["meta"]}
    projected["status"] = status
projected.update(req.get("extras") or {})
if projected:
    task_path.write_text(json.dumps(projected, indent=2), encoding="utf-8")

dump({
    "ok": True,
    "op": op,
    "kernel": kernel,
    "persisted": True,
    "projected": True,
    "idempotent": False,
    "legacy": {"status": status, "id": task_id, "name": task_id, "title": ""},
    "audit": kernel["audit"][-1],
})
"""


@pytest.fixture
def fake_kernel(tmp_path, monkeypatch):
    script = tmp_path / "fake_kernel.py"
    script.write_text(FAKE_KERNEL, encoding="utf-8")
    monkeypatch.setattr(
        kernel_command_mod,
        "kernel_cli_argv",
        lambda: [sys.executable, str(script)],
    )
    return script


def _record(**overrides):
    data = {
        "id": "shim-demo",
        "name": "shim-demo",
        "title": "Shim Demo",
        "description": "",
        "status": "planning",
        "dev_type": None,
        "scope": None,
        "package": None,
        "priority": "P2",
        "creator": "tester",
        "assignee": "tester",
        "createdAt": "2026-08-28",
        "completedAt": None,
        "branch": None,
        "base_branch": "main",
        "worktree_path": None,
        "commit": None,
        "pr_url": None,
        "subtasks": [],
        "children": [],
        "parent": None,
        "relatedFiles": [],
        "notes": "",
        "meta": {},
    }
    data.update(overrides)
    return data


def test_to_kernel_record_fills_canonical_fields():
    record = to_kernel_record({"id": "a", "name": "a", "title": "A"})
    assert record["status"] == "planning"
    assert record["priority"] == "P2"
    assert record["children"] == []
    assert record["meta"] == {}


def test_create_updates_kernel_json(fake_kernel, tmp_path):
    task_dir = tmp_path / "task"
    result = kernel_create(
        task_dir,
        _record(),
        actor="task.py create",
        idempotency_key="create:shim-demo",
    )
    assert result["ok"] is True
    assert (task_dir / "kernel.json").is_file()
    kernel = json.loads((task_dir / "kernel.json").read_text(encoding="utf-8"))
    assert kernel["revision"] >= 1
    task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert task["status"] == "planning"


def test_start_projects_in_progress(fake_kernel, tmp_path):
    task_dir = tmp_path / "task"
    kernel_create(task_dir, _record(), actor="a", idempotency_key="create:shim-demo")
    rev = kernel_expected_revision(task_dir)
    started = kernel_start(
        task_dir,
        _record(status="in_progress"),
        {"execution_approval": {"approved_by": "user"}},
        expected_revision=rev,
        actor="task.py start-execution --approved",
        idempotency_key="start:shim-demo",
    )
    assert started["legacy"]["status"] == "in_progress"
    task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert task["status"] == "in_progress"
    assert task["execution_approval"]["approved_by"] == "user"


def test_record_gate_and_archive_go_through_kernel(fake_kernel, tmp_path):
    task_dir = tmp_path / "task"
    kernel_create(task_dir, _record(), actor="a", idempotency_key="create:shim-demo")
    data = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    gate = {"result": "PASS", "evidence": "verify.md", "reviewer": "tester"}
    write_gate_record(data, "start-execution", "code-review", gate)
    extras = collect_kernel_projection_extras(data)
    kernel_record_gate(
        task_dir,
        expected_revision=kernel_expected_revision(task_dir),
        actor="task.py record-gate",
        idempotency_key="gate:code-review",
        transition="start-execution",
        gate="code-review",
        record=gate,
        extras=extras,
        evidence="verify.md",
    )
    kernel = json.loads((task_dir / "kernel.json").read_text(encoding="utf-8"))
    assert kernel["gates"]["transitions"]["start-execution"]["code-review"]["result"] == "PASS"

    archived = kernel_archive(
        task_dir,
        _record(status="completed", completedAt="2026-08-28"),
        extras,
        expected_revision=kernel_expected_revision(task_dir),
        actor="task.py archive",
        idempotency_key="archive:shim-demo",
    )
    assert archived["kernel"]["phase"] == "close"
    task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert task["status"] == "completed"


def test_half_conversion_is_not_success(tmp_path, monkeypatch):
    script = tmp_path / "failing_kernel.py"
    script.write_text(
        "import json,sys\n"
        "json.loads(sys.stdin.read())\n"
        "sys.stdout.write(json.dumps({"
        '"ok": False, "error": {"code": "HALF_CONVERSION", "message": "projection failed"},'
        '"halfConversion": {"kernelPersisted": True, "projectionPersisted": False}'
        "})+'\\n')\n"
        "sys.exit(1)\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        kernel_command_mod,
        "kernel_cli_argv",
        lambda: [sys.executable, str(script)],
    )
    with pytest.raises(KernelCommandError) as exc:
        run_kernel_command({"op": "create", "taskDir": str(tmp_path / "t")})
    assert "HALF_CONVERSION" in str(exc.value)
    assert exc.value.result["halfConversion"]["kernelPersisted"] is True
    assert exc.value.result["halfConversion"]["projectionPersisted"] is False


def test_kernel_patch_updates_meta_and_kernel_revision(fake_kernel, tmp_path):
    task_dir = tmp_path / "task"
    kernel_create(task_dir, _record(), actor="a", idempotency_key="create:shim-demo")
    data = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    data["meta"] = {"depends_mode": "block"}
    patched = kernel_patch(
        task_dir,
        data,
        kernel_projection_extras(data),
        expected_revision=kernel_expected_revision(task_dir),
        actor="task.py set-depends-mode",
        idempotency_key="patch:depends-mode:task:block",
    )
    assert patched["ok"] is True
    kernel = json.loads((task_dir / "kernel.json").read_text(encoding="utf-8"))
    assert kernel["revision"] >= 2
    assert kernel["audit"][-1]["idempotencyKey"] == "patch:depends-mode:task:block"
    task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert task["status"] == "planning"
    assert task["meta"]["depends_mode"] == "block"


def test_set_task_artifact_locale_goes_through_kernel(fake_kernel, tmp_path):
    task_dir = tmp_path / "task"
    kernel_create(task_dir, _record(), actor="a", idempotency_key="create:shim-demo")
    set_task_artifact_locale(task_dir, "en")
    kernel = json.loads((task_dir / "kernel.json").read_text(encoding="utf-8"))
    assert kernel["revision"] >= 2
    task = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert task["meta"]["artifact_locale"] == "en"
    assert task["status"] == "planning"


def test_projection_extra_keys_include_baseline_modules() -> None:
    assert "baseline_modules" in KERNEL_PROJECTION_EXTRA_KEYS
    assert tuple(KERNEL_PROJECTION_EXTRA_KEYS) == tuple(GATES_PROJECTION_EXTRA_KEYS)
