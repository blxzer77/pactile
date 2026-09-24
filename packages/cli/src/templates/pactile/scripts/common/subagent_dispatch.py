#!/usr/bin/env python3
"""
Subagent dispatch prompt builder — single source for hook + CLI Layer 2.

Agent-facing only; not documented in user README.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Literal

from .injection_budget import (
    JSONL_MAX_ENTRIES,
    JSONL_MAX_FILE_CHARS,
    JSONL_MAX_TOTAL_CHARS,
)
from .io import read_json
from .paths import FILE_TASK_JSON

DIR_WORKFLOW = ".pactile"
DIR_SPEC = "spec"

AGENT_IMPLEMENT = "pactile-implement"
AGENT_CHECK = "pactile-check"
AGENT_RESEARCH = "pactile-research"

AGENTS_ALL = (AGENT_IMPLEMENT, AGENT_CHECK, AGENT_RESEARCH)
AGENTS_REQUIRE_TASK = (AGENT_IMPLEMENT, AGENT_CHECK)

INJECTION_MARKER = "<!-- pactile-hook-injected -->"

DispatchRole = Literal["implement", "check", "research"]

DEFAULT_SCOPES: dict[str, str] = {
    "implement": (
        "Implement per prd.md and implement.md; run project lint/typecheck/tests."
    ),
    "check": (
        "Review against prd/spec; fix in-contract defects; record evidence in verify.md."
    ),
    "research": "Research and persist to {TASK}/research/.",
}


def prompt_has_injection_marker(text: str) -> bool:
    return INJECTION_MARKER in text


def read_file_content(base_path: str, file_path: str) -> str | None:
    full_path = os.path.join(base_path, file_path)
    if os.path.exists(full_path) and os.path.isfile(full_path):
        try:
            with open(full_path, "r", encoding="utf-8") as f:
                return f.read()
        except OSError:
            return None
    return None


def read_directory_contents(
    base_path: str, dir_path: str, max_files: int = 20
) -> list[tuple[str, str]]:
    full_path = os.path.join(base_path, dir_path)
    if not os.path.exists(full_path) or not os.path.isdir(full_path):
        return []

    results: list[tuple[str, str]] = []
    try:
        md_files = sorted(
            f
            for f in os.listdir(full_path)
            if f.endswith(".md") and os.path.isfile(os.path.join(full_path, f))
        )
        for filename in md_files[:max_files]:
            file_full_path = os.path.join(full_path, filename)
            relative_path = os.path.join(dir_path, filename)
            try:
                with open(file_full_path, "r", encoding="utf-8") as f:
                    results.append((relative_path, f.read()))
            except OSError:
                continue
    except OSError:
        pass
    return results


def read_jsonl_entries(
    base_path: str,
    jsonl_path: str,
    *,
    warn_prefix: str = "subagent-dispatch",
    apply_budget: bool = True,
) -> tuple[list[tuple[str, str]], list[str]]:
    full_path = os.path.join(base_path, jsonl_path)
    if not os.path.exists(full_path):
        print(
            f"[{warn_prefix}] WARN: {jsonl_path} not found — "
            "sub-agent will receive only task artifacts",
            file=sys.stderr,
        )
        return [], []

    results: list[tuple[str, str]] = []
    skipped: list[str] = []
    saw_real_entry = False
    loaded_entries = 0
    total_chars = 0
    try:
        with open(full_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                    file_path = item.get("file") or item.get("path")
                    entry_type = item.get("type", "file")
                    if not file_path:
                        continue
                    saw_real_entry = True
                    if apply_budget and loaded_entries >= JSONL_MAX_ENTRIES:
                        skipped.append(f"{file_path}: entry cap ({JSONL_MAX_ENTRIES})")
                        continue

                    expanded: list[tuple[str, str]] = []
                    if entry_type == "directory":
                        expanded = read_directory_contents(base_path, file_path)
                    else:
                        content = read_file_content(base_path, file_path)
                        if content:
                            expanded = [(file_path, content)]

                    if not expanded:
                        skipped.append(f"{file_path}: missing or empty")
                        continue

                    block_chars = sum(len(content) for _, content in expanded)
                    if apply_budget and block_chars > JSONL_MAX_FILE_CHARS:
                        skipped.append(
                            f"{file_path}: file cap ({block_chars}>{JSONL_MAX_FILE_CHARS} chars)"
                        )
                        continue
                    if apply_budget and total_chars + block_chars > JSONL_MAX_TOTAL_CHARS:
                        skipped.append(
                            f"{file_path}: total cap "
                            f"({total_chars + block_chars}>{JSONL_MAX_TOTAL_CHARS})"
                        )
                        continue

                    results.extend(expanded)
                    total_chars += block_chars
                    loaded_entries += 1
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass

    if not saw_real_entry:
        print(
            f"[{warn_prefix}] WARN: {jsonl_path} has no curated entries "
            "(only seed / empty) — sub-agent will receive only task artifacts.",
            file=sys.stderr,
        )
    elif apply_budget and (results or skipped):
        loaded_paths = ", ".join(path for path, _ in results) or "(none)"
        print(
            f"[{warn_prefix}] injection-budget: {jsonl_path} "
            f"loaded {loaded_entries} entries ({total_chars} chars): {loaded_paths}",
            file=sys.stderr,
        )
        for reason in skipped:
            print(f"[{warn_prefix}] injection-budget: skipped {reason}", file=sys.stderr)
    return results, skipped


def get_agent_context(repo_root: str, task_dir: str, agent_type: str) -> str:
    context_parts: list[str] = []
    agent_jsonl = f"{task_dir}/{agent_type}.jsonl"
    entries, _ = read_jsonl_entries(repo_root, agent_jsonl)
    for file_path, content in entries:
        context_parts.append(f"=== {file_path} ===\n{content}")
    return "\n\n".join(context_parts)


def get_implement_context(repo_root: str, task_dir: str) -> str:
    context_parts: list[str] = []
    base_context = get_agent_context(repo_root, task_dir, "implement")
    if base_context:
        context_parts.append(base_context)

    prd_content = read_file_content(repo_root, f"{task_dir}/prd.md")
    if prd_content:
        context_parts.append(f"=== {task_dir}/prd.md (Requirements) ===\n{prd_content}")

    design_content = read_file_content(repo_root, f"{task_dir}/design.md")
    if design_content:
        context_parts.append(
            f"=== {task_dir}/design.md (Technical Design) ===\n{design_content}"
        )

    implement_plan_content = read_file_content(repo_root, f"{task_dir}/implement.md")
    if implement_plan_content:
        context_parts.append(
            f"=== {task_dir}/implement.md (Execution Plan) ===\n{implement_plan_content}"
        )
    return "\n\n".join(context_parts)


def get_check_context(repo_root: str, task_dir: str) -> str:
    context_parts: list[str] = []
    entries, _ = read_jsonl_entries(repo_root, f"{task_dir}/check.jsonl")
    for file_path, content in entries:
        context_parts.append(f"=== {file_path} ===\n{content}")

    prd_content = read_file_content(repo_root, f"{task_dir}/prd.md")
    if prd_content:
        context_parts.append(f"=== {task_dir}/prd.md (Requirements) ===\n{prd_content}")

    design_content = read_file_content(repo_root, f"{task_dir}/design.md")
    if design_content:
        context_parts.append(
            f"=== {task_dir}/design.md (Technical Design) ===\n{design_content}"
        )

    implement_plan_content = read_file_content(repo_root, f"{task_dir}/implement.md")
    if implement_plan_content:
        context_parts.append(
            f"=== {task_dir}/implement.md (Execution Plan) ===\n{implement_plan_content}"
        )
    return "\n\n".join(context_parts)


def get_finish_context(repo_root: str, task_dir: str) -> str:
    return get_check_context(repo_root, task_dir)


def get_research_context(repo_root: str, task_dir: str | None) -> str:
    context_parts: list[str] = []

    if task_dir:
        entries, _ = read_jsonl_entries(repo_root, f"{task_dir}/research.jsonl")
        for file_path, content in entries:
            context_parts.append(f"=== {file_path} ===\n{content}")

        prd_content = read_file_content(repo_root, f"{task_dir}/prd.md")
        if prd_content:
            context_parts.append(
                f"=== {task_dir}/prd.md (Requirements) ===\n{prd_content}"
            )

        design_content = read_file_content(repo_root, f"{task_dir}/design.md")
        if design_content:
            context_parts.append(
                f"=== {task_dir}/design.md (Technical Design) ===\n{design_content}"
            )

    spec_path = f"{DIR_WORKFLOW}/{DIR_SPEC}"
    spec_root = Path(repo_root) / DIR_WORKFLOW / DIR_SPEC

    tree_lines = [f"{spec_path}/"]
    if spec_root.is_dir():
        pkg_dirs = sorted(d for d in spec_root.iterdir() if d.is_dir())
        for i, pkg_dir in enumerate(pkg_dirs):
            is_last = i == len(pkg_dirs) - 1
            prefix = "└── " if is_last else "├── "
            layers = sorted(d.name for d in pkg_dir.iterdir() if d.is_dir())
            layer_info = f" ({', '.join(layers)})" if layers else ""
            tree_lines.append(f"{prefix}{pkg_dir.name}/{layer_info}")

    project_structure = f"""## Project Spec Directory Structure

