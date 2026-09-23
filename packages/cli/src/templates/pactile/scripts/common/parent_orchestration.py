#!/usr/bin/env python3
"""
Parent reviewer orchestration: child prompt generation and review workflows.

Inline mode prints prompts and review summaries for manual handoff to external agents.
Subagent-capable platforms may use the same output with platform-specific dispatch.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from .io import read_json
from .paths import get_repo_root
from .task_gates import (
    build_spec_update_scaffold,
    durable_learning_decision_status,
    task_closeout_profile,
)
from .task_map import (
    PARENT_TERMINAL_STATES,
    get_child_entry,
    load_task_map,
    resolve_child_map_id,
    validate_parent_child_integration,
)

_ARTIFACT_NAMES = ("prd.md", "design.md", "implement.md", "verify.md", "handoff.md")
_GLOBAL_CHILD_CONSTRAINTS = """General constraints:
- Read the parent task artifacts first: prd.md, design.md, implement.md, task-map.md, and child-prompts.md when present.
- Read your own child task artifacts: prd.md, design.md, implement.md.
- Stay inside your child scope and declared touch areas.
- Do not publish packages, push remotes, create tags, edit credentials, or change global/MCP configuration.
- Preserve explicit user approval for destructive, remote, credential-bearing, publish, push, tag, and global configuration actions.
- Write `verify.md` and `handoff.md` in your child task directory.
- Handoff must include changed files, validation commands/results, residual risks, and parent integration notes.
- If you find a needed contract change, stop and report it to the parent instead of silently redefining shared state/gate semantics.

Validation baseline:
- Run focused tests for touched behavior.
- Run typecheck when touching TypeScript.
- Run ESLint for changed TypeScript test/source files when applicable.
- Run Python compile checks when touching Python scripts/templates.
- Run `python ./.pactile/scripts/task.py validate <your-child-task>` before handoff."""

_VALIDATION_BASELINE = """Validation baseline:
- Run focused tests for touched behavior.
- Run typecheck when touching TypeScript.
- Run ESLint for changed TypeScript test/source files when applicable.
- Run Python compile checks when touching Python scripts/templates.
- Run `python ./.pactile/scripts/task.py validate <child-dir>` before handoff."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_optional(path: Path, max_chars: int = 12000) -> str | None:
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if len(text) > max_chars:
        return text[:max_chars] + "\n\n...[truncated for prompt]...\n"
    return text


def _repo_rel(path: Path, repo_root: Path) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return str(path)


def _unmet_dependencies(child_entry: dict, children_by_id: dict[str, dict]) -> list[str]:
    deps = child_entry.get("depends_on") or []
    if not isinstance(deps, list):
        return []
    blocked: list[str] = []
    for dep_id in deps:
        if not isinstance(dep_id, str):
            continue
        dep = children_by_id.get(dep_id)
        if dep is None:
            blocked.append(f"{dep_id} (missing from task-map)")
            continue
        state = dep.get("state")
        if state not in PARENT_TERMINAL_STATES:
            blocked.append(f"{dep_id} (state={state!r}, need integrated or cancelled)")
    return blocked


def _child_prompt_section(
    parent_dir: Path,
    child_dir: Path,
    child_entry: dict,
    repo_root: Path,
    *,
    include_artifacts: bool,
) -> str:
    child_name = child_entry.get("id") or child_dir.name
    parent_rel = _repo_rel(parent_dir, repo_root)
    child_rel = _repo_rel(child_dir, repo_root)
    state = child_entry.get("state", "open")
    depends_on = child_entry.get("depends_on") or []
    touches = child_entry.get("touches") or []
    isolation = child_entry.get("isolation") or "git-worktree"

    lines = [
        f"## Child: `{child_name}`",
        "",
        f"- Parent task: `{parent_rel}`",
        f"- Child task: `{child_rel}`",
        f"- Integration state: `{state}`",
        f"- Isolation: `{isolation}`",
    ]
    if depends_on:
        lines.append(f"- Depends on: {', '.join(f'`{d}`' for d in depends_on)}")
    else:
        lines.append("- Depends on: (none)")
    if touches:
        lines.append("- Touch scope:")
        for touch in touches:
            lines.append(f"  - `{touch}`")
    else:
        lines.append("- Touch scope: (not declared in task-map; stay within child prd/design/implement)")

    if include_artifacts:
        lines.append("")
        lines.append("### Child artifacts (context)")
        for name in _ARTIFACT_NAMES:
            content = _read_optional(child_dir / name, max_chars=8000)
            if content:
                lines.append(f"#### {name}")
                lines.append("")
                lines.append(content.strip())
                lines.append("")

    lines.append("### Suggested child worker commands")
    lines.append("")
    lines.append("```bash")
    lines.append(f"python ./.pactile/scripts/task.py select {child_rel}")
    lines.append(
        f"python ./.pactile/scripts/task.py set-child-state {parent_rel} {child_rel} working --evidence implement.md"
    )
    lines.append("# ... implement ...")
    lines.append(
        f"python ./.pactile/scripts/task.py set-child-state {parent_rel} {child_rel} review --evidence verify.md"
    )
    lines.append("```")
    lines.append("")
    return "\n".join(lines)


