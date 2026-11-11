# 02 parallel work (TR) - DRAFT for beta.1.2, not yet recorded. Needs: configured install, pool capacity >= 3,
# a coding worker connection (scene plan: Codex subscription) and a planning model. The plan approval is answered
# by the labelled synthetic person of this throwaway install. Model waits are cut (Hide/Show).
Output ".github/assets/demos/tr/02-paralel.gif"
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
Type "/do Üç ayrı görev olarak üç kısa not yaz: docs/notes/glossary.md, docs/notes/known-limits.md ve docs/notes/policy.md; her biri docs/ içindeki eş dosyayı beş maddede özetlesin" Sleep 500ms Enter
Sleep 2s
Hide
Sleep 60s
Show
Sleep 4s
Type "y"
Sleep 2.5s
Type "/tasks" Sleep 300ms Enter
Sleep 4s
Hide
Sleep 40s
Show
Sleep 5s
Escape
Sleep 1s
Type "/monitor" Sleep 300ms Enter
Sleep 5s
