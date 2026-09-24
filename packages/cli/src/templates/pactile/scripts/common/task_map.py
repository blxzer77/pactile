#!/usr/bin/env python3
"""
Parent/Child task-map helpers.

task-map.md is a projection of the Kernel Topology / Dependency Graph plus
Parent orchestration fields (child worker state, event log). Graph authority
is Kernel extras (`topology`, `dependency_graph`); this module may render,
not invent, typed edges.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path


TASK_MAP = "task-map.md"

CHILD_STATES = {
    "open",
    "working",
    "blocked",
    "review",
    "changes",
    "accepted",
    "integrating",
    "integrated",
    "cancelled",
}

PARENT_TERMINAL_STATES = {"integrated", "cancelled"}
PARENT_CONTROLLED_STATES = {
    "changes",
    "accepted",
    "integrating",
    "integrated",
    "cancelled",
}
CHILD_REPORT_STATES = CHILD_STATES - PARENT_CONTROLLED_STATES
REF_REQUIRED_STATES = {"accepted", "integrating", "integrated"}
HANDOFF_REQUIRED_STATES = {"accepted", "integrating", "integrated"}


def utc_now() -> str:
    """Return a compact UTC timestamp for task-map event log entries."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def load_task_map(parent_dir: Path) -> tuple[dict | None, str]:
    """Load task-map.md frontmatter and body."""
    path = parent_dir / TASK_MAP
    if not path.is_file():
        return None, ""

    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return None, ""

    frontmatter, body = _split_frontmatter(content)
    if frontmatter is None:
        return None, content
    return _parse_frontmatter(frontmatter), body


def ensure_task_map(
    parent_dir: Path,
    parent_data: dict,
    child_names: list[str],
    event: str | None = None,
) -> dict:
    """Ensure task-map.md exists and contains entries for all child_names."""
    data, body = load_task_map(parent_dir)
    if data is None:
        data = {
            "parent_id": parent_data.get("id") or parent_dir.name,
            "contract_epoch": 1,
            "execution_topology": "parallel",
            "merge_limit": 1,
            "children": [],
            "stages": [],
            "integration_queue": [],
        }
        body = _default_body()

    data.setdefault("parent_id", parent_data.get("id") or parent_dir.name)
    data.setdefault("contract_epoch", 1)
    data.setdefault("execution_topology", "parallel")
    data.setdefault("merge_limit", 1)
    data.setdefault("children", [])
    data.setdefault("stages", [])
    data.setdefault("integration_queue", [])

    existing = {
        child.get("id"): child
        for child in data.get("children", [])
        if isinstance(child, dict)
    }
    for child_name in child_names:
        if child_name not in existing:
            child = _default_child(child_name)
            data["children"].append(child)
            existing[child_name] = child

    extras = {
        key: parent_data[key]
        for key in ("topology", "dependency_graph")
        if key in parent_data
    }
    if extras:
        from .ondemand_topology import apply_kernel_graph_projection

        apply_kernel_graph_projection(data, extras)

    write_task_map(parent_dir, data, body, event)
    return data


def remove_child_from_task_map(
    parent_dir: Path,
    parent_data: dict,
    child_name: str,
) -> None:
    """Remove a child entry from task-map.md when structural links are removed."""
    data, body = load_task_map(parent_dir)
    if data is None:
        return

    children = data.get("children")
    if isinstance(children, list):
        data["children"] = [
            child
            for child in children
            if not isinstance(child, dict) or child.get("id") != child_name
        ]
    data.setdefault("parent_id", parent_data.get("id") or parent_dir.name)
    write_task_map(parent_dir, data, body, f"Unlinked Child `{child_name}`.")


def resolve_child_map_id(
    parent_data: dict,
    child_dir: Path,
    child_data: dict | None = None,
) -> str:
    """Resolve task-map child id for a child directory (nested slash slugs)."""
    structural = parent_data.get("children", [])
    if not isinstance(structural, list):
        structural = []

    leaf = child_dir.name
    if leaf in structural:
        return leaf

    if child_data:
        for key in ("name", "id"):
            value = child_data.get(key)
            if isinstance(value, str) and value in structural:
                return value

    suffix_matches = [
        cid
        for cid in structural
        if isinstance(cid, str) and (cid == leaf or cid.endswith(f"/{leaf}"))
    ]
    if len(suffix_matches) == 1:
        return suffix_matches[0]

    return leaf