def build_child_prompt(
    parent_dir: Path,
    child_dir: Path,
    *,
    include_artifacts: bool = False,
    mode: str = "inline",
) -> tuple[str | None, list[str]]:
    """Build an implementation prompt for a linked child task."""
    errors: list[str] = []
    repo_root = get_repo_root()

    parent_json = parent_dir / "task.json"
    if not parent_json.is_file():
        return None, [f"parent task.json missing: {parent_dir}"]

    parent_data = read_json(parent_json) or {}
    child_data = read_json(child_dir / "task.json") or {}
    child_name = resolve_child_map_id(parent_data, child_dir, child_data)

    data, body = load_task_map(parent_dir)
    if data is None:
        return None, ["parent task-map.md missing or invalid"]

    child_entry = get_child_entry(data, child_name)
    if child_entry is None:
        return None, [f"child not in parent task-map: {child_name}"]

    children_by_id = {
        item.get("id"): item
        for item in data.get("children", [])
        if isinstance(item, dict) and item.get("id")
    }
    blocked = _unmet_dependencies(child_entry, children_by_id)

    parent_rel = _repo_rel(parent_dir, repo_root)
    child_rel = _repo_rel(child_dir, repo_root)
    repo_rel = _repo_rel(repo_root, repo_root)

    child_prd = _read_optional(child_dir / "prd.md", 4000)
    child_design = _read_optional(child_dir / "design.md", 4000)
    child_implement = _read_optional(child_dir / "implement.md", 4000)
    parent_child_prompts = _read_optional(parent_dir / "child-prompts.md", 16000)

    goal = ""
    if child_prd:
        goal_match = re.search(r"(?ms)^##\s*Goal\s*\n+(.*?)(?:\n##|\Z)", child_prd)
        if goal_match:
            goal = goal_match.group(1).strip()

    lines = [
        f"You are implementing child task `{child_name}`.",
        "",
        "Workspace:",
        f"- Root: {repo_rel}",
        f"- Parent task: {parent_rel}",
        f"- Child task: {child_rel}",
        "",
    ]

    if blocked:
        lines.extend(
            [
                "Start condition:",
                "- **BLOCKED** — unmet dependencies:",
            ]
        )
        for item in blocked:
            lines.append(f"  - {item}")
        lines.append("- Do not start implementation until dependencies reach `integrated` or `cancelled`.")
        lines.append("")
    elif depends_on := child_entry.get("depends_on"):
        lines.extend(
            [
                "Start condition:",
                f"- Dependencies satisfied: {', '.join(f'`{d}`' for d in depends_on)}.",
                "",
            ]
        )

    lines.extend(
        [
            "Read first:",
            f"- Parent prd.md/design.md/implement.md/task-map.md",
            f"- Child prd.md/design.md/implement.md under `{child_rel}`",
        ]
    )
    if parent_child_prompts and child_name in parent_child_prompts:
        lines.append(f"- Parent child-prompts.md section for `{child_name}` when present")

    if goal:
        lines.extend(["", "Goal:", goal, ""])

    lines.append(_GLOBAL_CHILD_CONSTRAINTS)
    lines.append("")

    if child_implement:
        lines.extend(["Implementation plan (from child implement.md):", child_implement.strip()[:6000], ""])
    elif child_design:
        lines.extend(["Design notes (from child design.md):", child_design.strip()[:4000], ""])

    touches = child_entry.get("touches") or []
    if touches:
        lines.append("Declared touch scope (parent task-map):")
        for touch in touches:
            lines.append(f"- `{touch}`")
        lines.append("")

    if mode == "subagent":
        topo = data.get("execution_topology", "serial")
        merge_lim = data.get("merge_limit", 1)
        lines.extend(
            [
                f"Selected task: {child_rel}",
                "",
                "Delivery mode: child task",
                "- The parent assigns this bounded task to a separate agent session only through an authorized host mechanism.",
                "- Independent Codex task coordination and the Pi bridge are planned; this prompt does not establish that bridge.",
                "- Parent retains `review-child` / `integrate-child`. Child must not broaden its write set.",
                f"- Parent orchestration: `execution_topology={topo}`, `merge_limit={merge_lim}`.",
                "- When `isolation: git-worktree`, prepare worktree from a **git repo root** (e.g. `Pactile/`) before large edits.",
                "",
            ]
        )
    else:
        lines.extend(
            [
                "Delivery mode: inline",
                "- Hand this prompt to the child worker agent or session manually.",
                "- Parent session retains integration authority (`integrate-child`, `review-child`).",
                "",
            ]
        )

    lines.append(_child_prompt_section(parent_dir, child_dir, child_entry, repo_root, include_artifacts=include_artifacts))

    return "\n".join(lines), errors