```
{chr(10).join(tree_lines)}
```

To get structured package info, run: `python ./{DIR_WORKFLOW}/scripts/get_context.py --mode packages`

## Search Tips

- Spec files: `{spec_path}/**/*.md`
- Code search: Use Glob and Grep tools
- External facts / docs: use the `smart-search-cli` skill and persist source citations."""
    context_parts.append(project_structure)
    return "\n\n".join(context_parts)


def build_implement_prompt(original_prompt: str, context: str) -> str:
    return f"""{INJECTION_MARKER}
# Implement Agent Task

You are the Implement Agent in the Multi-Agent Pipeline.

## Your Context

All the information you need has been prepared for you:

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. **Understand specs** - All dev specs are injected above, understand them
2. **Understand task artifacts** - Read requirements, technical design if present, and execution plan if present
3. **Implement feature** - Implement following specs and task artifacts
4. **Self-check** - Ensure code quality against check specs

## Important Constraints

- Do NOT execute git commit, only code modifications
- Follow all dev specs injected above
- Report list of modified/created files when done"""


def build_check_prompt(original_prompt: str, context: str) -> str:
    return f"""{INJECTION_MARKER}
# Check Agent Task

You are the Check Agent in the Multi-Agent Pipeline (code and cross-layer checker).

## Your Context