def set_child_state(
    parent_dir: Path,
    parent_data: dict,
    child_name: str,
    state: str,
    evidence: str,
    reason: str | None = None,
) -> tuple[bool, list[str]]:
    """Set a child state inside Parent task-map.md."""
    errors: list[str] = []
    if state not in CHILD_STATES:
        errors.append(f"unknown child state: {state}")
    if not _short_text(evidence):
        errors.append("evidence must be a short reference")
    if reason and not _short_text(reason, 500):
        errors.append("reason must be short and single-line")
    if errors:
        return False, errors

    structural_children = parent_data.get("children", [])
    if child_name not in structural_children:
        errors.append(f"child is not linked to parent: {child_name}")
        return False, errors

    data = ensure_task_map(parent_dir, parent_data, list(structural_children))
    child = get_child_entry(data, child_name)
    if child is None:
        errors.append(f"child missing from task-map.md: {child_name}")
        return False, errors

    child["state"] = state
    child["evidence"] = evidence
    if reason:
        child["reason"] = reason

    event = f"Set Child `{child_name}` state to `{state}`. Evidence: {evidence}."
    if reason:
        event = f"{event} Reason: {reason}."
    _, body = load_task_map(parent_dir)
    write_task_map(parent_dir, data, body, event)
    return True, []


def validate_parent_child_integration(
    parent_dir: Path,
    parent_data: dict,
    child_dir: Path,
    child_data: dict,
    state: str,
    evidence: str,
    ref: str | None = None,
    reason: str | None = None,
    current_state_override: str | None = None,
) -> list[str]:
    """Validate a Parent-controlled Child integration state transition."""
    errors: list[str] = []
    child_name = resolve_child_map_id(parent_data, child_dir, child_data)
    if state not in PARENT_CONTROLLED_STATES:
        errors.append(f"state is not Parent-controlled: {state}")
    if not _short_text(evidence):
        errors.append("evidence must be a short reference")
    if reason and not _short_text(reason, 500):
        errors.append("reason must be short and single-line")
    if state in {"changes", "cancelled"} and not reason:
        errors.append(f"{state} requires --reason")
    if state in REF_REQUIRED_STATES and not _short_text(ref):
        errors.append(f"{state} requires --ref")

    if child_data.get("parent") != parent_dir.name:
        errors.append(f"child is not linked to parent: {child_name}")

    structural_children = parent_data.get("children", [])
    if child_name not in structural_children:
        errors.append(f"child is not linked to parent: {child_name}")

    data, _ = load_task_map(parent_dir)
    if data is None:
        errors.append(f"{TASK_MAP}")
        return errors

    child = get_child_entry(data, child_name)
    if child is None:
        errors.append(f"child missing from task-map.md: {child_name}")
        return errors

    current_state = (
        current_state_override
        if current_state_override is not None
        else child.get("state")
    )
    if state in {"accepted", "changes"} and current_state != "review":
        errors.append(f"{state} requires current Child state 'review', got {current_state!r}")
    if state == "integrating" and current_state != "accepted":
        errors.append(f"integrating requires current Child state 'accepted', got {current_state!r}")
    if state == "integrated" and current_state != "integrating":
        errors.append(f"integrated requires current Child state 'integrating', got {current_state!r}")

    if state in HANDOFF_REQUIRED_STATES:
        errors.extend(_required_child_evidence(child_dir, ["verify.md", "handoff.md"]))

    if state == "integrating":
        merge_limit = data.get("merge_limit", 1)
        if not isinstance(merge_limit, int) or merge_limit < 1:
            errors.append("merge_limit must be a positive integer")
        else:
            integrating = [
                item.get("id")
                for item in data.get("children", [])
                if isinstance(item, dict)
                and item.get("id") != child_name
                and item.get("state") == "integrating"
            ]
            if len(integrating) >= merge_limit:
                errors.append(
                    f"merge_limit {merge_limit} blocks integrating {child_name}; already integrating: {', '.join(str(item) for item in integrating)}"
                )

    if state == "accepted":
        from .task_gates import task_closeout_profile, validate_transition_readiness

        profile = task_closeout_profile(child_dir, child_data)
        if profile == "full":
            errors.extend(
                validate_transition_readiness(
                    child_dir,
                    child_data,
                    "child-review",
                    mode="complete",
                )
            )
        elif profile == "parent":
            errors.extend(
                validate_transition_readiness(
                    child_dir,
                    child_data,
                    "parent-integrated",
                    mode="complete",
                )
            )

    return errors