def _children_by_id(data: dict) -> dict[str, dict]:
    return {
        item.get("id"): item
        for item in data.get("children", [])
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }


def _normalize_stages(data: dict) -> tuple[list[dict], list[str], bool]:
    """Return (stages, errors, used_legacy_default)."""
    errors: list[str] = []
    children = _children_by_id(data)
    raw_stages = data.get("stages") or []
    if not isinstance(raw_stages, list):
        return [], ["task-map stages must be a list"], False

    if not raw_stages:
        units = list(children.keys())
        return (
            [{"id": "default", "title": "All children (no stages declared)", "units": units}],
            [],
            True,
        )

    stages: list[dict] = []
    seen_units: set[str] = set()
    for idx, stage in enumerate(raw_stages):
        if not isinstance(stage, dict):
            errors.append(f"stages[{idx}] must be a mapping")
            continue
        stage_id = stage.get("id")
        if not isinstance(stage_id, str) or not stage_id.strip():
            errors.append(f"stages[{idx}] missing id")
            continue
        units = stage.get("units") or []
        if not isinstance(units, list):
            errors.append(f"stage `{stage_id}` units must be a list")
            continue
        norm_units: list[str] = []
        for unit in units:
            if not isinstance(unit, str) or not unit.strip():
                errors.append(f"stage `{stage_id}` has invalid unit entry")
                continue
            if unit not in children:
                errors.append(f"stage `{stage_id}` unit `{unit}` not in children[]")
                continue
            if unit in seen_units:
                errors.append(f"unit `{unit}` appears in multiple stages")
                continue
            seen_units.add(unit)
            norm_units.append(unit)
        stages.append(
            {
                "id": stage_id,
                "title": stage.get("title") if isinstance(stage.get("title"), str) else "",
                "units": norm_units,
            }
        )
    return stages, errors, False


def _unit_readiness(
    unit_id: str,
    children_by_id: dict[str, dict],
) -> tuple[str, list[str]]:
    entry = children_by_id.get(unit_id) or {}
    blocked = _unmet_dependencies(entry, children_by_id)
    return ("ready" if not blocked else "blocked", blocked)


_PACK_GENERATED_RE = re.compile(r"^- Generated:\s*(.+)$", re.MULTILINE)
_PACK_DASH = r"[\u2014\-]"
_PACK_UNIT_LINE_RE = re.compile(
    rf"^- `([^`]+)` {_PACK_DASH} `([^`]+)` {_PACK_DASH} \*\*(ready|blocked)\*\*",
    re.MULTILINE,
)


def _parse_iso_timestamp(raw: str) -> datetime | None:
    text = raw.strip()
    if not text:
        return None
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        try:
            parsed = datetime.strptime(text, "%Y-%m-%d")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _parse_pack_generated(pack_text: str) -> datetime | None:
    match = _PACK_GENERATED_RE.search(pack_text)
    if not match:
        return None
    return _parse_iso_timestamp(match.group(1))


def _last_integrate_event_time(body: str) -> datetime | None:
    last: datetime | None = None
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        remainder = stripped[2:]
        parts = remainder.split(" - ", 1)
        if len(parts) != 2:
            continue
        ts_raw, message = parts[0].strip(), parts[1]
        lowered = message.lower()
        if "integration state" not in message and "integrate-through" not in lowered:
            continue
        parsed = _parse_iso_timestamp(ts_raw)
        if parsed is not None and (last is None or parsed > last):
            last = parsed
    return last


def _pack_ready_units(pack_text: str) -> set[str]:
    ready: set[str] = set()
    for unit_id, _state, readiness in _PACK_UNIT_LINE_RE.findall(pack_text):
        if readiness == "ready":
            ready.add(unit_id)
    return ready


def _expected_pack_ready_units(
    data: dict,
    children_by_id: dict[str, dict],
) -> set[str]:
    stages, _, _ = _normalize_stages(data)
    ready: set[str] = set()
    for stage in stages:
        for unit in stage.get("units") or []:
            if not isinstance(unit, str):
                continue
            readiness, _ = _unit_readiness(unit, children_by_id)
            if readiness == "ready":
                ready.add(unit)
    return ready


def _pack_unit_states_mismatch(
    pack_text: str,
    children_by_id: dict[str, dict],
) -> bool:
    for unit_id, pack_state, _readiness in _PACK_UNIT_LINE_RE.findall(pack_text):
        entry = children_by_id.get(unit_id) or {}
        current_state = entry.get("state", "?")
        if str(current_state) != pack_state:
            return True
    return False


def _compute_stale_pack(
    parent_dir: Path,
    data: dict,
    body: str,
    children_by_id: dict[str, dict],
) -> bool | None:
    pack_path = parent_dir / "child-prompts" / "PACK.md"
    if not pack_path.is_file():
        return None
    try:
        pack_text = pack_path.read_text(encoding="utf-8")
    except OSError:
        return None

    generated = _parse_pack_generated(pack_text)
    if generated is None:
        return None

    stale = False
    last_integrate = _last_integrate_event_time(body)
    if last_integrate is not None and generated < last_integrate:
        stale = True
    if _pack_unit_states_mismatch(pack_text, children_by_id):
        stale = True
    expected_ready = _expected_pack_ready_units(data, children_by_id)
    if _pack_ready_units(pack_text) != expected_ready:
        stale = True
    return stale


