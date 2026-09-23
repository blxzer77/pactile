#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Thin Task shim over `pactile kernel --json`.

Write-path commands (create / start-execution / record-gate / archive / patch
via add-subtask and friends) submit a Kernel Command. Do not invent `pactile task`.
Select / dashboard / jsonl / parent-status stay Python overlays.

Usage:
    python task.py kernel                      # stdin JSON → pactile kernel --json
    python task.py create "<title>" [--slug <name>] [--assignee <dev>] [--priority P0|P1|P2|P3] [--parent <dir>] [--package <pkg>]
    python task.py add-context <dir> <file> <path> [reason] # Add jsonl entry
    python task.py validate <dir>              # Validate jsonl files
    python task.py list-context <dir>          # List jsonl entries
    python task.py dashboard                   # Show Task Dashboard
    python task.py select <dir>                # Select task for this live session
    python task.py selected [--source]         # Show selected task
    python task.py start-execution <dir> --approved  # Start approved execution
    python task.py record-gate <dir> --transition <key> --gate <gate> --result PASS|FAIL|SKIPPED --reviewer <id> --evidence <ref> [--root-cause <cause>]
    python task.py exit                        # Clear selected task
    python task.py set-branch <dir> <branch>   # Set git branch
    python task.py set-base-branch <dir> <branch>  # Set PR target branch
    python task.py set-scope <dir> <scope>     # Set scope for PR title
    python task.py set-deps <dir> <id...>      # Set task-level depends_on (soft checks)
    python task.py set-depends-mode <dir> <warn|block|off>  # Dependency policy mode
    python task.py archive <task-dir> [--check] [--archive-integrated-children] # Check or archive completed task
    python task.py prepare-archive-evidence <task-dir> [--dry-run]  # Draft missing verify.md archive evidence
    python task.py prepare-learning-scaffold <task-dir> [--trigger <text>]  # Print spec-capture checklist (stdout only)
    python task.py list                        # List active tasks
    python task.py list-archive [month]        # List archived tasks
    python task.py add-subtask <parent-dir> <child-dir>     # Link child to parent
    python task.py remove-subtask <parent-dir> <child-dir>  # Unlink child from parent
    python task.py prepare-child-worktree <parent-dir> <child-dir> --branch <branch>
    python task.py set-child-state <parent-dir> <child-dir> <state> --evidence <ref>
    python task.py integrate-child <parent-dir> <child-dir> <state> --evidence <ref>
    python task.py generate-child-prompt <parent-dir> <child-dir> [--mode inline|subagent]
    python task.py generate-dispatch-prompt <task-dir> <role> [--scope TEXT] [--finish] [--max-chars N]
    python task.py parent-status <parent-dir>
    python task.py publish-pack <parent-dir> [--stage <id>] [--mode inline|subagent] [--dry-run]
    python task.py review-child <parent-dir> <child-dir> [--check] [--decision accept|changes|cancel|integrate-through]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from common.log import Colors, colored
from common.paths import (
    DIR_WORKFLOW,
    DIR_TASKS,
    FILE_TASK_JSON,
    get_repo_root,
    get_developer,
    get_tasks_dir,
)
from common.active_task import (
    clear_selected_task,
    resolve_context_key,
    resolve_selected_task,
    set_selected_task,
)
from common.io import read_json
from common.kernel_command import (
    KernelCliNotFound,
    KernelCommandError,
    kernel_expected_revision,
    kernel_record_gate,
    kernel_start,
    print_kernel_error,
    run_kernel_command,
)
from common.task_dashboard import render_task_dashboard
from common.cli_environment import optional_capability_note
from common.task_gates import (
    BASELINE_GATE,
    build_reviewer_gate_record,
    collect_kernel_projection_extras,
    read_strategy_contract,
    start_execution_repair_hints,
    validate_start_execution,
    validate_start_execution_check,
    write_gate_record,
)
from common.task_utils import resolve_task_dir, run_task_hooks
from common.task_dependencies import read_depends_mode
from common.tasks import (
    children_progress,
    format_child_task_display,
    iter_active_tasks,
    load_parent_child_integration_states,
)
from common.task_map import get_child_state

# Import command handlers from split modules (also re-exports for plan.py compatibility)
from common.task_store import (
    cmd_create,
    cmd_archive,
    cmd_prepare_archive_evidence,
    cmd_prepare_learning_scaffold,
    cmd_set_branch,
    cmd_set_base_branch,
    cmd_set_scope,
    cmd_set_deps,
    cmd_set_depends_mode,
    append_depends_ignore_event,
    cmd_add_subtask,
    cmd_remove_subtask,
    cmd_prepare_child_worktree,
    cmd_set_child_state,
    cmd_integrate_child,
    cmd_generate_child_prompt,
    cmd_generate_dispatch_prompt,
    cmd_suggest_execution_strategy,
    cmd_parent_status,
    cmd_publish_pack,
    cmd_review_child,
    cmd_artifact_locale,
)
from common.task_context import (
    cmd_add_context,
    cmd_validate,
    cmd_list_context,
)


# =============================================================================
# Command: dashboard / select / selected / start-execution / record-gate / exit
# =============================================================================

def _repo_relative(path, repo_root) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return str(path)


