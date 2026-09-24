#!/usr/bin/env python3
"""
Capture Smart Search evidence into Pactile task artifacts.

This module shells out to the local `smart-search` CLI and writes a compact
manifest that downstream Pactile context/ranking code can consume. It stays
dependency-free because it is generated into user projects.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .paths import get_repo_root, get_selected_task_abs, resolve_task_ref
from .smart_search_resolve import default_smart_search_argv, resolve_smart_search_argv


INTENT_CHOICES = ("deep-research", "broad-search", "docs", "official-source", "fetch")
STATUS_OK = "ok"
STATUS_DEGRADED = "degraded"
STATUS_FAILED = "failed"
STATUS_NOT_CONFIGURED = "not_configured"
MANIFEST_VERSION = 1
MAX_SUMMARY_CHARS = 500


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run smart-search and save a Pactile evidence manifest.",
    )
    parser.add_argument("query", help="Search query, research question, or URL for --intent fetch.")
    parser.add_argument(
        "--intent",
        choices=INTENT_CHOICES,
        default="deep-research",
        help="Smart Search route to use.",
    )
    parser.add_argument(
        "--task",
        help="Task directory/ref. Defaults to the selected Pactile task when available.",
    )
    parser.add_argument(
        "--run-id",
        help="Stable run id for output paths. Defaults to timestamp plus query slug.",
    )
    parser.add_argument("--root", help="Repository root. Defaults to nearest parent with .pactile/.")
    parser.add_argument(
        "--smart-search-command",
        default=None,
        help="Override CLI executable (single path/name). Default: env, config, PATH, repo wrappers.",
    )
    parser.add_argument(
        "--skip-doctor",
        action="store_true",
        help="Skip smart-search doctor preflight and run the selected command directly.",
    )
    parser.add_argument("--budget", choices=("quick", "standard", "deep"), default="standard")
    parser.add_argument("--fallback", choices=("auto", "off"), default="auto")
    parser.add_argument("--validation", choices=("fast", "balanced", "strict"), default="balanced")
    parser.add_argument("--extra-sources", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--num-results", type=int, default=5)
    parser.add_argument(
        "--locale-scope",
        choices=("cn", "en", "both"),
        help="Bilingual discovery scope for --intent deep-research (smart-search research --locale-scope).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview research plan/routing without live providers (deep-research only).",
    )
    parser.add_argument(
        "--progress",
        action="store_true",
        help="Emit [research] stage logs to stderr during deep-research execution.",
    )
    parser.add_argument(
        "--include-domain",
        action="append",
        default=[],
        help="Domain filter for --intent official-source. May be repeated.",
    )
    parser.add_argument("--json", action="store_true", help="Emit manifest JSON.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.extra_sources < 0:
        print("Error: --extra-sources must be >= 0", file=sys.stderr)
        return 2
    if args.timeout <= 0:
        print("Error: --timeout must be > 0", file=sys.stderr)
        return 2
    if args.num_results <= 0:
        print("Error: --num-results must be > 0", file=sys.stderr)
        return 2

    repo_root = Path(args.root).resolve() if args.root else get_repo_root()
    if args.smart_search_command:
        args.smart_search_argv = [args.smart_search_command]
    else:
        args.smart_search_argv = resolve_smart_search_argv(repo_root) or default_smart_search_argv(
            repo_root
        )
    run_id = args.run_id or default_run_id(args.intent, args.query)
    evidence_dir = resolve_evidence_dir(repo_root, args.task, run_id)
    evidence_dir.mkdir(parents=True, exist_ok=True)

    command = build_smart_search_command(args, evidence_dir)
    doctor_result = None
    if not args.skip_doctor:
        doctor_result = run_command(
            [*args.smart_search_argv, "doctor", "--format", "json"],
            repo_root,
        )
        if doctor_result.not_found:
            manifest = build_manifest(
                repo_root=repo_root,
                query=args.query,
                intent=args.intent,
                command=command,
                evidence_dir=evidence_dir,
                output_path=command_output_path(args.intent, evidence_dir),
                status=STATUS_NOT_CONFIGURED,
                result_data={},
                doctor_data={},
                error="smart-search CLI could not be resolved (PATH, config, or repo wrapper).",
            )
            write_manifest(manifest, evidence_dir)
            print_manifest(manifest, args.json)
            return 4
        doctor_data = parse_json_output(doctor_result.stdout)
        if doctor_result.returncode != 0 or not doctor_data.get("ok"):
            manifest = build_manifest(
                repo_root=repo_root,
                query=args.query,
                intent=args.intent,
                command=command,
                evidence_dir=evidence_dir,
                output_path=command_output_path(args.intent, evidence_dir),
                status=STATUS_NOT_CONFIGURED,
                result_data={},
                doctor_data=doctor_data,
                error=doctor_data.get("error") or doctor_result.stderr.strip() or "smart-search doctor failed.",
            )
            write_manifest(manifest, evidence_dir)
            print_manifest(manifest, args.json)
            return doctor_result.returncode or 3

    result = run_command(command, repo_root)
    output_path = command_output_path(args.intent, evidence_dir)
    result_data = read_result_data(output_path, result.stdout)
    doctor_data = parse_json_output(doctor_result.stdout) if doctor_result else {}
    status = status_from_result(result.returncode, result_data)
    error = ""
    if result.not_found:
        status = STATUS_NOT_CONFIGURED
        error = "smart-search CLI could not be resolved (PATH, config, or repo wrapper)."
    elif status == STATUS_FAILED:
        error = (
            string_value(result_data.get("error"))
            or result.stderr.strip()
            or f"smart-search exited with code {result.returncode}."
        )
        if "timed out" in error.lower() or "timeout" in error.lower():
            error = (
                f"{error} Retry with --timeout 120 or --intent docs; "
                "or use an available web source and persist its citation."
            )

    manifest = build_manifest(
        repo_root=repo_root,
        query=args.query,
        intent=args.intent,
        command=command,
        evidence_dir=evidence_dir,
        output_path=output_path,
        status=status,
        result_data=result_data,
        doctor_data=doctor_data,
        error=error,
        dry_run=bool(args.dry_run),
    )
    write_manifest(manifest, evidence_dir)
    print_manifest(manifest, args.json)
    return 0 if status in {STATUS_OK, STATUS_DEGRADED} else (result.returncode or 4)


class CommandResult:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "", not_found: bool = False):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.not_found = not_found


def run_command(command: list[str], cwd: Path, timeout: int = 120) -> CommandResult:
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
            timeout=timeout,
        )
        return CommandResult(completed.returncode, completed.stdout or "", completed.stderr or "")
    except subprocess.TimeoutExpired:
        return CommandResult(124, "", f"Command timed out after {timeout}s")
    except FileNotFoundError as error:
        return CommandResult(127, "", str(error), not_found=True)


def build_smart_search_command(args: argparse.Namespace, evidence_dir: Path) -> list[str]:
    output_path = command_output_path(args.intent, evidence_dir)
    command = list(args.smart_search_argv)
    if args.intent == "deep-research":
        built = [
            *command,
            "research",
            args.query,
            "--budget",
            args.budget,
            "--fallback",
            args.fallback,
            "--format",
            "json",
            "--output",
            str(output_path),
        ]
        if args.locale_scope:
            built.extend(["--locale-scope", args.locale_scope])
        if args.dry_run:
            built.append("--dry-run")
        if args.progress:
            built.append("--progress")
        return built
    if args.intent == "broad-search":
        return [
            *command,
            "search",
            args.query,
            "--validation",
            args.validation,
            "--extra-sources",
            str(args.extra_sources),
            "--timeout",
            str(args.timeout),
            "--format",
            "json",
            "--output",
            str(output_path),
        ]
    if args.intent == "docs":
        return [
            *command,
            "context7-library",
            args.query,
            "--format",
            "json",
            "--output",
            str(output_path),
        ]
    if args.intent == "official-source":
        built = [
            *command,
            "exa-search",
            args.query,
            "--num-results",
            str(args.num_results),
            "--include-text",
            "--include-highlights",
            "--format",
            "json",
            "--output",
            str(output_path),
        ]
        for domain in args.include_domain:
            built.extend(["--include-domains", domain])
        return built
    if args.intent == "fetch":
        return [
            *command,
            "fetch",
            args.query,
            "--format",
            "markdown",
            "--output",
            str(output_path),
        ]
    raise ValueError(f"Unsupported Smart Search intent: {args.intent}")


def command_output_path(intent: str, evidence_dir: Path) -> Path:
    suffix = "md" if intent == "fetch" else "json"
    name = intent.replace("-", "_")
    return evidence_dir / f"{name}.{suffix}"


def resolve_evidence_dir(repo_root: Path, task_ref: str | None, run_id: str) -> Path:
    task_dir: Path | None = None
    if task_ref:
        task_dir = resolve_task_ref(task_ref, repo_root)
    else:
        task_dir = get_selected_task_abs(repo_root)

    if task_dir and task_dir.exists():
        return task_dir / "research" / "smart-search" / safe_filename(run_id)
    return repo_root / ".pactile" / "workspace" / "smart-search" / safe_filename(run_id)


def default_run_id(intent: str, query: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    slug = safe_filename(query)[:48] or "query"
    return f"{stamp}-{intent}-{slug}"


def safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip().lower())
    cleaned = cleaned.strip(".-_")
    return cleaned or "run"


def parse_json_output(content: str) -> dict[str, Any]:
    if not content.strip():
        return {}
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def read_result_data(output_path: Path, stdout: str) -> dict[str, Any]:
    if output_path.is_file() and output_path.suffix.lower() == ".json":
        return parse_json_output(output_path.read_text(encoding="utf-8"))
    if output_path.is_file() and output_path.suffix.lower() != ".json":
        return {"ok": True, "content": output_path.read_text(encoding="utf-8")}
    return parse_json_output(stdout)


def status_from_result(returncode: int, result_data: dict[str, Any]) -> str:
    if returncode != 0:
        return STATUS_FAILED
    if result_data.get("ok") is False:
        return STATUS_FAILED
    if result_data.get("degraded") is True:
        return STATUS_DEGRADED
    return STATUS_OK


def build_manifest(
    repo_root: Path,
    query: str,
    intent: str,
    command: list[str],
    evidence_dir: Path,
    output_path: Path,
    status: str,
    result_data: dict[str, Any],
    doctor_data: dict[str, Any],
    error: str = "",
    dry_run: bool = False,
) -> dict[str, Any]:
    provider_attempts = list_value(result_data.get("provider_attempts"))
    citations = normalize_citations(result_data)
    output_schema_version = result_data.get("output_schema_version")
    manifest: dict[str, Any] = {
        "version": MANIFEST_VERSION,
        "source": "smart-search",
        "query": query,
        "intent": intent,
        "command": render_command(command),
        "outputPath": to_repo_path(output_path, repo_root),
        "evidenceDir": to_repo_path(evidence_dir, repo_root),
        "manifestPath": to_repo_path(evidence_dir / "manifest.json", repo_root),
        "status": status,
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "summary": summarize_result(result_data, error),
        "citations": citations,
        "gapCheck": dict_value(result_data.get("gap_check")),
        "providerAttempts": provider_attempts,
        "degraded": bool(result_data.get("degraded", status == STATUS_DEGRADED)),
        "routePolicyVersion": string_value(result_data.get("route_policy_version")),
        "doctor": normalize_doctor(doctor_data),
    }
    if isinstance(output_schema_version, int):
        manifest["outputSchemaVersion"] = output_schema_version
    if dry_run:
        manifest["dryRun"] = True
    if error:
        manifest["error"] = error
    return manifest


def write_manifest(manifest: dict[str, Any], evidence_dir: Path) -> None:
    path = evidence_dir / "manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def print_manifest(manifest: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return
    print(f"Smart Search evidence: {manifest['status']}")
    print(f"Manifest: {manifest['manifestPath']}")
    print(f"Output: {manifest['outputPath']}")
    if manifest.get("summary"):
        print(f"Summary: {manifest['summary']}")
    if manifest.get("error"):
        print(f"Error: {manifest['error']}")


def normalize_citations(result_data: dict[str, Any]) -> list[dict[str, Any]]:
    raw_items = list_value(result_data.get("citations"))
    if not raw_items:
        raw_items = list_value(result_data.get("evidence_items"))
    if not raw_items:
        raw_items = list_value(result_data.get("primary_sources")) or list_value(result_data.get("sources"))

    citations: list[dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        url = string_value(item.get("url"))
        title = string_value(item.get("title"))
        if not url and not title:
            continue
        citation: dict[str, Any] = {}
        if title:
            citation["title"] = title
        if url:
            citation["url"] = url
        provider = string_value(item.get("provider"))
        if provider:
            citation["provider"] = provider
        for key in ("id", "source_type", "subquestion_id", "verified", "content_len"):
            if key in item:
                citation[key] = item[key]
        citations.append(citation)
    return citations


def summarize_result(result_data: dict[str, Any], error: str = "") -> str:
    if error:
        return error[:MAX_SUMMARY_CHARS]
    content = (
        string_value(result_data.get("final_answer"))
        or string_value(result_data.get("content"))
        or string_value(result_data.get("summary"))
    )
    if not content:
        total = result_data.get("total") or result_data.get("sources_count")
        if isinstance(total, int):
            return f"Smart Search returned {total} result(s)."
        return ""
    normalized = re.sub(r"\s+", " ", content).strip()
    return normalized[:MAX_SUMMARY_CHARS]


def normalize_doctor(doctor_data: dict[str, Any]) -> dict[str, Any]:
    allowed_keys = (
        "ok",
        "config_status",
        "minimum_profile_ok",
        "capability_status",
        "resolved_evidence_dir",
        "config_dir_source",
    )
    return {key: doctor_data[key] for key in allowed_keys if key in doctor_data}


def dict_value(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_value(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def string_value(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def to_repo_path(path: Path, repo_root: Path) -> str:
    try:
        return path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return str(path)


def render_command(parts: list[str]) -> str:
    return " ".join(quote_arg(part) for part in parts)


def quote_arg(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_./:=@+-]+", value):
        return value
    return json.dumps(value, ensure_ascii=False)
