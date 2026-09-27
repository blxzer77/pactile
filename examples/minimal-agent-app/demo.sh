#!/usr/bin/env bash
# minimal-agent-app demo — Pactile init → capability smoke → generated tree
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
NODE_VERSION="$(node --version 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
  echo "Error: Node.js 20 or newer is required (found: ${NODE_VERSION:-none})." >&2
  exit 1
fi
echo "Using Node.js $NODE_VERSION"

WORKSPACE_INPUT="${PACTILE_DEMO_WORKSPACE:-$SCRIPT_DIR/_demo-workspace}"
if [[ "$WORKSPACE_INPUT" != /* ]]; then
  WORKSPACE_INPUT="$SCRIPT_DIR/$WORKSPACE_INPUT"
fi
WORKSPACE_PARENT="$(cd "$(dirname "$WORKSPACE_INPUT")" && pwd -P)"
WORKSPACE_NAME="$(basename "$WORKSPACE_INPUT")"
if [[ -z "$WORKSPACE_NAME" || "$WORKSPACE_NAME" == "." || "$WORKSPACE_NAME" == ".." ]]; then
  echo "Error: PACTILE_DEMO_WORKSPACE must name a child directory." >&2
  exit 1
fi
WORKSPACE="$WORKSPACE_PARENT/$WORKSPACE_NAME"
if [[ "$WORKSPACE" == "/" || "$WORKSPACE" == "$SCRIPT_DIR" || "$WORKSPACE" == "$REPO_ROOT" ]]; then
  echo "Error: refusing to use a repository or filesystem root as the demo workspace." >&2
  exit 1
fi
if [[ -L "$WORKSPACE" ]]; then
  echo "Error: refusing to replace a symlink at $WORKSPACE." >&2
  exit 1
fi

PACTILE_JS="$REPO_ROOT/packages/cli/dist/bin/pactile.js"
PACTILE_BIN=""
if [[ -f "$PACTILE_JS" ]]; then
  if [[ ! -f "$REPO_ROOT/packages/cli/dist/cli/index.js" ]]; then
    echo "Building CLI from monorepo..."
    (cd "$REPO_ROOT" && pnpm build)
  fi
  if [[ ! -f "$PACTILE_JS" ]]; then
    echo "Error: build did not create $PACTILE_JS." >&2
    exit 1
  fi
elif command -v pactile >/dev/null 2>&1; then
  PACTILE_BIN="$(command -v pactile)"
else
  echo "Error: pactile not found. Install: npm install -g @blxzer/pactile" >&2
  echo "Or run from the Pactile repo after pnpm build." >&2
  exit 1
fi

run_pactile() {
  if [[ -n "$PACTILE_JS" && -f "$PACTILE_JS" ]]; then
    node "$PACTILE_JS" "$@"
  else
    "$PACTILE_BIN" "$@"
  fi
}

if [[ -n "$PACTILE_JS" && -f "$PACTILE_JS" ]]; then
  echo "Using CLI: node $PACTILE_JS"
else
  echo "Using CLI: $PACTILE_BIN"
fi

if [[ -e "$WORKSPACE" ]]; then
  rm -rf -- "$WORKSPACE"
fi
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

echo ""
echo "==> pactile --version"
run_pactile --version

echo ""
echo "==> verify pactile init --help supports --codex"
INIT_HELP="$(run_pactile init --help)"
if [[ "$INIT_HELP" != *"--codex"* ]]; then
  echo "Error: pactile init --help does not advertise --codex." >&2
  exit 1
fi
echo "init help advertises --codex"

echo ""
echo "==> pactile init --codex --yes --skip-readiness --user pactile-demo"
run_pactile init --codex --yes --skip-readiness --user pactile-demo

echo ""
echo "==> Generated Codex layout ($WORKSPACE)"
if command -v tree >/dev/null 2>&1; then
  tree -L 2 -a --dirsfirst
else
  find . -maxdepth 2 \( -name .pactile -o -name .agents -o -name AGENTS.md \) -print | sort
  echo ""
  echo ".pactile/"
  ls -1 .pactile 2>/dev/null || true
  echo ""
  echo ".agents/skills/"
  ls -1 .agents/skills 2>/dev/null || true
fi

echo ""
echo "Done. Open $WORKSPACE in Codex to continue with your normal workflow."