def _print_select_dispatch_fallback_tip() -> None:
    print(
        "Tip: if no session identity, use "
        "'python ./.pactile/scripts/generate_dispatch_prompt.py --task <path>' "
        "to dispatch directly.",
        file=sys.stderr,
    )


def _resolve_existing_task(task_input: str, repo_root):
    full_path = resolve_task_dir(task_input, repo_root)
    if not full_path.is_dir():
        print(colored(f"Error: Task not found: {task_input}", Colors.RED), file=sys.stderr)
        print("Hint: Use task name (e.g., 'my-task') or full path (e.g., '.pactile/tasks/01-31-my-task')", file=sys.stderr)
        return None
    return full_path


def cmd_kernel(args: argparse.Namespace) -> int:
    """Forward one JSON object on stdin to `pactile kernel --json`."""
    _ = args
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as err:
        print(colored(f"Error: stdin is not JSON: {err}", Colors.RED), file=sys.stderr)
        return 1
    if not isinstance(payload, dict):
        print(colored("Error: Kernel request must be a JSON object", Colors.RED), file=sys.stderr)
        return 1
    try:
        result = run_kernel_command(payload, cwd=get_repo_root())
    except (KernelCliNotFound, KernelCommandError) as err:
        print_kernel_error(err)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_dashboard(args: argparse.Namespace) -> int:
    """Show Task Dashboard without mutating selection or status."""
    _ = args
    print(render_task_dashboard(get_repo_root()))
    return 0


def cmd_select(args: argparse.Namespace) -> int:
    """Select a task for this live session without changing task.status."""
    repo_root = get_repo_root()
    task_input = args.dir
    full_path = _resolve_existing_task(task_input, repo_root)
    if full_path is None:
        _print_select_dispatch_fallback_tip()
        return 1

    if not resolve_context_key():
        print(
            colored("Error: session identity not available; selected_task was not persisted.", Colors.RED),
            file=sys.stderr,
        )
        print(
            "Hint: run inside an AI session that exposes session identity, or set PACTILE_CONTEXT_ID before running task.py select.",
            file=sys.stderr,
        )
        _print_select_dispatch_fallback_tip()
        return 1

    selected = set_selected_task(_repo_relative(full_path, repo_root), repo_root)
    if not selected:
        print(colored("Error: failed to select task", Colors.RED), file=sys.stderr)
        _print_select_dispatch_fallback_tip()
        return 1

    print(colored(f"✓ Selected task: {selected.task_path}", Colors.GREEN))
    print(f"Source: {selected.source}")
    print("Task status unchanged.")
    return 0


def _print_no_selected_task_guidance() -> None:
    """Explain why no task is selected and what to run next."""
    print(colored("No task selected for this live session.", Colors.YELLOW), file=sys.stderr)
    print("Next actions:", file=sys.stderr)
    print(
        "  - Route work: python ./.pactile/scripts/task.py dashboard",
        file=sys.stderr,
    )
    print(
        "  - Select a task: python ./.pactile/scripts/task.py select <task-dir>",
        file=sys.stderr,
    )
    print(
        "  - List active tasks: python ./.pactile/scripts/task.py list",
        file=sys.stderr,
    )
    print(
        "  - Persist selection in shells: set PACTILE_CONTEXT_ID (or use your platform session hook)",
        file=sys.stderr,
    )


def cmd_selected(args: argparse.Namespace) -> int:
    """Show selected task."""
    repo_root = get_repo_root()
    selected = resolve_selected_task(repo_root)

    if args.source:
        print(f"Selected task: {selected.task_path or '(none)'}")
        print(f"Source: {selected.source}")
        if selected.stale:
            print("State: stale")
        if not selected.task_path:
            _print_no_selected_task_guidance()
        return 0 if selected.task_path else 1

    if selected.task_path:
        print(selected.task_path)
        return 0

    _print_no_selected_task_guidance()
    return 1


def cmd_exit(args: argparse.Namespace) -> int:
    """Clear selected task for this live session without changing task.status."""
    _ = args
    repo_root = get_repo_root()
    selected = clear_selected_task(repo_root)
    if not selected.task_path:
        print(colored("No selected task set", Colors.YELLOW))
        return 0

    print(colored(f"✓ Cleared selected task (was: {selected.task_path})", Colors.GREEN))
    print(f"Source: {selected.source}")
    print("Task status unchanged.")
    return 0


def _print_guard_errors(items: list[str], stream=None) -> None:
    if stream is None:
        stream = sys.stdout
    for item in items:
        print(f"  - {item}", file=stream)


def _print_dependency_warnings(guard) -> None:
    """Print dependency warnings (Plan A soft checks; never affect PASS/FAIL)."""
    for warning in guard.warnings:
        print(
            colored(f"[dependencies] WARN: {warning}", Colors.YELLOW),
            file=sys.stderr,
        )


