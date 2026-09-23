#!/usr/bin/env python3
"""Session-scoped selected task resolution.

The user-facing concept is a live-session "selected task". Pactile stores that
pointer per AI session/window under `.pactile/.runtime/sessions/`; without a
stable session key there is no selected task.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DIR_WORKFLOW = ".pactile"
DIR_TASKS = "tasks"
DIR_RUNTIME = ".runtime"
DIR_SESSIONS = "sessions"
DIR_CURSOR_SHELL = "cursor-shell"
CURSOR_SHELL_TICKET_TTL_SECONDS = 30
TASK_SESSION_COMMANDS = {"select", "selected", "exit"}

_SESSION_KEYS = ("session_id", "sessionId", "sessionID")
_CONVERSATION_KEYS = ("conversation_id", "conversationId", "conversationID")
_TRANSCRIPT_KEYS = ("transcript_path", "transcriptPath", "transcript")
_NESTED_KEYS = ("input", "properties", "event", "hook_input", "hookInput")
_KNOWN_PLATFORMS = {
    "cursor",
    "codex",
}

_ENV_SESSION_KEYS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("cursor", ("CURSOR_SESSION_ID",)),
)
_ENV_CONVERSATION_KEYS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("cursor", ("CURSOR_CONVERSATION_ID", "CURSOR_CONVERSATIONID")),
)
_ENV_TRANSCRIPT_KEYS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("cursor", ("CURSOR_TRANSCRIPT_PATH",)),
)
_ENV_PLATFORM_ALIASES: dict[str, str] = {}


@dataclass(frozen=True)
class SelectedTask:
    """Resolved selected task state."""

    task_path: str | None
    source_type: str
    context_key: str | None = None
    stale: bool = False

    @property
    def source(self) -> str:
        """Human-readable source label."""
        if self.source_type == "session" and self.context_key:
            return f"session:{self.context_key}"
        return self.source_type


def normalize_task_ref(task_ref: str) -> str:
    """Normalize a task ref for stable storage and comparison."""
    normalized = task_ref.strip()
    if not normalized:
        return ""

    path_obj = Path(normalized)
    if path_obj.is_absolute():
        return str(path_obj)

    normalized = normalized.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]

    if normalized.startswith(f"{DIR_TASKS}/"):
        return f"{DIR_WORKFLOW}/{normalized}"

    return normalized


def resolve_task_ref(task_ref: str, repo_root: Path) -> Path | None:
    """Resolve a task ref to an absolute task directory."""
    normalized = normalize_task_ref(task_ref)
    if not normalized:
        return None

    path_obj = Path(normalized)
    if path_obj.is_absolute():
        return path_obj

    if normalized.startswith(f"{DIR_WORKFLOW}/"):
        return repo_root / path_obj

    return repo_root / DIR_WORKFLOW / DIR_TASKS / path_obj


def _runtime_sessions_dir(repo_root: Path) -> Path:
    return repo_root / DIR_WORKFLOW / DIR_RUNTIME / DIR_SESSIONS


def _sanitize_key(raw: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", raw.strip())
    safe = safe.strip("._-")
    return safe[:160] if safe else ""


def _hash_value(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _as_dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _string_value(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _lookup_string(data: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = _string_value(data.get(key))
        if value:
            return value

    for nested_key in _NESTED_KEYS:
        nested = _as_dict(data.get(nested_key))
        if not nested:
            continue
        value = _lookup_string(nested, keys)
        if value:
            return value

    return None


def _detect_platform(platform_input: dict[str, Any] | None, platform: str | None) -> str:
    if platform:
        return _sanitize_key(platform) or "session"
    if platform_input:
        for key in ("_pactile_platform", "pactile_platform", "platform", "source"):
            value = _string_value(platform_input.get(key))
            if value:
                return _sanitize_key(value) or "session"
        if _string_value(platform_input.get("cursor_version")):
            return "cursor"
    return "session"


def _context_key(platform_name: str, kind: str, value: str) -> str:
    if kind == "transcript":
        return f"{platform_name}_transcript_{_hash_value(value)}"
    safe_value = _sanitize_key(value)
    if safe_value:
        return f"{platform_name}_{safe_value}"
    return f"{platform_name}_{_hash_value(value)}"


def _iter_env_keys(
    env_keys: tuple[tuple[str, tuple[str, ...]], ...],
    platform_name: str | None,
) -> tuple[tuple[str, tuple[str, ...]], ...]:
    if not platform_name:
        return env_keys
    matched = tuple((name, keys) for name, keys in env_keys if name == platform_name)
    return matched


def _env_platform_name(platform_name: str | None) -> str | None:
    if not platform_name or platform_name == "session":
        return None
    return _ENV_PLATFORM_ALIASES.get(platform_name, platform_name)


def _lookup_env_context_key(platform_name: str | None) -> str | None:
    """Resolve a context key from platform-provided environment variables.

    Hooks pass `PACTILE_CONTEXT_ID` to subprocesses they launch, but an AI-run
    shell command can only see session identity if the host platform exports it
    in the command environment. These names are best-effort adapters; if none
    are present, there is no session-scoped selected task.
    """
    env_platform_name = _env_platform_name(platform_name)

    for name, keys in _iter_env_keys(_ENV_SESSION_KEYS, env_platform_name):
        for key in keys:
            value = _string_value(os.environ.get(key))
            if value:
                return _context_key(name, "session", value)

    for name, keys in _iter_env_keys(_ENV_CONVERSATION_KEYS, env_platform_name):
        for key in keys:
            value = _string_value(os.environ.get(key))
            if value:
                return _context_key(name, "conversation", value)

    for name, keys in _iter_env_keys(_ENV_TRANSCRIPT_KEYS, env_platform_name):
        for key in keys:
            value = _string_value(os.environ.get(key))
            if value:
                return _context_key(name, "transcript", value)

    return None


def _find_repo_root_from_cwd() -> Path | None:
    current = Path.cwd().resolve()
    while True:
        if (current / DIR_WORKFLOW).is_dir():
            return current
        if current == current.parent:
            return None
        current = current.parent


def _cursor_shell_ticket_dir(repo_root: Path) -> Path:
    return repo_root / DIR_WORKFLOW / DIR_RUNTIME / DIR_CURSOR_SHELL


def _remove_file(path: Path) -> bool:
    try:
        path.unlink()
        return True
    except OSError:
        return False


def _task_refs_match(left: str | None, right: str | None, repo_root: Path) -> bool:
    if not left or not right:
        return False
    left_path = resolve_task_ref(left, repo_root)
    right_path = resolve_task_ref(right, repo_root)
    if left_path is not None and right_path is not None:
        return left_path == right_path
    return normalize_task_ref(left) == normalize_task_ref(right)


def _pending_ticket_matches_args(ticket: dict[str, Any], repo_root: Path) -> bool:
    if Path(sys.argv[0]).name != "task.py":
        return False
    args = tuple(sys.argv[1:])
    if not args:
        return False

    command_name = args[0]
    if command_name not in TASK_SESSION_COMMANDS:
        return False

    subcommands = ticket.get("subcommands")
    if not isinstance(subcommands, list):
        return False

    for subcommand in subcommands:
        if not isinstance(subcommand, dict):
            continue
        if _string_value(subcommand.get("name")) != command_name:
            continue
        if command_name != "select":
            return True
        task_ref = args[1] if len(args) > 1 else None
        if _task_refs_match(_string_value(subcommand.get("task_ref")), task_ref, repo_root):
            return True

    return False


def _ticket_is_fresh(ticket: dict[str, Any], ticket_path: Path, now: float) -> bool:
    expires_at = ticket.get("expires_at_epoch")
    if isinstance(expires_at, (int, float)) and expires_at < now:
        _remove_file(ticket_path)
        return False

    created_at = ticket.get("created_at_epoch")
    if isinstance(created_at, (int, float)):
        if now - created_at <= CURSOR_SHELL_TICKET_TTL_SECONDS:
            return True
        _remove_file(ticket_path)
        return False
    return True


def _ticket_cwd_matches_repo(ticket: dict[str, Any], repo_root: Path) -> bool:
    cwd = _string_value(ticket.get("cwd"))
    if not cwd:
        return True
    try:
        Path(cwd).resolve().relative_to(repo_root)
    except ValueError:
        return False
    return True


def _matching_cursor_ticket_context_key(
    ticket_path: Path,
    repo_root: Path,
    now: float,
) -> str | None:
    ticket = _read_json(ticket_path)
    if ticket is None or ticket.get("platform") != "cursor":
        return None
    if not _ticket_is_fresh(ticket, ticket_path, now):
        return None
    if not _ticket_cwd_matches_repo(ticket, repo_root):
        return None
    if not _pending_ticket_matches_args(ticket, repo_root):
        return None
    return _string_value(ticket.get("context_key"))


def _lookup_cursor_shell_ticket_context_key() -> str | None:
    """Resolve Cursor conversation identity from a short-lived shell ticket.

    Cursor exposes `conversation_id` to `beforeShellExecution`, but does not
    export it into the shell command environment. The Cursor hook writes a
    short-lived ticket just before `task.py` runs. We accept a ticket only when
    the current `task.py` subcommand matches and exactly one fresh context key
    matches, which avoids cross-window pointer contamination.
    """
    repo_root = _find_repo_root_from_cwd()
    if repo_root is None:
        return None

    ticket_dir = _cursor_shell_ticket_dir(repo_root)
    if not ticket_dir.is_dir():
        return None

    now = time.time()
    candidates: set[str] = set()
    for ticket_path in ticket_dir.glob("*.json"):
        context_key = _matching_cursor_ticket_context_key(ticket_path, repo_root, now)
        if context_key:
            candidates.add(context_key)

    if len(candidates) == 1:
        return next(iter(candidates))
    return None


def resolve_context_key(
    platform_input: dict[str, Any] | None = None,
    platform: str | None = None,
) -> str | None:
    """Resolve a stable session/window context key, if one is available.

    `PACTILE_CONTEXT_ID` is an explicit context-key override used by CLI
    scripts and subprocesses. It does not store the task itself.
    """
    override = _string_value(os.environ.get("PACTILE_CONTEXT_ID"))
    if override:
        return _sanitize_key(override) or _hash_value(override)

    data = _as_dict(platform_input)
    platform_name = _detect_platform(data, platform) if data or platform else None

    if data:
        session_id = _lookup_string(data, _SESSION_KEYS)
        if session_id:
            return _context_key(platform_name or "session", "session", session_id)

        conversation_id = _lookup_string(data, _CONVERSATION_KEYS)
        if conversation_id:
            return _context_key(platform_name or "session", "conversation", conversation_id)

        transcript_path = _lookup_string(data, _TRANSCRIPT_KEYS)
        if transcript_path:
            return _context_key(platform_name or "session", "transcript", transcript_path)

    env_context_key = _lookup_env_context_key(platform_name)
    if env_context_key:
        return env_context_key

    if platform_name == "cursor":
        return _lookup_cursor_shell_ticket_context_key()
    return None


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, data: dict[str, Any]) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return True
    except OSError:
        return False


def _canonical_task_ref(task_path: str, repo_root: Path) -> str | None:
    normalized = normalize_task_ref(task_path)
    if not normalized:
        return None
    full_path = resolve_task_ref(normalized, repo_root)
    if full_path is None or not full_path.is_dir():
        return None
    try:
        return full_path.relative_to(repo_root).as_posix()
    except ValueError:
        return str(full_path)


def _selected_from_ref(
    task_ref: str | None,
    repo_root: Path,
    source_type: str,
    context_key: str | None = None,
) -> SelectedTask | None:
    if not task_ref:
        return None
    resolved = resolve_task_ref(task_ref, repo_root)
    stale = resolved is None or not resolved.is_dir()
    return SelectedTask(task_ref, source_type, context_key, stale)


def _context_path(repo_root: Path, context_key: str) -> Path:
    return _runtime_sessions_dir(repo_root) / f"{context_key}.json"


def resolve_selected_task(
    repo_root: Path,
    platform_input: dict[str, Any] | None = None,
    platform: str | None = None,
) -> SelectedTask:
    """Resolve the selected task from explicit session runtime state only.

    A stale session task is returned as stale. Missing context identity or a
    missing/empty session context returns no selected task. Pactile deliberately
    does not infer selection from the existence of a single runtime session file;
    every live session starts with no selected task until the user selects one.
    """
    context_key = resolve_context_key(platform_input, platform)
    if context_key:
        context = _read_json(_context_path(repo_root, context_key)) or {}
        task_ref = _string_value(context.get("selected_task"))
        selected = _selected_from_ref(task_ref, repo_root, "session", context_key)
        if selected:
            return selected

    return SelectedTask(None, "none", context_key)


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _context_metadata(
    platform_input: dict[str, Any] | None,
    platform: str | None,
    context_key: str | None = None,
) -> dict[str, Any]:
    data = _as_dict(platform_input) or {}
    platform_name = _detect_platform(data, platform)
    if platform_name == "session" and context_key:
        prefix = context_key.split("_", 1)[0]
        if prefix in _KNOWN_PLATFORMS:
            platform_name = prefix
    metadata: dict[str, Any] = {
        "platform": platform_name,
        "last_seen_at": _utc_now(),
    }
    for key in (*_SESSION_KEYS, *_CONVERSATION_KEYS, *_TRANSCRIPT_KEYS):
        value = _lookup_string(data, (key,))
        if value:
            metadata[key] = value
    return metadata


def set_selected_task(
    task_path: str,
    repo_root: Path,
    platform_input: dict[str, Any] | None = None,
    platform: str | None = None,
) -> SelectedTask | None:
    """Set the selected task in session scope.

    Returns None when no context key is available; callers should surface a
    user-facing error that explains how to provide session identity.
    """
    canonical = _canonical_task_ref(task_path, repo_root)
    if canonical is None:
        return None

    context_key = resolve_context_key(platform_input, platform)
    if not context_key:
        return None

    context_path = _context_path(repo_root, context_key)
    context = _read_json(context_path) or {}
    context.update(_context_metadata(platform_input, platform, context_key))
    context["selected_task"] = canonical
    context.pop("current_task", None)
    context.setdefault("current_run", None)
    if not _write_json(context_path, context):
        return None
    return SelectedTask(canonical, "session", context_key)


def clear_selected_task(
    repo_root: Path,
    platform_input: dict[str, Any] | None = None,
    platform: str | None = None,
) -> SelectedTask:
    """Clear the selected task by deleting the current session context file."""
    context_key = resolve_context_key(platform_input, platform)
    if not context_key:
        return SelectedTask(None, "none")

    previous = resolve_selected_task(repo_root, platform_input, platform)
    context_path = _context_path(repo_root, context_key)
    if context_path.is_file():
        _remove_file(context_path)
    return previous


def clear_task_from_sessions(task_path: str, repo_root: Path) -> int:
    """Delete all session runtime files that point at a task."""
    target = _canonical_task_ref(task_path, repo_root) or normalize_task_ref(task_path)
    if not target:
        return 0

    cleared = 0
    sessions_dir = _runtime_sessions_dir(repo_root)
    if not sessions_dir.is_dir():
        return cleared

    for session_path in sessions_dir.glob("*.json"):
        context = _read_json(session_path) or {}
        current = (
            _string_value(context.get("selected_task"))
            or _string_value(context.get("current_task"))
        )
        if not current:
            continue
        current_ref = _canonical_task_ref(current, repo_root) or normalize_task_ref(current)
        if current_ref != target:
            continue
        if session_path.is_file() and _remove_file(session_path):
            cleared += 1

    return cleared


def get_selected_task_source(
    repo_root: Path,
    platform_input: dict[str, Any] | None = None,
    platform: str | None = None,
) -> tuple[str, str | None, str | None]:
    """Return (`source_type`, `context_key`, `task_path`) for selected task."""
    active = resolve_selected_task(repo_root, platform_input, platform)
    return active.source_type, active.context_key, active.task_path


# Internal compatibility aliases. User-facing commands and generated guidance
# use selected-task wording, but keeping these names avoids a broad one-shot
# rewrite of imports that are not part of the public command surface.
ActiveTask = SelectedTask
resolve_active_task = resolve_selected_task
set_active_task = set_selected_task
clear_active_task = clear_selected_task
get_current_task_source = get_selected_task_source