All check specs and dev specs you need:

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. **Get changes** - Run `git diff --name-only` and `git diff` to get code changes
2. **Check against specs** - Check item by item against specs above
3. **Self-fix** - Fix issues directly, don't just report
4. **Run verification** - Run project's lint and typecheck commands

## Important Constraints

- Fix issues yourself, don't just report
- Must execute complete checklist in check specs
- Pay special attention to impact radius analysis (L1-L5)"""


def build_finish_prompt(original_prompt: str, context: str) -> str:
    return f"""{INJECTION_MARKER}
# Finish Agent Task

You are performing the final check before creating a PR.

## Your Context

Finish checklist and requirements:

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. **Review changes** - Run `git diff --name-only` to see all changed files
2. **Verify task artifacts** - Check requirements in prd.md and, when present, design.md / implement.md
3. **Spec sync** - Analyze whether changes introduce new patterns, contracts, or conventions
4. **Run final checks** - Execute lint and typecheck
5. **Confirm ready** - Ensure code is ready for PR

## Important Constraints

- You MAY update spec files when gaps are detected (use update-spec.md as guide)
- MUST read the target spec file BEFORE editing (avoid duplicating existing content)
- Do NOT update specs for trivial changes (typos, formatting, obvious fixes)
- Verify all acceptance criteria in prd.md are met"""


def build_research_prompt(original_prompt: str, context: str) -> str:
    return f"""{INJECTION_MARKER}
# Research Agent Task

You are the Pactile Research Agent.

## Core Principle

**You do one thing: find, explain, and PERSIST information.**

Conversations get compacted; files do not. Every research topic MUST be written under `{{TASK_DIR}}/research/`. Chat-only findings are a failure.

## Dispatch contract

- External facts: use the `smart-search-cli` skill and persist source citations.
- Do NOT spawn nested `pactile-implement` / `pactile-check` / `pactile-research` sub-agents.

## Project Info

{context}

---

## Your Task

{original_prompt}

---

## Workflow

1. **Resolve task** — ensure `{{TASK_DIR}}/research/` exists
2. **Classify** — internal / external / mixed
3. **Search** — Glob/Grep/Read for repo; `smart-search-cli` + CLI for external
4. **Persist** — Write each topic to `{{TASK_DIR}}/research/<topic-slug>.md`
5. **Report** — Reply with file paths + one-line summaries only

## Write ALLOWED

- `{{TASK_DIR}}/research/*.md` only

## Write FORBIDDEN

