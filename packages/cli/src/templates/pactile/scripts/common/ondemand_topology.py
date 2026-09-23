"""Stage 5 Topology + typed graph + On-demand (Python projection).

Kernel extras remain authoritative. This module renders and validates the
same contract; it does not schedule workers or write a second graph.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STAGE5_SOURCE = "stage5-ondemand-topology"
STAGE5_SCHEMA_VERSION = 1

# P29 On-demand modules. `integration-handoff` is an owner mapping
# under `parent-child`, not its own activatable module.
STAGE5_ONDEMAND_MODULES = (
    "define-extended",
    "independent-check",
    "worker-orchestration",
    "parent-child",
    "debug-recovery",
    "session-transfer",
    "spec-learning",
    "vcs-integration",
    "personal-memory",
    "retention-storage",
    "retrieval-extended",
)

ONDEMAND_OWNERS = {
    "integration-handoff": "parent-child",
    "session-transfer": "session-transfer",
}

PROFILE_BASELINE_MODULES = (
    "intake-basic",
    "define-basic",
    "approval-personal",
    "execute-agent",
    "verify-basic",
    "close-basic",
    "context-progressive",
    "observability-local",
)

# Documented first-legal-trigger reasons. Tests may pass these; not a hard enum.
ONDEMAND_TRIGGER_HINTS = {
    "worker-orchestration": (
        "isolatable-group-dispatch-window",
        "execution-mode-worker",
        "user-dispatch",
        "independent-check-true-independent",
        "define-extended-research-worker",
    ),
    "retrieval-extended": (
        "collected-evidence-ranking",
        "define-extended-pack",
        "maintainer-probe",
    ),
    "independent-check": (
        "rigor-full",
        "policy-independent-check",
    ),
    "parent-child": (
        "topology-parent-child",
        "user-decompose",
        "multi-deliverable-split",
    ),
}

LITE_DORMANT_ONDEMAND = (
    "parent-child",
    "vcs-integration",
    "personal-memory",
    "retention-storage",
)


class TopologyError(RuntimeError):
    """Topology / On-demand contract rejected a request."""


def capture_candidate(summary: str) -> dict[str, Any]:
    return {
        "kind": "candidate",
        "summary": (summary or "").strip(),
        "task_created": False,
    }


def propose_decompose(parent_id: str, slices: list[str]) -> dict[str, Any]:
    return {
        "parent_id": parent_id,
        "slices": _unique(slices),
        "confirmed": False,
        "children_created": [],
    }


def confirm_decompose(proposal: dict[str, Any]) -> dict[str, Any]:
    slices = _unique(proposal.get("slices") or [])
    return {
        **proposal,
        "confirmed": True,
        "children_created": slices,
    }


def apply_retention(outcome: str) -> str:
    return outcome


def default_topology(
    parent: str | None = None,
    children: list[str] | None = None,
) -> dict[str, Any]:
    """Seed Topology. ``parent_id`` + empty children stays ``single``."""
    kids = _unique(children or [])
    parent_id = (parent or "").strip() or None
    return {
        "schema_version": STAGE5_SCHEMA_VERSION,
        "kind": "parent-child" if kids else "single",
        "parent_id": parent_id,
        "children": kids,
    }


def assign_parent(topology: dict[str, Any], parent_id: str) -> dict[str, Any]:
    current = topology.get("parent_id")
    next_parent = (parent_id or "").strip()
    if not next_parent:
        raise TopologyError("parent_id must be a non-empty string")
    if current and current != next_parent:
        raise TopologyError(
            f"single-parent tree: second parent rejected ({current} vs {next_parent})"
        )
    children = list(topology.get("children") or [])
    return {
        "schema_version": STAGE5_SCHEMA_VERSION,
        "kind": "parent-child" if children else "single",
        "parent_id": next_parent,
        "children": children,
    }


def assert_integration_authority(actor_role: str) -> None:
    if actor_role == "parent":
        return
    raise TopologyError(
        "Integration authority stays with Parent; Child cannot integrate-child"
    )


def expand_depends_on_to_requires(
    graph: dict[str, Any],
    from_id: str,
    depends_on: list[str],
) -> dict[str, Any]:
    edges = list(graph.get("edges") or [])
    for dep in _unique(depends_on):
        if any(
            edge.get("from") == from_id
            and edge.get("to") == dep
            and edge.get("type") == "requires"
            for edge in edges
            if isinstance(edge, dict)
        ):
            continue
        edges.append({"from": from_id, "to": dep, "type": "requires"})
    return {"schema_version": STAGE5_SCHEMA_VERSION, "edges": edges}


def unmet_requires(
    graph: dict[str, Any],
    satisfied: list[str],
    from_id: str | None = None,
) -> list[str]:
    done = set(satisfied)
    missing: list[str] = []
    for edge in graph.get("edges") or []:
        if not isinstance(edge, dict) or edge.get("type") != "requires":
            continue
        if from_id and edge.get("from") != from_id:
            continue
        target = edge.get("to")
        if isinstance(target, str) and target not in done and target not in missing:
            missing.append(target)
    return missing


def project_task_map_graph(
    topology: dict[str, Any],
    graph: dict[str, Any],
) -> dict[str, Any]:
    children = []
    for child_id in topology.get("children") or []:
        if not isinstance(child_id, str):
            continue
        depends = [
            edge.get("to")
            for edge in graph.get("edges") or []
            if isinstance(edge, dict)
            and edge.get("type") == "requires"
            and edge.get("from") == child_id
        ]
        children.append({"id": child_id, "depends_on": depends})
    return {
        "graph_authority": "kernel-extras",
        "topology_kind": topology.get("kind") or "single",
        "parent_id": topology.get("parent_id"),
        "children": children,
    }


def apply_kernel_graph_projection(data: dict[str, Any], extras: dict[str, Any]) -> None:
    """Stamp Parent task-map frontmatter from Kernel extras. Projection only."""
    topology = extras.get("topology")
    graph = extras.get("dependency_graph")
    if not isinstance(topology, dict) and not isinstance(graph, dict):
        return
    projection = project_task_map_graph(
        topology if isinstance(topology, dict) else {},
        graph if isinstance(graph, dict) else {"edges": []},
    )
    data["graph_authority"] = "kernel-extras"
    data["topology_kind"] = projection["topology_kind"]
    if projection.get("parent_id"):
        data["parent_id"] = projection["parent_id"]
    existing = {
        child.get("id"): child
        for child in data.get("children") or []
        if isinstance(child, dict)
    }
    children = data.setdefault("children", [])
    if not isinstance(children, list):
        data["children"] = []
        children = data["children"]
    for child in projection["children"]:
        current = existing.get(child["id"])
        if current is None:
            current = {"id": child["id"], "state": "open", "depends_on": []}
            children.append(current)
            existing[child["id"]] = current
        current["depends_on"] = child["depends_on"]


def resident_on_demand_modules(extras: dict[str, Any]) -> list[str]:
    modules = extras.get("ondemand_modules")
    if not isinstance(modules, dict):
        return []
    active = modules.get("active") or []
    return [name for name in active if isinstance(name, str)]


def default_ondemand_modules() -> dict[str, Any]:
    return {
        "schema_version": STAGE5_SCHEMA_VERSION,
        "source": STAGE5_SOURCE,
        "registered": list(STAGE5_ONDEMAND_MODULES),
        "active": [],
        "triggers": [],
        "owners": dict(ONDEMAND_OWNERS),
        "degraded": [],
    }


def default_baseline_modules() -> dict[str, Any]:
    return {
        "schema_version": STAGE5_SCHEMA_VERSION,
        "source": "profile-runtime",
        "active": list(PROFILE_BASELINE_MODULES),
    }


def extras_from_task_dir(task_dir: Path | str | None) -> dict[str, Any]:
    """Merge Kernel extras with task.json overlay. Missing task → {}."""
    if task_dir is None:
        return {}
    path = Path(task_dir)
    if not path.is_dir():
        return {}
    kernel = _read_json(path / "kernel.json")
    projection = kernel.get("projection") if isinstance(kernel.get("projection"), dict) else {}
    extras = projection.get("extras") if isinstance(projection.get("extras"), dict) else {}
    merged = dict(extras) if isinstance(extras, dict) else {}
    task_data = _read_json(path / "task.json")
    for key in (
        "ondemand_modules",
        "baseline_modules",
        "required_controls",
        "topology",
        "event_bridge",
    ):
        if key not in merged and isinstance(task_data.get(key), dict):
            merged[key] = task_data[key]
    return merged


def is_ondemand_module_active(task_dir: Path | str | None, module_id: str) -> bool:
    """True only after a legal trigger wrote `ondemand_modules.active`."""
    name = (module_id or "").strip()
    if not name:
        return False
    extras = extras_from_task_dir(task_dir)
    return name in resident_on_demand_modules(extras)


def activate_ondemand_module(
    extras: dict[str, Any],
    module_id: str,
    *,
    reason: str,
    at: str | None = None,
) -> dict[str, Any]:
    """First legal trigger writes `active` + `triggers[]` and syncs subscriptions."""
    name = (module_id or "").strip()
    if not name:
        raise TopologyError("ondemand module id must be a non-empty string")
    owner = ONDEMAND_OWNERS.get(name)
    if name == "integration-handoff" or (
        owner == "parent-child" and name not in STAGE5_ONDEMAND_MODULES
    ):
        raise TopologyError(
            "integration-handoff is an owner mapping under parent-child, "
            "not an activatable module"
        )
    if name not in STAGE5_ONDEMAND_MODULES:
        raise TopologyError(f"unknown on-demand module: {name}")

    block = extras.get("ondemand_modules")
    if not isinstance(block, dict):
        block = default_ondemand_modules()
        extras["ondemand_modules"] = block
    registered = block.setdefault("registered", list(STAGE5_ONDEMAND_MODULES))
    if not isinstance(registered, list):
        registered = list(STAGE5_ONDEMAND_MODULES)
        block["registered"] = registered
    if name not in registered:
        registered.append(name)
    active = block.setdefault("active", [])
    if not isinstance(active, list):
        active = []
        block["active"] = active
    if name not in active:
        active.append(name)
    triggers = block.setdefault("triggers", [])
    if not isinstance(triggers, list):
        triggers = []
        block["triggers"] = triggers
    triggers.append(
        {
            "module": name,
            "reason": (reason or "").strip() or "legal-trigger",
            "at": at or _utc_now(),
        }
    )
    _sync_event_bridge(extras)
    return extras


def deactivate_ondemand_module(extras: dict[str, Any], module_id: str) -> dict[str, Any]:
    name = (module_id or "").strip()
    block = extras.get("ondemand_modules")
    if isinstance(block, dict) and isinstance(block.get("active"), list):
        block["active"] = [item for item in block["active"] if item != name]
    _sync_event_bridge(extras)
    return extras


def set_baseline_modules_active(
    extras: dict[str, Any],
    active: list[str],
) -> dict[str, Any]:
    extras["baseline_modules"] = {
        "schema_version": STAGE5_SCHEMA_VERSION,
        "source": "profile-runtime",
        "active": _unique([item for item in active if item in PROFILE_BASELINE_MODULES]),
    }
    _sync_event_bridge(extras)
    return extras


def _sync_event_bridge(extras: dict[str, Any]) -> None:
    try:
        from .adapter_middleware import sync_event_bridge_subscriptions
    except Exception:
        return
    sync_event_bridge_subscriptions(extras)


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _unique(values: list[Any]) -> list[str]:
    out: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        item = value.strip()
        if item and item not in out:
            out.append(item)
    return out
