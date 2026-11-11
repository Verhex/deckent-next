# 04 approval and modes (TR) - DRAFT for beta.1.2, not yet recorded: standard mode, a shell command opens the approval
# window (what, where, on whose behalf, scope, risk, undo, deadline), answered once by the synthetic person; then the
# Shift+Tab mode cycle and the /mode window. Model for this scene: OpenAI API (selected before Show).
Output ".github/assets/demos/tr/04-onay.gif"
Source ".github/assets/demos/tapes/theme-dark.tape"
Hide
Type 'exec "$DECKENT_DEMO_SHELL"' Enter
Sleep 2s
Type `deckent config set --global language '"tr"' >/dev/null; clear; printf '\e[3J'` Enter
Sleep 2s
Type "deckent" Enter
Sleep 12s
Show
Sleep 800ms
# full auto -> full access -> standard
Shift+Tab
Sleep 1.2s
Shift+Tab
Sleep 1.2s
Type "git log --oneline -3 çalıştır ve en yeni commit başlığını söyle." Sleep 400ms Enter
Hide
Sleep 15s
Show
Sleep 5s
Down
Sleep 400ms
Up
Sleep 800ms
Type "y"
Hide
Sleep 15s
Show
Sleep 3s
Shift+Tab
Sleep 1.2s
Shift+Tab
Sleep 1.2s
Shift+Tab
Sleep 1.2s
Type "/mode" Sleep 300ms Enter
Sleep 4s
Escape
Sleep 1.5s
