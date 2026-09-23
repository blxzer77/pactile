#!/usr/bin/env python3
"""Quality-layer eval helper: derive evidence_score (0-2) from telemetry.

Three-layer retrieval ABI (frozen; do not merge back into workflow.md):

| Layer    | Owner                 | This script                                      |
| -------- | --------------------- | ------------------------------------------------ |
| Intent   | context-progressive   | does not own intents                             |
| Provider | Middleware            | does not take smart-search as a Kernel dependency |
| Quality  | retrieval-extended    | owner: score already-collected evidence records   |

REC-11 eval proxy only. Does not search. Does not implement a new ranking
algorithm in this freeze. Input role: collected-evidence. Output is not
AC Evidence / Close Evidence (that remains verify-basic).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ABI_INTENT_OWNER = "context-progressive"
ABI_PROVIDER_OWNER = "middleware"
ABI_QUALITY_OWNER = "retrieval-extended"
ABI_LAYER = "quality"
INPUT_ROLE = "collected-evidence"

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from common.retrieval_tool_classification import classify_tool_calls  # noqa: E402


def evidence_score_from_record(record: dict[str, Any]) -> int:
    """
    Pactile verified layer proxy for eval (R-CR-014):
    0 = no Read on candidates
    1 = Read used but no corroborated_files / weak verify
    2 = read_verification_done and (corroborated_files or read_count >= 1 with top1)
    """
    if not record.get("read_verification_done") and int(record.get("read_count") or 0) <= 0:
        return 0
    corroborated = record.get("corroborated_files") or []
    if isinstance(corroborated, list) and len(corroborated) > 0:
        return 2
    if record.get("read_verification_done") or int(record.get("read_count") or 0) > 0:
        top1 = str(record.get("top1") or record.get("top_1") or "").strip()
        if top1:
            return 2
        return 1
    return 0


def enrich_record(raw: dict[str, Any]) -> dict[str, Any]:
    platform = str(raw.get("platform", "codex"))
    tools = raw.get("tools_called") or []
    if not isinstance(tools, list):
        tools = []
    classified = classify_tool_calls([str(t) for t in tools], platform=platform)
    out = dict(raw)
    out["platform_semantic_executed"] = bool(
        raw.get("platform_semantic_executed", classified.platform_semantic_executed)
    )
    out["semantic_executed"] = bool(raw.get("semantic_executed", classified.semantic_executed))
    out["read_count"] = int(raw.get("read_count", classified.read_count))
    if "read_verification_done" not in out:
        out["read_verification_done"] = classified.read_count > 0
    out["evidence_score"] = evidence_score_from_record(out)
    ans = raw.get("answer_score")
    if isinstance(ans, (int, float)):
        out["combined_score"] = float(ans) + float(out["evidence_score"])
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jsonl", type=Path, help="Per-query telemetry JSONL")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--markdown", action="store_true")
    args = parser.parse_args(argv)

    if not args.jsonl.is_file():
        print(f"error: not found: {args.jsonl}", file=sys.stderr)
        return 1

    rows: list[dict[str, Any]] = []
    for line in args.jsonl.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        raw = json.loads(stripped)
        if isinstance(raw, dict):
            rows.append(enrich_record(raw))

    evidence_total = sum(int(r.get("evidence_score", 0)) for r in rows)
    combined: list[float] = []
    for r in rows:
        c = r.get("combined_score")
        if isinstance(c, (int, float)):
            combined.append(float(c))

    summary = {
        "n": len(rows),
        "evidence_score_total": evidence_total,
        "evidence_score_max": len(rows) * 2,
        "avg_evidence_score": 0.0 if not rows else evidence_total / len(rows),
        "avg_combined_score": 0.0 if not combined else sum(combined) / len(combined),
    }

    if args.markdown:
        print("## Evidence scores (REC-11)\n")
        print("| query_id | evidence_score | read_verify | semantic_exec |")
        print("| --- | ---: | --- | --- |")
        for r in rows:
            print(
                f"| {r.get('query_id','')} | {r.get('evidence_score',0)} | "
                f"{r.get('read_verification_done')} | {r.get('semantic_executed')} |"
            )
        print(f"\nTotal evidence: **{evidence_total}** / {summary['evidence_score_max']}")
    else:
        payload = {"summary": summary, "records": rows}
        print(json.dumps(payload, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
