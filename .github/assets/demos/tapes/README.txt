README terminal recordings
==========================

The GIFs under `.github/assets/demos/{en,tr}/` are recorded from real deckent sessions with
VHS (https://github.com/charmbracelet/vhs) (v0.12.1, which drives ttyd (https://github.com/tsl0922/ttyd) 1.7.7) and the
JetBrains Mono font (SIL OFL 1.1). Each tape is one scene: `en/` runs deckent in English and `tr/` runs it in Turkish.

What the recording install is

- Throwaway and isolated. `lib/demo-ns.sh` opens a Linux user, mount and UTS namespace without root. Inside it, HOME is
  `/home/demo` (backed by `$DECKENT_DEMO_ROOT/home`), the host name is `deckent-demo` and the account name is `demo`.
  deckent's global state therefore lives in that throwaway HOME. The project is a checkout named `deckent`, so the header
  shows that name. Nothing propagates to the host, and the person's real deckent state is never opened.
- Synthetic person. `lib/demo-env.sh` removes the AI-agent markers that deckent uses to recognise AI callers. Inside
  this throwaway install only, the recording shell therefore acts as a person's terminal. Any approval in a recording is
  answered by this labelled synthetic person. Never use these scripts against a real installation.
- Brand colours. The tapes set COLORTERM=truecolor and `terminal.theme` to `"dark"`, in the throwaway global
  configuration only. Before an installation exists, COLORFGBG tells the `auto` theme that the background is dark. To
  confirm the brand palette, record deckent's raw output with `script` and check that `38;2;108;207;174` appears and
  `38;5;` does not.
- Models. Use a subscription or API connection made by the person inside the namespace. Do not copy credential files
  into it.

Re-record

export DECKENT_DEMO_ROOT="$HOME/.local/share/deckent-readme-demo"      # throwaway HOME, login and staged code
export DECKENT_DEMO_PROJECT="/home/$(id -un)/deckent"                  # a git worktree named deckent
export DECKENT_DEMO_SHELL="$PWD/.github/assets/demos/tapes/lib/demo-ns.sh"
mkdir -p .github/assets/demos/en .github/assets/demos/tr
.github/assets/demos/tapes/lib/stop-demo.sh                            # stops only HOME=/home/demo processes
.github/assets/demos/tapes/lib/reset-demo.sh                           # moves state aside; logins stay (01 only)
vhs .github/assets/demos/tapes/en/01-install.tape                      # run from the repository root

- Scene 01 needs a fresh install, so run `reset-demo.sh` before each 01 tape.
- Scenes 02–05 need a configured install. Set it up with `deckent init`, then
  `deckent init policy --scope deckent --modes full-auto,full-access --apply` and
  `deckent pool set-capacity --execution-slots 3 --in-flight-slots 3`, then connect a model.
- On the development host only, `demo-env.sh` points `DECKENT_NEXT_INSTALL_ROOT` at a copy of the staged release under
  `$DECKENT_DEMO_ROOT/install`, never at the live install root.
- Waits for models and for the runtime are cut with Hide/Show; everything that is shown is deckent's real output.
- VHS `Wait+Screen` reads the top of the terminal buffer. deckent's cards and appended setup boxes scroll past it, so the
  later steps use timed holds.
- Keep each GIF at 15–30 s and 5 MB or less, then check every frame: no key, token, email, account name or personal path.
