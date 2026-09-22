#!/usr/bin/env bash
# Main repoya dokunmadan yerel main'i feature worktree'ye alır (commit yapmaz).
set -euo pipefail
MAIN_REPO="${DECKENT_MAIN_REPO:-/home/alperen/deckent-next}"
WT="${DECKENT_WT:-/home/alperen/deckent-next-wt-local-llm}"
REF="$(git -C "$MAIN_REPO" rev-parse HEAD)"
git -C "$WT" fetch "$MAIN_REPO" HEAD:refs/heads/deckent-local-main
git -C "$WT" merge --no-edit deckent-local-main
echo "merged $REF into $(git -C "$WT" branch --show-current)"