def set_parent_child_integration_state(
    parent_dir: Path,
    parent_data: dict,
    child_dir: Path,
    child_data: dict,
    state: str,
    evidence: str,
    ref: str | None = None,
    reason: str | None = None,
    merge_ref: str | None = None,
) -> tuple[bool, list[str]]:
    """Set a Parent-controlled Child integration state."""
    errors = validate_parent_child_integration(
        parent_dir,
        parent_data,
        child_dir,
        child_data,
        state,
        evidence,
        ref,
        reason,
    )
    if errors:
        return False, errors

    child_name = resolve_child_map_id(parent_data, child_dir, child_data)
    data = ensure_task_map(parent_dir, parent_data, list(parent_data.get("children", [])))
    child = get_child_entry(data, child_name)
    if child is None:
        return False, [f"child missing from task-map.md: {child_name}"]

    child["state"] = state
    child["evidence"] = evidence
    if ref:
        child["ref"] = ref
    if merge_ref:
        child["merged_ref"] = merge_ref
    if reason:
        child["reason"] = reason
    elif "reason" in child:
        del child["reason"]

    queue = data.get("integration_queue")
    if not isinstance(queue, list):
        queue = []
        data["integration_queue"] = queue
    if state == "integrating":
        if child_name not in queue:
            queue.append(child_name)
    elif child_name in queue:
        data["integration_queue"] = [item for item in queue if item != child_name]

    event = f"Parent set Child `{child_name}` integration state to `{state}`. Evidence: {evidence}."
    if ref:
        event = f"{event} Ref: {ref}."
    if merge_ref:
        event = f"{event} Merge executed: git merge --no-ff --no-commit {merge_ref}."
    if reason:
        event = f"{event} Reason: {reason}."
    _, body = load_task_map(parent_dir)
    write_task_map(parent_dir, data, body, event)
    return True, []


def record_child_worktree(
    parent_dir: Path,
    parent_data: dict,
    child_name: str,
    branch: str,
    worktree_path: str,
    base_ref: str,
) -> tuple[bool, list[str]]:
    """Record a Child git worktree checkout in Parent task-map.md."""
    errors: list[str] = []
    if not _short_text(branch):
        errors.append("branch must be a short reference")
    if not _short_text(worktree_path):
        errors.append("worktree_path must be a short path reference")
    if not _short_text(base_ref):
        errors.append("base_ref must be a short reference")

    structural_children = parent_data.get("children", [])
    if child_name not in structural_children:
        errors.append(f"child is not linked to parent: {child_name}")
    if errors:
        return False, errors

    data = ensure_task_map(parent_dir, parent_data, list(structural_children))
    child = get_child_entry(data, child_name)
    if child is None:
        return False, [f"child missing from task-map.md: {child_name}"]

    child["isolation"] = "git-worktree"
    child["branch"] = branch
    child["worktree_path"] = worktree_path
    child["base_ref"] = base_ref
    child["ref"] = f"refs/heads/{branch}"

    event = (
        f"Prepared Child `{child_name}` git worktree. "
        f"Branch: {branch}. Path: {worktree_path}. Base: {base_ref}."
    )
    _, body = load_task_map(parent_dir)
    write_task_map(parent_dir, data, body, event)
    return True, []


def get_child_entry(data: dict | None, child_name: str) -> dict | None:
    """Return a child map entry by id."""
    if not data:
        return None
    children = data.get("children")
    if not isinstance(children, list):
        return None
    for child in children:
        if isinstance(child, dict) and child.get("id") == child_name:
            return child
    return None


def get_child_state(parent_dir: Path, child_name: str) -> str | None:
    """Return child state from a Parent task-map.md."""
    data, _ = load_task_map(parent_dir)
    child = get_child_entry(data, child_name)
    if not child:
        return None
    state = child.get("state")
    return state if isinstance(state, str) else None


def validate_parent_children_complete(parent_dir: Path, child_names: list[str]) -> list[str]:
    """Validate every structural child is integrated or cancelled."""
    errors: list[str] = []
    data, _ = load_task_map(parent_dir)
    if data is None:
        return [f"{TASK_MAP}"]

    for child_name in child_names:
        child = get_child_entry(data, child_name)
        if child is None:
            errors.append(f"{TASK_MAP} missing child entry: {child_name}")
            continue
        state = child.get("state")
        if state not in PARENT_TERMINAL_STATES:
            errors.append(
                f"child {child_name} must be integrated or cancelled before parent archive, got {state!r}"
            )
    return errors


