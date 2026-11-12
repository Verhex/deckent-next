# 01 install (EN): a fresh throwaway installation; deckent --version, deckent init, then the first open.
# Run from the repository root after lib/stop-demo.sh, with DECKENT_DEMO_SHELL=<abs path>/lib/demo-ns.sh, in a fresh throwaway
# root: DECKENT_DEMO_ROOT=<new dir> (its install/ links to the staged copy) and DECKENT_DEMO_PROJECT_SOURCE=<a fresh clone>, which
# demo-ns.sh shows at the usual project path; the configured demo of scenes 02-05 is not reset. One fresh root per take.
# Waits for the runtime and for each applied step are cut (Hide/Show); everything shown is deckent's real output.
Output ".github/assets/demos/en/01-install.gif"
Source ".github/assets/demos/tapes/theme-dark.tape"
Hide
Type 'exec "$DECKENT_DEMO_SHELL"' Enter
Sleep 2s
Type "clear" Enter
Sleep 500ms
Show
Sleep 500ms
Type "deckent --version" Sleep 300ms Enter
Wait+Screen /commit/
Sleep 1.5s
Type "deckent init" Sleep 300ms Enter
Hide
Wait+Screen@30s /Continue in English\?/
Show
Sleep 1.6s
Enter
Wait+Screen /scope "deckent"\?/
Sleep 1.1s
Enter
Wait+Screen /Who will use this installation\?/
Sleep 1.3s
Enter
Wait+Screen /Install the first-run permissions\?/
Sleep 2s
Enter
Wait+Screen /1\. Apply now \(y\)/
Sleep 700ms
Enter
# VHS reads the top of the buffer, and init appends a new box per step, so the rest is timed.
Hide
Sleep 7s
Show
Sleep 700ms
Enter
Hide
Sleep 7s
Show
Sleep 700ms
Enter
Hide
Sleep 7s
Show
Sleep 2s
Enter
Hide
Sleep 7s
Show
Sleep 800ms
Enter
Hide
Sleep 5s
Show
Sleep 2.4s
Hide
Type `deckent config set --global terminal.theme '"dark"' >/dev/null; clear; printf '\e[3J'` Enter
Sleep 2.5s
Show
Type "deckent" Sleep 300ms Enter
Hide
Wait+Screen@40s /Give yourself the rights/
Show
Sleep 1.8s
Enter
Hide
Sleep 5s
Sleep 300ms
Enter
Sleep 5s
Show
Sleep 1.2s
Escape
Hide
Sleep 5s
Show
Sleep 1.5s
Escape
Hide
Sleep 5s
Sleep 1.5s
Show
Sleep 3.5s