def cmd_start_execution(args: argparse.Namespace) -> int:
    """Start approved task execution after a non-mutating readiness check."""
    repo_root = get_repo_root()
    task_dir = _resolve_existing_task(args.dir, repo_root)
    if task_dir is None:
        return 1

    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None

    if args.check:
        guard = validate_start_execution_check(task_dir, task_data)
        if not guard.ok:
            print(colored("Start-execution check: FAIL", Colors.RED))
            _print_guard_errors(guard.errors)
            for hint in start_execution_repair_hints(guard.errors, task_dir):
                print(f"  Hint: {hint}")
            return 1
        _print_dependency_warnings(guard)
        print(colored("Start-execution check: PASS", Colors.GREEN))
        print(f"Contract fingerprint: {guard.contract_fingerprint}")
        baseline_fingerprint = guard.artifact_fingerprints.get(BASELINE_GATE)
        if baseline_fingerprint:
            print(f"Artifact fingerprint: {baseline_fingerprint}")
        if guard.required_gates:
            print(f"Required reviewer gates: {', '.join(guard.required_gates)}")
        if task_dir is not None:
            contract, _ = read_strategy_contract(task_dir)
            cap_note = optional_capability_note(contract.get("optional_capabilities"))
            if cap_note:
                print(colored(f"Note: {cap_note}", Colors.YELLOW))
            from common.execution_strategy import (
                contract_drift_warnings,
                validate_strategy_pair,
            )

            if contract:
                for item in contract_drift_warnings(
                    repo_root, task_dir, task_data or {}, contract
                ):
                    print(f"[execution-strategy] WARN: {item}", file=sys.stderr)
                mode = contract.get("execution_mode")
                iso = contract.get("isolation")
                if isinstance(mode, str) and isinstance(iso, str):
                    for item in validate_strategy_pair(mode, iso):
                        print(f"[execution-strategy] WARN: {item}", file=sys.stderr)
        print("Artifact gates are ready. Ask the user for explicit execution approval before running `task.py start-execution <task> --approved`.")
        return 0

    if not args.approved:
        print(colored("Error: no action selected for start-execution.", Colors.RED), file=sys.stderr)
        print("Run with --check for non-mutating preflight or --approved after explicit user approval.", file=sys.stderr)
        return 1

    ignore_deps = bool(getattr(args, "ignore_deps", False))
    guard = validate_start_execution(
        task_dir,
        task_data,
        approved=True,
        ignore_deps=ignore_deps,
        enforce_deps_block=True,
    )
    if not guard.ok:
        print(colored("Error: cannot start execution; readiness check failed.", Colors.RED), file=sys.stderr)
        _print_guard_errors(guard.errors, stream=sys.stderr)
        return 1

    _print_dependency_warnings(guard)

    assert task_data is not None
    if ignore_deps and guard.deps_blocking_summary:
        append_depends_ignore_event(
            task_data,
            command="start-execution",
            mode=read_depends_mode(task_data),
            blocking_summary=guard.deps_blocking_summary,
        )
        # Kernel's start op resolves `requires` edges via extras.dependency_satisfied.
        # --ignore-deps must mark the blocked depends_on refs satisfied so the
        # Kernel transition is allowed, in the same write as the audit event.
        depends_on = task_data.get("depends_on")
        if isinstance(depends_on, list):
            task_data["dependency_satisfied"] = [
                str(ref) for ref in depends_on if isinstance(ref, str) and ref.strip()
            ]
    if guard.baseline_record:
        write_gate_record(task_data, "start-execution", BASELINE_GATE, guard.baseline_record)
    for gate, record in guard.auto_gate_records.items():
        write_gate_record(task_data, "start-execution", gate, record)
    task_data["execution_approval"] = {
        "schema_version": 1,
        "transition": "start-execution",
        "approved_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "approved_by": "user",
        "approval_source": "task.py start-execution --approved",
        "contract_fingerprint": guard.contract_fingerprint,
        "artifact_fingerprint": guard.artifact_fingerprints.get(BASELINE_GATE),
    }
    if task_data.get("status") == "planning":
        task_data["status"] = "in_progress"

    extras = collect_kernel_projection_extras(task_data)
    try:
        expected = kernel_expected_revision(task_dir)
        kernel_start(
            task_dir,
            task_data,
            extras,
            expected_revision=expected,
            actor="task.py start-execution --approved",
            idempotency_key=(
                f"start:{task_data.get('id') or task_dir.name}:"
                f"{task_data['execution_approval']['approved_at']}"
            ),
            evidence="task.py start-execution --approved",
        )
    except (KernelCliNotFound, KernelCommandError) as err:
        print_kernel_error(err)
        return 1

    print(colored(f"✓ Execution approved for: {_repo_relative(task_dir, repo_root)}", Colors.GREEN))
    print(f"Status: {task_data.get('status')}")
    run_task_hooks("after_start", task_json_path, repo_root)
    return 0


