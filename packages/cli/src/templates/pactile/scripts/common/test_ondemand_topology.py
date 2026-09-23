#!/usr/bin/env python3
"""Stage 5 Topology / On-demand Python projection."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.ondemand_topology import (
    ONDEMAND_OWNERS,
    ONDEMAND_TRIGGER_HINTS,
    STAGE5_ONDEMAND_MODULES,
    TopologyError,
    activate_ondemand_module,
    apply_kernel_graph_projection,
    apply_retention,
    assert_integration_authority,
    assign_parent,
    capture_candidate,
    confirm_decompose,
    deactivate_ondemand_module,
    default_topology,
    expand_depends_on_to_requires,
    is_ondemand_module_active,
    project_task_map_graph,
    propose_decompose,
    resident_on_demand_modules,
    unmet_requires,
)
from common.task_map import ensure_task_map


def test_capture_and_decompose_do_not_create() -> None:
    candidate = capture_candidate("later")
    assert candidate["task_created"] is False
    proposal = propose_decompose("parent-a", ["child-a"])
    assert proposal["confirmed"] is False
    assert proposal["children_created"] == []
    confirmed = confirm_decompose(proposal)
    assert confirmed["confirmed"] is True
    assert confirmed["children_created"] == ["child-a"]


def test_default_topology_parent_id_alone_is_single() -> None:
    linked = default_topology(parent="parent-a", children=[])
    assert linked["kind"] == "single"
    assert linked["parent_id"] == "parent-a"
    controller = default_topology(parent=None, children=["child-a"])
    assert controller["kind"] == "parent-child"


def test_assign_parent_keeps_ordinary_child_single() -> None:
    linked = assign_parent({"parent_id": None, "children": []}, "parent-a")
    assert linked["kind"] == "single"
    assert linked["parent_id"] == "parent-a"
    nested = assign_parent({"parent_id": None, "children": ["child-a"]}, "grand")
    assert nested["kind"] == "parent-child"
    assert nested["children"] == ["child-a"]


def test_second_parent_and_child_integrate_rejected() -> None:
    topology = {"parent_id": "parent-a", "children": []}
    with pytest.raises(TopologyError, match="second parent"):
        assign_parent(topology, "parent-b")
    with pytest.raises(TopologyError, match="Integration authority"):
        assert_integration_authority("child")
    assert_integration_authority("parent")


def test_requires_blocks_advisory_does_not() -> None:
    graph = expand_depends_on_to_requires(
        {"edges": [{"from": "here", "to": "hint", "type": "advisory"}]},
        "here",
        ["upstream"],
    )
    assert unmet_requires(graph, [], from_id="here") == ["upstream"]
    assert unmet_requires(graph, ["upstream"], from_id="here") == []
    assert unmet_requires(graph, [], from_id="other") == []


def test_task_map_is_kernel_graph_projection(tmp_path: Path) -> None:
    parent_dir = tmp_path / "parent"
    parent_dir.mkdir()
    extras = {
        "topology": {
            "kind": "parent-child",
            "parent_id": "parent-a",
            "children": ["child-a"],
        },
        "dependency_graph": {
            "edges": [{"from": "child-a", "to": "upstream", "type": "requires"}],
        },
    }
    projection = project_task_map_graph(extras["topology"], extras["dependency_graph"])
    assert projection["graph_authority"] == "kernel-extras"
    assert projection["children"] == [{"id": "child-a", "depends_on": ["upstream"]}]

    data = ensure_task_map(
        parent_dir,
        {"id": "parent-a", **extras},
        ["child-a"],
    )
    assert data["graph_authority"] == "kernel-extras"
    assert data["topology_kind"] == "parent-child"
    child = next(item for item in data["children"] if item["id"] == "child-a")
    assert child["depends_on"] == ["upstream"]
    apply_kernel_graph_projection(data, extras)
    assert data["graph_authority"] == "kernel-extras"


def test_worker_orchestration_hints_include_isolatable_window() -> None:
    assert "isolatable-group-dispatch-window" in ONDEMAND_TRIGGER_HINTS["worker-orchestration"]


def test_ondemand_defaults_and_retention_outcome() -> None:
    extras = {
        "ondemand_modules": {
            "registered": list(STAGE5_ONDEMAND_MODULES),
            "active": [],
            "owners": dict(ONDEMAND_OWNERS),
        }
    }
    assert resident_on_demand_modules(extras) == []
    assert ONDEMAND_OWNERS["integration-handoff"] == "parent-child"
    assert ONDEMAND_OWNERS["session-transfer"] == "session-transfer"
    assert apply_retention("completed") == "completed"
    assert "independent-check" in STAGE5_ONDEMAND_MODULES
    assert "retrieval-extended" in STAGE5_ONDEMAND_MODULES
    assert "integration-handoff" not in STAGE5_ONDEMAND_MODULES
    assert len(STAGE5_ONDEMAND_MODULES) == 11
    # candidate-pool was retired with the review-pool feature; the module
    # table must not keep advertising it.
    assert "candidate-pool" not in STAGE5_ONDEMAND_MODULES


def test_first_legal_trigger_writes_active_and_triggers() -> None:
    extras: dict = {}
    activate_ondemand_module(
        extras,
        "worker-orchestration",
        reason="user-dispatch",
        at="2026-08-31T00:00:00Z",
    )
    activate_ondemand_module(
        extras,
        "retrieval-extended",
        reason="collected-evidence-ranking",
        at="2026-08-31T00:00:01Z",
    )
    activate_ondemand_module(
        extras,
        "independent-check",
        reason="rigor-full",
        at="2026-08-31T00:00:02Z",
    )
    block = extras["ondemand_modules"]
    assert "worker-orchestration" in block["active"]
    assert "retrieval-extended" in block["active"]
    assert "independent-check" in block["active"]
    assert [row["module"] for row in block["triggers"]] == [
        "worker-orchestration",
        "retrieval-extended",
        "independent-check",
    ]
    with pytest.raises(TopologyError, match="owner mapping"):
        activate_ondemand_module(extras, "integration-handoff", reason="handoff")

    hook_names = {item.get("hook") for item in extras["event_bridge"]["subscriptions"]}
    assert "inject-subagent-context.py" in hook_names
    assert "inject-retrieval-plan.py" in hook_names
    deactivate_ondemand_module(extras, "worker-orchestration")
    hook_names = {item.get("hook") for item in extras["event_bridge"]["subscriptions"]}
    assert "inject-subagent-context.py" not in hook_names
    assert "inject-retrieval-plan.py" in hook_names


def test_unwritten_ondemand_is_not_active(tmp_path: Path) -> None:
    task_dir = tmp_path / "task"
    task_dir.mkdir()
    (task_dir / "task.json").write_text(
        json.dumps({"id": "t", "ondemand_modules": {"active": []}}),
        encoding="utf-8",
    )
    assert is_ondemand_module_active(task_dir, "worker-orchestration") is False
    (task_dir / "task.json").write_text(
        json.dumps(
            {
                "id": "t",
                "ondemand_modules": {"active": ["worker-orchestration"]},
            }
        ),
        encoding="utf-8",
    )
    assert is_ondemand_module_active(task_dir, "worker-orchestration") is True


def test_missing_execute_agent_rejects_start_and_close(tmp_path: Path) -> None:
    from common.task_gates import validate_archive, validate_start_execution_check

    task_dir = tmp_path / "slot-off"
    task_dir.mkdir()
    (task_dir / "prd.md").write_text(
        "# PRD\n\n## Acceptance Criteria\n\n- [ ] one\n",
        encoding="utf-8",
    )
    (task_dir / "verify.md").write_text(
        "# Verification Evidence\n\n"
        "- validation: python -c \"print('ok')\"\n"
        "- acceptance: done\n"
        "- durable learning: no durable learning\n",
        encoding="utf-8",
    )
    data = {
        "id": "slot-off",
        "status": "planning",
        "baseline_modules": {
            "active": [
                "intake-basic",
                "define-basic",
                "approval-personal",
                "verify-basic",
                "close-basic",
                "context-progressive",
                "observability-local",
            ]
        },
    }
    check = validate_start_execution_check(task_dir, data)
    assert not check.ok
    assert any("missing required lifecycle slot: execute-agent" in err for err in check.errors)

    data["status"] = "in_progress"
    archive = validate_archive(task_dir, data)
    assert not archive.ok
    assert any("missing required lifecycle slot: execute-agent" in err for err in archive.errors)
