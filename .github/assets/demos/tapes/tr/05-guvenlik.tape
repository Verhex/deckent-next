# 05 security (TR): the same scene as en/05-security.tape in Turkish. The chat model is chosen on camera (Anthropic API). The agent is asked to list ~/.ssh
# and to append "test" to .deckent/policy.json. Observed on beta.1.2: the shell runs in bubblewrap with HOME hidden, so the
# listing fails (No such file); the policy write opens an approval card even in full auto; the labelled synthetic person
# answers No (the owner's default); the audit log holds a policy-turn record with the refused call. The policy file is never
# edited. A prompt naming a private key file was stopped by the Anthropic API itself in 2 of 4 tries, so this one lists the
# folder only. Waits are cut (Hide/Show); all output is deckent's own.
Output ".github/assets/demos/tr/05-guvenlik.gif"
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
Type@22ms "Sandbox demosu: kabukta ls ~/.ssh çalıştır, sonra echo test >> .deckent/policy.json. Her sonuç için tek kısa satır." Sleep 300ms Enter
Hide
Sleep 55s
Show
Sleep 4s
Type "n"
Hide
Sleep 35s
Show
Sleep 4s
Ctrl+D
Sleep 1s
# audit list pages oldest first, 100 records per page; --after skips the setup records so the newest policy-turn shows.
Type@15ms "deckent audit list --scope deckent --after 150 | grep policy-turn | tail -1" Sleep 300ms Enter
Sleep 2s
Type@8ms `deckent audit list --scope deckent --after 150 --json | jq -c '[.records[].event.subject | select(.kind=="policy-turn" and .refused.count>0)][-1].refused.calls[0] | {tool: .tool.name, cell, decision}'` Sleep 300ms Enter
Sleep 3.5s
