#!/usr/bin/env python
"""
Task CRUD operations.

Provides:
    ensure_tasks_dir   - Ensure tasks directory exists
    cmd_create         - Create a new task
    cmd_archive        - Archive completed task
    cmd_set_branch     - Set git branch for task
    cmd_set_base_branch - Set PR target branch
    cmd_set_scope      - Set scope for PR title
    cmd_set_deps       - Set task-level depends_on (declare + soft checks)
    cmd_set_depends_mode - Set meta.depends_mode (warn | block | off)
    cmd_add_subtask    - Link child task to parent
    cmd_remove_subtask - Unlink child task from parent
    cmd_prepare_child_worktree - Create/register Child git worktree
    cmd_set_child_state - Set Child-reported task-map state
    cmd_integrate_child - Set Parent-controlled Child integration state
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from .artifact_locale import (
    default_prd_content,
    default_verify_content,
    resolve_artifact_locale,
)
from .config import (
    get_packages,
    get_session_auto_commit,
    is_monorepo,
    resolve_package,
    validate_package,
)
from .cli_environment import format_git_repo_errors, print_environment_repair_hints
from .git import is_git_worktree, run_git
from .io import read_json
from .kernel_command import (
    KernelCliNotFound,
    KernelCommandError,
    kernel_archive,
    kernel_create,
    kernel_expected_revision,
    kernel_patch,
    print_kernel_error,
)
from .log import Colors, colored
from .paths import (
    DIR_ARCHIVE,
    DIR_TASKS,
    DIR_WORKFLOW,
    FILE_TASK_JSON,
    generate_task_date_prefix,
    get_developer,
    get_repo_root,
    get_tasks_dir,
)
from .safe_commit import (
    print_gitignore_warning,
    safe_archive_paths_to_add,
    safe_git_add,
)
from .task_gates import (
    BASELINE_GATE,
    archive_repair_hints,
    build_notes_projection,
    build_spec_update_scaffold,
    collect_kernel_projection_extras,
    prepare_archive_evidence,
    task_closeout_profile,
    validate_archive,
    write_gate_record,
)
from .ondemand_topology import TopologyError, assign_parent, default_topology
from .task_map import (
    CHILD_STATES,
    CHILD_REPORT_STATES,
    PARENT_CONTROLLED_STATES,
    ensure_task_map,
    get_child_state,
    record_child_worktree,
    remove_child_from_task_map,
    resolve_child_map_id,
    set_child_state,
    set_parent_child_integration_state,
    validate_parent_child_integration,
)
from .tasks import parent_archive_child_followup_hint
from .task_utils import (
    archive_task_complete,
    find_task_by_name,
    resolve_task_dir,
    run_task_hooks,
)


# =============================================================================
# Helper Functions
# =============================================================================

def _slugify(title: str) -> str:
    """Convert title to slug (only works with ASCII)."""
    result = title.lower()
    result = re.sub(r"[^a-z0-9]", "-", result)
    result = re.sub(r"-+", "-", result)
    result = result.strip("-")
    return result


def ensure_tasks_dir(repo_root: Path) -> Path:
    """Ensure tasks directory exists."""
    tasks_dir = get_tasks_dir(repo_root)
    archive_dir = tasks_dir / "archive"

    if not tasks_dir.exists():
        tasks_dir.mkdir(parents=True)
        print(colored(f"Created tasks directory: {tasks_dir}", Colors.GREEN), file=sys.stderr)

    if not archive_dir.exists():
        archive_dir.mkdir(parents=True)

    return tasks_dir


def _find_archived_task_by_dir_name(tasks_dir: Path, dir_name: str) -> Path | None:
    """Find an archived task directory with the exact active-task dir name."""
    archive_dir = tasks_dir / DIR_ARCHIVE
    if not archive_dir.is_dir():
        return None

    for month_dir in sorted(archive_dir.iterdir()):
        if not month_dir.is_dir():
            continue
        candidate = month_dir / dir_name
        if candidate.is_dir():
            return candidate

    return None


def _repo_relative_path(path: Path, repo_root: Path) -> str:
    """Format a path relative to the repo root when possible."""
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return str(path)


def _short_cli_ref(value: str | None) -> bool:
    """Return True for a compact single-argument ref/path value."""
    if not value or not isinstance(value, str):
        return False
    if value.startswith("-"):
        return False
    if len(value) > 240:
        return False
    return "\n" not in value and "\r" not in value


def _validate_git_repo(repo_root: Path) -> list[str]:
    rc, out, err = run_git(["rev-parse", "--is-inside-work-tree"], cwd=repo_root)
    if rc != 0 or out.strip() != "true":
        detail = err.strip() or out.strip() or "not a Git worktree"
        return format_git_repo_errors([f"Git repository required: {detail}"])
    return []


def _validate_branch_name(repo_root: Path, branch: str) -> list[str]:
    if not _short_cli_ref(branch):
        return ["branch must be a short git branch name"]
    rc, _, err = run_git(["check-ref-format", "--branch", branch], cwd=repo_root)
    if rc != 0:
        return [f"invalid branch name: {branch} ({err.strip() or 'git check-ref-format failed'})"]
    return []


def _git_commit_exists(repo_root: Path, ref: str | None) -> bool:
    if not _short_cli_ref(ref):
        return False
    rc, _, _ = run_git(["rev-parse", "--verify", f"{ref}^{{commit}}"], cwd=repo_root)
    return rc == 0


def _git_branch_exists(repo_root: Path, branch: str) -> bool:
    rc, _, _ = run_git(
        ["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"],
        cwd=repo_root,
    )
    return rc == 0


def _default_child_worktree_path(repo_root: Path, child_dir: Path) -> Path:
    return repo_root / DIR_WORKFLOW / "worktrees" / child_dir.name


def _resolve_child_worktree_path(repo_root: Path, child_dir: Path, raw_path: str | None) -> tuple[Path | None, str | None]:
    path = Path(raw_path) if raw_path else _default_child_worktree_path(repo_root, child_dir)
    if not path.is_absolute():
        path = repo_root / path
    resolved = path.resolve()
    worktree_root = (repo_root / DIR_WORKFLOW / "worktrees").resolve()
    try:
        resolved.relative_to(worktree_root)
    except ValueError:
        return None, f"worktree path must stay under {_repo_relative_path(worktree_root, repo_root)}"
    return resolved, None


def _non_pactile_dirty_paths(repo_root: Path) -> list[str]:
    rc, out, err = run_git(["status", "--porcelain"], cwd=repo_root)
    if rc != 0:
        return [err.strip() or "git status failed"]

    dirty: list[str] = []
    for raw_line in out.splitlines():
        path = raw_line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1].strip()
        path = path.replace("\\", "/").strip('"')
        if path and path != ".pactile" and not path.startswith(".pactile/"):
            dirty.append(path)
    return dirty


def _validate_merge_execution(repo_root: Path, state: str, ref: str | None) -> list[str]:
    errors = _validate_git_repo(repo_root)
    if state != "integrated":
        errors.append("--execute-merge is only valid with state `integrated`")
    if not _short_cli_ref(ref):
        errors.append("--execute-merge requires --ref")
    elif not _git_commit_exists(repo_root, ref):
        errors.append(f"merge ref does not resolve to a commit: {ref}")

    dirty = _non_pactile_dirty_paths(repo_root)
    if dirty:
        errors.append(
            "non-Pactile working tree changes block merge execution: "
            + ", ".join(dirty[:8])
        )
    return errors


# =============================================================================
# Sub-agent platform detection + JSONL seeding
# =============================================================================

# Config directories of platforms that consume implement.jsonl / check.jsonl.
# Keep in sync with src/types/ai-tools.ts AI_TOOLS entries — these are the
# platforms listed in workflow.md's "agent-capable" Skill Routing block
# (Class-1 hook-inject + Class-2 pull-based preludes). Kilo / Antigravity /
# Windsurf are NOT in this list: they do not consume JSONL.
_SUBAGENT_CONFIG_DIRS: tuple[str, ...] = (
    ".claude",
    ".cursor",
    ".codex",
    ".kiro",
    ".gemini",
    ".opencode",
    ".qoder",
    ".codebuddy",
    ".factory",   # Factory Droid
    ".github/copilot",
    ".pi",        # Pi Agent
)

# Stable seed paths for jsonl create: one user-owned thinking-guide index plus
# framework-owned verification/injection docs (both always present after init).
_STABLE_SEED_PATHS: tuple[str, ...] = (
    ".pactile/spec/guides/index.md",
    ".pactile/framework/verification-strength-guide.md",
    ".pactile/framework/injection-budget-guide.md",
)


def _has_subagent_platform(repo_root: Path) -> bool:
    """Return True if any sub-agent-capable platform is configured.

    Detected by probing well-known config directories at the repo root. Used
    only to decide whether ``task.py create`` should seed empty
    ``implement.jsonl`` / ``check.jsonl`` files.
    """
    for config_dir in _SUBAGENT_CONFIG_DIRS:
        if (repo_root / config_dir).is_dir():
            return True
    return False


def _resolve_seed_spec_paths(
    repo_root: Path,
    task_dir: Path,
    task_data: dict,
) -> list[str]:
    """Return 2–3 existing spec file paths for jsonl create seeds."""
    from .task_gates import suggest_spec_targets

    candidates: list[str] = []
    for path in suggest_spec_targets(repo_root, task_dir, task_data):
        if path not in candidates:
            candidates.append(path)

    guides_dir = repo_root / ".pactile" / "spec" / "guides"
    if guides_dir.is_dir():
        for guide in sorted(guides_dir.iterdir()):
            if guide.is_file() and guide.suffix.lower() == ".md":
                rel = f".pactile/spec/guides/{guide.name}"
                if rel not in candidates:
                    candidates.append(rel)

    for rel in _STABLE_SEED_PATHS:
        if rel not in candidates:
            candidates.append(rel)

    existing = [rel for rel in candidates if (repo_root / rel).is_file()]
    if len(existing) >= 2:
        return existing[:3]

    fallback = [
        rel for rel in _STABLE_SEED_PATHS if (repo_root / rel).is_file()
    ]
    return fallback[:3]


def _write_seed_jsonl(
    path: Path,
    repo_root: Path,
    task_dir: Path,
    task_data: dict,
) -> None:
    """Write 2–3 JSONL rows with real spec ``file`` paths for sub-agent context."""
    spec_paths = _resolve_seed_spec_paths(repo_root, task_dir, task_data)
    if len(spec_paths) < 2:
        raise ValueError(
            "task create requires at least two existing spec guide paths for jsonl seed"
        )

    lines: list[str] = []
    for spec_path in spec_paths:
        lines.append(
            json.dumps(
                {
                    "file": spec_path,
                    "reason": "default spec seed — curate entries for this task",
                },
                ensure_ascii=False,
            )
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _default_prd_content(
    title: str,
    description: str | None = None,
    *,
    repo_root: Path | None = None,
    task_dir: Path | None = None,
) -> str:
    """Return the default PRD skeleton created with every task."""
    root = repo_root or get_repo_root()
    locale = resolve_artifact_locale(task_dir, root)
    return default_prd_content(title, description, locale, root)


def _kernel_patch_task_json(
    task_dir: Path,
    data: dict,
    *,
    actor: str,
    op: str,
    evidence: str,
) -> bool:
    """Persist mutated task.json fields through Kernel patch (not task-map.md)."""
    extras = collect_kernel_projection_extras(data)
    if "depends_on" in data:
        extras["depends_on"] = data["depends_on"]
    try:
        expected = kernel_expected_revision(task_dir)
        kernel_patch(
            task_dir,
            data,
            extras,
            expected_revision=expected,
            actor=actor,
            idempotency_key=f"patch:{op}:{task_dir.name}:r{expected}",
            evidence=evidence,
        )
        return True
    except (KernelCliNotFound, KernelCommandError) as err:
        print_kernel_error(err)
        return False


# =============================================================================
# Command: create
# =============================================================================

def cmd_create(args: argparse.Namespace) -> int:
    """Create a new task."""
    repo_root = get_repo_root()

    if not args.title:
        print(colored("Error: title is required", Colors.RED), file=sys.stderr)
        return 1

    # Validate --package (CLI source: fail-fast)
    package: str | None = getattr(args, "package", None)
    if not is_monorepo(repo_root):
        # Single-repo: ignore --package, no package prefix
        if package:
            print(colored(f"Warning: --package ignored in single-repo project", Colors.YELLOW), file=sys.stderr)
        package = None
    elif package:
        if not validate_package(package, repo_root):
            packages = get_packages(repo_root)
            available = ", ".join(sorted(packages.keys())) if packages else "(none)"
            print(colored(f"Error: unknown package '{package}'. Available: {available}", Colors.RED), file=sys.stderr)
            return 1
    else:
        # Inferred: default_package → None (no task.json yet for create)
        package = resolve_package(repo_root=repo_root)

    # Default assignee to current developer
    assignee = args.assignee
    if not assignee:
        assignee = get_developer(repo_root)
        if not assignee:
            print(colored("Error: No developer set. Run init_developer.py first or use --assignee", Colors.RED), file=sys.stderr)
            return 1

    ensure_tasks_dir(repo_root)

    # Get current developer as creator
    creator = get_developer(repo_root) or assignee

    # Generate slug if not provided
    slug = args.slug or _slugify(args.title)
    if not slug:
        print(colored("Error: could not generate slug from title", Colors.RED), file=sys.stderr)
        return 1

    # Create task directory with MM-DD-slug format
    tasks_dir = get_tasks_dir(repo_root)
    date_prefix = generate_task_date_prefix()
    dir_name = f"{date_prefix}-{slug}"
    task_dir = tasks_dir / dir_name
    task_json_path = task_dir / FILE_TASK_JSON

    archived_task_dir = _find_archived_task_by_dir_name(tasks_dir, dir_name)
    if archived_task_dir:
        print(colored(f"Error: Task already archived: {dir_name}", Colors.RED), file=sys.stderr)
        print(f"Archived at: {_repo_relative_path(archived_task_dir, repo_root)}", file=sys.stderr)
        print("Use a new slug if you intend to create a new task.", file=sys.stderr)
        return 1

    if task_dir.exists():
        print(colored(f"Warning: Task directory already exists: {dir_name}", Colors.YELLOW), file=sys.stderr)
    else:
        task_dir.mkdir(parents=True)

    today = datetime.now().strftime("%Y-%m-%d")

    # Record current branch as base_branch (PR target)
    _, branch_out, _ = run_git(["branch", "--show-current"], cwd=repo_root)
    current_branch = branch_out.strip() or "main"

    task_data = {
        "id": slug,
        "name": slug,
        "title": args.title,
        "description": args.description or "",
        "status": "planning",
        "dev_type": None,
        "scope": None,
        "package": package,
        "priority": args.priority,
        "creator": creator,
        "assignee": assignee,
        "createdAt": today,
        "completedAt": None,
        "branch": None,
        "base_branch": current_branch,
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

    parent_dir = None
    parent_data = None
    if args.parent:
        parent_dir = resolve_task_dir(args.parent, repo_root)
        parent_json_path = parent_dir / FILE_TASK_JSON
        if not parent_json_path.is_file():
            print(colored(f"Warning: Parent task.json not found: {args.parent}", Colors.YELLOW), file=sys.stderr)
        else:
            parent_data = read_json(parent_json_path)
            if parent_data:
                task_data["parent"] = parent_dir.name

    try:
        kernel_create(
            task_dir,
            task_data,
            actor="task.py create",
            idempotency_key=f"create:{slug}",
            evidence="task.py create",
        )
    except (KernelCliNotFound, KernelCommandError) as err:
        print_kernel_error(err)
        return 1

    persisted = read_json(task_json_path)
    if persisted:
        task_data = persisted

    prd_path = task_dir / "prd.md"
    if not prd_path.exists():
        prd_path.write_text(
            _default_prd_content(args.title, args.description, repo_root=repo_root, task_dir=task_dir),
            encoding="utf-8",
        )

    verify_path = task_dir / "verify.md"
    if not verify_path.exists():
        verify_path.write_text(
            default_verify_content(repo_root=repo_root, task_dir=task_dir),
            encoding="utf-8",
        )

    # Seed implement.jsonl / check.jsonl for sub-agent-capable platforms.
    # Agent curates real entries during planning when the task needs them.
    # Agent-less platforms (Kilo / Antigravity / Windsurf) skip this — they
    # load specs via the pactile-before-dev skill instead of JSONL.
    seeded_jsonl = False
    if _has_subagent_platform(repo_root):
        for jsonl_name in ("implement.jsonl", "check.jsonl"):
            jsonl_path = task_dir / jsonl_name
            if not jsonl_path.exists():
                _write_seed_jsonl(jsonl_path, repo_root, task_dir, task_data)
        seeded_jsonl = True

    # Handle --parent: child's `parent` is in the Kernel create record above;
    # parent `children[]` goes through Kernel patch. task-map.md stays Python.
    if parent_dir is not None and parent_data:
        parent_children = parent_data.get("children", [])
        if dir_name not in parent_children:
            parent_children.append(dir_name)
            parent_data["children"] = parent_children
            if not _kernel_patch_task_json(
                parent_dir,
                parent_data,
                actor="task.py create",
                op="create-parent-link",
                evidence="children[]",
            ):
                return 1
        ensure_task_map(
            parent_dir,
            parent_data,
            list(parent_data.get("children", [])),
            f"Linked Child `{dir_name}`.",
        )
        print(colored(f"Linked as child of: {parent_dir.name}", Colors.GREEN), file=sys.stderr)

    print(colored(f"Created task: {dir_name}", Colors.GREEN), file=sys.stderr)
    print("", file=sys.stderr)
    print(colored("Next steps:", Colors.BLUE), file=sys.stderr)
    print("  - Fill prd.md with requirements and acceptance criteria", file=sys.stderr)
    print(f"  - Select it when ready: python ./.pactile/scripts/task.py select {DIR_WORKFLOW}/{DIR_TASKS}/{dir_name}", file=sys.stderr)
    print("  - Personal Lite: Definition=prd.md, Evidence=verify.md; start-execution --check is not approval", file=sys.stderr)
    print("  - Lightweight task: PRD-only is valid", file=sys.stderr)
    print("  - Complex task: add design.md and implement.md before task.py start-execution --check", file=sys.stderr)
    if seeded_jsonl:
        print(
            "  - Curate implement.jsonl / check.jsonl as spec/research manifests when sub-agents need context",
            file=sys.stderr,
        )
    print("  - Use /pactile:continue or phase context to decide the next step", file=sys.stderr)
    print("", file=sys.stderr)

    # Output relative path for script chaining
    print(f"{DIR_WORKFLOW}/{DIR_TASKS}/{dir_name}")

    run_task_hooks("after_create", task_json_path, repo_root)
    return 0


# =============================================================================
# Command: archive / prepare-archive-evidence
# =============================================================================

def cmd_prepare_archive_evidence(args: argparse.Namespace) -> int:
    """Append missing archive evidence sections to verify.md (non-destructive)."""
    repo_root = get_repo_root()
    task_name = args.name
    if not task_name:
        print(colored("Error: Task name is required", Colors.RED), file=sys.stderr)
        return 1

    task_dir = resolve_task_dir(task_name, repo_root)
    if not task_dir or not task_dir.is_dir():
        print(colored(f"Error: Task not found: {task_name}", Colors.RED), file=sys.stderr)
        return 1

    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None
    dry_run = getattr(args, "dry_run", False)

    changed, messages = prepare_archive_evidence(
        task_dir, task_data, dry_run=dry_run
    )
    for msg in messages:
        print(msg)
    if not changed and messages and messages[0].startswith("task.json"):
        return 1

    guard = validate_archive(task_dir, task_data)
    if guard.ok:
        print(colored("Archive check: PASS (after prepare)", Colors.GREEN))
        return 0
    print(colored("Archive check: still blocked", Colors.YELLOW))
    for item in guard.errors:
        print(f"  - {item}")
    if task_data is not None:
        hints = archive_repair_hints(guard.errors, task_dir, task_data, guard)
        if hints:
            print(colored("Next steps:", Colors.BLUE))
            for hint in hints:
                print(f"  - {hint}")
    return 0 if changed else 1


def cmd_prepare_learning_scaffold(args: argparse.Namespace) -> int:
    """Print spec-update scaffolding for a task (stdout only; does not edit specs)."""
    repo_root = get_repo_root()
    task_name = args.name
    if not task_name:
        print(colored("Error: Task name is required", Colors.RED), file=sys.stderr)
        return 1

    task_dir = resolve_task_dir(task_name, repo_root)
    if not task_dir or not task_dir.is_dir():
        print(colored(f"Error: Task not found: {task_name}", Colors.RED), file=sys.stderr)
        return 1

    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None
    if task_data is None:
        print(colored("Error: task.json missing or invalid", Colors.RED), file=sys.stderr)
        return 1

    trigger = getattr(args, "trigger", None)
    print(build_spec_update_scaffold(repo_root, task_dir, task_data, trigger=trigger))
    return 0


def _integrated_children_still_active(
    parent_dir: Path,
    child_names: list[str],
    tasks_dir: Path,
) -> list[tuple[str, Path]]:
    """Return (name, dir) for integrated children that remain in the active set."""
    pending: list[tuple[str, Path]] = []
    for child_name in child_names:
        if not isinstance(child_name, str):
            continue
        if get_child_state(parent_dir, child_name) != "integrated":
            continue
        child_dir = find_task_by_name(child_name, tasks_dir)
        if child_dir and child_dir.is_dir():
            pending.append((child_name, child_dir))
    return pending


def _archive_one_task(
    task_dir: Path,
    repo_root: Path,
    tasks_dir: Path,
    *,
    no_commit: bool,
) -> tuple[bool, list[str], str | None]:
    """Archive a single task directory after validate_archive passed.

    Returns (success, modified_child_names, archived_relative_path_or_none).
    """
    dir_name = task_dir.name
    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None
    guard = validate_archive(task_dir, task_data)
    if not guard.ok:
        return False, [], None

    today = datetime.now().strftime("%Y-%m-%d")
    modified_children: list[str] = []
    if task_data:
        data = task_data
        if guard.baseline_record:
            write_gate_record(data, "full-task-complete", BASELINE_GATE, guard.baseline_record)
        data["status"] = "completed"
        data["completedAt"] = today

        year_month = datetime.now().strftime("%Y-%m")
        archived_rel_guess = (
            f"{DIR_WORKFLOW}/{DIR_TASKS}/{DIR_ARCHIVE}/{year_month}/{dir_name}"
        )
        data["notes_projection"] = build_notes_projection(
            task_dir, data, archived_rel=archived_rel_guess
        )

        extras = collect_kernel_projection_extras(data)
        try:
            expected = kernel_expected_revision(task_dir)
            kernel_archive(
                task_dir,
                data,
                extras,
                expected_revision=expected,
                actor="task.py archive",
                idempotency_key=f"archive:{dir_name}:{today}",
                evidence="task.py archive",
            )
        except (KernelCliNotFound, KernelCommandError) as err:
            print_kernel_error(err)
            return False, [], None

        task_children = data.get("children", [])
        if task_children:
            for child_name in task_children:
                child_dir_path = find_task_by_name(child_name, tasks_dir)
                if child_dir_path:
                    child_json = child_dir_path / FILE_TASK_JSON
                    if child_json.is_file():
                        child_data = read_json(child_json)
                        if child_data:
                            child_data["parent"] = None
                            if not _kernel_patch_task_json(
                                child_dir_path,
                                child_data,
                                actor="task.py archive",
                                op="archive-clear-parent",
                                evidence="parent",
                            ):
                                return False, modified_children, None
                            modified_children.append(child_dir_path.name)

    from .active_task import clear_task_from_sessions

    profile = task_closeout_profile(task_dir, task_data) if task_data else "lite"
    clear_task_from_sessions(str(task_dir), repo_root)
    result = archive_task_complete(task_dir, repo_root)
    if "archived_to" not in result:
        if profile == "lite":
            print(
                colored(
                    "Close Outcome written; physical archive/retention skipped "
                    "(not a Lite completion condition).",
                    Colors.YELLOW,
                ),
                file=sys.stderr,
            )
            return True, modified_children, f"{DIR_WORKFLOW}/{DIR_TASKS}/{dir_name}"
        return False, modified_children, None

    archive_dest = Path(result["archived_to"])
    year_month = archive_dest.parent.name
    print(
        colored(f"Archived: {dir_name} -> archive/{year_month}/", Colors.GREEN),
        file=sys.stderr,
    )

    if not no_commit:
        if not _auto_commit_archive(dir_name, repo_root, modified_children):
            if profile == "lite":
                print(
                    colored(
                        "Lite Close Outcome stands; git auto-commit skipped or failed "
                        "(VCS is On-demand, not a completion condition).",
                        Colors.YELLOW,
                    ),
                    file=sys.stderr,
                )
            else:
                print(
                    colored(
                        "Archive moved on disk, but git auto-commit did not complete. "
                        "Resolve `git status` before continuing.",
                        Colors.RED,
                    ),
                    file=sys.stderr,
                )
                return False, modified_children, None

    rel = f"{DIR_WORKFLOW}/{DIR_TASKS}/{DIR_ARCHIVE}/{year_month}/{dir_name}"
    archived_json = archive_dest / FILE_TASK_JSON
    run_task_hooks("after_archive", archived_json, repo_root)
    return True, modified_children, rel


def cmd_archive(args: argparse.Namespace) -> int:
    """Archive completed task."""
    repo_root = get_repo_root()
    task_name = args.name

    if not task_name:
        print(colored("Error: Task name is required", Colors.RED), file=sys.stderr)
        return 1

    tasks_dir = get_tasks_dir(repo_root)

    # Resolve task directory (supports task name, relative path, or absolute path)
    task_dir = resolve_task_dir(task_name, repo_root)

    if not task_dir or not task_dir.is_dir():
        print(colored(f"Error: Task not found: {task_name}", Colors.RED), file=sys.stderr)
        print("Active tasks:", file=sys.stderr)
        # Import lazily to avoid circular dependency
        from .tasks import iter_active_tasks
        for t in iter_active_tasks(tasks_dir):
            print(f"  - {t.dir_name}/", file=sys.stderr)
        return 1

    dir_name = task_dir.name
    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None

    guard = validate_archive(task_dir, task_data)
    task_children_raw = (
        task_data.get("children", []) if isinstance(task_data, dict) else []
    )
    structural_children = [
        name for name in task_children_raw if isinstance(name, str)
    ]
    cascade = getattr(args, "archive_integrated_children", False)
    pending_integrated = _integrated_children_still_active(
        task_dir, structural_children, tasks_dir
    )

    if getattr(args, "check", False):
        if not guard.ok:
            print(colored("Archive check: FAIL", Colors.RED))
            for item in guard.errors:
                print(f"  - {item}")
            if task_data is not None:
                hints = archive_repair_hints(
                    guard.errors, task_dir, task_data, guard
                )
                if hints:
                    print(colored("Next steps:", Colors.BLUE))
                    for hint in hints:
                        print(f"  - {hint}")
            return 1
        if cascade and pending_integrated:
            for child_name, child_dir in pending_integrated:
                child_data = read_json(child_dir / FILE_TASK_JSON)
                child_guard = validate_archive(child_dir, child_data)
                if not child_guard.ok:
                    print(colored("Archive check: FAIL", Colors.RED))
                    print(
                        f"  - integrated child {child_name} not ready to archive:"
                    )
                    for item in child_guard.errors:
                        print(f"    - {item}")
                    if child_data is not None:
                        hints = archive_repair_hints(
                            child_guard.errors, child_dir, child_data, child_guard
                        )
                        if hints:
                            print(colored("Next steps:", Colors.BLUE))
                            for hint in hints:
                                print(f"    - {hint}")
                    return 1
        print(colored("Archive check: PASS", Colors.GREEN))
        print(f"Contract fingerprint: {guard.contract_fingerprint}")
        if guard.required_gates:
            print(f"Required completion gates: {', '.join(guard.required_gates)}")
        if pending_integrated and not cascade:
            hint = parent_archive_child_followup_hint(
                task_dir, structural_children, tasks_dir
            )
            if hint:
                print(hint)
        if cascade and pending_integrated:
            names = ", ".join(n for n, _ in pending_integrated)
            print(
                f"Cascade: {len(pending_integrated)} integrated child dir(s) "
                f"would archive with parent: {names}"
            )
        return 0

    if not guard.ok:
        print(colored("Error: cannot archive task; completion check failed.", Colors.RED), file=sys.stderr)
        for item in guard.errors:
            print(f"  - {item}", file=sys.stderr)
        if task_data is not None:
            hints = archive_repair_hints(guard.errors, task_dir, task_data, guard)
            if hints:
                print(colored("Next steps:", Colors.BLUE), file=sys.stderr)
                for hint in hints:
                    print(f"  - {hint}", file=sys.stderr)
        print("Run `task.py archive <task> --check` for a non-mutating preflight.", file=sys.stderr)
        return 1

    no_commit = getattr(args, "no_commit", False)
    if cascade and pending_integrated:
        for child_name, child_dir in pending_integrated:
            child_data = read_json(child_dir / FILE_TASK_JSON)
            child_guard = validate_archive(child_dir, child_data)
            if not child_guard.ok:
                print(
                    colored(
                        f"Error: integrated child {child_name} failed archive check.",
                        Colors.RED,
                    ),
                    file=sys.stderr,
                )
                for item in child_guard.errors:
                    print(f"  - {item}", file=sys.stderr)
                return 1
        for child_name, child_dir in pending_integrated:
            ok, _, _ = _archive_one_task(
                child_dir, repo_root, tasks_dir, no_commit=no_commit
            )
            if not ok:
                print(
                    colored(
                        f"Error: failed to archive integrated child {child_name}.",
                        Colors.RED,
                    ),
                    file=sys.stderr,
                )
                return 1

    manual_child_hint = None
    if pending_integrated and not cascade:
        manual_child_hint = parent_archive_child_followup_hint(
            task_dir, structural_children, tasks_dir
        )

    ok, _, rel_path = _archive_one_task(
        task_dir, repo_root, tasks_dir, no_commit=no_commit
    )
    if not ok or not rel_path:
        return 1

    if manual_child_hint:
        print(colored("Note:", Colors.YELLOW), file=sys.stderr)
        print(manual_child_hint, file=sys.stderr)

    print(rel_path)
    return 0


def _auto_commit_archive(
    task_name: str,
    repo_root: Path,
    modified_children: list[str] | None = None,
) -> bool:
    """Stage Pactile-owned task paths and commit after archive.

    Scoped narrowly to the archived task's source + destination paths
    plus any child task dirs whose ``task.json`` was edited (parent →
    children relationship update). Dirty changes in OTHER active task
    dirs are NOT bundled into the archive commit.

    If ``.gitignore`` blocks the paths, we warn + skip — we do NOT
    retry with ``git add -f``. The warning explicitly forbids
    ``git add -f .pactile/`` (which would fan out to caches/backups)
    and points users at ``session_auto_commit: false``.

    Honors ``session_auto_commit`` in ``.pactile/config.yaml``: when
    set to ``false``, this function returns immediately without
    touching git (the archive directory move on disk is unaffected).
    """
    if not is_git_worktree(repo_root):
        print(
            "[OK] no Git worktree — skipping archive auto-commit "
            "(Close Outcome already written).",
            file=sys.stderr,
        )
        return True

    if not get_session_auto_commit(repo_root):
        print(
            "[OK] session_auto_commit: false — skipping git stage/commit.",
            file=sys.stderr,
        )
        return True

    source_rel = f"{DIR_WORKFLOW}/{DIR_TASKS}/{task_name}"
    rc, tracked_out, _ = run_git(
        ["ls-files", "--", source_rel],
        cwd=repo_root,
    )
    source_was_tracked = rc == 0 and bool(tracked_out.strip())

    paths = safe_archive_paths_to_add(
        repo_root, task_name=task_name, modified_children=modified_children
    )
    if not paths:
        print("[OK] No task changes to commit.", file=sys.stderr)
        return True

    success, _, err = safe_git_add(paths, repo_root)
    if not success:
        if err and "ignored by" in err.lower():
            print_gitignore_warning(paths)
        else:
            print(
                f"[WARN] git add failed: {err.strip() if err else 'unknown error'}",
                file=sys.stderr,
            )
        return not source_was_tracked

    # Belt-and-suspenders for the phantom-delete bug: `safe_git_add` uses
    # `git add` (no -A) which only stages additions/modifications. The
    # source task directory was moved away by `shutil.move`, so its files
    # need an explicit `git rm --cached` to stage the deletions in this
    # same commit — otherwise they sit as uncommitted "phantom deletes"
    # against HEAD until something later picks them up.
    #
    # `--ignore-unmatch` makes this a no-op when the task was never tracked
    # (e.g. archiving a task that lived only in working tree).
    run_git(
        ["rm", "-r", "--cached", "--ignore-unmatch", "--", source_rel],
        cwd=repo_root,
    )

    rc, _, _ = run_git(
        ["diff", "--cached", "--quiet", "--", *paths, source_rel],
        cwd=repo_root,
    )
    if rc == 0:
        print("[OK] No task changes to commit.", file=sys.stderr)
        return True

    commit_msg = f"chore(task): archive {task_name}"
    rc, _, err = run_git(["commit", "-m", commit_msg], cwd=repo_root)
    if rc == 0:
        print(f"[OK] Auto-committed: {commit_msg}", file=sys.stderr)
        return True
    else:
        print(f"[WARN] Auto-commit failed: {err.strip()}", file=sys.stderr)
        return not source_was_tracked


# =============================================================================
# Command: add-subtask
# =============================================================================

def cmd_add_subtask(args: argparse.Namespace) -> int:
    """Link a child task to a parent task."""
    repo_root = get_repo_root()

    parent_dir = resolve_task_dir(args.parent_dir, repo_root)
    child_dir = resolve_task_dir(args.child_dir, repo_root)

    parent_json_path = parent_dir / FILE_TASK_JSON
    child_json_path = child_dir / FILE_TASK_JSON

    if not parent_json_path.is_file():
        print(colored(f"Error: Parent task.json not found: {args.parent_dir}", Colors.RED), file=sys.stderr)
        return 1

    if not child_json_path.is_file():
        print(colored(f"Error: Child task.json not found: {args.child_dir}", Colors.RED), file=sys.stderr)
        return 1

    parent_data = read_json(parent_json_path)
    child_data = read_json(child_json_path)

    if not parent_data or not child_data:
        print(colored("Error: Failed to read task.json", Colors.RED), file=sys.stderr)
        return 1

    # Check if child already has a parent
    existing_parent = child_data.get("parent")
    if existing_parent:
        print(colored(f"Error: Child task already has a parent: {existing_parent}", Colors.RED), file=sys.stderr)
        return 1

    # Add child to parent's children list
    parent_children = parent_data.get("children", [])
    child_dir_name = child_dir.name
    if child_dir_name not in parent_children:
        parent_children.append(child_dir_name)
        parent_data["children"] = parent_children

    # Set parent in child's task.json
    child_data["parent"] = parent_dir.name

    parent_id = str(parent_data.get("id") or parent_dir.name)
    parent_existing = (
        parent_data.get("topology")
        if isinstance(parent_data.get("topology"), dict)
        else {}
    )
    parent_data["topology"] = default_topology(
        parent=parent_existing.get("parent_id") or parent_data.get("parent"),
        children=parent_children,
    )
    child_existing = (
        child_data.get("topology")
        if isinstance(child_data.get("topology"), dict)
        else {}
    )
    child_children = list(
        child_existing.get("children") or child_data.get("children") or []
    )
    try:
        child_data["topology"] = assign_parent(
            default_topology(parent=None, children=child_children),
            parent_id,
        )
    except TopologyError as err:
        print(colored(f"Error: {err}", Colors.RED), file=sys.stderr)
        return 1

    if not _kernel_patch_task_json(
        parent_dir,
        parent_data,
        actor="task.py add-subtask",
        op="add-subtask",
        evidence="children[]",
    ):
        return 1
    if not _kernel_patch_task_json(
        child_dir,
        child_data,
        actor="task.py add-subtask",
        op="add-subtask",
        evidence="parent",
    ):
        return 1
    ensure_task_map(
        parent_dir,
        parent_data,
        list(parent_data.get("children", [])),
        f"Linked Child `{child_dir_name}`.",
    )

    print(colored(f"Linked: {child_dir.name} -> {parent_dir.name}", Colors.GREEN), file=sys.stderr)
    return 0


# =============================================================================
# Command: remove-subtask
# =============================================================================

def cmd_remove_subtask(args: argparse.Namespace) -> int:
    """Unlink a child task from a parent task."""
    repo_root = get_repo_root()

    parent_dir = resolve_task_dir(args.parent_dir, repo_root)
    child_dir = resolve_task_dir(args.child_dir, repo_root)

    parent_json_path = parent_dir / FILE_TASK_JSON
    child_json_path = child_dir / FILE_TASK_JSON

    if not parent_json_path.is_file():
        print(colored(f"Error: Parent task.json not found: {args.parent_dir}", Colors.RED), file=sys.stderr)
        return 1

    if not child_json_path.is_file():
        print(colored(f"Error: Child task.json not found: {args.child_dir}", Colors.RED), file=sys.stderr)
        return 1

    parent_data = read_json(parent_json_path)
    child_data = read_json(child_json_path)

    if not parent_data or not child_data:
        print(colored("Error: Failed to read task.json", Colors.RED), file=sys.stderr)
        return 1

    # Remove child from parent's children list
    parent_children = parent_data.get("children", [])
    child_dir_name = child_dir.name
    if child_dir_name in parent_children:
        parent_children.remove(child_dir_name)
        parent_data["children"] = parent_children

    # Clear parent in child's task.json
    child_data["parent"] = None

    parent_existing = (
        parent_data.get("topology")
        if isinstance(parent_data.get("topology"), dict)
        else {}
    )
    parent_data["topology"] = default_topology(
        parent=parent_existing.get("parent_id") or parent_data.get("parent"),
        children=parent_children,
    )
    child_existing = (
        child_data.get("topology")
        if isinstance(child_data.get("topology"), dict)
        else {}
    )
    child_data["topology"] = default_topology(
        parent=None,
        children=list(child_existing.get("children") or child_data.get("children") or []),
    )

    if not _kernel_patch_task_json(
        parent_dir,
        parent_data,
        actor="task.py remove-subtask",
        op="remove-subtask",
        evidence="children[]",
    ):
        return 1
    if not _kernel_patch_task_json(
        child_dir,
        child_data,
        actor="task.py remove-subtask",
        op="remove-subtask",
        evidence="parent",
    ):
        return 1
    remove_child_from_task_map(parent_dir, parent_data, child_dir_name)

    print(colored(f"Unlinked: {child_dir.name} from {parent_dir.name}", Colors.GREEN), file=sys.stderr)
    return 0


# =============================================================================
# Command: prepare-child-worktree
# =============================================================================

def cmd_prepare_child_worktree(args: argparse.Namespace) -> int:
    """Create and register a Git worktree for a Child task."""
    repo_root = get_repo_root()

    parent_dir = resolve_task_dir(args.parent_dir, repo_root)
    child_dir = resolve_task_dir(args.child_dir, repo_root)

    parent_json_path = parent_dir / FILE_TASK_JSON
    child_json_path = child_dir / FILE_TASK_JSON

    if not parent_json_path.is_file():
        print(colored(f"Error: Parent task.json not found: {args.parent_dir}", Colors.RED), file=sys.stderr)
        return 1
    if not child_json_path.is_file():
        print(colored(f"Error: Child task.json not found: {args.child_dir}", Colors.RED), file=sys.stderr)
        return 1

    parent_data = read_json(parent_json_path)
    child_data = read_json(child_json_path)
    if not parent_data or not child_data:
        print(colored("Error: Failed to read task.json", Colors.RED), file=sys.stderr)
        return 1

    if child_data.get("parent") != parent_dir.name:
        print(colored(f"Error: Child is not linked to parent: {child_dir.name}", Colors.RED), file=sys.stderr)
        return 1

    branch = args.branch
    base_ref = getattr(args, "base", None) or child_data.get("base_branch") or parent_data.get("base_branch") or "HEAD"
    worktree_path, path_error = _resolve_child_worktree_path(
        repo_root,
        child_dir,
        getattr(args, "path", None),
    )

    errors: list[str] = []
    errors.extend(_validate_git_repo(repo_root))
    errors.extend(_validate_branch_name(repo_root, branch))
    if path_error:
        errors.append(path_error)
    if worktree_path and worktree_path.exists():
        errors.append(f"worktree path already exists: {_repo_relative_path(worktree_path, repo_root)}")
    if not _git_commit_exists(repo_root, base_ref):
        errors.append(f"base ref does not resolve to a commit: {base_ref}")

    if errors:
        print("Prepare-child-worktree check: FAIL" if getattr(args, "check", False) else colored("Error: cannot prepare child worktree.", Colors.RED), file=sys.stderr)
        for item in errors:
            print(f"  - {item}", file=sys.stderr)
        print_environment_repair_hints(errors)
        return 1

    assert worktree_path is not None
    worktree_rel = _repo_relative_path(worktree_path, repo_root)
    if getattr(args, "check", False):
        print("Prepare-child-worktree check: PASS")
        print(f"Branch: {branch}")
        print(f"Base: {base_ref}")
        print(f"Path: {worktree_rel}")
        print("No files changed.")
        return 0

    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    if _git_branch_exists(repo_root, branch):
        git_args = ["worktree", "add", str(worktree_path), branch]
    else:
        git_args = ["worktree", "add", "-b", branch, str(worktree_path), base_ref]
    rc, _, err = run_git(git_args, cwd=repo_root)
    if rc != 0:
        print(colored("Error: git worktree add failed.", Colors.RED), file=sys.stderr)
        print(err.strip() or "unknown git error", file=sys.stderr)
        return 1

    child_data["branch"] = branch
    child_data["worktree_path"] = worktree_rel
    if not _kernel_patch_task_json(
        child_dir,
        child_data,
        actor="task.py prepare-child-worktree",
        op="prepare-child-worktree",
        evidence="branch,worktree_path",
    ):
        return 1

    ok, map_errors = record_child_worktree(
        parent_dir,
        parent_data,
        child_dir.name,
        branch,
        worktree_rel,
        base_ref,
    )
    if not ok:
        print(colored("Error: worktree created, but Parent task-map update failed.", Colors.RED), file=sys.stderr)
        for item in map_errors:
            print(f"  - {item}", file=sys.stderr)
        return 1

    print(colored(f"✓ Child worktree prepared: {child_dir.name}", Colors.GREEN))
    print(f"Branch: {branch}")
    print(f"Path: {worktree_rel}")
    print(f"Parent map: {_repo_relative_path(parent_dir / 'task-map.md', repo_root)}")
    return 0


# =============================================================================
# Plan B: depends_mode block helpers
# =============================================================================

def append_depends_ignore_event(
    task_data: dict,
    *,
    command: str,
    mode: str,
    blocking_summary: list[str],
    evidence: str | None = None,
    reason: str | None = None,
) -> None:
    """Append a depends-ignore audit event to meta.depends_ignore_events.

    Mutates task_data in memory; the caller persists it in the SAME
    Kernel patch as the mutation it accompanies (execution approval / child
    state), so the event can never dangle as a separate stale write. The
    list is capped at MAX_IGNORE_EVENTS (FIFO drops the oldest entry).
    """
    from .task_dependencies import MAX_IGNORE_EVENTS
    from .task_map import utc_now

    meta = task_data.get("meta")
    if not isinstance(meta, dict):
        meta = {}
        task_data["meta"] = meta
    events = meta.get("depends_ignore_events")
    if not isinstance(events, list):
        events = []
    event: dict = {
        "at": utc_now(),
        "command": command,
        "by": "user",
        "mode": mode,
        "blocking_summary": list(blocking_summary),
    }
    if evidence:
        event["evidence"] = evidence
    if reason:
        event["reason"] = reason
    events.append(event)
    del events[:-MAX_IGNORE_EVENTS]
    meta["depends_ignore_events"] = events


def _guard_child_working_deps(
    args: argparse.Namespace,
    parent_dir: Path,
    parent_data: dict,
    child_dir: Path,
    child_data: dict,
    child_map_id: str,
) -> int:
    """Enforce depends_mode=block before a Child transitions to `working`.

    Reads the CHILD's meta.depends_mode (the Parent mode never proxies for
    the Child). The dependency union covers the Child task.json depends_on
    plus the Parent task-map children[].depends_on entry; either source
    blocking rejects the transition unless --ignore-deps is passed, which
    appends an audit event to the Child task.json and a line to the Parent
    task-map Event Log. Returns 0 to allow, nonzero to reject.
    """
    from .task_dependencies import describe_child_dependencies, read_depends_mode
    from .task_map import get_child_entry, load_task_map, write_task_map

    mode = read_depends_mode(child_data)
    if mode != "block":
        return 0

    repo_root = get_repo_root()
    map_data, _ = load_task_map(parent_dir)
    entry = get_child_entry(map_data, child_map_id)
    report = describe_child_dependencies(
        child_dir, child_data, entry, repo_root=repo_root
    )
    blocking = report.blocking_errors()
    if not blocking:
        return 0

    if not getattr(args, "ignore_deps", False):
        print(
            colored(
                "Error: cannot set Child state to 'working': blocking dependencies "
                "(depends_mode=block).",
                Colors.RED,
            ),
            file=sys.stderr,
        )
        for item in blocking:
            print(f"  - {item}", file=sys.stderr)
        print(
            "Run with --ignore-deps to override (audited via meta.depends_ignore_events).",
            file=sys.stderr,
        )
        return 1

    append_depends_ignore_event(
        child_data,
        command="set-child-state",
        mode=mode,
        blocking_summary=blocking,
        evidence=args.evidence,
        reason=getattr(args, "reason", None),
    )
    if not _kernel_patch_task_json(
        child_dir,
        child_data,
        actor="task.py set-child-state",
        op="depends-ignore",
        evidence=str(args.evidence or "ignore-deps"),
    ):
        print(
            colored("Error: failed to write task.json (ignore event)", Colors.RED),
            file=sys.stderr,
        )
        return 1

    map_data_evt, map_body = load_task_map(parent_dir)
    if map_data_evt is not None:
        event = (
            f"Ignored dependencies (mode=block) for child `{child_dir.name}` "
            f"while setting state `working`: {'; '.join(blocking)}"
        )
        write_task_map(parent_dir, map_data_evt, map_body, event)
    return 0


# =============================================================================
# Command: set-child-state
# =============================================================================

def cmd_set_child_state(args: argparse.Namespace) -> int:
    """Set a Child Worker-reported state in the Parent task-map.md."""
    repo_root = get_repo_root()

    parent_dir = resolve_task_dir(args.parent_dir, repo_root)
    child_dir = resolve_task_dir(args.child_dir, repo_root)
    state = args.state

    parent_json_path = parent_dir / FILE_TASK_JSON
    child_json_path = child_dir / FILE_TASK_JSON

    if not parent_json_path.is_file():
        print(colored(f"Error: Parent task.json not found: {args.parent_dir}", Colors.RED), file=sys.stderr)
        return 1
    if not child_json_path.is_file():
        print(colored(f"Error: Child task.json not found: {args.child_dir}", Colors.RED), file=sys.stderr)
        return 1

    parent_data = read_json(parent_json_path)
    child_data = read_json(child_json_path)
    if not parent_data or not child_data:
        print(colored("Error: Failed to read task.json", Colors.RED), file=sys.stderr)
        return 1

    if child_data.get("parent") != parent_dir.name:
        print(colored(f"Error: Child is not linked to parent: {child_dir.name}", Colors.RED), file=sys.stderr)
        return 1

    if state in CHILD_STATES and not getattr(args, "evidence", None):
        print(colored("Error: --evidence is required when setting child state", Colors.RED), file=sys.stderr)
        return 1
    if state in PARENT_CONTROLLED_STATES:
        print(
            colored(
                "Error: Parent-controlled Child states require `task.py integrate-child`.",
                Colors.RED,
            ),
            file=sys.stderr,
        )
        print(
            "Allowed set-child-state values: "
            + ", ".join(sorted(CHILD_REPORT_STATES)),
            file=sys.stderr,
        )
        return 1

    child_map_id = resolve_child_map_id(parent_data, child_dir, child_data)
    if state == "working":
        guard_rc = _guard_child_working_deps(
            args,
            parent_dir,
            parent_data,
            child_dir,
            child_data,
            child_map_id,
        )
        if guard_rc != 0:
            return guard_rc

    ok, errors = set_child_state(
        parent_dir,
        parent_data,
        child_map_id,
        state,
        args.evidence,
        getattr(args, "reason", None),
    )
    if not ok:
        print(colored("Error: cannot set child state.", Colors.RED), file=sys.stderr)
        for item in errors:
            print(f"  - {item}", file=sys.stderr)
        return 1

    print(colored(f"✓ Child state updated: {child_dir.name} -> {state}", Colors.GREEN))
    print(f"Parent map: {_repo_relative_path(parent_dir / 'task-map.md', repo_root)}")
    return 0


# =============================================================================
# Command: integrate-child
# =============================================================================

def cmd_integrate_child(args: argparse.Namespace) -> int:
    """Set a Parent-controlled Child integration state."""
    repo_root = get_repo_root()

    parent_dir = resolve_task_dir(args.parent_dir, repo_root)
    child_dir = resolve_task_dir(args.child_dir, repo_root)
    state = args.state

    parent_json_path = parent_dir / FILE_TASK_JSON
    child_json_path = child_dir / FILE_TASK_JSON

    if not parent_json_path.is_file():
        print(colored(f"Error: Parent task.json not found: {args.parent_dir}", Colors.RED), file=sys.stderr)
        return 1
    if not child_json_path.is_file():
        print(colored(f"Error: Child task.json not found: {args.child_dir}", Colors.RED), file=sys.stderr)
        return 1

    parent_data = read_json(parent_json_path)
    child_data = read_json(child_json_path)
    if not parent_data or not child_data:
        print(colored("Error: Failed to read task.json", Colors.RED), file=sys.stderr)
        return 1

    if state not in PARENT_CONTROLLED_STATES:
        print(
            colored("Error: state is not Parent-controlled.", Colors.RED),
            file=sys.stderr,
        )
        print(
            "Allowed integrate-child values: "
            + ", ".join(sorted(PARENT_CONTROLLED_STATES)),
            file=sys.stderr,
        )
        return 1

    evidence = args.evidence
    ref = getattr(args, "ref", None)
    reason = getattr(args, "reason", None)
    execute_merge = getattr(args, "execute_merge", False)
    if getattr(args, "check", False):
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
        if execute_merge:
            errors.extend(_validate_merge_execution(repo_root, state, ref))
        if errors:
            print("Integrate-child check: FAIL")
            for item in errors:
                print(f"  - {item}")
            print_environment_repair_hints(errors, stream=sys.stdout)
            return 1
        print("Integrate-child check: PASS")
        if execute_merge:
            print("Merge execution check: PASS")
        print("No files changed.")
        return 0

    merge_ref = None
    if execute_merge:
        merge_errors = _validate_merge_execution(repo_root, state, ref)
        if merge_errors:
            print(colored("Error: cannot execute child merge.", Colors.RED), file=sys.stderr)
            for item in merge_errors:
                print(f"  - {item}", file=sys.stderr)
            print_environment_repair_hints(merge_errors)
            return 1

        rc, _, err = run_git(["merge", "--no-ff", "--no-commit", ref], cwd=repo_root)
        if rc != 0:
            print(colored("Error: git merge failed; Parent task-map was not advanced to integrated.", Colors.RED), file=sys.stderr)
            if err.strip():
                print(err.strip(), file=sys.stderr)
            print_environment_repair_hints([err.strip()])
            print("Resolve the merge manually, abort it with `git merge --abort`, or record a `changes` / `cancelled` Parent decision.", file=sys.stderr)
            return 1
        merge_ref = ref

    ok, errors = set_parent_child_integration_state(
        parent_dir,
        parent_data,
        child_dir,
        child_data,
        state,
        evidence,
        ref,
        reason,
        merge_ref,
    )
    if not ok:
        print(colored("Error: cannot integrate child.", Colors.RED), file=sys.stderr)
        for item in errors:
            print(f"  - {item}", file=sys.stderr)
        return 1

    print(colored(f"✓ Child integration updated: {child_dir.name} -> {state}", Colors.GREEN))
    if merge_ref:
        print(f"Merge executed: git merge --no-ff --no-commit {merge_ref}")
    print(f"Parent map: {_repo_relative_path(parent_dir / 'task-map.md', repo_root)}")

    if state == "integrated" and not getattr(args, "no_publish_pack", False):
        from .parent_orchestration import build_publish_pack

        summary, pack_errors = build_publish_pack(parent_dir)
        if pack_errors or summary is None:
            for item in pack_errors:
                print(f"  - {item}", file=sys.stderr)
            print(
                colored(
                    "Warning: integrate succeeded but publish-pack failed; "
                    "PACK may be stale (see parent-status stalePack).",
                    Colors.YELLOW,
                ),
                file=sys.stderr,
            )
            return 2
        print(colored("✓ PACK refreshed after integrate", Colors.GREEN))
        for line in summary.splitlines():
            if line.startswith("- Generated:"):
                print(line)
                break

    return 0


# =============================================================================
# Command: generate-child-prompt / parent-status / review-child
# =============================================================================

def cmd_suggest_execution_strategy(args: argparse.Namespace) -> int:
    """Suggest execution_mode and isolation for implement.md contract."""
    import json

    from .execution_strategy import (
        format_contract_yaml_block,
        suggest_execution_strategy,
    )
    from .task_utils import resolve_task_dir

    repo_root = get_repo_root()
    task_dir = resolve_task_dir(args.task_dir, repo_root)
    task_json_path = task_dir / FILE_TASK_JSON
    if not task_json_path.is_file():
        print(colored("Error: task.json not found", Colors.RED), file=sys.stderr)
        return 1
    task_data = read_json(task_json_path)
    if not isinstance(task_data, dict):
        print(colored("Error: invalid task.json", Colors.RED), file=sys.stderr)
        return 1

    suggestion = suggest_execution_strategy(repo_root, task_dir, task_data)
    if getattr(args, "json", False):
        print(json.dumps(suggestion.to_dict(), indent=2, ensure_ascii=False))
        return 0
    print(format_contract_yaml_block(suggestion))
    return 0


def cmd_generate_dispatch_prompt(args: argparse.Namespace) -> int:
    """Build a full Task dispatch prompt (Agent-facing CLI Layer 2)."""
    from .subagent_dispatch import build_dispatch_prompt

    repo_root = get_repo_root()
    task_dir = resolve_task_dir(args.task_dir, repo_root)
    role = args.role
    scope = getattr(args, "scope", None)
    finish = bool(getattr(args, "finish", False))
    max_chars = getattr(args, "max_chars", None)

    prompt, warnings, errors = build_dispatch_prompt(
        repo_root,
        task_dir,
        role,
        scope=scope,
        finish=finish,
        max_chars=max_chars,
    )
    for item in warnings:
        print(f"[generate-dispatch-prompt] WARN: {item}", file=sys.stderr)
    if errors:
        for item in errors:
            print(f"[generate-dispatch-prompt] Error: {item}", file=sys.stderr)
        return 1
    if prompt is None:
        print(colored("Error: could not build dispatch prompt", Colors.RED), file=sys.stderr)
        return 1
    print(prompt)
    return 0


def cmd_generate_child_prompt(args: argparse.Namespace) -> int:
    """Generate a child implementation prompt for parent orchestration."""
    from .parent_orchestration import build_child_prompt

    repo_root = get_repo_root()
    parent_dir = resolve_task_dir(args.parent_dir, repo_root)
    child_dir = resolve_task_dir(args.child_dir, repo_root)
    mode = getattr(args, "mode", "inline") or "inline"
    if mode not in ("inline", "subagent"):
        print(colored("Error: --mode must be inline or subagent", Colors.RED), file=sys.stderr)
        return 1

    prompt, errors = build_child_prompt(
        parent_dir,
        child_dir,
        include_artifacts=getattr(args, "include_artifacts", False),
        mode=mode,
    )
    if errors:
        for item in errors:
            print(f"  - {item}", file=sys.stderr)
        return 1
    if prompt is None:
        print(colored("Error: could not generate child prompt", Colors.RED), file=sys.stderr)
        return 1

    out_path = getattr(args, "output", None)
    if out_path:
        path = Path(out_path)
        if not path.is_absolute():
            path = repo_root / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(prompt + "\n", encoding="utf-8")
        print(colored(f"✓ Child prompt written: {_repo_relative_path(path, repo_root)}", Colors.GREEN))
    else:
        print(prompt)
    return 0


def cmd_parent_status(args: argparse.Namespace) -> int:
    """Show parent task-map orchestration status."""
    import json

    from .parent_orchestration import build_parent_status, build_parent_status_dict

    repo_root = get_repo_root()
    parent_dir = resolve_task_dir(args.parent_dir, repo_root)
    if getattr(args, "json", False):
        payload = build_parent_status_dict(parent_dir)
        if payload is None:
            print(
                json.dumps(
                    {
                        "error": "task-map.md missing or invalid",
                        "path": str(parent_dir),
                    }
                )
            )
            return 1
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    print(build_parent_status(parent_dir))
    return 0



def cmd_publish_pack(args: argparse.Namespace) -> int:
    """Publish HYBRID campaign PACK (ready list + child prompts)."""
    from .parent_orchestration import build_publish_pack

    repo_root = get_repo_root()
    parent_dir = resolve_task_dir(args.parent_dir, repo_root)
    mode = getattr(args, "mode", "inline") or "inline"
    if mode not in ("inline", "subagent"):
        print(colored("Error: --mode must be inline or subagent", Colors.RED), file=sys.stderr)
        return 1

    summary, errors = build_publish_pack(
        parent_dir,
        stage_id=getattr(args, "stage", None),
        mode=mode,
        dry_run=bool(getattr(args, "dry_run", False)),
    )
    if errors:
        for item in errors:
            print(f"  - {item}", file=sys.stderr)
        print(colored("Error: publish-pack failed", Colors.RED), file=sys.stderr)
        return 1
    if summary is None:
        print(colored("Error: publish-pack produced no summary", Colors.RED), file=sys.stderr)
        return 1
    print(summary)
    return 0


def cmd_review_child(args: argparse.Namespace) -> int:
    """Review child handoff and optionally advance parent integration states."""
    from .parent_orchestration import (
        append_parent_review_notes,
        build_review_report,
        write_review_artifact,
    )
    from .task_map import set_parent_child_integration_state

    repo_root = get_repo_root()
    parent_dir = resolve_task_dir(args.parent_dir, repo_root)
    child_dir = resolve_task_dir(args.child_dir, repo_root)

    parent_json_path = parent_dir / FILE_TASK_JSON
    child_json_path = child_dir / FILE_TASK_JSON
    if not parent_json_path.is_file() or not child_json_path.is_file():
        print(colored("Error: parent or child task.json missing", Colors.RED), file=sys.stderr)
        return 1

    parent_data = read_json(parent_json_path)
    child_data = read_json(child_json_path)
    if not parent_data or not child_data:
        print(colored("Error: Failed to read task.json", Colors.RED), file=sys.stderr)
        return 1

    decision = getattr(args, "decision", None)
    ref = getattr(args, "ref", None)
    reason = getattr(args, "reason", None)
    notes = getattr(args, "notes", None)
    check_only = getattr(args, "check", False) or not decision

    report, errors, actions = build_review_report(
        parent_dir,
        child_dir,
        parent_data,
        child_data,
        decision=decision if not check_only else None,
        ref=ref,
        reason=reason,
        notes=notes,
    )

    if getattr(args, "write_artifact", False):
        artifact = write_review_artifact(parent_dir, child_dir.name, report)
        print(colored(f"✓ Review artifact: {_repo_relative_path(artifact, repo_root)}", Colors.GREEN))

    if check_only:
        if errors:
            print("Review-child check: FAIL")
            for item in errors:
                print(f"  - {item}")
            print("")
            print(report)
            return 1
        print("Review-child check: PASS")
        print("")
        print(report)
        return 0

    if errors:
        print(colored("Error: review decision blocked by validation.", Colors.RED), file=sys.stderr)
        for item in errors:
            print(f"  - {item}", file=sys.stderr)
        return 1

    evidence_default = "handoff.md"
    if actions.get("integrate_sequence"):
        for step in actions["integrate_sequence"]:
            ok, step_errors = set_parent_child_integration_state(
                parent_dir,
                parent_data,
                child_dir,
                child_data,
                step["state"],
                step.get("evidence", evidence_default),
                step.get("ref", ref),
                step.get("reason", reason),
            )
            if not ok:
                print(colored("Error: integrate-child step failed.", Colors.RED), file=sys.stderr)
                for item in step_errors:
                    print(f"  - {item}", file=sys.stderr)
                return 1
            print(colored(f"✓ Child integration updated: {child_dir.name} -> {step['state']}", Colors.GREEN))
    elif actions.get("integrate"):
        step = actions["integrate"]
        ok, step_errors = set_parent_child_integration_state(
            parent_dir,
            parent_data,
            child_dir,
            child_data,
            step["state"],
            step.get("evidence", evidence_default),
            step.get("ref", ref),
            step.get("reason", reason),
        )
        if not ok:
            print(colored("Error: integrate-child failed.", Colors.RED), file=sys.stderr)
            for item in step_errors:
                print(f"  - {item}", file=sys.stderr)
            return 1
        print(colored(f"✓ Child integration updated: {child_dir.name} -> {step['state']}", Colors.GREEN))

    if not getattr(args, "no_append_parent_verify", False):
        append_parent_review_notes(parent_dir, child_dir.name, report)
        print(colored("✓ Appended review notes to parent verify.md", Colors.GREEN))

    for gate in actions.get("gates", []):
        if gate.get("optional") and gate.get("hint"):
            print(f"Optional reviewer gate: {gate['hint']}")

    print(report)
    return 0


# =============================================================================
# Command: set-branch
# =============================================================================

def cmd_set_branch(args: argparse.Namespace) -> int:
    """Set git branch for task."""
    repo_root = get_repo_root()
    target_dir = resolve_task_dir(args.dir, repo_root)
    branch = args.branch

    if not branch:
        print(colored("Error: Missing arguments", Colors.RED))
        print("Usage: python task.py set-branch <task-dir> <branch-name>")
        return 1

    task_json = target_dir / FILE_TASK_JSON
    if not task_json.is_file():
        print(colored(f"Error: task.json not found at {target_dir}", Colors.RED))
        return 1

    data = read_json(task_json)
    if not data:
        return 1

    data["branch"] = branch
    if not _kernel_patch_task_json(
        target_dir,
        data,
        actor="task.py set-branch",
        op="set-branch",
        evidence="branch",
    ):
        return 1

    print(colored(f"✓ Branch set to: {branch}", Colors.GREEN))
    return 0


# =============================================================================
# Command: set-base-branch
# =============================================================================

def cmd_set_base_branch(args: argparse.Namespace) -> int:
    """Set the base branch (PR target) for task."""
    repo_root = get_repo_root()
    target_dir = resolve_task_dir(args.dir, repo_root)
    base_branch = args.base_branch

    if not base_branch:
        print(colored("Error: Missing arguments", Colors.RED))
        print("Usage: python task.py set-base-branch <task-dir> <base-branch>")
        print("Example: python task.py set-base-branch <dir> develop")
        print()
        print("This sets the target branch for PR (the branch your feature will merge into).")
        return 1

    task_json = target_dir / FILE_TASK_JSON
    if not task_json.is_file():
        print(colored(f"Error: task.json not found at {target_dir}", Colors.RED))
        return 1

    data = read_json(task_json)
    if not data:
        return 1

    data["base_branch"] = base_branch
    if not _kernel_patch_task_json(
        target_dir,
        data,
        actor="task.py set-base-branch",
        op="set-base-branch",
        evidence="base_branch",
    ):
        return 1

    print(colored(f"✓ Base branch set to: {base_branch}", Colors.GREEN))
    print(f"  PR will target: {base_branch}")
    return 0


# =============================================================================
# Command: set-scope
# =============================================================================

def cmd_set_scope(args: argparse.Namespace) -> int:
    """Set scope for PR title."""
    repo_root = get_repo_root()
    target_dir = resolve_task_dir(args.dir, repo_root)
    scope = args.scope

    if not scope:
        print(colored("Error: Missing arguments", Colors.RED))
        print("Usage: python task.py set-scope <task-dir> <scope>")
        return 1

    task_json = target_dir / FILE_TASK_JSON
    if not task_json.is_file():
        print(colored(f"Error: task.json not found at {target_dir}", Colors.RED))
        return 1

    data = read_json(task_json)
    if not data:
        return 1

    data["scope"] = scope
    if not _kernel_patch_task_json(
        target_dir,
        data,
        actor="task.py set-scope",
        op="set-scope",
        evidence="scope",
    ):
        return 1

    print(colored(f"✓ Scope set to: {scope}", Colors.GREEN))
    return 0


# =============================================================================
# Command: set-deps
# =============================================================================

def cmd_set_deps(args: argparse.Namespace) -> int:
    """Set task-level depends_on (Plan A: declare + soft checks, no blocking).

    Bare task ids are supported. Dangling references are warned but still
    written (Plan A is discovery-first; `warn` never errors).
    """
    from .task_dependencies import KIND_MISSING, normalize_dep_list, resolve_dep_ref

    repo_root = get_repo_root()
    target_dir = resolve_task_dir(args.dir, repo_root)

    task_json = target_dir / FILE_TASK_JSON
    if not task_json.is_file():
        print(
            colored(f"Error: task.json not found at {target_dir}", Colors.RED),
            file=sys.stderr,
        )
        return 1

    data = read_json(task_json)
    if not data:
        return 1

    normalized = normalize_dep_list(args.dep)
    data["depends_on"] = normalized

    dangling = [
        ref
        for ref in normalized
        if resolve_dep_ref(ref, repo_root=repo_root).kind == KIND_MISSING
    ]

    if not _kernel_patch_task_json(
        target_dir,
        data,
        actor="task.py set-deps",
        op="set-deps",
        evidence="depends_on",
    ):
        print(colored("Error: failed to write task.json", Colors.RED), file=sys.stderr)
        return 1

    if normalized:
        print(
            colored(
                f"✓ depends_on set: {', '.join(normalized)}",
                Colors.GREEN,
            )
        )
    else:
        print(colored("✓ depends_on cleared to []", Colors.GREEN))
    for ref in dangling:
        print(
            colored(
                f"[dependencies] WARN: dangling dependency: {ref} "
                "(no matching task or child; declaration kept)",
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )
    return 0


# =============================================================================
# Command: set-depends-mode
# =============================================================================

def cmd_set_depends_mode(args: argparse.Namespace) -> int:
    """Set meta.depends_mode (warn | block | off) for a task.

    warn is the default (= Plan A soft checks); block opts the task into
    hard dependency gates at start-execution --approved and
    set-child-state working; off silences dependency output entirely.
    """
    from .task_dependencies import DEPENDS_MODES, read_depends_mode

    repo_root = get_repo_root()
    target_dir = resolve_task_dir(args.dir, repo_root)

    task_json = target_dir / FILE_TASK_JSON
    if not task_json.is_file():
        print(
            colored(f"Error: task.json not found at {target_dir}", Colors.RED),
            file=sys.stderr,
        )
        return 1

    data = read_json(task_json)
    if not data:
        return 1

    previous = read_depends_mode(data)
    if args.mode not in DEPENDS_MODES:
        print(
            colored(
                f"Error: depends_mode must be one of {', '.join(DEPENDS_MODES)}",
                Colors.RED,
            ),
            file=sys.stderr,
        )
        return 1

    meta = data.get("meta")
    if not isinstance(meta, dict):
        meta = {}
        data["meta"] = meta
    meta["depends_mode"] = args.mode

    if not _kernel_patch_task_json(
        target_dir,
        data,
        actor="task.py set-depends-mode",
        op="set-depends-mode",
        evidence="meta.depends_mode",
    ):
        print(colored("Error: failed to write task.json", Colors.RED), file=sys.stderr)
        return 1

    print(
        colored(
            f"✓ depends_mode: {previous} -> {args.mode}",
            Colors.GREEN,
        )
    )
    return 0


# =============================================================================
# Command: artifact-locale
# =============================================================================

def cmd_artifact_locale(args: argparse.Namespace) -> int:
    """Get or set human-reviewed artifact locale (zh | en)."""
    from .artifact_locale import (
        resolve_artifact_locale,
        set_task_artifact_locale,
        set_workspace_artifact_locale,
    )

    repo_root = get_repo_root()
    subcommand = getattr(args, "artifact_locale_command", None)

    if subcommand == "get":
        task_dir = resolve_task_dir(args.task, repo_root) if args.task else None
        print(resolve_artifact_locale(task_dir, repo_root))
        return 0

    if subcommand == "set":
        try:
            if args.task:
                task_dir = resolve_task_dir(args.task, repo_root)
                set_task_artifact_locale(task_dir, args.locale, repo_root)
                scope = f"task {task_dir.name}"
            else:
                set_workspace_artifact_locale(args.locale, repo_root)
                scope = "workspace"
        except (ValueError, FileNotFoundError) as exc:
            print(colored(f"Error: {exc}", Colors.RED), file=sys.stderr)
            return 1

        print(colored(f"✓ artifact_locale set to {args.locale} ({scope})", Colors.GREEN))
        return 0

    print(colored("Error: use artifact-locale get|set", Colors.RED), file=sys.stderr)
    return 1
