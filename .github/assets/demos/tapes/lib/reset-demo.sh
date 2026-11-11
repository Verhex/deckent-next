#!/bin/bash
# Reset the throwaway install for a fresh recording: MOVE (never delete) the project's ignored deckent state and the demo
# HOME into $DECKENT_DEMO_TRASH (deckent's headless/logins stay). Run stop-demo.sh first.
set -eu
DECKENT_DEMO_ROOT="${DECKENT_DEMO_ROOT:-$HOME/.local/share/deckent-readme-demo}"
DECKENT_DEMO_PROJECT="${DECKENT_DEMO_PROJECT:-/home/$(id -un)/deckent}"
T="${DECKENT_DEMO_TRASH:-$DECKENT_DEMO_ROOT/trash}/$(date +%s)"; mkdir -p "$T/project" "$T/home"
cd "$DECKENT_DEMO_PROJECT"
git clean -ndX -- .deckent | sed 's/^Would remove //' | while read -r p; do mv "$p" "$T/project/$(echo "$p" | tr / _)"; done
shopt -s dotglob nullglob; for f in "$DECKENT_DEMO_ROOT/home"/*; do mv "$f" "$T/home/"; done
# Keep a person's own CLI sign-in (deckent's headless/logins) across resets: it is the only part not recreated by a recording.
L=.local/state/deckent-next-dev/headless/logins
if [ -d "$T/home/$L" ]; then mkdir -p "$DECKENT_DEMO_ROOT/home/$(dirname $L)"; chmod 700 "$DECKENT_DEMO_ROOT/home/.local" "$DECKENT_DEMO_ROOT/home/.local/state" "$DECKENT_DEMO_ROOT/home/.local/state/deckent-next-dev" "$DECKENT_DEMO_ROOT/home/$(dirname $L)" 2>/dev/null || true; mv "$T/home/$L" "$DECKENT_DEMO_ROOT/home/$L"; fi
echo "reset: moved to $T"
