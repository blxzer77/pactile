#!/usr/bin/env bash
# minimal-agent-app demo — pactile init → capability smoke → list tree
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE="$SCRIPT_DIR/_demo-workspace"

resolve_pactile() {
  local built="$REPO_ROOT/packages/cli/bin/pactile.js"
  if [[ -f "$built" ]]; then
    if [[ ! -f "$REPO_ROOT/packages/cli/dist/cli/index.js" ]]; then
      echo "Building CLI from monorepo..."
      (cd "$REPO_ROOT" && pnpm build)
    fi
    echo "$built"
    return
  fi
  if command -v pactile >/dev/null 2>&1; then
    command -v pactile
    return
  fi
  echo "Error: pactile not found. Install: npm install -g @blxzer/pactile" >&2
  echo "Or run from the Pactile repo after pnpm build." >&2
  exit 1
}

PACTILE="$(resolve_pactile)"
echo "Using CLI: $PACTILE"

rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

echo ""
echo "==> pactile init --cursor --codex -y"
node "$PACTILE" init --cursor --codex -y

echo ""
echo "==> pactile capability-smoke --json"
node "$PACTILE" capability-smoke --json

echo ""
echo "==> Generated layout ($WORKSPACE)"
if command -v tree >/dev/null 2>&1; then
  tree -L 2 -a --dirsfirst
else
  find . -maxdepth 2 \( -name .pactile -o -name .cursor -o -name AGENTS.md \) -print | sort
  echo ""
  echo ".pactile/"
  ls -1 .pactile 2>/dev/null || true
  echo ""
  echo ".cursor/"
  ls -1 .cursor 2>/dev/null || true
fi

echo ""
echo "Done. Open $WORKSPACE in Cursor or Codex to continue with your normal workflow."
