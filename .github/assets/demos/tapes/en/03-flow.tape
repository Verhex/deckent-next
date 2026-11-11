# 03 flow verification (EN) - DRAFT for beta.1.2, not yet recorded: plan with acceptance lines, approval (synthetic person),
# the worker, the acceptance evidence and the delivery card. Delivery writes into the throwaway recording worktree only.
Output ".github/assets/demos/en/03-flow.gif"
Source ".github/assets/demos/tapes/theme-dark.tape"
Hide
Type 'exec "$DECKENT_DEMO_SHELL"' Enter
Sleep 2s
Type `deckent config set --global language '"en"' >/dev/null; clear; printf '\e[3J'` Enter
Sleep 2s
Type "deckent" Enter
Sleep 12s
Show
Sleep 800ms
Type "/do Add docs/notes/glossary-index.md: an alphabetical list of the terms defined in docs/glossary.md, one line each" Sleep 500ms Enter
Sleep 2s
Hide
Sleep 60s
Show
Sleep 4s
Type "y"
Sleep 2s
Type "/tasks" Sleep 300ms Enter
Sleep 3s
Hide
Sleep 120s
Show
Sleep 3s
Escape
Sleep 800ms
Type "/deliver" Sleep 300ms Enter
Sleep 6s
Type "y"
Sleep 4s
