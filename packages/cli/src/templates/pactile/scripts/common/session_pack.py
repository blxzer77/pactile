#!/usr/bin/env python3
"""Five-layer Session pack compiler (`context-progressive`).

Legal inputs: Kernel Phase/Condition/Outcome, activated module ids, current
artifact roles. Illegal inputs: `workflow.md`, AGENTS longform,
`[workflow-state:*]`, unactivated module bodies.

Activation is profile-runtime: layer 2 Baseline ids are phase-needed
intersect still-active. On-demand ids come only from
`ondemand_modules.active`. Unactivated modules are not installed.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PACK_VERSION = 1
PACK_SOURCE = "context-progressive"
ACTIVATION_SOURCE_KIND = "profile-runtime"

# Same budget envelope as Personal Lite / retrieval context_pack (do not
# import maintainer-only context_pack.py; SessionStart must load this file
# via importlib without executing common/__init__.py).
SESSION_MAX_ITEMS = 8
SESSION_MAX_ESTIMATED_TOKENS = 4000
SESSION_CHARS_PER_TOKEN = 4
SESSION_MIN_ITEM_TOKENS = 40
CONTRACT_EXCERPT_CHARS = 2200
ARTIFACT_EXCERPT_CHARS = 1200

RETRIEVAL_INTENTS = ("exact", "semantic", "structural", "external")

BASELINE_EIGHT = (
    "intake-basic",
    "define-basic",
    "approval-personal",
    "execute-agent",
    "verify-basic",
    "close-basic",
    "context-progressive",
    "observability-local",
)

# Compiler / telemetry modules never occupy resident layer 2.
NEVER_LAYER2 = frozenset(
    {
        "context-progressive",
        "observability-local",
        "debug-recovery",
        "retention-storage",
        "retrieval-extended",
        "personal-memory",
    }
)

LITE_BLOCKED_LAYER2 = frozenset(
    {
        "parent-child",
        "vcs-integration",
        "personal-memory",
        "retention-storage",
        "retrieval-extended",
        "worker-orchestration",
    }
)

NO_TASK_BLOCKED = frozenset(
    {
        "parent-child",
        "worker-orchestration",
        "vcs-integration",
        "personal-memory",
        "retention-storage",
        "retrieval-extended",
        "independent-check",
        "define-extended",
        "spec-learning",
        "session-transfer",
    }
)

PHASE_LAYER2_BASELINE: dict[str, tuple[str, ...]] = {
    "open": (),
    "define": ("define-basic",),
    "approve": ("approval-personal",),
    "execute": ("execute-agent",),
    "verify": ("verify-basic",),
    "integrate": (),
    "close": ("close-basic",),
}

PHASE_ARTIFACT_ROLES: dict[str, tuple[tuple[str, str], ...]] = {
    "open": (),
    "define": (("prd.md", "definition"),),
    "approve": (("prd.md", "definition"),),
    "execute": (("prd.md", "definition"),),
    "verify": (("prd.md", "definition"), ("verify.md", "evidence")),
    "integrate": (("prd.md", "definition"), ("handoff.md", "integration-handoff")),
    "close": (("verify.md", "evidence"),),
}

ONDEMAND_PHASE: dict[str, frozenset[str] | None] = {
    "define-extended": frozenset({"define"}),
    "independent-check": frozenset({"verify"}),
    "worker-orchestration": frozenset({"execute"}),
    "parent-child": frozenset({"define", "execute", "integrate", "verify"}),
    "debug-recovery": None,
    "session-transfer": None,
    "spec-learning": frozenset({"close"}),
    "vcs-integration": frozenset({"close"}),
    "personal-memory": None,
    "retention-storage": None,
    "retrieval-extended": None,
}

ILLEGAL_BASENAMES = frozenset({"workflow.md", "agents.md"})
KERNEL_PHASES = (
    "open",
    "define",
    "approve",
    "execute",
    "verify",
    "integrate",
    "close",
)
KERNEL_PHASE_HUMAN = {
    "open": "Open",
    "define": "Define",
    "approve": "Approve",
    "execute": "Execute",
    "verify": "Verify",
    "integrate": "Integrate",
    "close": "Close",
}
STATUS_TO_PHASE = {
    "planning": "define",
    "in_progress": "execute",
    "review": "verify",
    "completed": "close",
    "done": "close",
}
PHASE_DEFAULT_CONDITION = {
    "open": "ready",
    "define": "ready",
    "approve": "waiting",
    "execute": "active",
    "verify": "waiting",
    "integrate": "waiting",
    "close": "ready",
}
VALID_CONDITIONS = frozenset({"ready", "active", "waiting", "blocked"})
VALID_OUTCOMES = frozenset({"completed", "cancelled", "failed"})

LAYER_NAMES = {
    1: "resident-min",
    2: "activated-contracts",
    3: "artifact-snippets",
    4: "retrieval-pointer",
    5: "deep-diagnosis",
}


def estimate_tokens(text: str) -> int:
    if not text:
        return SESSION_MIN_ITEM_TOKENS
    return max(SESSION_MIN_ITEM_TOKENS, len(text) // SESSION_CHARS_PER_TOKEN + 20)


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        name = str(value).strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _illegal_path(path: str) -> bool:
    base = path.replace("\\", "/").rsplit("/", 1)[-1].lower()
    return base in ILLEGAL_BASENAMES


def project_kernel(
    *,
    phase: str | None = None,
    condition: str | None = None,
    outcome: str | None = None,
    status: str | None = None,
    selected: bool = False,
    stale: bool = False,
) -> dict[str, Any]:
    resolved_phase = phase if phase in KERNEL_PHASE_HUMAN else None
    if resolved_phase is None:
        resolved_phase = STATUS_TO_PHASE.get(status or "", "open") if selected else "open"
    resolved_condition = condition if condition in VALID_CONDITIONS else None
    if resolved_condition is None:
        resolved_condition = PHASE_DEFAULT_CONDITION.get(resolved_phase, "ready")
    resolved_outcome = outcome if outcome in VALID_OUTCOMES else None
    return {
        "phase": resolved_phase,
        "condition": resolved_condition,
        "outcome": resolved_outcome,
        "status": status or "",
        "humanPhase": KERNEL_PHASE_HUMAN[resolved_phase],
        "selected": bool(selected),
        "stale": bool(stale),
    }


def kernel_from_task_dir(task_dir: Path | None, *, stale: bool = False) -> dict[str, Any]:
    if task_dir is None or not task_dir.is_dir():
        return project_kernel(selected=False, stale=False)
    task_data = _read_json(task_dir / "task.json")
    kernel = _read_json(task_dir / "kernel.json")
    phase = kernel.get("phase") if kernel.get("phase") in KERNEL_PHASE_HUMAN else None
    condition = kernel.get("condition") if isinstance(kernel.get("condition"), str) else None
    outcome = kernel.get("outcome") if kernel.get("outcome") in VALID_OUTCOMES else None
    status = task_data.get("status") if isinstance(task_data.get("status"), str) else None
    surface = project_kernel(
        phase=phase,
        condition=condition,
        outcome=outcome,
        status=status,
        selected=True,
        stale=stale,
    )
    surface["taskDir"] = str(task_dir)
    surface["title"] = str(task_data.get("title") or task_data.get("name") or task_dir.name)
    return surface


def _extras(task_dir: Path | None) -> dict[str, Any]:
    if task_dir is None:
        return {}
    kernel = _read_json(task_dir / "kernel.json")
    projection = kernel.get("projection") if isinstance(kernel.get("projection"), dict) else {}
    extras = projection.get("extras") if isinstance(projection.get("extras"), dict) else {}
    task_data = _read_json(task_dir / "task.json")
    merged = dict(extras)
    for key in (
        "ondemand_modules",
        "baseline_modules",
        "required_controls",
        "topology",
        "capability_router",
        "event_bridge",
    ):
        if key not in merged and isinstance(task_data.get(key), dict):
            merged[key] = task_data[key]
    return merged


def _ondemand_active(task_dir: Path | None) -> list[str]:
    extras = _extras(task_dir)
    block = extras.get("ondemand_modules")
    if not isinstance(block, dict):
        return []
    raw = block.get("active")
    if not isinstance(raw, list):
        return []
    return _unique([str(item) for item in raw if isinstance(item, str)])


def _baseline_active(task_dir: Path | None) -> list[str]:
    extras = _extras(task_dir)
    block = extras.get("baseline_modules")
    if not isinstance(block, dict) or "active" not in block:
        return list(BASELINE_EIGHT)
    raw = block.get("active")
    if not isinstance(raw, list):
        return []
    allowed = set(BASELINE_EIGHT)
    return _unique(
        [
            str(item).strip()
            for item in raw
            if isinstance(item, str) and str(item).strip() in allowed
        ]
    )


def _rigor(task_dir: Path | None) -> str:
    extras = _extras(task_dir)
    controls = extras.get("required_controls")
    if isinstance(controls, dict) and isinstance(controls.get("rigor"), str):
        value = controls["rigor"].strip().lower()
        if value in {"lite", "full"}:
            return value
    return "lite"


def _topology_kind(task_dir: Path | None) -> str:
    extras = _extras(task_dir)
    topo = extras.get("topology")
    if isinstance(topo, dict) and isinstance(topo.get("kind"), str):
        return topo["kind"]
    return "single"


def load_module_catalog(modules_root: Path | None) -> dict[str, Any]:
    if modules_root is None:
        return {"modules": [], "byId": {}}
    catalog = _read_json(modules_root / "index.json")
    modules = catalog.get("modules") if isinstance(catalog.get("modules"), list) else []
    by_id: dict[str, dict[str, Any]] = {}
    for entry in modules:
        if not isinstance(entry, dict):
            continue
        module_id = str(entry.get("id") or "").strip()
        if module_id:
            by_id[module_id] = entry
    catalog["byId"] = by_id
    return catalog


def read_contract(modules_root: Path | None, module_id: str, catalog: dict[str, Any]) -> str:
    if modules_root is None:
        return ""
    entry = catalog.get("byId", {}).get(module_id)
    rel = ""
    if isinstance(entry, dict) and isinstance(entry.get("contract"), str):
        rel = entry["contract"]
    path = modules_root / (rel or f"{module_id}/contract.md")
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    if _illegal_path(str(path)):
        return ""
    return text[:CONTRACT_EXCERPT_CHARS].strip()


def resolve_layer2_ids(
    *,
    kernel: dict[str, Any],
    ondemand_active: list[str],
    rigor: str,
    topology_kind: str,
    intake_event: bool,
    baseline_active: list[str] | None = None,
) -> list[str]:
    selected = bool(kernel.get("selected"))
    phase = str(kernel.get("phase") or "open")
    still_active = set(
        baseline_active if baseline_active is not None else list(BASELINE_EIGHT)
    )
    ids: list[str] = []

    if not selected:
        if intake_event and "intake-basic" in still_active:
            ids.append("intake-basic")
        return [name for name in _unique(ids) if name not in NO_TASK_BLOCKED]

    ids.extend(
        module_id
        for module_id in PHASE_LAYER2_BASELINE.get(phase, ())
        if module_id in still_active
    )

    lite_single = rigor == "lite" and topology_kind != "parent-child"
    for module_id in ondemand_active:
        if module_id in NEVER_LAYER2:
            continue
        allowed_phases = ONDEMAND_PHASE.get(module_id, frozenset())
        if allowed_phases is None:
            continue
        if phase not in allowed_phases:
            continue
        if lite_single and module_id in LITE_BLOCKED_LAYER2:
            continue
        ids.append(module_id)

    filtered: list[str] = []
    for module_id in _unique(ids):
        if module_id in NEVER_LAYER2:
            continue
        if lite_single and module_id in LITE_BLOCKED_LAYER2:
            continue
        if not selected and module_id in NO_TASK_BLOCKED:
            continue
        filtered.append(module_id)
    return filtered


def _next_action(kernel: dict[str, Any], layer2_ids: list[str]) -> str:
    if kernel.get("stale"):
        return (
            "Clear the stale selection with `python ./.pactile/scripts/task.py exit`, "
            "then ask what to work on next."
        )
    if not kernel.get("selected"):
        return (
            "Intake: answer directly, clarify whether there is work, or draft an "
            "Open Proposal. Do not `task.py create` without Open approval."
        )
    if kernel.get("condition") == "blocked":
        return "Stop. Classify the stall before retrying the same hypothesis."
    phase = kernel.get("phase")
    if phase == "open":
        return "Task exists. Move into Define: measurable Acceptance Criteria before Execute."
    if phase == "define":
        return "Finish Definition + measurable AC. Do not implement; do not `--approved`."
    if phase == "approve":
        return (
            "Request the Execute gate. `--check` PASS is a preflight, not human approval."
        )
    if phase == "execute":
        return "Implement inside the approved contract. Contract change → Return-to-Define."
    if phase == "verify":
        return "Map every AC to locatable evidence. Placeholder or fake-green cannot Close."
    if phase == "integrate":
        return "Parent integrates children. Child must not `integrate-child`."
    if phase == "close":
        return "Write Outcome + learning disposition. Git commit is not Close."
    if "intake-basic" in layer2_ids:
        return "Intake is in layer 2. Do not treat missing modules as installed."
    return "Follow Kernel Phase / Condition. Unlisted modules are not installed."


def _key_constraints(kernel: dict[str, Any], *, rigor: str, topology_kind: str) -> str:
    lines = [
        "Do not treat `.pactile/workflow.md` or AGENTS longform as runtime SSOT.",
        "Modules absent from this pack are not installed.",
        f"Rigor={rigor}; topology={topology_kind}.",
    ]
    if kernel.get("selected"):
        lines.append("Stay inside the selected task contract.")
    else:
        lines.append("No selected task: no task-directory dump; no Parent/Worker/VCS teaching.")
    if kernel.get("condition") == "blocked":
        lines.append("Condition=blocked: do not silently retry.")
    return "\n".join(lines)


def collect_artifact_snippets(
    task_dir: Path | None,
    kernel: dict[str, Any],
) -> list[dict[str, Any]]:
    if task_dir is None or not kernel.get("selected") or kernel.get("stale"):
        return []
    phase = str(kernel.get("phase") or "open")
    items: list[dict[str, Any]] = []
    for name, role in PHASE_ARTIFACT_ROLES.get(phase, ()):
        path = task_dir / name
        if not path.is_file() or _illegal_path(name):
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        excerpt = raw[:ARTIFACT_EXCERPT_CHARS].strip()
        if not excerpt:
            continue
        freshness = ""
        try:
            mtime = path.stat().st_mtime
            freshness = datetime.fromtimestamp(mtime, tz=timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
        except OSError:
            freshness = ""
        try:
            rel = path.as_posix()
        except Exception:
            rel = str(path)
        items.append(
            {
                "role": role,
                "path": rel,
                "excerpt": excerpt,
                "freshness": freshness,
            }
        )
    return items


def _apply_budget(items: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, str]], int]:
    selected: list[dict[str, Any]] = []
    omitted: list[dict[str, str]] = []
    tokens = 0
    for item in items:
        cost = int(item.get("estimatedTokens") or estimate_tokens(str(item.get("text") or "")))
        would_items = len(selected) >= SESSION_MAX_ITEMS
        would_tokens = tokens + cost > SESSION_MAX_ESTIMATED_TOKENS
        if would_items or would_tokens:
            omitted.append(
                {
                    "id": str(item.get("id") or item.get("path") or ""),
                    "reason": "outside session pack budget",
                }
            )
            continue
        selected.append(item)
        tokens += cost
    return selected, omitted, tokens


def compile_session_pack(
    *,
    kernel: dict[str, Any],
    ondemand_active: list[str] | None = None,
    baseline_active: list[str] | None = None,
    modules_root: Path | str | None = None,
    artifacts: list[dict[str, Any]] | None = None,
    rigor: str = "lite",
    topology_kind: str = "single",
    intake_event: bool | None = None,
    fact_gap: bool = False,
    catalog: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compile a five-layer Session pack. Never dumps all 20 contracts."""
    modules_path = Path(modules_root) if modules_root else None
    loaded_catalog = catalog or load_module_catalog(modules_path)
    selected = bool(kernel.get("selected"))
    if intake_event is None:
        intake_event = not selected
    active = _unique(list(ondemand_active or []))
    if baseline_active is None:
        resolved_baseline = list(BASELINE_EIGHT)
    else:
        allowed = set(BASELINE_EIGHT)
        resolved_baseline = _unique(
            [
                str(item).strip()
                for item in baseline_active
                if str(item).strip() in allowed
            ]
        )
    layer2_ids = resolve_layer2_ids(
        kernel=kernel,
        ondemand_active=active,
        rigor=rigor,
        topology_kind=topology_kind,
        intake_event=bool(intake_event),
        baseline_active=resolved_baseline,
    )

    budget_candidates: list[dict[str, Any]] = []
    contracts: dict[str, str] = {}
    for module_id in layer2_ids:
        body = read_contract(modules_path, module_id, loaded_catalog)
        if not body:
            continue
        contracts[module_id] = body
        budget_candidates.append(
            {
                "id": module_id,
                "kind": "contract",
                "text": body,
                "estimatedTokens": estimate_tokens(body),
            }
        )

    snippet_items = list(artifacts or [])
    for item in snippet_items:
        path = str(item.get("path") or "")
        if _illegal_path(path):
            continue
        text = str(item.get("excerpt") or "")
        budget_candidates.append(
            {
                "id": path,
                "kind": "artifact",
                "path": path,
                "role": item.get("role") or "",
                "text": text,
                "freshness": item.get("freshness") or "",
                "estimatedTokens": estimate_tokens(text),
            }
        )

    kept, omitted, tokens = _apply_budget(budget_candidates)
    kept_contract_ids = [row["id"] for row in kept if row.get("kind") == "contract"]
    kept_artifacts = [row for row in kept if row.get("kind") == "artifact"]
    layer2_ids = [module_id for module_id in layer2_ids if module_id in kept_contract_ids]

    stuck = kernel.get("condition") == "blocked" or bool(kernel.get("stale"))
    diagnosis_ids: list[str] = []
    if stuck:
        diagnosis_ids = ["debug-recovery"]

    layer1_text = "\n".join(
        [
            f"Phase: {kernel.get('humanPhase') or kernel.get('phase')} ({kernel.get('phase')})",
            f"Condition: {kernel.get('condition')}",
            f"Outcome: {kernel.get('outcome') or '(none)'}",
            "Constraints:",
            _key_constraints(kernel, rigor=rigor, topology_kind=topology_kind),
            f"Next: {_next_action(kernel, layer2_ids)}",
        ]
    )

    layer2_parts: list[str] = []
    for module_id in layer2_ids:
        body = contracts.get(module_id, "")
        if not body:
            continue
        layer2_parts.append(f"### `{module_id}`\n{body}")

    layer3_parts: list[str] = []
    layer3_meta: list[dict[str, Any]] = []
    if selected:
        for row in kept_artifacts:
            path = str(row.get("path") or "")
            excerpt = str(row.get("text") or "")
            layer3_meta.append(
                {
                    "path": path,
                    "role": row.get("role") or "",
                    "freshness": row.get("freshness") or "",
                    "excerpt": excerpt,
                }
            )
            layer3_parts.append(f"{path}\n{excerpt}")

    layer4_text = ""
    if fact_gap:
        layer4_text = (
            "Fact gap: route with intents exact / semantic / structural / external. "
            "Do not bind Agent tool names. Ranking and retrieval-pack stay with "
            "`retrieval-extended`."
        )

    layer5_text = ""
    if stuck:
        layer5_text = (
            "Deep diagnosis pointer only (not a layer-2 contract): `debug-recovery`. "
            "Stop homogeneous retries. Classify implementation / contract / "
            "environment / platform / process-loop. First failure is not break-loop."
        )

    layers = [
        {
            "n": 1,
            "name": LAYER_NAMES[1],
            "text": layer1_text,
        },
        {
            "n": 2,
            "name": LAYER_NAMES[2],
            "moduleIds": layer2_ids,
            "text": "\n\n".join(layer2_parts),
        },
        {
            "n": 3,
            "name": LAYER_NAMES[3],
            "items": layer3_meta,
            "text": "\n\n".join(layer3_parts),
        },
        {
            "n": 4,
            "name": LAYER_NAMES[4],
            "present": bool(fact_gap),
            "intents": list(RETRIEVAL_INTENTS) if fact_gap else [],
            "text": layer4_text,
        },
        {
            "n": 5,
            "name": LAYER_NAMES[5],
            "present": bool(stuck),
            "moduleIds": diagnosis_ids,
            "text": layer5_text,
        },
    ]

    catalog_ids = list(loaded_catalog.get("byId", {}).keys())
    return {
        "version": PACK_VERSION,
        "source": PACK_SOURCE,
        "activationSource": {
            "kind": ACTIVATION_SOURCE_KIND,
            "filter": "phase-intersect-active",
            "baselineActive": resolved_baseline,
            "ondemandActive": active,
            "note": (
                "Layer 2 is phase-needed intersect still-active. "
                "Unactivated modules are not installed."
            ),
        },
        "kernel": {
            "phase": kernel.get("phase"),
            "condition": kernel.get("condition"),
            "outcome": kernel.get("outcome"),
            "humanPhase": kernel.get("humanPhase"),
            "selected": selected,
        },
        "rigor": rigor,
        "topologyKind": topology_kind,
        "layers": layers,
        "budget": {
            "maxItems": SESSION_MAX_ITEMS,
            "maxEstimatedTokens": SESSION_MAX_ESTIMATED_TOKENS,
            "estimatedTokens": tokens,
            "itemsUsed": len(kept),
        },
        "omitted": omitted,
        "illegalInputsRejected": [
            "workflow.md",
            "AGENTS.md",
            "[workflow-state:*]",
            "unactivated-module-bodies",
        ],
        "catalogSize": len(catalog_ids),
        "retrievalIntents": list(RETRIEVAL_INTENTS),
    }