def _compute_newly_ready(children_by_id: dict[str, dict]) -> list[str]:
    ready_ids: list[str] = []
    for unit_id in sorted(children_by_id):
        entry = children_by_id[unit_id]
        if entry.get("state") != "open":
            continue
        readiness, _ = _unit_readiness(unit_id, children_by_id)
        if readiness == "ready":
            ready_ids.append(unit_id)
    return ready_ids


def _child_prompt_filename(unit_id: str) -> str:
    """Flat filename for child-prompts (nested slash unit ids use `--`)."""
    return f"{unit_id.replace('/', '--')}.md"


def build_publish_pack(
    parent_dir: Path,
    *,
    stage_id: str | None = None,
    mode: str = "inline",
    dry_run: bool = False,
) -> tuple[str | None, list[str]]:
    """Build campaign PACK index + per-unit prompts under child-prompts/."""
    errors: list[str] = []
    repo_root = get_repo_root()
    parent_rel = _repo_rel(parent_dir, repo_root)

    if not (parent_dir / "task.json").is_file():
        return None, [f"parent task.json missing: {parent_dir}"]

    data, _ = load_task_map(parent_dir)
    if data is None:
        return None, ["parent task-map.md missing or invalid"]

    stages, stage_errors, legacy = _normalize_stages(data)
    errors.extend(stage_errors)
    if errors:
        return None, errors

    if stage_id:
        stages = [s for s in stages if s.get("id") == stage_id]
        if not stages:
            return None, [f"unknown stage id: {stage_id}"]

    children_by_id = _children_by_id(data)
    prompts_dir = parent_dir / "child-prompts"
    ready_rows: list[tuple[str, str, str]] = []
    blocked_rows: list[tuple[str, str, list[str]]] = []

    pack_lines = [
        f"# Campaign PACK — `{parent_dir.name}`",
        "",
        f"- Parent: `{parent_rel}`",
        f"- Generated: {_utc_now()}",
        f"- Mode: `{mode}`",
        "- Path rule: every worker must `task.py select <explicit-child-path>`; "
        "do not rely on selected_task inheritance across windows.",
        "",
        "## Manual window path (PACK)",
        "",
        "1. Run `publish-pack` (this file) on the Parent.",
        "2. For each **ready** unit: IDE **New Chat** or Agents Window → paste `child-prompts/<child>.md`.",
        "3. In that session run `python ./.pactile/scripts/task.py select <child-path>`.",
        "4. Parent retains `review-child` / `integrate-child`. PACK is not RUN auto-dispatch.",
        "",
        "## Stages",
        "",
    ]
    if legacy:
        pack_lines.append(
            "> Warning: no `stages:` in task-map; using implicit `default` stage "
            "with all children. Declare `stages:` for HYBRID campaign packs."
        )
        pack_lines.append("")

    written: list[str] = []
    for stage in stages:
        sid = stage["id"]
        title = stage.get("title") or ""
        heading = f"### `{sid}`" + (f" — {title}" if title else "")
        pack_lines.append(heading)
        pack_lines.append("")
        for unit in stage.get("units") or []:
            readiness, blocked = _unit_readiness(unit, children_by_id)
            child_dir = parent_dir.parent / unit
            child_rel = _repo_rel(child_dir, repo_root)
            state = (children_by_id.get(unit) or {}).get("state", "?")
            if readiness == "ready":
                prompt, prompt_errors = build_child_prompt(
                    parent_dir,
                    child_dir,
                    include_artifacts=False,
                    mode=mode,
                )
                if prompt_errors or not prompt:
                    errors.extend(prompt_errors or [f"could not build prompt for `{unit}`"])
                    continue
                out_name = _child_prompt_filename(unit)
                out_rel = f"{parent_rel}/child-prompts/{out_name}"
                if not dry_run:
                    prompts_dir.mkdir(parents=True, exist_ok=True)
                    (prompts_dir / out_name).write_text(prompt + "\n", encoding="utf-8")
                    written.append(out_rel)
                ready_rows.append((sid, unit, out_rel))
                pack_lines.append(
                    f"- `{unit}` — `{state}` — **ready** — prompt: `child-prompts/{out_name}` "
                    f"(select `{child_rel}`)"
                )
            else:
                blocked_rows.append((sid, unit, blocked))
                stub = "\n".join(
                    [
                        f"# BLOCKED — `{unit}`",
                        "",
                        f"- Parent: `{parent_rel}`",
                        f"- Child: `{child_rel}`",
                        f"- Stage: `{sid}`",
                        "- Do not start implementation until dependencies reach "
                        "`integrated` or `cancelled`.",
                        "",
                        "Unmet dependencies:",
                        *[f"- {item}" for item in blocked],
                        "",
                    ]
                )
                out_name = _child_prompt_filename(unit)
                out_rel = f"{parent_rel}/child-prompts/{out_name}"
                if not dry_run:
                    prompts_dir.mkdir(parents=True, exist_ok=True)
                    (prompts_dir / out_name).write_text(stub, encoding="utf-8")
                    written.append(out_rel)
                pack_lines.append(
                    f"- `{unit}` — `{state}` — **blocked** — {', '.join(blocked)}"
                )
        pack_lines.append("")

    pack_lines.extend(["## Ready", ""])
    if ready_rows:
        for sid, unit, path in ready_rows:
            pack_lines.append(f"- `{sid}` / `{unit}` → `{path}`")
    else:
        pack_lines.append("(none)")
    pack_lines.extend(["", "## Blocked", ""])
    if blocked_rows:
        for sid, unit, deps in blocked_rows:
            pack_lines.append(f"- `{sid}` / `{unit}` — {', '.join(deps)}")
    else:
        pack_lines.append("(none)")
    pack_lines.append("")

    pack_body = "\n".join(pack_lines)
    pack_rel = f"{parent_rel}/child-prompts/PACK.md"
    if not dry_run:
        prompts_dir.mkdir(parents=True, exist_ok=True)
        (prompts_dir / "PACK.md").write_text(pack_body + "\n", encoding="utf-8")
        written.append(pack_rel)

    if errors:
        return None, errors

    summary = [
        f"# publish-pack — `{parent_dir.name}`",
        "",
        f"- Parent: `{parent_rel}`",
        f"- dry_run: {dry_run}",
        f"- legacy_no_stages: {legacy}",
        f"- ready: {len(ready_rows)}",
        f"- blocked: {len(blocked_rows)}",
        f"- pack_index: `{pack_rel}`",
        "",
    ]
    if written:
        summary.append("## Written")
        summary.append("")
        for path in written:
            summary.append(f"- `{path}`")
        summary.append("")
    elif dry_run:
        summary.append("(dry-run: no files written)")
        summary.append("")
    summary.append(pack_body)
    return "\n".join(summary), []