- Code, `.pactile/spec/`, platform config, git operations"""


def _repo_relative(task_dir: Path, repo_root: Path) -> str:
    try:
        return task_dir.relative_to(repo_root).as_posix()
    except ValueError:
        return task_dir.as_posix()


def _truncate_context(context: str, max_chars: int | None, warnings: list[str]) -> str:
    if max_chars is None or len(context) <= max_chars:
        return context
    warnings.append(f"context truncated at {max_chars} chars")
    return context[:max_chars] + "\n...[truncated]..."


def _resolve_scope(role: DispatchRole, scope: str | None, task_rel: str) -> str:
    if scope and scope.strip():
        return scope.strip()
    default = DEFAULT_SCOPES[role]
    if role == "research":
        return default.replace("{TASK}", task_rel)
    return default


def _compose_task_prompt(task_rel: str, scope: str) -> str:
    return f"Selected task: {task_rel}\n\n{scope}"


def build_dispatch_prompt(
    repo_root: Path,
    task_dir: Path,
    role: str,
    *,
    scope: str | None = None,
    finish: bool = False,
    max_chars: int | None = None,
    original_prompt: str | None = None,
    require_in_progress: bool = True,
) -> tuple[str | None, list[str], list[str]]:
    """
    Build a full subagent dispatch prompt.

    Returns (prompt, warnings, errors). prompt is None on hard failure.
    When original_prompt is set (hook path), it is used as the task section as-is.
    """
    warnings: list[str] = []
    errors: list[str] = []

    if role not in ("implement", "check", "research"):
        errors.append(f"invalid role: {role!r}")
        return None, warnings, errors

    repo_root_str = str(repo_root)
    if not task_dir.is_dir():
        errors.append(f"task directory not found: {task_dir}")
        return None, warnings, errors

    task_rel = _repo_relative(task_dir, repo_root)
    prd_path = task_dir / "prd.md"
    if role in ("implement", "check"):
        if not prd_path.is_file():
            errors.append(f"prd.md missing under {task_rel}")
            return None, warnings, errors
    elif not prd_path.is_file():
        warnings.append(f"prd.md missing under {task_rel}")

    if role in ("implement", "check") and require_in_progress:
        task_json_path = task_dir / FILE_TASK_JSON
        task_data = read_json(task_json_path) if task_json_path.is_file() else None
        status = (task_data or {}).get("status")
        if status != "in_progress":
            errors.append(f"task status must be in_progress, got {status!r}")

    if original_prompt is not None:
        task_prompt = original_prompt
    else:
        resolved_scope = _resolve_scope(role, scope, task_rel)  # type: ignore[arg-type]
        task_prompt = _compose_task_prompt(task_rel, resolved_scope)

    if role == "implement":
        context = get_implement_context(repo_root_str, task_rel)
        context = _truncate_context(context, max_chars, warnings)
        if not context:
            errors.append("no implement context available")
            return None, warnings, errors
        prompt = build_implement_prompt(task_prompt, context)
    elif role == "check":
        context = get_finish_context(repo_root_str, task_rel) if finish else get_check_context(
            repo_root_str, task_rel
        )
        context = _truncate_context(context, max_chars, warnings)
        if not context:
            errors.append("no check context available")
            return None, warnings, errors
        prompt = (
            build_finish_prompt(task_prompt, context)
            if finish
            else build_check_prompt(task_prompt, context)
        )
    else:
        context = get_research_context(repo_root_str, task_rel)
        context = _truncate_context(context, max_chars, warnings)
        if not context:
            errors.append("no research context available")
            return None, warnings, errors
        prompt = build_research_prompt(task_prompt, context)

    return prompt, warnings, errors


def build_dispatch_prompt_for_agent(
    repo_root: str,
    task_dir: str,
    subagent_type: str,
    original_prompt: str,
    *,
    finish: bool = False,
    max_chars: int | None = None,
) -> str | None:
    """Hook helper: map subagent type to role and build prompt."""
    if subagent_type == AGENT_RESEARCH and not task_dir:
        context = get_research_context(repo_root, None)
        if max_chars is not None and len(context) > max_chars:
            context = context[:max_chars] + "\n...[truncated]..."
        if not context:
            return None
        return build_research_prompt(original_prompt, context)

    role_map = {
        AGENT_IMPLEMENT: "implement",
        AGENT_CHECK: "check",
        AGENT_RESEARCH: "research",
    }
    role = role_map.get(subagent_type)
    if not role:
        return None

    repo_path = Path(repo_root)
    task_path = repo_path / task_dir.replace("\\", "/")
    is_finish = finish or "[finish]" in original_prompt.lower()
    prompt, _, errors = build_dispatch_prompt(
        repo_path,
        task_path,
        role,
        finish=is_finish if role == "check" else False,
        max_chars=max_chars,
        original_prompt=original_prompt,
        require_in_progress=False,
    )
    if errors:
        for item in errors:
            print(f"[inject-subagent-context] {item}", file=sys.stderr)
        return None
    return prompt