def render_session_pack(pack: dict[str, Any]) -> str:
    """Render the pack as tagged SessionStart additional_context."""
    meta = {
        "source": pack.get("source"),
        "activationSource": pack.get("activationSource"),
        "layer2ModuleIds": (pack.get("layers") or [{}])[1].get("moduleIds")
        if len(pack.get("layers") or []) > 1
        else [],
        "layers": [row.get("n") for row in pack.get("layers") or []],
        "kernel": pack.get("kernel"),
        "illegalInputsRejected": pack.get("illegalInputsRejected"),
    }
    lines = [
        "<session-pack source=\"context-progressive\">",
        "<session-pack-meta>",
        json.dumps(meta, ensure_ascii=False, indent=2),
        "</session-pack-meta>",
    ]
    for layer in pack.get("layers") or []:
        n = int(layer.get("n") or 0)
        name = str(layer.get("name") or "")
        extra = ""
        ids = layer.get("moduleIds")
        if isinstance(ids, list) and ids:
            extra += f" ids=\"{','.join(str(i) for i in ids)}\""
        if layer.get("present") is False:
            extra += " present=\"false\""
        elif layer.get("present") is True:
            extra += " present=\"true\""
        body = str(layer.get("text") or "").strip()
        lines.append(f"<layer n=\"{n}\" name=\"{name}\"{extra}>")
        lines.append(body if body else "(empty)")
        lines.append("</layer>")
    lines.append("</session-pack>")
    return "\n".join(lines)


