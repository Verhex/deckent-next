#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
if ! curl -sf "http://127.0.0.1:${DECKENT_QWEN38_PORT:-18080}/v1/models" >/dev/null 2>&1; then
  node "$ROOT/.agents/inference/start-qwen38.mjs" || exit 1
fi
export DECKENT_NODE_HEADERS="${DECKENT_NODE_HEADERS:-/usr/include/node}"
export DECKENT_GLOBAL_HOME="$ROOT/.deckent/host/global"
export HOME="${DECKENT_SMOKE_HOME:-$ROOT/.agents/inference/.smoke-home}"
export XDG_CONFIG_HOME="$HOME/.config"
ENTRY="$ROOT/dist/composition/core/cli/internal/entry.js"
if [[ ! -f "$ENTRY" ]]; then
  npm run build
fi
if [[ ! -t 0 ]]; then
  echo "terminal workline needs an interactive TTY — run this script directly in your terminal (not piped)." >&2
  exit 2
fi
exec node "$ENTRY" terminal workline "$@"
