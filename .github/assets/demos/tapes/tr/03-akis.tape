# 03 flow verification (TR) - DRAFT for beta.1.2, not yet recorded: plan with acceptance lines, approval (synthetic person),
# the worker, the acceptance evidence and the delivery card. Delivery writes into the throwaway recording worktree only.
Output ".github/assets/demos/tr/03-akis.gif"
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
Type "/do docs/notes/glossary-index.md ekle: docs/glossary.md içinde tanımlanan terimlerin alfabetik listesi, her biri bir satır" Sleep 500ms Enter
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