def cmd_record_gate(args: argparse.Namespace) -> int:
    """Record a non-baseline reviewer gate result."""
    repo_root = get_repo_root()
    task_dir = _resolve_existing_task(args.dir, repo_root)
    if task_dir is None:
        return 1

    task_json_path = task_dir / FILE_TASK_JSON
    task_data = read_json(task_json_path) if task_json_path.is_file() else None
    if task_data is None:
        print(colored("Error: task.json not found or invalid", Colors.RED), file=sys.stderr)
        return 1

    record, errors, warnings = build_reviewer_gate_record(
        task_dir=task_dir,
        task_data=task_data,
        transition=args.transition,
        gate=args.gate,
        result=args.result,
        reviewer=args.reviewer,
        evidence=args.evidence,
        issue_fingerprint=args.issue_fingerprint,
        issue_summary=args.issue_summary,
        root_cause=args.root_cause,
        skip_approved_by=args.skip_approved_by,
        skip_reason=args.skip_reason,
        contract_fingerprint=args.contract_fingerprint,
        artifact_fingerprint=args.artifact_fingerprint,
    )
    if errors:
        print(colored("Error: cannot record quality gate.", Colors.RED), file=sys.stderr)
        _print_guard_errors(errors, stream=sys.stderr)
        return 1

    assert record is not None
    write_gate_record(task_data, args.transition, args.gate, record)
    extras = collect_kernel_projection_extras(task_data)
    try:
        expected = kernel_expected_revision(task_dir)
        kernel_record_gate(
            task_dir,
            expected_revision=expected,
            actor="task.py record-gate",
            idempotency_key=(
                f"gate:{args.transition}:{args.gate}:"
                f"{record.get('contract_fingerprint') or record.get('evidence')}"
            ),
            transition=args.transition,
            gate=args.gate,
            record=record,
            extras=extras,
            evidence=str(record.get("evidence") or args.evidence),
        )
    except (KernelCliNotFound, KernelCommandError) as err:
        print_kernel_error(err)
        return 1

    print(colored(f"✓ Recorded gate: {args.transition}/{args.gate} = {record['result']}", Colors.GREEN))
    print(f"Evidence: {record['evidence']}")
    print(f"Contract fingerprint: {record['contract_fingerprint']}")
    print(f"Artifact fingerprint: {record['artifact_fingerprint']}")
    if record.get("route"):
        print(f"Route: {record['route']}")
    for warning in warnings:
        print(colored(f"Warning: {warning}", Colors.YELLOW), file=sys.stderr)
    return 0


# =============================================================================
# Command: list
# =============================================================================

def cmd_list(args: argparse.Namespace) -> int:
    """List active tasks."""
    repo_root = get_repo_root()
    tasks_dir = get_tasks_dir(repo_root)
    selected_task = resolve_selected_task(repo_root).task_path
    developer = get_developer(repo_root)
    filter_mine = args.mine
    filter_status = args.status

    if filter_mine:
        if not developer:
            print(colored("Error: No developer set. Run init_developer.py first", Colors.RED), file=sys.stderr)
            return 1
        print(colored(f"My tasks (assignee: {developer}):", Colors.BLUE))
    else:
        print(colored("All active tasks:", Colors.BLUE))
    print()

    # Single pass: collect all tasks via shared iterator
    all_tasks = {t.dir_name: t for t in iter_active_tasks(tasks_dir)}
    all_statuses = {name: t.status for name, t in all_tasks.items()}

    # Display tasks hierarchically
    count = 0

    def _print_task(
        dir_name: str,
        indent: int = 0,
        parent_dir: Path | None = None,
    ) -> None:
        nonlocal count
        t = all_tasks[dir_name]

        # Apply --mine filter
        if filter_mine and (t.assignee or "-") != developer:
            return

        # Apply --status filter
        if filter_status and t.status != filter_status:
            return

        relative_path = f"{DIR_WORKFLOW}/{DIR_TASKS}/{dir_name}"
        marker = ""
        if relative_path == selected_task:
            marker = f" {colored('<- selected', Colors.GREEN)}"

        integration_states = None
        if t.children:
            integration_states = load_parent_child_integration_states(
                t.directory, t.children
            )
        progress = children_progress(
            t.children, all_statuses, integration_states
        )

        integration_state = None
        if parent_dir is not None:
            integration_state = get_child_state(parent_dir, dir_name)
        status_display = format_child_task_display(t.status, integration_state)

        # Package tag
        pkg_tag = f" @{t.package}" if t.package else ""

        prefix = "  " * indent + "  - "

        if filter_mine:
            print(
                f"{prefix}{dir_name}/ ({status_display}){pkg_tag}{progress}{marker}"
            )
        else:
            print(
                f"{prefix}{dir_name}/ ({status_display}){pkg_tag}{progress} "
                f"[{colored(t.assignee or '-', Colors.CYAN)}]{marker}"
            )
        count += 1

        # Print children indented
        for child_name in t.children:
            if child_name in all_tasks:
                _print_task(child_name, indent + 1, parent_dir=t.directory)

    # Display only top-level tasks (those without a parent)
    for dir_name in sorted(all_tasks.keys()):
        if not all_tasks[dir_name].parent:
            _print_task(dir_name)

    if count == 0:
        if filter_mine:
            print("  (no tasks assigned to you)")
        else:
            print("  (no active tasks)")

    print()
    print(f"Total: {count} task(s)")
    return 0


# =============================================================================
# Command: list-archive
# =============================================================================

def cmd_list_archive(args: argparse.Namespace) -> int:
    """List archived tasks."""
    repo_root = get_repo_root()
    tasks_dir = get_tasks_dir(repo_root)
    archive_dir = tasks_dir / "archive"
    month = args.month

    print(colored("Archived tasks:", Colors.BLUE))
    print()

    if month:
        month_dir = archive_dir / month
        if month_dir.is_dir():
            print(f"[{month}]")
            for d in sorted(month_dir.iterdir()):
                if d.is_dir():
                    print(f"  - {d.name}/")
        else:
            print(f"  No archives for {month}")
    else:
        if archive_dir.is_dir():
            for month_dir in sorted(archive_dir.iterdir()):
                if month_dir.is_dir():
                    month_name = month_dir.name
                    count = sum(1 for d in month_dir.iterdir() if d.is_dir())
                    print(f"[{month_name}] - {count} task(s)")

    return 0