def build_parent_status_dict(parent_dir: Path) -> dict | None:
    """Machine-readable parent orchestration snapshot (campaign UI / MCP)."""
    repo_root = get_repo_root()
    parent_rel = _repo_rel(parent_dir, repo_root)
    data, _ = load_task_map(parent_dir)
    if data is None:
        return None

    children_by_id = _children_by_id(data)
    stages, stage_errors, legacy = _normalize_stages(data)
    _, body = load_task_map(parent_dir)
    stale_pack = _compute_stale_pack(parent_dir, data, body, children_by_id)
    newly_ready = _compute_newly_ready(children_by_id)

    stage_rows: list[dict] = []
    for stage in stages:
        units: list[dict] = []
        for unit in stage.get("units") or []:
            entry = children_by_id.get(unit) or {}
            readiness, blocked = _unit_readiness(unit, children_by_id)
            units.append(
                {
                    "id": unit,
                    "state": entry.get("state", "?"),
                    "readiness": readiness,
                    "blockedBy": blocked,
                }
            )
        stage_rows.append(
            {
                "id": stage["id"],
                "title": stage.get("title") or "",
                "units": units,
            }
        )

    children_rows: list[dict] = []
    for child in data.get("children") or []:
        if not isinstance(child, dict):
            continue
        cid = child.get("id")
        if not isinstance(cid, str):
            continue
        child_dir = parent_dir.parent / cid
        children_rows.append(
            {
                "id": cid,
                "state": child.get("state", "?"),
                "dependsOn": child.get("depends_on") or [],
                "touches": child.get("touches") or [],
                "isolation": child.get("isolation"),
                "branch": child.get("branch"),
                "worktreePath": child.get("worktree_path"),
                "evidence": child.get("evidence"),
                "ref": child.get("ref"),
                "verifyMd": (child_dir / "verify.md").is_file(),
                "handoffMd": (child_dir / "handoff.md").is_file(),
            }
        )

    return {
        "id": parent_dir.name,
        "path": parent_rel,
        "contractEpoch": data.get("contract_epoch"),
        "executionTopology": data.get("execution_topology"),
        "mergeLimit": data.get("merge_limit"),
        "stages": stage_rows,
        "children": children_rows,
        "integrationQueue": data.get("integration_queue") or [],
        "stageErrors": stage_errors,
        "legacyStages": legacy,
        "stalePack": stale_pack,
        "newlyReady": newly_ready,
    }


