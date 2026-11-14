# 04 approval and modes (EN): the chat model is chosen on camera (DeepSeek API), Shift+Tab steps to standard mode, a shell
# command opens the approval window (what, where, on whose behalf, scope, why, risk, undo, deadline), answered once by the
# labelled synthetic person of this throwaway install; then the cycle back to full auto and the /mode window.
# Waits for the runtime and for the model are cut (Hide/Show); everything shown is deckent's real output.
Output ".github/assets/demos/en/04-approval.gif"
Source ".github/assets/demos/tapes/theme-dark.tape"
Hide
Type 'exec "$DECKENT_DEMO_SHELL"' Enter
Sleep 2s
Type `deckent config set --global language '"en"' >/dev/null; clear; printf '\e[3J'` Enter
Sleep 2s
# Start every take in full auto (the stored mode survives a take that stopped elsewhere), then reopen.
Type "deckent" Enter
Sleep 15s
Type "/mode" Enter
Sleep 1.5s
Type "full auto"
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
Sleep 1.2s
Type "deepseek"
Sleep 600ms
Enter
Sleep 700ms
Enter
Sleep 700ms
Enter
Sleep 900ms
Down
Sleep 500ms
Enter
Sleep 1.2s
# full auto -> full access -> standard
Shift+Tab
Sleep 900ms
Shift+Tab
Sleep 1s
Type "Run git log --no-merges --oneline -3 and tell me the newest commit subject." Sleep 300ms Enter
Hide
Sleep 40s
Show
Sleep 4.5s
Up
Sleep 500ms
Down
Sleep 700ms
Type "y"
Hide
Sleep 30s
Show
Sleep 2.5s
# standard -> careful -> full auto
Shift+Tab
Sleep 900ms
Shift+Tab
Sleep 900ms
Type "/mode" Sleep 200ms Enter
Sleep 3.5s
Escape
Sleep 1s