def validate_child_archive_state(parent_dir: Path, child_name: str) -> list[str]:
    """Validate the Parent has marked a Child terminal before child archive."""
    state = get_child_state(parent_dir, child_name)
    if state is None:
        return [f"{TASK_MAP} missing child entry: {child_name}"]
    if state not in PARENT_TERMINAL_STATES:
        return [
            f"Parent task-map.md must mark child {child_name} integrated or cancelled before archive, got {state!r}"
        ]
    return []


def write_task_map(
    parent_dir: Path,
    data: dict,
    body: str,
    event: str | None = None,
) -> None:
    """Write task-map.md from structured snapshot and Markdown body."""
    normalized_body = body if body.strip() else _default_body()
    if event:
        normalized_body = _append_event(normalized_body, event)
    content = f"---\n{_format_frontmatter(data)}---\n{normalized_body.lstrip()}"
    (parent_dir / TASK_MAP).write_text(content, encoding="utf-8")


def _default_child(child_name: str) -> dict:
    return {
        "id": child_name,
        "state": "open",
        "depends_on": [],
        "touches": [],
        "isolation": "git-worktree",
        "ref": None,
    }


def _default_body() -> str:
    return (
        "# Task Map\n\n"
        "## Orchestration notes\n\n"
        "- **parallel-first:** Use independent, bounded work only when dependencies and "
        "write sets allow it. Pactile does not yet schedule Codex tasks or Pi workers.\n"
        "- `execution_topology: parallel` — default when ≥2 children have empty `depends_on`. "
        "Parent `integrate-child`, HITL, `start-execution --approved`, and reviewer gates stay "
        "serial (`merge_limit`).\n"
        "- `serial_reason` — required when topology is `serial`. One of: shared write-set / "
        "HITL or reviewer gate / `depends_on` unmet / user asked serial / conflict surface "
        "cannot isolate.\n"
        "- `stages:` (or `parallel_groups`) — concurrently runnable child id groups.\n"
        "- `merge_points` — where serial join happens (usually `integrate-child` + gates). "
        "Default `merge_limit: 1`.\n"
        "- `touches` (or `conflict_surface`) — write-sets that can collide; declare before dispatch.\n"
        "- Child-reported states: `open` → `working` → `blocked` | `review`.\n"
        "- Parent-controlled states: `review` → `changes` | `accepted` → `integrating` → "
        "`integrated` | `cancelled`.\n"
        "- `isolation: git-worktree` — run `prepare-child-worktree` from the **git package root** "
        "(not a non-git harness root).\n\n"
        "## Event Log\n\n"
    )


def _append_event(body: str, event: str) -> str:
    stripped = body.rstrip()
    if "## Event Log" not in stripped:
        stripped = f"{stripped}\n\n## Event Log"
    return f"{stripped}\n\n- {utc_now()} - {event}\n"


def _split_frontmatter(content: str) -> tuple[str | None, str]:
    lines = content.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return None, content

    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            frontmatter = "".join(lines[1:idx])
            body = "".join(lines[idx + 1 :])
            return frontmatter, body
    return None, content


def _parse_frontmatter(frontmatter: str) -> dict:
    """Parse the small YAML subset written by this module.

    Supports top-level scalars plus list-of-maps for ``children:`` and optional
    ``stages:`` (same indentation style).
    """
    data: dict = {"children": [], "stages": []}
    current_item: dict | None = None
    list_key: str | None = None

    for raw_line in frontmatter.splitlines():
        if not raw_line.strip():
            continue

        if raw_line.startswith("children:"):
            list_key = "children"
            data["children"] = []
            current_item = None
            continue

        if raw_line.startswith("stages:"):
            list_key = "stages"
            data["stages"] = []
            current_item = None
            continue

        if list_key and raw_line.startswith("  - "):
            current_item = {}
            data[list_key].append(current_item)
            item = raw_line[4:].strip()
            if ":" in item:
                key, value = item.split(":", 1)
                current_item[key.strip()] = _parse_value(value.strip())
            continue

        if list_key and raw_line.startswith("    ") and current_item is not None:
            item = raw_line.strip()
            if ":" in item:
                key, value = item.split(":", 1)
                current_item[key.strip()] = _parse_value(value.strip())
            continue

        list_key = None
        current_item = None
        if ":" in raw_line:
            key, value = raw_line.split(":", 1)
            data[key.strip()] = _parse_value(value.strip())

    return data