def build_parent_status(parent_dir: Path) -> str:
    """Render a parent task-map status summary for the reviewer."""
    repo_root = get_repo_root()
    parent_rel = _repo_rel(parent_dir, repo_root)
    data, _ = load_task_map(parent_dir)
    if data is None:
        return f"Parent `{parent_rel}`: task-map.md missing or invalid."

    lines = [
        f"# Parent orchestration status — `{parent_dir.name}`",
        "",
        f"- Path: `{parent_rel}`",
        f"- contract_epoch: {data.get('contract_epoch', '?')}",
        f"- execution_topology: {data.get('execution_topology', '?')}",
        f"- merge_limit: {data.get('merge_limit', '?')}",
        "",
    ]

    children_by_id = _children_by_id(data)
    stages, stage_errors, legacy = _normalize_stages(data)
    _, body = load_task_map(parent_dir)
    stale_pack = _compute_stale_pack(parent_dir, data, body, children_by_id)
    newly_ready = _compute_newly_ready(children_by_id)
    lines.append("## Pack freshness")
    lines.append("")
    lines.append(f"- stalePack: {stale_pack}")
    if newly_ready:
        lines.append(f"- newlyReady: {', '.join(newly_ready)}")
    else:
        lines.append("- newlyReady: (none)")
    lines.append("")
    lines.append("## Stages")
    lines.append("")
    if stage_errors:
        for err in stage_errors:
            lines.append(f"- error: {err}")
        lines.append("")
    elif legacy:
        lines.append("stages: (none declared — implicit `default` for publish-pack)")
        lines.append("")
    else:
        for stage in stages:
            sid = stage["id"]
            title = stage.get("title") or ""
            heading = f"### `{sid}`" + (f" — {title}" if title else "")
            lines.append(heading)
            for unit in stage.get("units") or []:
                entry = children_by_id.get(unit) or {}
                state = entry.get("state", "?")
                readiness, blocked = _unit_readiness(unit, children_by_id)
                if readiness == "ready":
                    lines.append(f"- `{unit}` — `{state}` — ready")
                else:
                    lines.append(f"- `{unit}` — `{state}` — blocked ({', '.join(blocked)})")
            lines.append("")

    lines.extend(["## Children", ""])

    children = data.get("children") or []
    if not children:
        lines.append("(no children in task-map)")
        return "\n".join(lines)

    for child in children:
        if not isinstance(child, dict):
            continue
        cid = child.get("id", "?")
        state = child.get("state", "?")
        evidence = child.get("evidence")
        ref = child.get("ref")
        deps = child.get("depends_on") or []
        touches = child.get("touches") or []
        isolation = child.get("isolation")
        branch = child.get("branch")
        worktree_path = child.get("worktree_path")
        lines.append(f"### `{cid}` — `{state}`")
        if deps:
            lines.append(f"- depends_on: {', '.join(deps)}")
        if touches:
            lines.append(f"- touches: {', '.join(touches)}")
        if isolation:
            lines.append(f"- isolation: {isolation}")
        if branch:
            lines.append(f"- branch: {branch}")
        if worktree_path:
            lines.append(f"- worktree_path: {worktree_path}")
        if evidence:
            lines.append(f"- evidence: {evidence}")
        if ref:
            lines.append(f"- ref: {ref}")
        child_dir = parent_dir.parent / cid
        for artifact in ("verify.md", "handoff.md"):
            flag = "yes" if (child_dir / artifact).is_file() else "missing"
            lines.append(f"- {artifact}: {flag}")
        lines.append("")

    queue = data.get("integration_queue") or []
    lines.append(f"integration_queue: {queue}")
    lines.append("")
    lines.append("## Suggested parent commands")
    lines.append("")
    lines.append("```bash")
    lines.append(f"python ./.pactile/scripts/task.py parent-status {parent_rel}")
    lines.append(f"python ./.pactile/scripts/task.py publish-pack {parent_rel}")
    lines.append(f"python ./.pactile/scripts/task.py generate-child-prompt {parent_rel} <child> --mode subagent")
    lines.append(f"python ./.pactile/scripts/task.py generate-child-prompt {parent_rel} <child> --mode inline")
    lines.append(f"python ./.pactile/scripts/task.py review-child {parent_rel} <child> --check")
    lines.append(f"python ./.pactile/scripts/task.py review-child {parent_rel} <child> --decision accept --ref <ref>")
    lines.append("```")
    return "\n".join(lines)


def _summarize_handoff(child_dir: Path) -> dict[str, str | list[str] | bool]:
    verify = _read_optional(child_dir / "verify.md", 6000) or ""
    handoff = _read_optional(child_dir / "handoff.md", 12000) or ""
    has_verify = (child_dir / "verify.md").is_file()
    has_handoff = (child_dir / "handoff.md").is_file()

    validation_ok = bool(
        re.search(r"(?i)validation\s+(evidence|commands|results)", verify)
        or re.search(r"(?i)validation\s*:", verify)
    )
    acceptance_ok = bool(re.search(r"(?i)acceptance\s+evidence|accepted\s+by\s+user", verify))
    learning = durable_learning_decision_status(verify) if verify else {
        "no_durable_learning": False,
        "spec_update": False,
        "learning_artifact": False,
        "any": False,
    }

    changed_files: list[str] = []
    for line in handoff.splitlines():
        if "|" in line and not line.strip().startswith("| ---"):
            cells = [c.strip() for c in line.split("|") if c.strip()]
            if len(cells) >= 2 and cells[0].lower() not in ("path", "file"):
                changed_files.append(cells[0])

    return {
        "has_verify": has_verify,
        "has_handoff": has_handoff,
        "validation_section": validation_ok,
        "acceptance_section": acceptance_ok,
        "learning_decision": learning,
        "verify_excerpt": verify.strip()[:2000],
        "handoff_excerpt": handoff.strip()[:4000],
        "changed_files": changed_files[:20],
    }