# =============================================================================
# Help
# =============================================================================

def show_usage() -> None:
    """Show usage help."""
    print("""Task Management Script

Usage:
  python task.py create <title>                     Create new task directory
  python task.py create <title> --package <pkg>     Create task for a specific package
  python task.py create <title> --parent <dir>      Create task as child of parent
  python task.py add-context <dir> <jsonl> <path> [reason]  Add entry to jsonl
  python task.py validate <dir>                     Validate jsonl files
  python task.py list-context <dir>                 List jsonl entries
  python task.py dashboard                          Show Task Dashboard
  python task.py select <dir>                       Select task for this live session
  python task.py selected [--source]                Show selected task
  python task.py start-execution <dir> --check      Check execution readiness
  python task.py start-execution <dir> --approved   Start approved execution
  python task.py record-gate <dir> --transition <key> --gate <gate> --result PASS|FAIL|SKIPPED --reviewer <id> --evidence <ref> [--root-cause <cause>]
  python task.py exit                               Clear selected task
  python task.py set-branch <dir> <branch>          Set git branch
  python task.py set-base-branch <dir> <branch>     Set PR target branch
  python task.py set-scope <dir> <scope>            Set scope for PR title
  python task.py set-deps <dir> [dep ...]           Set depends_on (no deps clears to [])
  python task.py archive <task-dir> [--check]       Check or archive completed task
  python task.py add-subtask <parent> <child>       Link child task to parent
  python task.py remove-subtask <parent> <child>    Unlink child from parent
  python task.py prepare-child-worktree <parent> <child> --branch <branch>
  python task.py set-child-state <parent> <child> <state> --evidence <ref>
  python task.py integrate-child <parent> <child> <state> --evidence <ref>
  python task.py list [--mine] [--status <status>]  List tasks
  python task.py list-archive [YYYY-MM]             List archived tasks

Monorepo options:
  --package <pkg>      Package name (validated against config.yaml packages)

List options:
  --mine, -m           Show only tasks assigned to current developer
  --status, -s <s>     Filter by status (planning, in_progress, review, completed)

Examples:
  python task.py create "Add login feature" --slug add-login
  python task.py create "Add login feature" --slug add-login --package cli
  python task.py create "Child task" --slug child --parent .pactile/tasks/01-21-parent
  python task.py add-context <dir> implement .pactile/spec/cli/backend/auth.md "Auth guidelines"
  python task.py set-branch <dir> task/add-login
  python task.py dashboard
  python task.py select .pactile/tasks/01-21-add-login
  python task.py selected --source
  python task.py start-execution .pactile/tasks/01-21-add-login --check
  python task.py start-execution .pactile/tasks/01-21-add-login --approved
  python task.py record-gate .pactile/tasks/01-21-add-login --transition full-task-complete --gate code-review --result FAIL --reviewer codex --evidence verify.md --issue-fingerprint auth-branch-1 --root-cause implementation-defect
  python task.py exit
  python task.py archive add-login --check
  python task.py archive add-login
  python task.py add-subtask parent-task child-task  # Link existing tasks
  python task.py remove-subtask parent-task child-task
  python task.py prepare-child-worktree parent-task child-task --branch child-task
  python task.py set-child-state parent-task child-task review --evidence verify.md
  python task.py integrate-child parent-task child-task accepted --evidence handoff.md --ref child-branch
  python task.py integrate-child parent-task child-task integrated --evidence task-map.md --ref child-branch --execute-merge
  python task.py generate-child-prompt parent-task child-task --mode inline
  python task.py parent-status parent-task
  python task.py publish-pack parent-task
  python task.py publish-pack parent-task --stage stage-1 --dry-run
  python task.py review-child parent-task child-task --check
  python task.py review-child parent-task child-task --decision accept --ref child-branch
  python task.py list                               # List all active tasks
  python task.py list --mine                        # List my tasks only
  python task.py list --mine --status in_progress   # List my in-progress tasks
""")


# =============================================================================
# Main Entry
# =============================================================================

