# 02 tasks and workers (TR): the same scene as en/02-tasks.tape in Turkish, on three other files. The chat model is chosen on camera (Anthropic API; with no Brain model chosen, /do plans with
# the chat model). /do asks for three read-only tasks on this checkout. The plan card names each task's worker (gpt-6-luna
# on the Codex subscription); the labelled synthetic person of this throwaway install approves it. The monitor's
# Summary tab shows a task waiting for an execution slot; its Workers tab lists worker rows with state and model
# (older runs' rows included). Observed on
# beta.1.2: one subscription sign-in is one capacity slot (assets/native-coding/commands.json, maxInFlight 1), so the three
# Codex tasks run one after another although the pool allows 3; the recording does not claim parallel work. The take ends
# on the completed Run (accepted on exit code) and its delivery card, left undecided. Waits are cut (Hide/Show); all output is deckent's own.
Output ".github/assets/demos/tr/02-gorevler.gif"
Source ".github/assets/demos/tapes/theme-dark.tape"
Hide
Type 'exec "$DECKENT_DEMO_SHELL"' Enter
Sleep 2s
Type `deckent config set --global language '"tr"' >/dev/null; clear; printf '\e[3J'` Enter
Sleep 2s
# Start every take in full auto (the stored mode survives a take that stopped elsewhere), then reopen.
Type "deckent" Enter
Sleep 15s
Type "/mode" Enter
Sleep 1.5s
Type "tam otomatik"
Sleep 500ms
Enter
Sleep 1s
Ctrl+D
Sleep 2s
Type `clear; printf '\e[3J'` Enter
Sleep 1s
Type "deckent" Enter
Sleep 10s
Show
Sleep 600ms
Type "/model" Sleep 200ms Enter
Sleep 900ms
Type "anthropic"
Sleep 400ms
Enter
Sleep 500ms
Enter
Sleep 500ms
Enter
Sleep 600ms
Down
Sleep 400ms
Enter
Sleep 800ms
Type@20ms "/do Üç ayrı salt-okunur görev, dosya değişikliği yok: AGENTS.md, CHANGELOG.md ve docs/policy-and-ai.md dosyalarının ilk satırını bildir." Sleep 300ms Enter
Hide
Sleep 40s
Show
Sleep 4.5s
Type "y"
Sleep 1.5s
Escape
Sleep 400ms
Type "/monitor" Sleep 200ms Enter
Sleep 3.5s
Hide
Sleep 14s
Show
Type "3"
Sleep 4s
# Wait for the whole Run to finish before the take ends, so the stopped runtime leaves no Run half done.
Hide
Sleep 150s
Show
Escape
Sleep 4.5s