def resolve_task_dir(pactile_dir: Path, task_ref: str | None) -> Path | None:
    if not task_ref:
        return None
    normalized = task_ref.strip().replace("\\", "/")
    path_obj = Path(normalized)
    if path_obj.is_absolute():
        return path_obj
    if normalized.startswith(".pactile/"):
        return pactile_dir.parent / path_obj
    if normalized.startswith("tasks/"):
        return pactile_dir / path_obj
    return pactile_dir / "tasks" / path_obj


def compile_session_pack_from_pactile(
    pactile_dir: Path,
    *,
    selected_task_path: str | None = None,
    selected_stale: bool = False,
    fact_gap: bool = False,
    intake_event: bool | None = None,
) -> dict[str, Any]:
    task_dir = resolve_task_dir(pactile_dir, selected_task_path)
    if selected_task_path and (task_dir is None or not task_dir.is_dir()):
        selected_stale = True
        task_dir = None
    kernel = kernel_from_task_dir(task_dir, stale=selected_stale)
    if selected_stale:
        kernel["stale"] = True
        kernel["selected"] = bool(selected_task_path)
    modules_root = pactile_dir / "modules"
    artifacts = collect_artifact_snippets(task_dir, kernel)
    return compile_session_pack(
        kernel=kernel,
        ondemand_active=_ondemand_active(task_dir),
        baseline_active=_baseline_active(task_dir),
        modules_root=modules_root if modules_root.is_dir() else None,
        artifacts=artifacts,
        rigor=_rigor(task_dir),
        topology_kind=_topology_kind(task_dir),
        intake_event=intake_event,
        fact_gap=fact_gap,
    )