def main() -> int:
    """CLI entry point."""
    # Deprecation guard: `init-context` was removed in v0.5.0-beta.12.
    # Detect early so argparse doesn't mask the real reason with a generic
    # "invalid choice" error.
    if len(sys.argv) >= 2 and sys.argv[1] == "init-context":
        print(
            colored(
                "Error: `task.py init-context` was removed in v0.5.0-beta.12.",
                Colors.RED,
            ),
            file=sys.stderr,
        )
        print(
            "implement.jsonl / check.jsonl are now seeded on `task.py create` for",
            file=sys.stderr,
        )
        print(
            "sub-agent-capable platforms and curated by the AI during planning when needed.",
            file=sys.stderr,
        )
        print("See .pactile/workflow.md planning artifact guidance or run:", file=sys.stderr)
        print(
            "  python ./.pactile/scripts/get_context.py --mode phase --step 1",
            file=sys.stderr,
        )
        print(
            "Use `task.py add-context <dir> implement|check <path> <reason>` to append entries.",
            file=sys.stderr,
        )
        return 2

    parser = argparse.ArgumentParser(
        description="Thin Task shim over pactile kernel --json",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    subparsers.add_parser(
        "kernel",
        help="Forward stdin JSON to `pactile kernel --json` (do not invent pactile task)",
    )

    # create
    p_create = subparsers.add_parser("create", help="Create new task")
    p_create.add_argument("title", help="Task title")
    p_create.add_argument("--slug", "-s", help="Task slug")
    p_create.add_argument("--assignee", "-a", help="Assignee developer")
    p_create.add_argument("--priority", "-p", default="P2", help="Priority (P0-P3)")
    p_create.add_argument("--description", "-d", help="Task description")
    p_create.add_argument("--parent", help="Parent task directory (establishes subtask link)")
    p_create.add_argument("--package", help="Package name for monorepo projects")

    # add-context
    p_add = subparsers.add_parser("add-context", help="Add context entry")
    p_add.add_argument("dir", help="Task directory")
    p_add.add_argument("file", help="JSONL file (implement|check)")
    p_add.add_argument("path", help="File path to add")
    p_add.add_argument("reason", nargs="?", help="Reason for adding")

    # validate
    p_validate = subparsers.add_parser("validate", help="Validate context files")
    p_validate.add_argument("dir", help="Task directory")

    # list-context
    p_listctx = subparsers.add_parser("list-context", help="List context entries")
    p_listctx.add_argument("dir", help="Task directory")

    # dashboard
    subparsers.add_parser("dashboard", help="Show Task Dashboard")

    # select
    p_select = subparsers.add_parser("select", help="Select task for this live session")
    p_select.add_argument("dir", help="Task directory")

    # selected
    p_selected = subparsers.add_parser("selected", help="Show selected task")
    p_selected.add_argument("--source", action="store_true",
                            help="Show selected task source")

    # start-execution
    p_start_execution = subparsers.add_parser("start-execution", help="Start approved task execution")
    p_start_execution.add_argument("dir", help="Task directory")
    p_start_execution.add_argument("--check", action="store_true",
                                   help="Run non-mutating execution readiness check")
    p_start_execution.add_argument("--approved", action="store_true",
                                   help="Record explicit approval and start execution")
    p_start_execution.add_argument(
        "--ignore-deps",
        action="store_true",
        help="Override blocking dependencies (depends_mode=block) and record an audit event",
    )

    # record-gate
    p_record_gate = subparsers.add_parser("record-gate", help="Record reviewer quality gate")
    p_record_gate.add_argument("dir", help="Task directory")
    p_record_gate.add_argument("--transition", required=True, help="Transition key")
    p_record_gate.add_argument("--gate", required=True, help="Gate name")
    p_record_gate.add_argument("--result", required=True, help="PASS, FAIL, or SKIPPED")
    p_record_gate.add_argument("--reviewer", required=True, help="Reviewer identifier")
    p_record_gate.add_argument("--evidence", required=True, help="Short evidence reference")
    p_record_gate.add_argument("--issue-fingerprint", help="Required for FAIL")
    p_record_gate.add_argument("--issue-summary", help="Optional short issue summary for FAIL")
    p_record_gate.add_argument("--root-cause",
                               help="Required for FAIL: implementation-defect, contract-changing-defect, or validation-environment-blocker")
    p_record_gate.add_argument("--skip-approved-by", help="Must be 'user' for SKIPPED")
    p_record_gate.add_argument("--skip-reason", help="Required reason for SKIPPED")
    p_record_gate.add_argument("--contract-fingerprint", help="Optional current contract fingerprint assertion")
    p_record_gate.add_argument("--artifact-fingerprint", help="Optional current artifact fingerprint assertion")

    # exit
    subparsers.add_parser("exit", help="Clear selected task")

    # set-branch
    p_branch = subparsers.add_parser("set-branch", help="Set git branch")
    p_branch.add_argument("dir", help="Task directory")
    p_branch.add_argument("branch", help="Branch name")

    # set-base-branch
    p_base = subparsers.add_parser("set-base-branch", help="Set PR target branch")
    p_base.add_argument("dir", help="Task directory")
    p_base.add_argument("base_branch", help="Base branch name (PR target)")

    # set-scope
    p_scope = subparsers.add_parser("set-scope", help="Set scope")
    p_scope.add_argument("dir", help="Task directory")
    p_scope.add_argument("scope", help="Scope name")

    # set-deps
    p_deps = subparsers.add_parser(
        "set-deps",
        help="Set task-level depends_on (declare only; soft checks in Plan A)",
    )
    p_deps.add_argument("dir", help="Task directory or name")
    p_deps.add_argument(
        "dep",
        nargs="*",
        help="Dependency task ids (bare id). No deps clears to [].",
    )

    # set-depends-mode
    p_depends_mode = subparsers.add_parser(
        "set-depends-mode",
        help="Set meta.depends_mode (warn | block | off) for dependency policy",
    )
    p_depends_mode.add_argument("dir", help="Task directory or name")
    p_depends_mode.add_argument(
        "mode",
        choices=["warn", "block", "off"],
        help="warn = Plan A soft checks (default); block = hard gates at "
        "start-execution --approved and set-child-state working; off = silent",
    )

    # artifact-locale
    p_artifact_locale = subparsers.add_parser(
        "artifact-locale",
        help="Get or set human-reviewed artifact locale (zh | en)",
    )
    locale_sub = p_artifact_locale.add_subparsers(dest="artifact_locale_command")
    p_locale_get = locale_sub.add_parser("get", help="Print resolved artifact locale")
    p_locale_get.add_argument("--task", help="Task directory (includes task override)")
    p_locale_set = locale_sub.add_parser("set", help="Set artifact locale")
    p_locale_set.add_argument("locale", choices=["zh", "en"], help="Locale code")
    p_locale_set.add_argument("--task", help="Task directory (task-level override)")

    # archive
    p_archive = subparsers.add_parser("archive", help="Archive task")
    p_archive.add_argument("name", help="Task directory or name")
    p_archive.add_argument("--check", action="store_true", help="Run non-mutating archive readiness check")
    p_archive.add_argument("--no-commit", action="store_true", help="Skip auto git commit after archive")
    p_archive.add_argument(
        "--archive-integrated-children",
        action="store_true",
        help="When archiving a parent, also archive integrated children that pass archive --check",
    )

    # prepare-archive-evidence
    p_prepare_archive = subparsers.add_parser(
        "prepare-archive-evidence",
        help="Append missing archive evidence sections to verify.md",
    )
    p_prepare_archive.add_argument("name", help="Task directory or name")
    p_prepare_archive.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be appended without writing verify.md",
    )

    # prepare-learning-scaffold
    p_learning_scaffold = subparsers.add_parser(
        "prepare-learning-scaffold",
        help="Print durable-learning / spec-update checklist (does not edit specs)",
    )
    p_learning_scaffold.add_argument("name", help="Task directory or name")
    p_learning_scaffold.add_argument(
        "--trigger",
        help="Optional reason (e.g. parent review changes, repeated workflow bug)",
    )

    # list
    p_list = subparsers.add_parser("list", help="List tasks")
    p_list.add_argument("--mine", "-m", action="store_true", help="My tasks only")
    p_list.add_argument("--status", "-s", help="Filter by status")

    # add-subtask
    p_addsub = subparsers.add_parser("add-subtask", help="Link child task to parent")
    p_addsub.add_argument("parent_dir", help="Parent task directory")
    p_addsub.add_argument("child_dir", help="Child task directory")

    # remove-subtask
    p_rmsub = subparsers.add_parser("remove-subtask", help="Unlink child task from parent")
    p_rmsub.add_argument("parent_dir", help="Parent task directory")
    p_rmsub.add_argument("child_dir", help="Child task directory")

    # prepare-child-worktree
    p_prepare_worktree = subparsers.add_parser("prepare-child-worktree", help="Create/register a Child git worktree")
    p_prepare_worktree.add_argument("parent_dir", help="Parent task directory")
    p_prepare_worktree.add_argument("child_dir", help="Child task directory")
    p_prepare_worktree.add_argument("--branch", required=True, help="Child git branch to create or checkout")
    p_prepare_worktree.add_argument("--base", help="Base ref for a new Child branch")
    p_prepare_worktree.add_argument("--path", help="Worktree path under .pactile/worktrees/")
    p_prepare_worktree.add_argument("--check", action="store_true", help="Run non-mutating worktree readiness check")

    # set-child-state
    p_child_state = subparsers.add_parser("set-child-state", help="Set Child Worker state in Parent task-map.md")
    p_child_state.add_argument("parent_dir", help="Parent task directory")
    p_child_state.add_argument("child_dir", help="Child task directory")
    p_child_state.add_argument("state", help="Child state")
    p_child_state.add_argument("--evidence", required=True, help="Short evidence reference")
    p_child_state.add_argument("--reason", help="Optional short reason")

    # integrate-child
    p_integrate_child = subparsers.add_parser("integrate-child", help="Set Parent-controlled Child integration state")
    p_integrate_child.add_argument("parent_dir", help="Parent task directory")
    p_integrate_child.add_argument("child_dir", help="Child task directory")
    p_integrate_child.add_argument("state", help="Parent-controlled Child state")
    p_integrate_child.add_argument("--evidence", required=True, help="Short evidence reference")
    p_integrate_child.add_argument("--ref", help="Child git ref or reviewed diff reference")
    p_integrate_child.add_argument("--reason", help="Optional short reason")
    p_integrate_child.add_argument("--execute-merge", action="store_true", help="Execute git merge --no-ff --no-commit for an integrated Child")
    p_integrate_child.add_argument(
        "--no-publish-pack",
        action="store_true",
        help="Skip auto publish-pack after integrated (default: refresh child-prompts/ including evidence-only integrates)",
    )
    p_integrate_child.add_argument("--check", action="store_true", help="Run non-mutating integration readiness check")

    # suggest-execution-strategy
    p_suggest_strategy = subparsers.add_parser(
        "suggest-execution-strategy",
        help="Suggest execution_mode and isolation for Development Strategy Contract",
    )
    p_suggest_strategy.add_argument("task_dir", help="Task directory")
    p_suggest_strategy.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON",
    )

    # generate-dispatch-prompt
    p_dispatch_prompt = subparsers.add_parser(
        "generate-dispatch-prompt",
        help="Build full Task dispatch prompt (Agent-facing)",
    )
    p_dispatch_prompt.add_argument("task_dir", help="Task directory")
    p_dispatch_prompt.add_argument(
        "role",
        choices=["implement", "check", "research"],
        help="Subagent role",
    )
    p_dispatch_prompt.add_argument("--scope", help="One-line task instruction for subagent")
    p_dispatch_prompt.add_argument(
        "--finish",
        action="store_true",
        help="Use finish check context (role=check only)",
    )
    p_dispatch_prompt.add_argument(
        "--max-chars",
        type=int,
        help="Hard truncate embedded context block",
    )

    # generate-child-prompt
    p_gen_prompt = subparsers.add_parser(
        "generate-child-prompt",
        help="Generate child implementation prompt for parent orchestration",
    )
    p_gen_prompt.add_argument("parent_dir", help="Parent task directory")
    p_gen_prompt.add_argument("child_dir", help="Child task directory")
    p_gen_prompt.add_argument(
        "--mode",
        choices=["inline", "subagent"],
        default="inline",
        help="Delivery mode hint (inline manual handoff vs optional subagent)",
    )
    p_gen_prompt.add_argument(
        "--include-artifacts",
        action="store_true",
        help="Embed child artifact bodies in the generated prompt",
    )
    p_gen_prompt.add_argument("--output", "-o", help="Write prompt to file instead of stdout")

    # parent-status
    p_parent_status = subparsers.add_parser("parent-status", help="Show parent task-map orchestration status")
    p_parent_status.add_argument("parent_dir", help="Parent task directory")
    p_parent_status.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON snapshot (campaign UI / MCP)",
    )

    # publish-pack
    p_publish_pack = subparsers.add_parser(
        "publish-pack",
        help="Publish HYBRID campaign PACK (stage ready list + child-prompts)",
    )
    p_publish_pack.add_argument("parent_dir", help="Parent task directory")
    p_publish_pack.add_argument(
        "--stage",
        help="Restrict pack to one stage id from task-map stages:",
    )
    p_publish_pack.add_argument(
        "--mode",
        choices=["inline", "subagent"],
        default="inline",
        help="Prompt delivery mode forwarded to generate-child-prompt builder",
    )
    p_publish_pack.add_argument(
        "--dry-run",
        action="store_true",
        help="Print ready/blocked summary without writing child-prompts/",
    )

    # review-child
    p_review_child = subparsers.add_parser(
        "review-child",
        help="Review child handoff and optionally advance integration states",
    )
    p_review_child.add_argument("parent_dir", help="Parent task directory")
    p_review_child.add_argument("child_dir", help="Child task directory")
    p_review_child.add_argument("--check", action="store_true", help="Non-mutating review readiness check")
    p_review_child.add_argument(
        "--decision",
        choices=["accept", "changes", "cancel", "integrate-through"],
        help="Parent review decision (runs integrate-child steps when valid)",
    )
    p_review_child.add_argument("--ref", help="Child git ref for accept / integrate-through")
    p_review_child.add_argument("--reason", help="Required for changes or cancel decisions")
    p_review_child.add_argument("--notes", help="Short parent review notes included in the report")
    p_review_child.add_argument(
        "--write-artifact",
        action="store_true",
        help="Also write review-<child>.md under the parent task directory",
    )
    p_review_child.add_argument(
        "--no-append-parent-verify",
        action="store_true",
        help="Do not append review notes to parent verify.md",
    )

    # list-archive
    p_listarch = subparsers.add_parser("list-archive", help="List archived tasks")
    p_listarch.add_argument("month", nargs="?", help="Month (YYYY-MM)")

    args = parser.parse_args()

    if not args.command:
        show_usage()
        return 1

    commands = {
        "kernel": cmd_kernel,
        "create": cmd_create,
        "add-context": cmd_add_context,
        "validate": cmd_validate,
        "list-context": cmd_list_context,
        "dashboard": cmd_dashboard,
        "select": cmd_select,
        "selected": cmd_selected,
        "start-execution": cmd_start_execution,
        "record-gate": cmd_record_gate,
        "exit": cmd_exit,
        "set-branch": cmd_set_branch,
        "set-base-branch": cmd_set_base_branch,
        "set-scope": cmd_set_scope,
        "set-deps": cmd_set_deps,
        "set-depends-mode": cmd_set_depends_mode,
        "archive": cmd_archive,
        "prepare-archive-evidence": cmd_prepare_archive_evidence,
        "prepare-learning-scaffold": cmd_prepare_learning_scaffold,
        "add-subtask": cmd_add_subtask,
        "remove-subtask": cmd_remove_subtask,
        "prepare-child-worktree": cmd_prepare_child_worktree,
        "set-child-state": cmd_set_child_state,
        "integrate-child": cmd_integrate_child,
        "generate-child-prompt": cmd_generate_child_prompt,
        "generate-dispatch-prompt": cmd_generate_dispatch_prompt,
        "suggest-execution-strategy": cmd_suggest_execution_strategy,
        "parent-status": cmd_parent_status,
        "publish-pack": cmd_publish_pack,
        "review-child": cmd_review_child,
        "artifact-locale": cmd_artifact_locale,
        "list": cmd_list,
        "list-archive": cmd_list_archive,
    }

    if args.command in commands:
        return commands[args.command](args)
    else:
        show_usage()
        return 1


if __name__ == "__main__":
    sys.exit(main())
