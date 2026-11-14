# Recording shell environment, sourced inside the namespace by demo-ns.sh.
# SYNTHETIC PERSON: the AI-agent markers deckent uses to recognise AI callers are removed here, so the throwaway
# install treats this shell as a person's terminal. Use it only in this throwaway install, and say so wherever the
# recording is shown.
for v in $(env | grep -oE '^(CLAUDE[A-Z_]*|AI_AGENT|CODEX_[A-Z_]*|CURSOR_AGENT|GEMINI_CLI|SG_AGENTIC_MODEL|SECURITY_REVIEW_MODEL|VSCODE_[A-Z_]*|TERM_PROGRAM[A-Z_]*)='); do unset "${v%=}"; done
export HOME=/home/demo
# Development-host entry only: run the staged release copied into the demo root, never the live install root.
export DECKENT_NEXT_INSTALL_ROOT="$DECKENT_DEMO_ROOT/install"
export COLORTERM=truecolor TERM=xterm-256color LANG=C.UTF-8 LC_ALL=C.UTF-8
# The recording terminal is dark (VHS theme #191B1A); deckent's auto theme reads this before an installation exists.
export COLORFGBG='15;0'
export USER=demo LOGNAME=demo PS1='$ '