def compile_session_pack_for_repo(repo_root: Path | None = None) -> dict[str, Any]:
    """CLI helper used by `get_context.py --mode session`."""
    root = repo_root or Path.cwd()
    pactile_dir = root / ".pactile"
    if not pactile_dir.is_dir():
        current = root.resolve()
        while True:
            if (current / ".pactile").is_dir():
                pactile_dir = current / ".pactile"
                root = current
                break
            if current.parent == current:
                break
            current = current.parent
    selected_path: str | None = None
    try:
        from .paths import get_selected_task

        selected_path = get_selected_task(root)
    except Exception:
        selected_path = None
    fact_gap = os.environ.get("PACTILE_SESSION_FACT_GAP") == "1"
    return compile_session_pack_from_pactile(
        pactile_dir,
        selected_task_path=selected_path,
        fact_gap=fact_gap,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compile a five-layer context-progressive Session pack.",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of XML.")
    parser.add_argument(
        "--pactile-dir",
        help="Path to `.pactile`. Defaults to nearest `.pactile` from cwd.",
    )
    parser.add_argument(
        "--task",
        help="Selected task path (repo-relative or absolute). Default: none.",
    )
    parser.add_argument(
        "--fact-gap",
        action="store_true",
        help="Include layer-4 retrieval intent pointer.",
    )
    args = parser.parse_args(argv)
    if args.pactile_dir:
        pactile_dir = Path(args.pactile_dir)
    else:
        cwd = Path.cwd()
        pactile_dir = cwd / ".pactile" if (cwd / ".pactile").is_dir() else cwd
    selected = args.task
    if not selected:
        try:
            from .paths import get_selected_task

            selected = get_selected_task(pactile_dir.parent)
        except Exception:
            selected = None
    pack = compile_session_pack_from_pactile(
        pactile_dir,
        selected_task_path=selected,
        fact_gap=bool(args.fact_gap),
    )
    if args.json:
        print(json.dumps(pack, ensure_ascii=False, indent=2))
    else:
        print(render_session_pack(pack))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