def _learning_decision_review_lines(
    parent_dir: Path,
    child_dir: Path,
    child_data: dict,
    summary: dict,
    *,
    decision: str | None,
    reason: str | None,
) -> list[str]:
    """Prompt parent/child to record durable learning before child archive."""
    learning = summary.get("learning_decision") or {}
    if learning.get("any"):
        return []

    repo_root = get_repo_root()
    child_rel = _repo_rel(child_dir, repo_root)
    lines = [
        "## Durable learning decision (required before child archive)",
        "",
        "Child verify.md has no grep-friendly durable-learning line yet. Pick one outcome:",
        "",
        "- `Durable learning decision: no durable learning` — routine scope, no reusable contract.",
        "- `Spec update evidence: .pactile/spec/<path>` — after `/pactile:update-spec` with reviewer confirmation.",
        f"- `Learning artifact: {child_rel}/handoff.md` — handoff already captures the insight.",
        "",
        f"Helper: `python ./.pactile/scripts/task.py prepare-archive-evidence {child_rel}`",
        "",
    ]

    trigger: str | None = None
    if decision == "changes":
        trigger = f"Parent review requested changes ({reason or 'see review notes'})"
    elif decision in ("accept", "integrate-through"):
        trigger = "Parent accepted child handoff — confirm whether workflow/contracts should be captured in spec"

    if trigger or decision == "changes":
        lines.append(build_spec_update_scaffold(repo_root, child_dir, child_data, trigger=trigger))
    return lines


