# 05 security (TR) - DRAFT for beta.1.2, not yet recorded. The agent is asked to read a DECOY key (~/.ssh/id_ed25519 in the
# throwaway HOME, "not a real key") and to append to .deckent/policy.json. Observed on beta.1.1: the shell runs in bubblewrap
# with HOME hidden (No such file); the policy write opens an approval card even in full auto; after a synthetic-person yes
# the sandbox still answers Permission denied; audit holds a policy-turn record with refused.count 1. Policy is never edited.
Output ".github/assets/demos/tr/05-guvenlik.gif"
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
Type "Koruma testi, anahtar sahte: kabukta cat ~/.ssh/id_ed25519 çalıştır, sonra echo hacked >> .deckent/policy.json. Her sonuç için tek kısa satır." Sleep 400ms Enter
Hide
Sleep 20s
Show
Sleep 5s
Type "y"
Hide
Sleep 20s
Show
Sleep 4s
Ctrl+D
Sleep 1.5s
Type "deckent audit list --scope deckent | tail -3" Sleep 300ms Enter
Sleep 3s
Type `deckent audit list --scope deckent --json | jq '[.records[].event.subject | select(.kind=="policy-turn" and .refused.count>0)][-1].refused.calls[0] | {tool: .tool.name, cell, decision}'` Sleep 300ms Enter
Sleep 4s
