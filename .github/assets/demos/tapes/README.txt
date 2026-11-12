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
.github/assets/demos/tapes/en/02-tasks.tape                           # run from the repository root

- Scene 01 needs a fresh install. Record it in a second throwaway root so the configured demo of 02–05 stays intact: a new
  DECKENT_DEMO_ROOT whose `install` links to the staged copy, and DECKENT_DEMO_PROJECT_SOURCE set to a fresh clone at the
  release commit; `demo-ns.sh` shows that clone at the usual project path. Use a new root for every 01 take.
  (`reset-demo.sh` resets the configured demo in place instead; it moves its state, including connections, aside.)
- Scenes 02–05 need a configured install. Set it up with `deckent init`, then
  `deckent init policy --scope deckent --modes full-auto,full-access --apply` and
  `deckent pool set-capacity --execution-slots 3 --in-flight-slots 3`. The person places the API keys
  (DECKENT_ANTHROPIC_KEY, DECKENT_OPENAI_KEY, DECKENT_DEEPSEEK_KEY) and creates the scope budget; then, on a terminal
  inside the namespace (after `deckent runtime restart`):
    deckent models connect --scope deckent --connection anthropic-api --model claude-sonnet-5-5
    deckent models connect --scope deckent --connection openai-api --model gpt-6.1-sol
    deckent models connect --scope deckent --connection deepseek-api --model deepseek-flash
    deckent models connect --scope deckent --connection codex-cli-subscription --model gpt-6.1-sol \
      --executable <abs path to codex> --config-dir /home/demo/.local/state/deckent-next-dev/headless/logins/codex --delegate ai
    deckent coding template --provider codex --kind coding \
      --connection codex-cli-subscription.codex-cli-subscription.gpt-6.1-sol.1 --apply   # workers on the Codex subscription
    (scene 03 binds the same kind to the Claude subscription instead, with --provider claude and
    --connection claude-cli-subscription.claude-cli-subscription.sonnet-5-5.1; see the beta.1.2 notes below)
    (connect codex again, and once more with --model gpt-6-luna: the `small` work class routes Codex work to gpt-6-luna)
- Workers on this checkout (02, 03) also need the operator acknowledgements a deckent-next checkout declares by design
  (tests/contracts/adapters/worker-tree-gate-own-tree.test.ts); without them every worker stops with
  WORKER_TREE_SECRET_REFUSED. A person sets them on a terminal inside the namespace, then restarts the runtime:
    deckent config set execution.secretGate.allowPatternPaths '["tests/**","src/platform/core/i18n/locales/**",".agents/refactor/effort.test.mjs"]'
    deckent config set execution.secretGate.acknowledgedDenyPaths '[".npmrc"]'
- The runtime admits only peers in its own namespaces, so each tape starts its own runtime: run `lib/stop-demo.sh` before
  and after every tape. The chat tapes first set full auto through `/mode` (a stored mode survives a take that stopped
  elsewhere), then pick the scene's model on camera with `/model`.
- `deckent audit list` pages oldest first (100 records per page); 05 passes `--after 150` to reach the newest records.
  Check that the record shown carries the time of the take.
- On the development host only, `demo-env.sh` points `DECKENT_NEXT_INSTALL_ROOT` at a copy of the staged release under
  `$DECKENT_DEMO_ROOT/install`, never at the live install root.
- Waits for models and for the runtime are cut with Hide/Show; everything that is shown is deckent's real output.
- VHS `Wait+Screen` reads the top of the terminal buffer. deckent's cards and appended setup boxes scroll past it, so the
  later steps use timed holds.
- Observed on beta.1.2 (02, 03): one subscription sign-in is one capacity slot (assets/native-coding/commands.json,
  maxInFlight 1), so Codex workers on one login run one at a time although the pool allows 3. A Codex worker that emits
  an item outside its guard's allowed list (an `error` item from listing a missing folder, for example) stops; the two
  later Codex write attempts in this demo stopped with NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED, so scene 03 uses the
  Claude subscription worker. A request with "#" must not pass through `sed s#…#`.
- A take that runs a few seconds long may have holds shortened afterwards with ffmpeg (`select` on frames inside a
  static stretch, then a fresh palette); only identical frames are dropped.
- Keep each GIF at 15–30 s and 5 MB or less, then check every frame: no key, token, email, account name or personal path.
