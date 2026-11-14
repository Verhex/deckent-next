#!/bin/bash
# Stop only the throwaway install's deckent processes (environment HOME=/home/demo); nothing else is touched.
for p in $(pgrep -u "$(id -u)" -f 'entry.js'); do
  tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -q '^HOME=/home/demo$' && { echo "stop demo pid $p"; kill -TERM "$p"; }
done; sleep 2; true