def _parse_value(value: str):
    if value == "null":
        return None
    if value == "[]":
        return []
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [item.strip().strip("'\"") for item in inner.split(",") if item.strip()]
    if value.isdigit():
        return int(value)
    return value.strip("'\"")


def _format_frontmatter(data: dict) -> str:
    lines = [
        f"parent_id: {_format_value(data.get('parent_id'))}",
        f"contract_epoch: {_format_value(data.get('contract_epoch', 1))}",
        f"execution_topology: {_format_value(data.get('execution_topology', 'parallel'))}",
        f"merge_limit: {_format_value(data.get('merge_limit', 1))}",
    ]
    if data.get("serial_reason"):
        lines.append(f"serial_reason: {_format_value(data.get('serial_reason'))}")
    if data.get("parallel_groups"):
        lines.append(f"parallel_groups: {_format_value(data.get('parallel_groups'))}")
    if data.get("merge_points"):
        lines.append(f"merge_points: {_format_value(data.get('merge_points'))}")
    if data.get("conflict_surface"):
        lines.append(f"conflict_surface: {_format_value(data.get('conflict_surface'))}")
    if data.get("graph_authority"):
        lines.append(f"graph_authority: {_format_value(data.get('graph_authority'))}")
    if data.get("topology_kind"):
        lines.append(f"topology_kind: {_format_value(data.get('topology_kind'))}")
    lines.append("children:")
    children = data.get("children", [])
    if isinstance(children, list):
        for child in children:
            if not isinstance(child, dict):
                continue
            lines.append(f"  - id: {_format_value(child.get('id'))}")
            lines.append(f"    state: {_format_value(child.get('state', 'open'))}")
            lines.append(f"    depends_on: {_format_value(child.get('depends_on', []))}")
            lines.append(f"    touches: {_format_value(child.get('touches', []))}")
            lines.append(f"    isolation: {_format_value(child.get('isolation', 'git-worktree'))}")
            lines.append(f"    ref: {_format_value(child.get('ref'))}")
            if child.get("branch"):
                lines.append(f"    branch: {_format_value(child.get('branch'))}")
            if child.get("worktree_path"):
                lines.append(f"    worktree_path: {_format_value(child.get('worktree_path'))}")
            if child.get("base_ref"):
                lines.append(f"    base_ref: {_format_value(child.get('base_ref'))}")
            if child.get("merged_ref"):
                lines.append(f"    merged_ref: {_format_value(child.get('merged_ref'))}")
            if child.get("evidence"):
                lines.append(f"    evidence: {_format_value(child.get('evidence'))}")
            if child.get("reason"):
                lines.append(f"    reason: {_format_value(child.get('reason'))}")
    stages = data.get("stages") or []
    if isinstance(stages, list) and stages:
        lines.append("stages:")
        for stage in stages:
            if not isinstance(stage, dict):
                continue
            lines.append(f"  - id: {_format_value(stage.get('id'))}")
            if stage.get("title"):
                lines.append(f"    title: {_format_value(stage.get('title'))}")
            lines.append(f"    units: {_format_value(stage.get('units', []))}")
    lines.append(f"integration_queue: {_format_value(data.get('integration_queue', []))}")
    return "\n".join(lines) + "\n"


def _format_value(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, list):
        if not value:
            return "[]"
        return "[" + ", ".join(str(item) for item in value) + "]"
    return str(value)


def _short_text(value: str | None, max_len: int = 240) -> bool:
    if not value or not isinstance(value, str):
        return False
    if len(value) > max_len:
        return False
    if "\n" in value or "\r" in value:
        return False
    return True


def _required_child_evidence(child_dir: Path, names: list[str]) -> list[str]:
    errors: list[str] = []
    for name in names:
        path = child_dir / name
        if not path.is_file():
            errors.append(name)
            continue
        try:
            if not path.read_text(encoding="utf-8").strip():
                errors.append(f"{name} is empty")
        except OSError:
            errors.append(f"{name} could not be read")
    return errors
