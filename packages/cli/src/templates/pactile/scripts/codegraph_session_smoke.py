#!/usr/bin/env python3
"""Pre-run checks for codegraph index presence (does not start MCP)."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from common.paths import get_repo_root


def _find_codegraph_dirs(root: Path) -> list[Path]:
    found: list[Path] = []
    direct = root / ".codegraph"
    if direct.is_dir():
        found.append(direct.resolve())
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        nested = child / ".codegraph"
        if nested.is_dir() and nested.resolve() not in found:
            found.append(nested.resolve())
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description="Codegraph session smoke (index on disk)")
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Workspace root (default: Pactile repo root)",
    )
    parser.add_argument("--json", action="store_true", help="Machine-readable report")
    args = parser.parse_args()

    root = (args.root or get_repo_root()).resolve()
    indexes = _find_codegraph_dirs(root)
    ok = len(indexes) > 0
    payload = {
        "ok": ok,
        "workspace_root": str(root),
        "codegraph_index_paths": [str(p) for p in indexes],
        "checked_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "mcp_note": (
            "Enable codegraph MCP in host settings; this script only checks "
            "on-disk .codegraph/ directories."
        ),
        "run_header_fields": {
            "codegraph_mcp": "configured|unknown|off",
            "codegraph_index_path": str(indexes[0]) if indexes else "",
            "codegraph_smoke_at": "<iso8601>",
            "codegraph_smoke_ok": ok,
        },
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        if ok:
            print("Codegraph smoke: PASS")
            for p in indexes:
                print(f"  index: {p}")
        else:
            print("Codegraph smoke: FAIL — no .codegraph/ under workspace root", file=sys.stderr)
            print(f"  root: {root}", file=sys.stderr)
        print(payload["mcp_note"])

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
