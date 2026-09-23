#!/usr/bin/env python3
"""Injection budget constants and measurement helpers (P0 channel matrix aligned)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

RULES_TOTAL_WARN_BYTES = 20_480
RULES_TOTAL_FAIL_BYTES = 32_768
AGENTS_PACTILE_WARN_BYTES = 4_096
JSONL_MAX_ENTRIES = 8
JSONL_MAX_FILE_CHARS = 12_000
JSONL_MAX_TOTAL_CHARS = 48_000

DISPATCH_DEFAULT_MAX_CHARS: dict[str, int] = {
    "implement": 96_000,
    "check": 64_000,
    "research": 48_000,
}

DispatchRole = Literal["implement", "check", "research"]


@dataclass
class RuleFileMeasure:
    path: str
    bytes: int
    always_apply: bool


@dataclass
class RulesMeasure:
    files: list[RuleFileMeasure] = field(default_factory=list)

    @property
    def always_apply_total_bytes(self) -> int:
        return sum(f.bytes for f in self.files if f.always_apply)


@dataclass
class AgentsMeasure:
    path: str
    total_bytes: int
    pactile_block_bytes: int


@dataclass
class JsonlMeasure:
    jsonl_path: str
    entry_count: int
    expanded_chars: int
    skipped: list[str] = field(default_factory=list)
    loaded_files: list[str] = field(default_factory=list)


@dataclass
class DispatchMeasure:
    role: str
    task_rel: str
    prompt_chars: int
    warnings: list[str] = field(default_factory=list)


@dataclass
class BudgetReport:
    rules: RulesMeasure
    agents: AgentsMeasure | None
    jsonl: list[JsonlMeasure] = field(default_factory=list)
    dispatch: DispatchMeasure | None = None


def _read_text_bytes(path: Path) -> tuple[str, int]:
    data = path.read_bytes()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("utf-8", errors="replace")
    return text, len(data)


def measure_always_apply_rules(repo_root: Path) -> RulesMeasure:
    rules_dir = repo_root / ".cursor" / "rules"
    result = RulesMeasure()
    if not rules_dir.is_dir():
        return result

    for path in sorted(rules_dir.glob("*.mdc")):
        text, nbytes = _read_text_bytes(path)
        always = bool(re.search(r"^alwaysApply:\s*true\s*$", text, re.MULTILINE))
        result.files.append(
            RuleFileMeasure(path=str(path.relative_to(repo_root)), bytes=nbytes, always_apply=always)
        )
    return result


def measure_agents_block(repo_root: Path) -> AgentsMeasure | None:
    agents_path = repo_root / "AGENTS.md"
    if not agents_path.is_file():
        return None
    text, nbytes = _read_text_bytes(agents_path)
    pactile_bytes = 0
    start = text.find("<!-- PACTILE:START -->")
    end = text.find("<!-- PACTILE:END -->")
    if start != -1 and end != -1 and end > start:
        pactile_bytes = len(text[start : end + len("<!-- PACTILE:END -->")].encode("utf-8"))
    return AgentsMeasure(
        path="AGENTS.md",
        total_bytes=nbytes,
        pactile_block_bytes=pactile_bytes,
    )


def _expand_jsonl_entry(repo_root: Path, file_path: str, entry_type: str) -> list[tuple[str, str]]:
    if entry_type == "directory":
        from .subagent_dispatch import read_directory_contents  # lazy import

        return read_directory_contents(str(repo_root), file_path)
    from .subagent_dispatch import read_file_content

    content = read_file_content(str(repo_root), file_path)
    if content is None:
        return []
    return [(file_path, content)]


def measure_jsonl_manifest(
    repo_root: Path,
    task_dir: Path,
    jsonl_name: str,
    *,
    apply_budget: bool = True,
) -> JsonlMeasure:
    jsonl_path = task_dir / jsonl_name
    rel_jsonl = str(jsonl_path.relative_to(repo_root)) if jsonl_path.is_file() else jsonl_name
    measure = JsonlMeasure(jsonl_path=rel_jsonl, entry_count=0, expanded_chars=0)
    if not jsonl_path.is_file():
        return measure

    entries: list[tuple[str, str]] = []
    for line in jsonl_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        file_path = item.get("file") or item.get("path")
        if not file_path:
            continue
        entry_type = item.get("type", "file")
        entries.append((file_path, entry_type))

    measure.entry_count = len(entries)
    if not apply_budget:
        for file_path, entry_type in entries:
            for rel, content in _expand_jsonl_entry(repo_root, file_path, entry_type):
                measure.loaded_files.append(rel)
                measure.expanded_chars += len(content)
        return measure

    total_chars = 0
    loaded_count = 0
    for file_path, entry_type in entries:
        if loaded_count >= JSONL_MAX_ENTRIES:
            measure.skipped.append(f"{file_path}: entry cap ({JSONL_MAX_ENTRIES})")
            continue
        expanded = _expand_jsonl_entry(repo_root, file_path, entry_type)
        if not expanded:
            measure.skipped.append(f"{file_path}: missing or empty")
            continue
        block_chars = sum(len(content) for _, content in expanded)
        if block_chars > JSONL_MAX_FILE_CHARS:
            measure.skipped.append(
                f"{file_path}: file cap ({block_chars}>{JSONL_MAX_FILE_CHARS} chars)"
            )
            continue
        if total_chars + block_chars > JSONL_MAX_TOTAL_CHARS:
            measure.skipped.append(
                f"{file_path}: total cap ({total_chars + block_chars}>{JSONL_MAX_TOTAL_CHARS})"
            )
            continue
        for rel, content in expanded:
            measure.loaded_files.append(rel)
            total_chars += len(content)
        loaded_count += 1

    measure.expanded_chars = total_chars
    return measure


def measure_dispatch_prompt(repo_root: Path, task_dir: Path, role: DispatchRole) -> DispatchMeasure | None:
    from .subagent_dispatch import build_dispatch_prompt

    prompt, warnings, errors = build_dispatch_prompt(
        repo_root,
        task_dir,
        role,
        max_chars=DISPATCH_DEFAULT_MAX_CHARS.get(role),
        require_in_progress=False,
    )
    if not prompt:
        return None
    try:
        task_rel = task_dir.relative_to(repo_root).as_posix()
    except ValueError:
        task_rel = task_dir.as_posix()
    return DispatchMeasure(
        role=role,
        task_rel=task_rel,
        prompt_chars=len(prompt),
        warnings=list(warnings) + [f"error:{e}" for e in errors],
    )


def collect_budget_report(
    repo_root: Path,
    *,
    task_dir: Path | None = None,
    dispatch_role: DispatchRole | None = None,
) -> BudgetReport:
    report = BudgetReport(
        rules=measure_always_apply_rules(repo_root),
        agents=measure_agents_block(repo_root),
    )
    if task_dir and task_dir.is_dir():
        for name in ("implement.jsonl", "check.jsonl"):
            report.jsonl.append(measure_jsonl_manifest(repo_root, task_dir, name))
        if dispatch_role:
            report.dispatch = measure_dispatch_prompt(repo_root, task_dir, dispatch_role)
    return report


def budget_violations(report: BudgetReport, *, strict: bool = False) -> list[str]:
    violations: list[str] = []
    rules_total = report.rules.always_apply_total_bytes
    if rules_total > RULES_TOTAL_WARN_BYTES:
        level = "FAIL" if strict and rules_total > RULES_TOTAL_FAIL_BYTES else "WARN"
        violations.append(
            f"{level}: alwaysApply rules total {rules_total} B "
            f"(warn>{RULES_TOTAL_WARN_BYTES}, fail>{RULES_TOTAL_FAIL_BYTES})"
        )
    elif strict and rules_total > RULES_TOTAL_WARN_BYTES:
        violations.append(
            f"WARN: alwaysApply rules total {rules_total} B (warn>{RULES_TOTAL_WARN_BYTES})"
        )

    if report.agents and report.agents.pactile_block_bytes > AGENTS_PACTILE_WARN_BYTES:
        violations.append(
            f"WARN: AGENTS PACTILE block {report.agents.pactile_block_bytes} B "
            f"(warn>{AGENTS_PACTILE_WARN_BYTES})"
        )

    for jm in report.jsonl:
        if jm.entry_count > JSONL_MAX_ENTRIES:
            violations.append(
                f"WARN: {jm.jsonl_path} has {jm.entry_count} entries (max {JSONL_MAX_ENTRIES})"
            )
        if jm.expanded_chars > JSONL_MAX_TOTAL_CHARS:
            violations.append(
                f"WARN: {jm.jsonl_path} expanded {jm.expanded_chars} chars "
                f"(max {JSONL_MAX_TOTAL_CHARS})"
            )

    if report.dispatch:
        cap = DISPATCH_DEFAULT_MAX_CHARS.get(report.dispatch.role, 0)
        if cap and report.dispatch.prompt_chars > cap:
            violations.append(
                f"WARN: dispatch {report.dispatch.role} prompt {report.dispatch.prompt_chars} chars "
                f"(default cap {cap})"
            )

    return violations


def format_budget_report(report: BudgetReport) -> str:
    lines: list[str] = ["# Injection budget report", ""]
    lines.append("## Legacy alwaysApply rules (older .cursor/rules/*.mdc)")
    for rf in report.rules.files:
        flag = "alwaysApply" if rf.always_apply else "scoped"
        lines.append(f"- {rf.path}: {rf.bytes} B ({flag})")
    lines.append(f"- **Total alwaysApply:** {report.rules.always_apply_total_bytes} B")
    lines.append("")

    if report.agents:
        lines.append("## AGENTS.md")
        lines.append(f"- Total: {report.agents.total_bytes} B")
        lines.append(f"- PACTILE block: {report.agents.pactile_block_bytes} B")
        lines.append("")

    for jm in report.jsonl:
        lines.append(f"## {jm.jsonl_path}")
        lines.append(f"- Entries: {jm.entry_count}")
        lines.append(f"- Expanded (budgeted): {jm.expanded_chars} chars")
        if jm.loaded_files:
            lines.append(f"- Loaded: {', '.join(jm.loaded_files)}")
        if jm.skipped:
            lines.append("- Skipped:")
            for item in jm.skipped:
                lines.append(f"  - {item}")
        lines.append("")

    if report.dispatch:
        lines.append(f"## Layer 2 dispatch ({report.dispatch.role})")
        lines.append(f"- Task: {report.dispatch.task_rel}")
        lines.append(f"- Prompt chars: {report.dispatch.prompt_chars}")
        if report.dispatch.warnings:
            lines.append("- Warnings:")
            for w in report.dispatch.warnings:
                lines.append(f"  - {w}")
        lines.append("")

    return "\n".join(lines)