def build_review_report(
    parent_dir: Path,
    child_dir: Path,
    parent_data: dict,
    child_data: dict,
    *,
    decision: str | None,
    ref: str | None,
    reason: str | None,
    notes: str | None,
) -> tuple[str, list[str], dict]:
    """Build review summary and validate integration transitions for a decision."""
    child_name = resolve_child_map_id(parent_data, child_dir, child_data)
    summary = _summarize_handoff(child_dir)
    errors: list[str] = []
    actions: dict = {"integrate": None, "gates": []}

    data, _ = load_task_map(parent_dir)
    child_entry = get_child_entry(data, child_name) if data else None
    current_state = child_entry.get("state") if child_entry else None

    lines = [
        f"# Parent review — `{child_name}`",
        "",
        f"- Timestamp: {_utc_now()}",
        f"- Current integration state: `{current_state}`",
        f"- Decision: `{decision or 'check-only'}`",
        "",
        "## Handoff artifacts",
        "",
        f"- verify.md: {'present' if summary['has_verify'] else '**missing**'}",
        f"- handoff.md: {'present' if summary['has_handoff'] else '**missing**'}",
        f"- verify validation section signal: {summary['validation_section']}",
        f"- verify acceptance section signal: {summary['acceptance_section']}",
        f"- durable learning decision signal: {summary['learning_decision'].get('any')}",
        "",
    ]
    learning_lines = _learning_decision_review_lines(
        parent_dir,
        child_dir,
        child_data,
        summary,
        decision=decision,
        reason=reason,
    )
    if learning_lines:
        lines.extend(learning_lines)

    if summary["changed_files"]:
        lines.append("Changed files (from handoff table):")
        for path in summary["changed_files"]:
            lines.append(f"- `{path}`")
        lines.append("")

    if notes:
        lines.extend(["## Parent notes", "", notes.strip(), ""])

    if decision in ("accept", "changes", "cancel"):
        if decision == "accept":
            target = "accepted"
            if current_state != "review":
                errors.append(f"accept requires child state 'review', got {current_state!r}")
            errors.extend(
                validate_parent_child_integration(
                    parent_dir,
                    parent_data,
                    child_dir,
                    child_data,
                    target,
                    "handoff.md",
                    ref,
                    reason,
                )
            )
            actions["integrate"] = {
                "state": target,
                "evidence": "handoff.md",
                "ref": ref,
            }
            actions["gates"].append(
                {
                    "task": "parent",
                    "transition": "parent-accepted",
                    "optional": True,
                    "hint": (
                        f"Optional audit: python ./.pactile/scripts/task.py record-gate {parent_dir.name} "
                        f"--transition parent-accepted --gate code-review --result PASS "
                        f"--reviewer parent --evidence review-{child_name}.md"
                    ),
                }
            )
            child_profile = task_closeout_profile(child_dir, child_data)
            if child_profile == "full":
                actions["gates"].append(
                    {
                        "task": "child",
                        "transition": "child-review",
                        "optional": False,
                        "hint": (
                            f"Required before accept: python ./.pactile/scripts/task.py record-gate {child_name} "
                            f"--transition child-review --gate code-review --result PASS "
                            f"--reviewer parent --evidence verify.md"
                        ),
                    }
                )
            elif child_profile == "lite":
                actions["gates"].append(
                    {
                        "task": "child",
                        "transition": "child-review",
                        "optional": True,
                        "hint": "Lite child: no child-review gate chain required.",
                    }
                )
        elif decision == "changes":
            target = "changes"
            errors.extend(
                validate_parent_child_integration(
                    parent_dir,
                    parent_data,
                    child_dir,
                    child_data,
                    target,
                    "handoff.md",
                    ref,
                    reason,
                )
            )
            if not reason:
                errors.append("changes requires --reason")
            actions["integrate"] = {
                "state": target,
                "evidence": "handoff.md",
                "ref": ref,
                "reason": reason,
            }
        elif decision == "cancel":
            target = "cancelled"
            errors.extend(
                validate_parent_child_integration(
                    parent_dir,
                    parent_data,
                    child_dir,
                    child_data,
                    target,
                    "handoff.md",
                    ref,
                    reason,
                )
            )
            if not reason:
                errors.append("cancel requires --reason")
            actions["integrate"] = {
                "state": target,
                "evidence": "handoff.md",
                "reason": reason,
            }
    elif decision == "integrate-through":
        sequence = [
            ("accepted", "handoff.md"),
            ("integrating", "task-map.md"),
            ("integrated", "task-map.md"),
        ]
        sim_state = current_state
        for target, evidence in sequence:
            if target == "accepted" and sim_state != "review":
                errors.append(f"integrate-through requires child state 'review', got {sim_state!r}")
                break
            if target == "integrating" and sim_state != "accepted":
                errors.append(f"integrating requires 'accepted', simulated from {sim_state!r}")
                break
            if target == "integrated" and sim_state != "integrating":
                errors.append(f"integrated requires 'integrating', simulated from {sim_state!r}")
                break
            step_errors = validate_parent_child_integration(
                parent_dir,
                parent_data,
                child_dir,
                child_data,
                target,
                evidence,
                ref,
                reason,
                current_state_override=sim_state,
            )
            errors.extend(step_errors)
            if step_errors:
                break
            sim_state = target
        if not errors:
            actions["integrate_sequence"] = [
                {"state": "accepted", "evidence": "handoff.md", "ref": ref},
                {"state": "integrating", "evidence": "task-map.md", "ref": ref},
                {"state": "integrated", "evidence": "task-map.md", "ref": ref},
            ]
            actions["gates"].append(
                {
                    "task": "parent",
                    "transition": "parent-integrated",
                    "optional": False,
                    "hint": (
                        f"Required before parent archive: python ./.pactile/scripts/task.py record-gate {parent_dir.name} "
                        f"--transition parent-integrated --gate integration-review --result PASS "
                        f"--reviewer parent --evidence task-map.md"
                    ),
                }
            )

    lines.extend(
        [
            "## verify.md excerpt",
            "",
            (summary["verify_excerpt"] or "(empty)"),
            "",
            "## handoff.md excerpt",
            "",
            (summary["handoff_excerpt"] or "(empty)"),
            "",
        ]
    )

    if decision and not errors:
        lines.append("## Integration plan")
        lines.append("")
        if actions.get("integrate_sequence"):
            for step in actions["integrate_sequence"]:
                lines.append(
                    f"- integrate-child → `{step['state']}` (evidence={step['evidence']}, ref={step.get('ref')})"
                )
        elif actions.get("integrate"):
            step = actions["integrate"]
            lines.append(
                f"- integrate-child → `{step['state']}` (evidence={step['evidence']}, ref={step.get('ref')})"
            )
        for gate in actions.get("gates", []):
            if gate.get("optional"):
                lines.append(f"- Optional gate ({gate['transition']}): {gate['hint']}")
        lines.append("")

    report = "\n".join(lines)
    return report, errors, actions


def append_parent_review_notes(parent_dir: Path, child_name: str, report: str) -> None:
    """Append a parent review section to parent verify.md."""
    verify_path = parent_dir / "verify.md"
    header = f"\n\n## Parent review — `{child_name}` ({_utc_now()})\n\n"
    if verify_path.is_file():
        existing = verify_path.read_text(encoding="utf-8")
        verify_path.write_text(existing.rstrip() + header + report.strip() + "\n", encoding="utf-8")
    else:
        verify_path.write_text(
            "# Verification Evidence\n\n" + header + report.strip() + "\n",
            encoding="utf-8",
        )


def write_review_artifact(parent_dir: Path, child_name: str, report: str) -> Path:
    """Write a standalone review artifact under the parent task directory."""
    path = parent_dir / f"review-{child_name}.md"
    path.write_text(report.strip() + "\n", encoding="utf-8")
    return path
