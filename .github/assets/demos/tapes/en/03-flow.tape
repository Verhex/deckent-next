# 03 plan, evidence, delivery (EN): the chat model is chosen on camera (OpenAI API; with no Brain model chosen, /do plans
# with the chat model). /do asks for one small new file in this throwaway recording checkout. The plan names the task, its
# worker (claude-sonnet-5-5 on the Claude subscription: the `coding` kind is bound to it for this scene, because
# Codex workers on this beta.1.2 checkout stopped on write tasks with NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED) and its acceptance criterion; the labelled synthetic person approves it.
# Observed on beta.1.2: the task is accepted on the worker's exit code (evaluator process-exit) and the card says the
# content is not independently verified; the delivery card shows the worker's own report as a claim and "System
# verification: none recorded"; the synthetic person says yes and the file is written into the checkout with no commit.
# The take ends on git status and the new file. Waits are cut (Hide/Show); all output is deckent's own.
Output ".github/assets/demos/en/03-flow.gif"
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
Sleep 900ms
Type "openai"
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
Type@20ms "/do Write a new file docs/glossary-terms.md: the ## headings of docs/glossary.md, sorted alphabetically, one per line. Read only docs/glossary.md and write only that file." Sleep 300ms Enter
Hide
Sleep 45s
Show
Sleep 3s
Type "y"
Sleep 3s
Escape
Hide
Sleep 75s
Show
Sleep 4s
Ctrl+O
Sleep 400ms
Type "y"
Hide
Sleep 55s
Show
Sleep 3s
Escape
Sleep 400ms
Ctrl+D
Sleep 800ms
Type@15ms "git status --short; head -5 docs/glossary-terms.md" Sleep 200ms Enter
Sleep 3.5s
