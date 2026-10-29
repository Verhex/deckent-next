# Known limits

[Türkçe](known-limits.tr.md) · [README](../README.md) · [Architecture overview](architecture-overview.md)

This page says plainly what Deckent does not do yet, what has not been tried, and what you should do instead. It
describes the current pre-release (the version is in the [README](../README.md) and the top line of the
[CHANGELOG](../CHANGELOG.md)). A limit leaves this page when the change that closes it has landed and been
seen working, not before. Each item gives **what** the limit is, **the impact** on you and, where one exists, a
**workaround**. [CHANGELOG.md](../CHANGELOG.md) lists the limits each release carried at the time.

Deckent is a pre-release. Nothing here is a promise of a date.
Alpha.57 has landed (PRs #120 and #121) and is live. Alpha.58 is a release candidate, not released; items marked alpha.58 describe that candidate. Released mechanisms and the remaining scenario/platform acceptance are distinguished below; a release does not close every limit.


## BeUser B1 journey walks (alpha.57)

Alpha.57 binds walk/report callbacks, real Run admission/reservation, private durable realm records, streaming transport, C4/C5 retained evidence, TaskEvaluation and per-Run reports. R3-B publishes policy data inside init/upgrade; replay keeps its original byte verification. Dry admission is author evidence, not a realm journey. Secret FD creation/verified reset, full milestone readbacks and measured call/cost/reliability evidence remain open; unobserved fields stay unknown/null. One finite limits profile is provisional. Sealed ledgers can never be exported, backed up or restored; backup-dependent branches remain unknown. Unsupported private systemd stays unknown and non-blocking. No host socket/bus workaround. Native adoption/full surfaces remain B2/B4. The first host walk on the assembled release ran three journeys; all three were red, so journey acceptance and owner acceptance are open.

- **In alpha.57, yes/no letters are not accepted everywhere in `deckent init`.** The first card shows the `y` key next to its yes answer and takes `y`; the guided setup window that follows shows no letter and silently ignores `y`. *Impact:* a person (or a BeUser persona) pressing `y` there sees nothing happen. *Workaround:* press Enter to choose the highlighted answer. The alpha.58 candidate shows and takes (y)/(n) on every yes/no card; this entry leaves when that lands.
- **BeUser arranges only the start states it can reach without a witness (alpha.58).** A v3 journey profile names its branch's catalogued start states. Before the persona's first look, Deckent arranges them in the realm over an exec without a terminal (closed stdin, explicit user and locale), never through the persona's terminal, and reads each one back. The catalog arranges an installed Deckent (through `deckent init --yes --scope beuser-realm --json`), a Git project with a tracked file under `.deckent/`, an unknown file under `.deckent/`, a stopped service, a second installation, an unreadable ledger, an unsafe authority file, a hand-made launcher, an unproven install method, an empty cache, a fresh home, no Docker socket, a folder with the person's own files and the assembled candidate. The persona's language and accessibility needs come from its profile; `cancel` is the persona's own act. These stay unknown, and the report names each one with its reason: states that need a person's witness (managed policy and approvals `T2`/`S14`/`S14b`, global or relocated data `S10b`/`S25`, keys `S11`, an applied or interrupted uninstall `S15`/`S16`, a modified bridge `S21`, and model, price, role or budget setup), states outside the sealed realm (service managers and running services `S2`/`S4`/`S4b`/`K4`, active work and uncertain effects `S5`/`S8`, worker images `S12`, another platform `S18`, image preparation, worker questions, an unavailable realm or network), states with no witness-free producer (`S3`, parked work `S6`, pending approval `S7`, queued delivery `S9`, dispatch history `S23`), driver limits (pipe, CI and MCP `S17`, line mode) and Enterprise company scope. A branch that names any of them stops as `BEUSER_START_STATE_UNREACHABLE` before any step, and the persona does not start; a step that fails or does not read back stops it as `BEUSER_START_STATE_UNMET`. Both are unknown, never red. Nothing bypasses the witness. *Impact:* those branches are not walked, which is 18 of the 23 uninstall branches and 12 of the 21 onboarding branches. *Workaround:* keep the report's list of unarranged states; a v2 profile keeps the earlier empty realm.
- **BeUser compares screens with their numbers masked when it looks for a stuck persona (alpha.58).** The same key or text a third time on a screen that came back through other screens and differs only in numbers (a revision, a counter, a clock) ends the walk as a `loop`, and a fourth look or wait in a row on such a screen ends it as `observing`; both are red `persona-stuck` findings. *Impact:* a journey that legitimately repeats one action three times through a screen that shows only changing numbers (for example adding three items to a list that shows just a count), or a product that stays on one screen through four looks or waits, is reported stuck. *Workaround:* read the finding's screen and evidence before treating it as a product defect; the thresholds are registry data in `assets/beuser/limits.json`.
- **BeUser walks need the host's Docker.** A walk starts a realm container through the host Docker daemon (non-root uid, no network, read-only root, its own mount/pid/ipc/uts/cgroup namespaces); an environment that cannot start such a container cannot walk. *Workaround:* prepare the profile anywhere, run `deckent beuser walk` on a host with Docker.

## Platforms: tried and not tried

- **Tried:** Linux and Windows through WSL2 (the supported execution path). Hosted checks run on Ubuntu with Node 24 and
  Node 26. Node.js 24.22.1 or newer is required (24.21 and older 24.x have a heap overrun in UTF-16LE decoding; 24.22.1 carries the 2026-10-21 security fixes). On Node 26, 26.12.1 or newer is required; Node 25 is not supported.
  *Impact:* these are the only places where behavior has been observed.
- **Not supported: native Windows runtime.** The service transport does not run there, and the file-based secret stores are
  not available there. The OS-user identity cannot be read and the private ledger files cannot be opened, so backup, the
  monitor, model calls, the Brain and acceptance do not work natively either. Platform tests skip these with an
  `[unsupported on Windows: …]` tag, so a green Windows check does not mean these parts work. *Workaround:* use WSL2.
- **Conversation origins only filter the resume list.** `/resume` starts with the current OS user and launch folder; “All folders” widens it within the project. Older snapshots appear at the project root to their file owner. These labels grant no permissions.
- **Native Windows does not open a project from its subfolders.** Elsewhere `deckent` and `deckent-mcp` started in a subfolder
  use the installation above it, never one above the home folder; native Windows has no owner and mode checks for that walk, so it stops with
  `INSTALLATION_ROOT_WALK_UNSUPPORTED`. *Workaround:* run in the project's own folder or pass `deckent-mcp --project`.
- **macOS has separate, incomplete verification.** It is not part of the required checks. *Impact:* execution and security
  behavior there is unproven; do not rely on it for real work. The local runtime socket is Linux-only, so the service
  transport, backup and restore do not run on macOS either; platform tests skip them with a `[requires Linux …]` tag.
- **The terminal screen layout has not been tried** on physical Windows Terminal, macOS Terminal, VS Code's terminal or tmux.
  *Impact:* the input bar, windows and colors may misbehave there. *Workaround:* use a plain Linux or WSL2 terminal.
- **Copying with the mouse and `/copy [n]` use your terminal's clipboard sequence (OSC 52)** and were proven only on a Linux
  pseudo-terminal, not on physical Windows Terminal, WSL inside it, xterm, tmux or iTerm2. Some terminals block it (iTerm2 until
  "Applications in terminal may access clipboard" is on; tmux needs `set -g set-clipboard on`, and for `/copy` also
  `allow-passthrough on`). Deckent cannot ask the terminal whether it took the text, so `/copy` says "sent", never "copied". One
  request carries at most 64 KiB and `/copy` reaches back at most 99 answers; a larger answer is refused, and off an interactive
  terminal nothing is sent. Drag selection has no autoscroll and no double/triple click.
  *Impact:* after "Copied … characters" or "Sent answer …" the paste may be empty. *Workaround:* hold Shift (Option in iTerm2) and drag to use the
  terminal's own selection, or set `terminal.layout` to `inline`.
- **arm64 is not shipped.** The locked bubblewrap bundle ships for x86_64; an arm64 build check is not arm64 runtime proof.
  *Workaround:* use x86_64.
- **No npm package yet.** You install from source (see [Get started](../README.md#get-started)).
- **Some install-time messages are English only** (build and sandbox preparation messages appear before translation exists).
- **`deckent init` installs only.** Language is the first step; the profile is answered before permissions and saved through the
  existing configuration owner once installation exists. Model, execution, work and instruction stages are onboarding; init neither asks
  nor applies them. `init --json` is schema v2 with `phase`, without `firstJob`; `init --json --phase onboarding` is read-only.
  The interactive first-open onboarding is a separate integration; the phase document alone does not prove that journey works.
  `--yes --scope <id>` applies only fresh permissions and language, never read-only checks or person-only stages. It does not save the profile.
  The final check settles only over install stages; a completed check with warnings can be done, with warnings visible. A repeat `--yes`
  applies no already-settled work. Doctor derives work guidance from the setup stage evaluators and points onboarding work to `deckent` / `/setup`.
- **Docker Engine install from setup is new** (alpha.48 I-D2; an onboarding stage, excluded from `deckent init`, only to a
  person at a real terminal). It installs only from Docker's official apt repository on the Ubuntu and Debian releases Docker
  lists (checked 2026-10-19), with Docker's signing key shipped in Deckent; everything else (native Windows/macOS, Docker
  Desktop on WSL, derivatives such as Linux Mint, conflicting `docker.io`/`containerd`/`runc` packages, an older
  `docker.list`, no network) only prints the next step. *Impact:* a real install has only been rehearsed with a recording
  fake `sudo`, never run by Deckent's tests. If Docker changes its key, apt refuses the repository until a Deckent update
  ships the new key (fail closed). The key and source files are staged in a private folder under `$TMPDIR` that stays
  after a declined or print-only run. On WSL without systemd the engine may not start after the install; the next check
  then says the service is stopped. The Docker Desktop check on WSL looks for the Windows-side program (an observed
  convention, not a documented contract). The terminal-witness refusal text does not name this install yet. The window
  closes while the install runs (sudo asks on the plain terminal) and reopens afterwards.
  *Workaround:* follow the printed commands, start the service, log out and in again for the `docker` group.

## Isolation

- **Docker tasks get a Node heap ceiling of 75 % of their memory limit.** Deckent sets `NODE_OPTIONS=--max-old-space-size` so Node-based
  checks (for example `tsc`) use the memory the container has. A task command that sets `NODE_OPTIONS` itself wins; an image that sets
  `NODE_OPTIONS` in its own environment is overridden. Several Node processes in one container share the limit and can still be stopped
  by it (exit 137).
- **A Docker worker is not a virtual machine.** It shares the host kernel. *Impact:* a kernel-level escape is not
  contained by Deckent. A microVM sandbox is planned, not built.
- **A coding worker's own tools sit outside Deckent's model ingress.** Claude Code, Codex and Cursor use their own tools
  inside the container. *Impact:* those tool calls are not decided by Deckent's per-call approval windows; what contains
  them is the container, the checkout and the delivery gate. *Workaround:* give workers only the checkout and the
  permissions the job needs.
- **Ubuntu 24.04 and later can block the sandbox.** If `kernel.apparmor_restrict_unprivileged_userns` is `1`, bubblewrap cannot
  start; Deckent falls back to Landlock visibly and refuses full-access shell calls. *Workaround:* an administrator installs
  bubblewrap root-owned as `/usr/local/bin/bwrap` with an AppArmor profile that allows `userns` for it (see
  [Get started](../README.md#get-started)).
- **On a Landlock-only host a large `.gitignore`d folder can refuse the shell.** Landlock now checks folders named in
  `.gitignore` for credential files like bubblewrap does, so they count toward its 20,000-entry limit (bubblewrap: 50,000).
  *Impact:* a project over the limit gets the shell refused with a visible reason instead of running. *Workaround:* make
  bubblewrap usable, or keep large generated folders out of the project folder.
- **The `prefer-sandbox` host fallback has no enforced filesystem boundary.** In the closed modes, when no sandbox is
  usable the call may run on the host. *Workaround:* set `require-sandbox` when confinement is required.
- **Credential and home-folder hiding is bounded.** The shared registry covers gh, Docker, kube, Codex, Git credentials and
  common cloud CLIs; hiding stops at depth 3 and 20,000 entries. *Impact:* custom locations and unusual file names are not
  masked. *Workaround:* keep such files out of the home folder the sandbox sees, or isolate separately.
- **Only the installation config may name a secret.** A `$DECK:NAME` reference in the project config (`.deckent/config.json`)
  refuses the whole config load with `SECRET_REFERENCE_PROJECT_LAYER`, and the delivery commit author may not be a reference
  in any config (`SECRET_REFERENCE_LEAVES_HOST`). *Impact:* a project file written before alpha.48 that used `$DECK:` stops
  loading until it is changed. *Workaround:* move the reference into the installation config, or write the plain value.
- **The secret gate does not scan Git history.** Before dispatch it scans everything the worker receives (checkout, `.git`
  metadata, binds, task inputs, prompt context) and refuses on a hit; past commits in the object store are not scanned.
  Exclusions are configured paths or a declared dependency tree only, audited and shown on the Run card. *Workaround:*
  remove committed secrets from history and rotate them; never put credentials into a request, a prompt or `DECKENT.md`.
- **A declared dependency tree is trusted for content patterns.** A read-only bind the task profile declares
  `dependencyTree` (for example `node_modules`) whose real path lies outside the attempt workspace and the work-target
  checkout is third-party content (without a separate work target the project root is the checkout, so a bind inside it
  keeps the normal rules): credential-shaped text in it (test fixtures, type
  definitions, READMEs) passes as an audited exception instead of refusing, and a native binary above
  `execution.secretGate.maxFileBytes` is read in bounded windows and listed by its SHA-256 digest. In a file whose header
  claims a native format, private keys and provider or cloud tokens refuse. Deny-listed
  files (`.npmrc`, `.env`, keys) and configured secret values still refuse there; archives and any other oversized file
  are still unscannable; oversized binaries are read only in 1 MiB windows, and one whose window carry cannot be bounded
  (more than 1 MiB) or that holds an archive anywhere in its body (an appended zip, an embedded gzip member) is unscannable.
  Archive detection follows each container's most lenient common extractor (a zip end record anywhere in the body, judged without its stated
  offsets, gzip with reserved flag bits, a signed tar checksum), but compressed or encoded data without a container header (raw
  deflate, zlib, brotli, LZMA-alone, lz4, a custom encoding) cannot be told apart from machine code: it passes inside the
  binary's digest exception, and a worker can decompress it at a known offset (for example with Node's own zlib). A native binary at or below `maxFileBytes` is read whole and an archive is recognised only at its start, so an archive embedded later in such a binary passes (closing it would refuse common dependency binaries such as esbuild; during beta this moves to scanning every offset with lockfile-pinned digest exceptions). Pattern results are cached per file content under the product's `state/tree-scan-cache`; a changed lockfile
  or release starts over, and the unsigned cache can change only which exceptions are listed, never a decision.
  The tree is scanned on the host and bound live, read-only: a change made on
  the host after the scan reaches the worker unscanned (as for any bind).
  *Impact:* a real token planted in a dependency package as plain text reaches the worker, visible only as an exception.
  *Workaround:* declare only trees installed from a lockfile you trust, and review the exceptions on the Run card.
- **Concurrent dispatches share one secret scan of an identical dependency tree only inside one process.** The runtime service admits
  `execution.secretGate.maxConcurrentScans` scans at a time, and dispatches whose declared dependency bind has the same source, target,
  lockfile bytes and configuration await the scan already in flight. A separate CLI `execute` process scans on its own, a bind without a
  readable lockfile is never shared, and a dispatch that joins a scan in flight relies on files that scan read before the dispatch arrived
  (the same window as any change after a scan). Bounds now apply to the dispatch's own views and to the shared binds separately. A scan
  that runs out of time under load is retried up to `maxTimeRefusals` times per attempt before the attempt is refused.
  *Workaround:* raise `maxConcurrentScans` or `timeoutMs` for large trees; run the service rather than parallel CLI executions.
- **The secret gate's config rule covers config-like files only.** A password written into ordinary source code is not
  detected. *Workaround:* keep secrets in a secret store, never in source.

- **Authority changes need a person at a terminal.** Changing the permission mode, setting or deleting a secret, switching
  the secret store, or (alpha.55.1) changing a protected setting with `deckent config set|unset`, the terminal's `/config`,
  `init registry --apply` or `coding template --apply` is refused
  with `AUTHORITY_WITNESS_REQUIRED` unless the requesting process has its input and output on an interactive terminal and carries no
  AI-agent marker; the MCP actor is always refused, and nothing is decided, audited or written. *Impact:*
  `echo KEY | deckent secret set NAME`, `deckent config set <protected key>` from a script, a pipe or with `--json`, the SDK called from a
  script and AI tools can no longer make these changes, and there is no approval-request path for them yet. *Workaround:* run
  `deckent secret set NAME --main` (or `--project`; hidden prompt), `deckent secret store`, `deckent config set <key> <value>` or the
  terminal's `/provider`, `/config` and mode switch in your own interactive terminal.
- **A fresh install sets up its own starting authority without a witness; changing it later needs one.** Headless
  `deckent init --yes` (or `init policy --apply`) on a fresh project writes the product-fixed first-run policy and bindings, creates
  the installation and project identities and switches the secret store to the encrypted store, with no person at a terminal. The
  switch is decided by the template's own `first-run-secret-switch` rule, written by the same install a moment earlier: before it
  there is no authority to protect, and the content is fixed by the product, not chosen by the caller. Profile and mode authority
  stay pending until the person's first witnessed terminal open. Afterwards `deckent secret store` (the runtime store switch) is an
  authority change and needs the terminal witness like the changes above. A supplied profile (`deckent init apply --profile`, or
  `init resume`) is published without a witness only while every rule it carries stays inside what the template would give the
  installing person; anything wider (edit or shell tools allowed without asking, grants to the MCP actor or to everyone) is refused
  with `AUTHORITY_WITNESS_REQUIRED` off an interactive terminal, before any evidence step or write. *Impact:* whoever can run a first
  install on a fresh project gets the template's starting authority (never more), and an agent can still run a template-bounded
  supplied install unattended; this gate checks the terminal, not the AI-agent marker, the same as `init policy --upgrade --apply`.
  *Workaround:* run first installs yourself; apply a wider supplied profile in your own interactive terminal.
- **The runtime socket refuses sandboxed processes, not other processes of your account.** The runtime service refuses a
  peer outside its own PID, mount and user namespaces, the full-access bubblewrap view hides the runtime socket directories,
  and the Landlock realm cannot open a unix socket at all. A process your account runs outside a sandbox (a host-realm call
  approved in a full-access turn, an MCP server run on the host, another agent) still reaches the socket and acts as you for
  everything except the authority changes above. *Workaround:* run untrusted servers and agents in a sandbox or under a
  separate account.
- **An AI agent running on your own operating-system account is not contained by Deckent's approvals.** Approval and
  audit records are sealed with a key stored in your account, the interactive-terminal check proves a terminal rather than
  a person, and your account can write the policy file. Where your account can use Docker or sudo, such an agent can in
  practice do anything. *Impact:* approvals and policy hold against Deckent's own sandboxed workers, not against other
  agents you run as yourself. Audit checkpoints (`deckent audit verify`) show a changed policy or producer set and a cut
  or wiped audit trail; undoing both local histories together on your own account is only caught by a checkpoint export
  kept on a separate device. A separate approval channel, a fixed audit floor and the design for remote decisions are worked on during the beta process; hardware-key signed policy and approvals follow after beta. *Workaround:* run other AI agents under a
  separate account without Docker or sudo, and keep Deckent's workers in their sandbox.
- **Opening full-auto or full-access is a person's act at their own terminal.** `deckent init policy --scope <id> --modes <list>|none`
  opens or closes the modes for the installation owner; AI tools, pipes and CI cannot. After an apply the policy has a new `a-…`
  revision, so `deckent doctor` no longer names it `first-run-template-v13` and a later `init policy --upgrade` takes the add-only path.
  The terminal witness is the controlling terminal: a same-UID process can manufacture a pseudo-terminal (the SEC-1 limit; an
  Enterprise composition can pass a stronger witness); an AI agent's shell is refused by the agent marker and the CLI card gate, not by
  the witness alone. Closing a mode keeps the stored full-auto entry in the person's bindings but not in effect: every call re-checks
  the grant.

- **A worker sees the project's instruction snapshot only after a person trusts it.** A Run snapshots one project instruction file
  (`.deckent/worker-instructions.md` by default, or `AGENTS.md`, or none; `execution.workerInstructions.source`) at the Git work target
  root. With a configured work target the file is read from the commit the target's base ref names (alpha.54), not from the folder:
  an uncommitted or modified copy is never used, a file that exists only in the folder reads as absent, and a link, a submodule or a
  non-tree parent is left out as unsafe. Trust binds the folder, the ref and the file's content: the same bytes on another ref or in
  the folder itself need their own trust, and taking trust back on one ref leaves another ref's trust in place. The commit is shown
  (`ref@commit` in `status`, on the card and in the worker prompt) and recorded but not compared, so a branch that moves on with the
  same bytes stays trusted. Trust given on alpha.53 (folder and content) still counts at any ref of that folder with those bytes:
  alpha.54 seals the list of those older records the first time it opens the trust folder. A folder-and-content trust given later
  (for the folder's own file without a configured target, or in the terminal) never opens a ref. Taking trust back at a ref ends that
  ref's trust and its alpha.53 trust, and keeps the folder's own trust. Without a configured target the folder's file is read and trusted by folder and content as before. *Impact:* commit the file before you trust it; a change you have not committed does not
  reach workers. Back on alpha.53, trust given at a ref on alpha.54 is not seen and is asked again. Until `deckent coding instructions trust` is confirmed at the person's own terminal for that exact content, workers get the task
  text only and `run create`, MCP and `--json` carry the warning `WORKER_INSTRUCTIONS_WITHHELD`; `/do` and queue admissions show no such
  warning. Any change to the file makes it untrusted again. A non-Git target has no snapshot (explicit no-op).
- **Hiding instruction files from a worker is not confidentiality.** Codex discovery is `disabled` by strict-config keys that are
  proven at preflight by hidden probes; the keys were verified on Codex 0.163.0 only, so re-probe after a Codex update (an unknown key
  that is silently ignored fails the probe, not the Run). Cursor has no suppression flag, so its checkout is sparse: `AGENTS.md`,
  `CLAUDE.md`, `.agents`, `.claude`, `.codex`, `.cursor`, `DECKENT.md` and the worker file are absent from the worker's clone, with the
  same retained patch as a full checkout. The objects stay in the clone (`git show HEAD:AGENTS.md` works). The hidden-path list can be
  replaced per project only in a template's `invocation.discovery.hiddenPaths`; there is no CLI for it yet. `.claude`, `.codex`,
  `.cursor` and `.deckent` were already excluded from patches. Queue verification keeps the full tree. A change to one of these
  instruction paths by any worker is refused at delivery (`PATCH_INSTRUCTION_SURFACE_WRITE`) unless the task scope names the file, or
  its directory as `dir/**`; the task itself still reads as accepted, and only the delivery or queue ticket is refused.

## Providers and subscriptions

- **Claude subscription:** a Claude Code worker runs with your own Claude login. Since alpha.55 the Brain (the planner behind `/do`)
  can also plan with your own Claude subscription through the isolated `claude-cli-subscription` connection. It signs in to its own
  Deckent-owned login directory (`headless/logins/claude`, never backed up) with `deckent models login --connection
  claude-cli-subscription`, not your `~/.claude`; `--config-dir` names another directory. It runs only where
  Deckent's bubblewrap sandbox works (Linux and WSL), see [core layers](#core-layers). Terminal chat with a Claude subscription is not
  supported for now. *Workaround:* use an Anthropic API key for terminal chat, and for `/do` planning where the sandbox is missing.
- **Terminal chat needs a model connection and, for a paid API, a budget.** Of the subscriptions only Sign in with ChatGPT serves
  terminal chat (below); a paid API turn without a scope budget is refused. *Workaround:* sign in with ChatGPT in `/provider`, or
  connect an API key there, set a budget and choose `/model`.
- **Today the worker takes your login by reading the CLI's own credential file** in your home folder. *Impact:* that file
  must exist and be readable by Deckent. This path may change.
- **A subscription worker holds a short-lived copy of your login token while it runs.** Deckent copies only the current
  access token (for Codex also the ID token) into the worker's container and checks that it has not expired; refresh tokens,
  API keys and the rest of the login file stay on the host. *Impact:* the worker's CLI can act as your subscription account
  until that token expires. *Workaround:* none; the token's own lifetime is the bound.
- **Sign in with ChatGPT serves chat; the Codex worker on the plan is still held.** Alpha.56 opens person sign-in for terminal
  chat and Deckent's own features (`/provider` → ChatGPT, or `deckent models connect --connection chatgpt-login`, from your own
  terminal). The session stays only in your own local encrypted store: Linux or WSL, a folder only you can open (0700) on this
  computer's local disk. A shared team host, a store on a network share or `/mnt/c`, or a folder other users can open is refused
  before the browser opens; `deckent doctor` names the folder and the fix (for example `chmod 700 <folder>`), and Deckent never
  changes permissions itself. macOS and native Windows are not supported yet. One sign-in per project; OpenAI offers no plan-limit
  query, so Deckent shows only its own 30-day usage. Tools connected over MCP cannot use the plan as a raw API.
  The Codex app-server runs inside the isolated worker; the host app-server route was rejected.
  Worker activation stays on HOLD until real-binary N1 proof (`SIWC_APP_SERVER_AUTH_UNAVAILABLE`, reason `activation-hold`);
  missing isolation is a typed refusal, never a host/token-file fallback. While held, no Run is assigned this route and a
  Codex worker keeps its existing connection; a Run frozen on it closes `launch-refused` before any workspace or container.
  OpenAI's documentation marks the Codex app-server command and its WebSocket transport as experimental; Deckent's boundary
  proof for the pinned binary and transport is not vendor production support or a compliance approval of this combination,
  and an unsupported combination stops with a typed refusal before any authenticated work. *Workaround:* use an already
  supported connection; do not treat successful sign-in as proof that a Codex worker is available.

- **ChatGPT sign-in over SSH needs callback forwarding.** The CLI and terminal show the login URL, but the callback
  still returns to loopback on the machine running Deckent; no device-code flow is provided. *Workaround:* forward that
  callback port from your browser's machine, or sign in locally on the Deckent host.

- **No automatic fallback from a subscription to an API model.** Deckent never switches to a paid API by itself when a subscription
  window is used up. Exception: a ChatGPT sign-in where you explicitly enabled continuation and chose an API model at connect may
  continue on that model from your budget at a confirmed plan limit; every switch is shown and recorded, and the permission is
  revocable. Temporary errors never switch billing paths. The Claude subscription never switches. Since alpha.55 a worker Run parked on a subscription quota waits at most 5 hours
  (`runRuntime.quotaRecovery.maxWaitMs`) and then asks you on a card whether to keep waiting or to use the next candidate of its
  WorkClass list; nothing is cancelled on its own and no AI can answer. A Run that was parked before the upgrade keeps the deadline it
  sealed then (the old default was 7 days). *Workaround:* answer with `deckent run resume --quota wait` or
  `deckent run resume --quota next-candidate`, or connect an API model yourself and choose it.
- **A remote model without a verified published price is locked.** Zhipu GLM China stays locked because its prices are in
  CNY. DeepSeek settles at the published peak price, labelled an upper bound. *Workaround:* use a priced model or a local
  one.
- **A model server on another machine needs a registered price.** Plain `http` is accepted only on this machine
  (`127.0.0.1` or `[::1]`). A remote HTTPS OpenAI-compatible server connects when a published price row or a registered
  catalog row with `connect.tariff` covers that model; without usable terms it is refused (`MODEL_CONNECT_PRICE_REQUIRED` or
  `MODEL_CONNECT_TARIFF_UNVERIFIED`), never priced by guess. *Workaround:* register a catalog row with its price, or run the
  model server on this machine.
- **A Codex worker's model is only client-reported, and a Cursor worker's model is checked by name only.** Only Claude Code reports
  per-model usage (`verified`). Codex writes the model it resolved into its own session log inside the container; Deckent reads the
  first turn's model from that log (bounded, no links followed; only the model and the Codex version leave the container) and records
  `client-reported` (Turkish: "istemci beyanı"). The admitted model, by its exact id or a catalog name of it, is accepted by its criteria
  with that label; another name reads `client-reported-mismatch` and the attempt is held for a person; no name stays `unverified` and is
  accepted by its criteria as before. The worker can rewrite that log, so this is never `verified` and never a substitution failure.
  The Codex names were measured from Codex 0.163.0. Cursor reports only the
  model's display-style name at session start: a name the catalog records for the chosen model reads `start-name-matched` and is
  accepted by its criteria; a name the catalog records for another model reads `substituted` and fails; no name or an unknown
  name reads `unverified` and the attempt is held for a human, never accepted silently. A Cursor catalog entry with
  `selection: provider` (`auto`) leaves the model choice to Cursor and reads `provider-chosen`; it never claims a model match.
  *Impact:* a client-reported or matched name is weaker evidence than Claude's per-model usage, and a Codex worker that rewrites its
  own log can hide another model.
- **Cursor renames can hold every Cursor attempt on that model.** The packaged names were measured from Cursor
  2026.10.19-6bbf2c4, and the worker image records the installed Cursor version but does not pin it. If an update renames a
  model, each Cursor attempt on it is held as `unverified` until the catalog names are measured again. *Workaround:* re-measure
  with `cursor-agent -p --output-format stream-json` and register an updated catalog.
- **Codex and Cursor workers report less about their run.** A Codex attempt shows its turns and measured tokens (fresh input, cache
  reads, cache writes, output and reasoning), but no cost because it runs on a subscription. A Cursor attempt
  shows derived turns (the number of assistant messages, not a provider count), tokens, duration and tool calls, but no cost
  because it runs on a subscription. *Impact:* their effort and cost are not comparable with Claude Code's. *Workaround:* judge
  them by the delivered result.
- **Cursor's packaged catalog is a measured seed you register yourself.** `deckent models catalog register --seed
  cursor-cli-subscription`, then activate it, admits `composer-2.5`, `claude-opus-5-thinking-high`,
  `claude-sonnet-5-thinking-high` and `-xhigh`, `gpt-5.6-sol-high` and `-xhigh`, and `auto`. A worker is admitted only on an
  active `native-cli` catalog channel. *Workaround for other models:* write a catalog and register it with
  `deckent models catalog register --file`.
- **Deckent cannot see provider-side settings.** For OpenRouter it cannot see the "Prevent overrides" plugin setting or your
  OpenRouter credit limit. *Workaround:* check both yourself before the first paid call.
- **MCP trust from before alpha.48 is asked again once.** Trust for project and local MCP servers moved out of the project
  folder into the Deckent global root, so a repository can no longer ship it. A server trusted before alpha.48 waits for its
  card (`mcp list` reason `trust-moved`); `deckent mcp approve <name>` on a terminal shows it (`--yes` does not skip it), and
  off a terminal it is refused with `MCP_APPROVAL_NEEDS_TERMINAL`. The old `integrations/mcp-trust.json` in the data folder is
  left in place and never read as trust. *Workaround:* answer the card on first use in the terminal, or run `deckent mcp approve
  <name>` in a terminal; then delete the old file if you like.
- **A project MCP file reads only a few environment variables.** `${VAR}` in a project `.deckent/mcp.json` reads only `HOME`,
  `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TZ` and `TMPDIR`; any other name reads as its written default or empty, and a value
  that carries a credential refuses the server. Known installation secrets are not yet compared (credential patterns only).
  *Workaround:* put a server that needs other variables in your local or user scope (`deckent mcp add`).
- **Project MCP trust needs a global root outside the project.** When `DECKENT_GLOBAL_HOME` (or, without it, `DECKENT_HOME`)
  points inside the project, project and local servers show `trust-store-unavailable` and never start. *Workaround:* point
  `DECKENT_GLOBAL_HOME` outside the project.
- **Trusting an MCP server needs a person at a terminal.** `deckent mcp approve` and `deckent mcp add` to a local or user scope
  show their card only on a real terminal; from a pipe, CI or an AI tool they are refused (`MCP_APPROVAL_NEEDS_TERMINAL`), and
  `--yes` no longer skips the card. *Workaround:* add the server with `--no-approve` from a script; it asks on first use.
- **`deckent mcp import` takes every server of the chosen client.** On a terminal you pick the client; picking single servers is
  not offered yet. Imported servers stay untrusted. *Workaround:* `deckent mcp remove <name>` after the import.
- **MCP servers over OAuth are not supported.** Streamable HTTP servers work without OAuth. *Workaround:* use a local stdio server or an
  HTTP server that does not need OAuth.
- **Provider keys live in a main vault (installation) or a project vault, and a main key is used in a project only after a grant.**
  Non-terminal `deckent secret set` needs `--main` or `--project`; project keys need a `.deck` file (references only); a main key needs
  a grant per project (a card on a solo terminal, or `deckent secret grant NAME --scope S`). *Limits:* rolling back to alpha.50 lifts
  the grant floor (the old binary uses main-vault keys as before and does not see project-vault keys). Native macOS and Windows have
  no terminal witness: no first-use card, and `secret grant` is refused there (a Linux terminal or an admin grants). The first-use key
  card appears only in the streamed terminal on Linux, at the person's own terminal on a solo installation. Agent turns never escape
  this: a full-access agent turn runs only in a real open sandbox (the host realm is refused there) where the vaults are out of reach,
  and an agent's own authority commands ask a person's card in every mode (an interpreter's inline program counts when its text names
  the product; program text built from character codes or encodings is not recognised — the open sandbox and the vault floor remain the
  boundary). The remaining limit is outside agent turns: on the person's
  own account, any same-user process with a terminal (a pty wrapper such as `script` included) passes the same terminal witness as
  `approval decide`. Worktrees of a bare repository each get their own project vault (no main working tree to share). `.deck` is closed to agent tools but does not stop a worker.
- **A customer config key whose name contains secret, token or password and whose value looks like a literal is still refused**, even
  when the value is a secret NAME reference (for example `"secretName": "DB_PASS"`). *Workaround:* rename the key or acknowledge the path.

## Budgets and spend

- **There is no spend ceiling for a whole Run.** Each paid model call is reserved against the scope's USD budget at the
  dearest applicable price, but there is no limit on the total a long-running API worker may spend. *Impact:* a Run on an
  API worker can use up the scope budget. *Workaround:* set a small scope budget and a credit limit at your provider.
- **Subscription and local models are not metered by the USD budget.** A subscription or local model keeps working with no
  budget. *Impact:* their limits are your provider plan's limits, not Deckent's.
- **Per-provider spend limits are not built.** There is one shared USD budget per scope. *Workaround:* set limits in each
  provider account.
- **Settled spend is Deckent's own calculation,** from the usage the provider reports times a verified price (OpenRouter
  calls settle from the cost OpenRouter reports). It is not the provider's invoice.
- **A call that never reported final usage stays held** until you resolve it with `deckent models reconcile-spending`.

## Delivery and adoption

- **A work task needs a valid result report, but a worker CLI without one is not checked.** Since 1.0.0-alpha.47 a work task that
  exits 0 without a valid report fails as `report-missing` or `report-invalid`. Since 1.0.0-alpha.52 this includes Cursor workers, which end with the report JSON as their final answer (`final-text-json`). A CLI whose installed
  version no longer offers its result channel reads `unsupported` and is not gated. Since 1.0.0-alpha.50 a worker
  can mark a report check with `checkId` and `role: acceptance`, and the worker instructions ask it to; an acceptance check whose last
  result is not `passed` refuses the task (`declared-check-not-passed`). A worker that does not type its checks is not caught:
  untyped and exploratory checks remain claims and do not block acceptance. *Workaround:* prefer Claude or Codex workers for tasks
  whose completion must be proven.
- **A coding task is accepted on its exit code.** Its criterion may ask for more (a retained diff, a readback), but the only evaluator
  available to coding tasks is `process-exit`; Core work classes carry an acceptance profile (completion, retained artifact) that
  the planner uses, but no evaluator scores it, so the extra evidence is not checked. Since 1.0.0-alpha.50 the evaluation line
  says so ("accepted · exit code · content not independently verified") in the monitor, `workers`, `/runs`, `run inspect`, `task
  inspect` and `report`; counts such as "1/1 accepted" are not qualified. An acceptance profile with a real verification evaluator
  is beta work.
- **Deckent checks only the environment requirements a task declares** (since 1.0.0-alpha.50). A task profile or template may declare
  `environment.requirements`; Deckent checks them before the worker starts and parks the Run as "environment not ready: <id>" when one
  is unmet (no worker, no model call; fix it, then resume, which checks again). An undeclared missing tool is reported as a check that
  could not run (`acceptance-check-not-run`); that is the worker's claim, not proof of an environment defect. Requirements are frozen
  with the Run, so one added to the registry applies to new Runs after `deckent runtime restart`. Core ships coding probe kinds
  (executable, path-readable, node-heap); connector or credential kinds come from Enterprise/ERP packages through
  `deckent/extensions`, and a kind nobody registered refuses the launch. Each probe starts one short container and proves it removed before
  answering (about 0.85 s on the reference host); when removal cannot be proven the Run parks as uncertain (the attempt code
  `EXECUTION_ENVIRONMENT_UNCERTAIN`, shown in monitor and `run inspect` like any environment park), and the next service start removes
  this installation's leftover probe containers. While a probe's removal is unproven, its Run keeps its pool slot and cannot be closed
  or resumed (`RUN_DECISION_NOT_READY`); cancel and the park deadline do not free it. A probe that can never be proven gone holds the
  slot indefinitely; the service journal names it at every start, and after `docker rm --force <name>` the next service start
  releases the slot once (a progression turn of that Run does so only when one runs; ordinary progression skips Runs parked for the
  environment or cancelled). If a probe is proven removed but the ledger write that releases its slot fails, the start journal says so with the error code (not "not proven removed"); the slot stays held until the next start. The slot is held from before the first probe container starts: cancelling a Run while its probe runs frees
  nothing until the probe ends, and if the service dies mid-probe the slot stays held until the next service start proves the probes removed. `deckent coding template` declares defaults (node, the Node heap ceiling; the typescript path only for a template
  with a `/node_modules` dependency mount); an existing task kind keeps its template (re-running the command for it is refused with
  `CODING_TEMPLATE_KIND_CONFLICT`), so adding a requirement to it today means editing `admission.registry` with `deckent config set`.
  doctor does not list Runs parked for the environment yet; `monitor` and `run inspect` do.
- **A silent worker is stopped and retried once, but only some tasks are watched.** Since 1.0.0-alpha.47 a native-subscription worker
  that sends no event and no model traffic for the silence limit (default 1 hour, `runRuntime.stallRecovery.stopAfterMs`; warning
  after 3 minutes) is stopped. A task whose effects stay in its own workspace is retried once on a new Attempt; any other task waits
  for a human as before. The limit applies only when it stops before the profile deadline: a task whose profile deadline is shorter
  than the limit (with the 1-hour default, any deadline under an hour) is not watched, gets no silence warning and is bounded by its
  deadline only. Runs created before alpha.47 and workers without the native gateway are also bounded by the deadline only. A silent
  worker keeps its execution slot until it is stopped, so a hung worker can hold a slot for up to the limit. The monitor's
  `worker-silent` warning sees worker events, not model traffic, so it can warn while the worker is still working. A single long
  tool call inside the worker (a build, a test run or a lock wait) sends no event and no model traffic while it runs, so it counts as
  silence: a call longer than the limit is stopped, and a repeat fails the task as `worker-stalled`. The stopped Attempt's workspace
  clone stays held. *Workaround:* keep `runRuntime.stallRecovery.stopAfterMs` (or a work class's `inactivity`) above your longest
  tool call; lower it, or raise the profile deadline, when the deadline comes first and you want silent workers stopped earlier.
- **The target queue is in live use but not yet accepted for the beta.** It has run live since 1.0.0-alpha.43 and settled real deliveries. It connects registered Git targets, private
  combined-candidate verification, separate publish/adopt batch cards and a separately confirmed rollback. Runtime protocol
  v29 and the current ledger (v73; the queue arrived with ledger v57–v59) need a rebuilt binary and a verified pre-switch ledger
  backup. Native terminal/socket/crash and N1 load
  acceptance are still separate gates; there is no measured capacity claim. Queue inspection reports last-known state, and
  position counts this authorized scope only. Explicit refresh is currently needed in the delivery window.
- **Queue verification needs an installed profile and normal Run authority.** The original evaluator criteria and the current
  adoption bar are conjunctive. An unsupported profile/changed evaluator refuses; a Run-create approval can leave the ticket
  waiting. After answering that ordinary approval, replay the same enqueue command; no policy is bypassed. Unknown effects
  stay reconciling; elapsed TTL does not prove an old process ended.
- **Queue generation blocks direct legacy writes.** Activation is the first consented queue execution on a target; enqueue,
  preparation, verification, a conflict and a declined or expired card write nothing to it, and a direct write before
  activation only makes a waiting ticket stale (typed refusal). After activation use the queue command family, including
  `integration-queue-rollback` plus `integration-queue-confirm`; a busy target refuses rollback. Existing direct-path limits
  below describe historical/direct integrations, not a weaker way around the queue. No remote-host branch-protection lookup
  is performed: protection uses registered policy and local repository/remote-HEAD metadata.


- **Delivery and adoption are Git only.** A work target is one Git repository (exactly one is supported). *Impact:* work on a
  business system has no delivery surface; its results are not delivered like a patch.
- **A checked-out branch cannot be adopted into.** Adoption only moves a branch no worktree uses, so the branch you are
  working on (often `main`) is refused. *Workaround:* create a separate branch (`git branch deckent/first-job HEAD`),
  list it in `execution.adoption.targets`, and merge it yourself.
- **A stale prepared direct delivery to the same branch is refused** unless the branch is still at the delivery base
  (`ADOPTION_BASE_CHANGED`). Deckent never rebases or merges for you. *Workaround:* deliver again on the current base.
- **A patch made on a stale checkout can fail to apply.** The delivery check stops it before anything is written.
  *Workaround:* re-run the request on the current source.
- **There is no rollback window in the terminal.** Rolling back an adoption is a command-line step; the terminal shows the
  adoption's command id and the `deckent task integration-rollback --adoption-command-id` hint. *Workaround:* run that
  command, or move the branch back with Git yourself, using the commit shown in the `Adopted:` line.
- **The adoption window cannot pre-filter verification Runs by commit.** It lists accepted verification Runs of the configured
  kind; one that verified a different commit is refused at adoption and the window returns to the choice.
- **A verification Run cannot be created from the terminal.** *Workaround:* run the `deckent run create ...
  --delivery-command-id <id>` command the window shows from another shell, then press `r` in the window.
- **By default adoption rests on recorded acceptance, not verification.** The `Adopted:` line says so. *Workaround:* configure
  `execution.adoption.verification` so a verification Run is required.
- **The approval card for creating a Run does not fill every line.** Its Risk and Undo lines say the tool did not classify or
  declare them. *Workaround:* read the plan and its acceptance criterion; approving creating a Run does not accept its result.
- **`deckent do` on the command line does not continue after you approve.** It plans and records the proposal, then you
  repeat the same command with the same `--command-id` after the decision; the id is not printed, so pass your own with
  `--command-id`. In the terminal `/do` continues by itself.
- **Answering a worker's question.** In `/runs` press `a` on the Run: Tab writes the answer and a single `y` sends it. On the
  command line: `deckent run resume --scope <id> --id <run> --command-id <id> --expected-revision <n> --task <id> --answer <text>`.
- **Autonomous delivery is designed but off.** Every delivery and adoption needs your `y` in a verified terminal.
- **A held Run keeps its pool slot until you resume.** When a hold is laid over another park (progression failed, environment not
  ready, quota exhausted and the others), progression stops and the active or unresolved task keeps its pool slot until `deckent run
  resume`; holds that only stop new reservations keep the slots of tasks that are already running, by design. `/runs`, the `/run`
  picker and `deckent run list` show the park reason and, for a hold laid over another park, "also held by an operator". A probe
  stopped by its own deadline gives no answer: the Run is held with `EXECUTION_ENVIRONMENT_TIMED_OUT` (not parked as an installation
  defect, never retried automatically) and `deckent run resume` probes again; until then its slot stays held, and the lists show this
  hold as "progression failed", not by its own code. Image probe failures keep a bounded cause (deadline, exit, signal, parse).
- **The delivery card summary is a projection, not evidence.** Queue, delivery and adoption cards show title, what changed, why it was
  accepted, model verdict, risk and what yes/no does. The worker's own report is shown as a claim; the Git change facts (files, +/−,
  out-of-scope) are filled by the Git workspace adapter. Queue ordering is unchanged (in flight first, parked last).
- **The autonomy shadow is advice only.** Rule `autonomy@1` records `would-deliver` or `would-hold` with reasons per queue ticket at
  awaiting-confirmation (`state/autonomy-shadow`, outside the audit chain). Nothing acts on it; every delivery, adoption and rollback
  still needs your `y`, and it is not shown on the `y/N` prompt. A crash between the ticket transition and the append leaves no
  record for that revision. Comparing it with your decisions is a later owner decision.

## ERP and operations

- **There are no ERP connectors.** The operation contract (intent, conditional write, idempotent resend, evidence-based
  acceptance, compensation) and the extension entry exist; IFS, SAP, Oracle, Microsoft, Uyumsoft or Logo adapters do not.
  The only worked target is a test fixture. Core also ships a generic `http-conditional` REST target (ETag, `If-Match`,
  `Idempotency-Key`; its operations are declared in config); it sends no credentials. *Impact:* you must write your own
  adapter to run ERP effects, including any ERP that requires authentication.
- **There is no `deckent operation list`.** You can look up one operation with `deckent operation inspect --scope <id>
  --command-id <id>`, so you must keep the command ids you used. *Impact:* pending and uncertain effects cannot be listed.
  (`deckent operation` alone lists the configured operation catalog, not the commands that ran.)
- **`deckent operation execute` takes the command as JSON on a terminal too.** There is no guided flow yet (catalog operation →
  target → parameters from a schema → preview → approval → wait on one screen); `--schema` prints the contract and a bad document
  names its field; `--example` writes a starting command for this catalog. *Impact:* a person edits a JSON document.
- **An uncertain ERP write has no exit except a resend.** If the target cannot say whether the write happened, Deckent does not
  retry it by itself and the record keeps the target busy. When the target can confirm afterwards, resend the same command id and
  its evidence settles the record; if it cannot, the record stays unresolved. `EFFECT_OUTCOME_UNKNOWN` names this next step and
  `deckent operation inspect` shows it for an unknown or claimed record. `EFFECT_TARGET_BUSY` says an earlier operation on the same
  record must settle first, but it cannot name that earlier command: you must know its command id. *Impact:* a person cannot close
  an unresolved record yet. Closing
  it with a human declaration (with attached evidence, not counted as acceptance) is planned.
- **The approval card for an operation lists the input fields as sent, not the target's resulting record.** Each top-level
  field is one line (named by the catalog's optional `inputLabels`, credentials redacted, long inputs counted); the input digest
  stays on the first line. *Impact:* you see what is sent, not a computed before/after of the ERP record.
- **Ten of the seventeen reasons an ERP result may be not accepted have no readable text** (six about evidence, four
  about compensation); you see the code.
- **A read operation returns only the record version,** not the business data.
- **Each operation is a hand-written JSON command** with its own command id, idempotency key and expected version, . `deckent operation --example`
  prints a filled catalog and target with every field explained, and `deckent operation execute --example` a command for it.
- **ERP effect results are not yet written to the audit trail as their own events.** Authority and policy changes are audited;
  the generic effect path records its result in the ledger.
- **Enterprise SSO, fleet management and the central policy service are not available.** The policy module's remaining
  parts (founder-admin recovery with a card, two-person handover, role editing, signed packages) are not built.
- **`deckent policy grants --all` shows a start time only for governed standing approvals.** The "since" column comes from the
  sealed audit change that created the rule; a rule written by hand or before the audit existed shows "—", and only the
  first 10 000 policy changes of a scope are searched (the page then says the times are partial). People are shown as
  issuer/subject: Core keeps no display names.

## Recovery and upgrades

- **After the alpha.56.1 upgrade, a personal MCP server whose entry names a main-vault key (`$DECK:NAME`) needs that key granted to each
  project** (KER-17, 2026-10-28): the key is now used under the same project grant as a provider key, so the server does not start in a
  project without it and the turn says which key. *Workaround:* `deckent doctor` lists each such key with its command; run
  `deckent secret grant NAME --scope <id>` once per project at your own terminal (a card; AI sessions cannot answer it).
- **A local model connected before alpha.56.1 has no tool-call declaration, so the terminal offers it no file tools** (AYSE-16,
  2026-10-28): the connect step now asks a keyless local server once whether it accepts a tool call and declares it. *Workaround:*
  reconnect the server once in `deckent` → /provider (the same address); a vLLM started without `--enable-auto-tool-choice
  --tool-call-parser <parser>` stays without tools, and the terminal says so.
- **Without a work kind and worker pool, `/do` and the first task can run in the terminal, not as a background Run** (owner option A,
  2026-10-28): only when nothing is set up, and only after a card you confirm every time (changes go straight to the folder: no
  delivery card, no rollback; Esc cancels). Any other refusal (Brain tier, worker channel, assignment, a held pool, policy) shows its
  own next step and never runs here. *Workaround:* for background workers set up /setup → First work kind → Worker image → Worker pool. `pool hold` and
  `pool set-capacity` say there is no pool yet until then.
- **A step shown as `cancelled` may already have taken effect** (owner 2026-10-21: fix planned in beta). When a turn is cancelled
  (disconnect, explicit cancel, shutdown) after an approved tool call finished, the call is still reported `cancelled`; a write set
  stopped by the cancellation can be partly applied. The result text lists what was written. *Workaround:* before running a cancelled
  step again, check its result text and the files or records it targets; do not assume nothing happened.
- **Backup sets are not fully encrypted.** Only the authority key inside a set is encrypted with your passphrase; the ledger and
  the state archive are plain files. *Workaround:* store sets on encrypted storage and keep the passphrase apart.
- **A restore turns the backup schedule off,** and provider keys and the backup passphrase are not in the set. *Workaround:*
  after a restore, choose `backup.schedule` again and run `deckent secret set` for each key.
- **A restore needs the service stopped,** and the message does not name the command. *Workaround:* `deckent runtime shutdown`
  (on a terminal it asks on a card; elsewhere add `--reason <text>`; the long form with `--service`, `--instance`, `--command-id`
  and `--reason` also works), close open terminals, then run the restore again. On a terminal `deckent backup restore` checks this
  before asking for the passphrase.
- **`deckent backup` lists only the default recovery folder** (`state/backups/recovery`); sets made elsewhere with `--set` are not
  listed. "Last verified" comes only from this installation's sealed backup audit records for the same absolute set path, so a set
  verified under another spelling of its path shows "not on record". *Workaround:* name such a set with `--set`.
- **The relative path of a backup set is refused with a misleading message.** Use an absolute path.
- **You cannot go back to an older Deckent after a ledger upgrade** without restoring the backup taken before the upgrade
  (newer ledger versions cannot be opened by older builds).
- **The daily backup schedule takes no backup right before a ledger upgrade.** `backup.schedule` holds one value (off, daily or
  before-upgrade), so with daily the upgrade starts without a fresh set and the way back is the newest daily set, up to about a
  day old. *Workaround:* before an upgrade run `deckent backup create --scope <id> --set <absolute path>` yourself, or choose
  before-upgrade instead of daily.
- **Downgrading from alpha.56 requires the pre-switch backup.** Alpha.55.1 refuses the v73 installation ledger before
  writing (`ATTEMPT_STORE_VERSION`); it cannot open the upgraded database. An existing Hub v1/v2 store is backed up when it
  is upgraded to v3; a new v3 store has nothing to back up. A policy rollback removes only the content-equal v18 delta, leaving earlier v16/v17 grants and
  customized rows. *Workaround:* restore the matching pre-switch data and policy; switching a binary alone is insufficient.
- **A lost worker can keep its slot until custody is resolved.** Nervous and recovery start `off`; seed rules stay
  provisional until a person promotes a measured rule and grants its recovery action. Alpha.56 supplies
  `deckent policy recovery` and blind case review through `deckent recovery review`; its recovery shadow also consumes
  sealed would-stop records without actually stopping a worker. Shadow decisions can call the configured model and spend
  money; they apply no recovery effect. *Workaround:* inspect the Run's frozen mode and watch with `deckent monitor`;
  release still needs the required fence and termination proof. N1 scenario/owner acceptance remains open.

- **A worker has no network route of its own, and recovery relies on that.** Each worker container runs with no network; its one way
  out is the host gateway, which reaches only the hosts of the worker's model provider. Changes to outside systems (ERP, CRM, an HTTP
  target) are made by governed operations of a person or an approved agent. From alpha.56 each worker's dispatch record declares this,
  the worker starts only when Docker reports that network mode, and automatic recovery continues a lost worker only with that record;
  a lost worker started before alpha.56 has no such record and goes to a person (`isolation-unproven`). This covers the network only:
  a unix socket inside a read-only folder bound into the worker is not checked. *Workaround:* do not bind folders that hold another
  service's socket. Letting workers act on outside systems themselves is not offered yet.
- **Recovery is turned on only through your own exact policy cells.** Template v16 introduced the named person's
  require-approval recovery-action and Nervous-promotion cells; current template v18 retains them, adds v17's first-commit
  grant and v18's uninstall grants. The recovery card refuses `RECOVERY_CELL_NOT_OWN` for role-derived, broad/shared or
  overlapping require-approval cells. Old installations change only through explicit upgrade; use the witnessed
  `deckent init policy --upgrade` path when the managed `deckent policy upgrade` path cannot add authority the caller lacks.
  Current rollback removes only the content-equal v18 delta, not historical v16 recovery grants; customized rows are kept
  and reported. Adding a Nervous/recovery rule or version still needs a template version and policy upgrade: this remains
  an OPEN owner issue, also after v17/v18. Measured-exit rechecks bind the policy revision, not later sealed measurements.
  Lost workers dispatched before alpha.56 have no isolation record; they go to a person and shadow measurement restarts.

- **Full clean-machine acceptance remains open.** The 2026-10-15/16 rehearsal stopped before the model/first-job chain.
  Alpha.56 later exercised packaged setup and chat surfaces with controlled inputs, but that does not prove a cold Docker
  image build, a real first commit and the whole `init` → `/do` → delivery journey without assistance.
  *Workaround:* follow the README first-job path and report what differs.

- **Restart recovery has not had an independent review** with a real container kill and service restart.
- **After an upgrade that sets `service.identity`, a running service needs one manual stop** (Ctrl+C on `deckent runtime serve`,
  or its idle stop) before `runtime restart` works: a service reads its identity only when it starts.
- **The service identity and the clock.** A rare window remains at first publication of the installation identity; a slow
  clock drift inside the tolerance is not detected; one overlay case where a stopped run reports `cancelled` is not reproduced.
- **A /do plan that is still waiting for approval from before this release, and that was waiting only because of a task-level
  approval rule, does not continue after the upgrade:** resubmitting it parks it (`APPROVAL_CONFLICT`). *Workaround:* start a new
  /do; the task approval is then asked once, just before the task runs. Installations without a `task` rule in their policy are not
  affected.
- **Restart fingerprint.** `restart-exempt.json` lists members of restart sections that every request re-reads (`admission.registry`); changing them never reports a stale service. A member is added only after proving no start-time capture.
- **`runtime restart`, the terminal's `/service-restart`, `runtime shutdown` (unless `--force`), the MCP tool `shutdown_runtime_service` and the SDK client's `shutdownService` refuse a service that systemd runs only when systemd confirms it** (Linux): the service process's control group names a candidate `.service` unit, and the restart is refused, naming `systemctl [--user] restart <unit>` (a shutdown names `systemctl [--user] stop <unit>`), only when systemd reports that process as the unit's MainPID (`systemctl show -p MainPID`, 2 s bound; the target service process's environment is never read). A user unit is asked through the caller's `XDG_RUNTIME_DIR`, or `/run/user/<uid>` when a launcher cleared the environment (alpha.56.1). Without a reachable systemd bus, or with no answer, the check is off and the restart proceeds; a unit whose ExecStart wrapper does not `exec` the runtime is not detected. Other service managers and non-Linux hosts are not detected. The MCP and SDK refusals are new in the alpha.58 candidate; those callers have no `--force` override, and on those surfaces an unreadable service descriptor sends nothing. *Workaround:* restart a systemd-run service with `systemctl [--user] restart <unit>`.
- **The local runtime socket's peer liveness witness** observes HUP/ERR/NVAL with one zero-duration `ppoll` that blocks catchable signals for the call: a handled signal such as SIGCHLD no longer reads as a disconnected client. A tool call that finished before a genuine turn cancellation is still reported `cancelled`; its result text carries the applied write set (the owner decision on a completeness flag or a new status is open).
- **MCP and terminal processes started before a switch to a new release keep running the previous build.** A switch replaces the
  installed build, but an MCP server or a `deckent` terminal that a client started earlier keeps the code it loaded until that client
  restarts it. *Workaround:* after a switch, restart the client (the Claude Code session, or close and reopen the terminal);
  `deckent runtime describe` shows which build the service runs.

- **Switching to alpha.55 and back needs care.** The ledger moves from v59 to v70 and alpha.54 cannot open it, so going back means
  restoring the backup taken right before the switch (with the daily schedule no fresh set is taken; run `deckent backup create`
  yourself). Before going back, also unset the settings alpha.54 does not know: `memoryAutomation`, `catalogEvolution`,
  `runRuntime.nervous`, `runRuntime.recovery`, `runRuntime.quotaRecovery.maxRewaits`, `model_roles`, `models.headless` and
  `brain_planner.quotaWait`. At the switch: a Brain whose model is not a frontier row of the model role registry is refused with
  `BRAIN_TIER_REFUSED` (check `deckent models roles`); a `brain_planner.selected` pinned to an older template keeps the Brain choosing
  worker models, so system assignment does not run; a WorkClass overlay written against a Core candidate list of version 1 is refused
  with `WORK_CLASS_OVERRIDE_DENIED` because those lists are version 2 now; the new identities (memory distiller and evaluator, recovery)
  get their rights only after the owner applies policy template v15. Runtime protocol v29 did not change.
- **Switching to alpha.54 and back needs care.** Codex worker profiles pinned before alpha.54 carry the old `none` evidence stamp and
  are refused with `WORKER_MODEL_BINDING_MISMATCH` when a Run is created or its budget is planned: finish the waiting Codex work before
  the switch and declare the Codex profiles again after it. Going back to alpha.53: unset `terminal.responseStyle` and
  `terminal.notify` (alpha.53 refuses a `terminal` section with keys it does not know); Codex profiles declared on alpha.54 carry the
  `client-reported` stamp, which alpha.53 refuses, and alpha.53 cannot read the `client-reported` and `client-reported-mismatch` model
  verdicts. Instruction trust keeps the same key, so it stays valid in both directions, and alpha.53 again reads the file from the
  folder. A `/rename` title is a separate file that alpha.53 ignores. Ledger v59 and runtime protocol v29 did not change.
- **Rolling back from alpha.53 to alpha.52 needs care.** Unset `execution.workerInstructions`; finish or release Cursor attempts (their
  clones are sparse); Codex and Cursor `disabled` kinds are refused by alpha.52; have an empty delivery queue at the switch (tickets
  are titled differently); the alpha.52 audit verify does not see the shadow store (it is outside the chain). If the Cursor catalog was
  registered for alpha.53 profiles, restore the backup. Ledger v59 and runtime protocol v29 did not change.

## Core layers

alpha.55 adds the core layers (memory, system assignment and model roles, the Auditor's sealed decisions, Nervous and recovery, the
headless subscription Brain, agents). They are code, not yet accepted behaviour: each switch starts off and each layer has been tried with tests and
fakes (the subscription Brain also with real isolated calls by the lead), not yet in real N1 use. Detail: [core layers](../.deckent/docs/architecture/modules/core-layers.md).

- **Every core-layer switch starts off, and only a person turns it on.** The switches (`memoryAutomation.extraction|verification|context.mode`,
  `runRuntime.nervous.mode`, `runRuntime.recovery.mode`, `catalogEvolution.mode`) are protected: no AI and no MCP actor may write them,
  and since alpha.55.1 a person writes them only at their own interactive terminal (an AI tool, script, pipe or `--json` is refused).
  The headless Brain has no switch (S3-5 retired its preview key): it works only after the person's own login, connect and consent.
  A `shadow` mode records what it would do and applies nothing; memory-verification and recovery shadow still call their model (data
  goes to that provider and the call is spent). The new identities get their exact rights only from policy template v15, which a fresh
  installation gets directly. *Workaround:* a policy installed from the first-run template upgrades with
  `deckent policy upgrade --template current --scope <id> --preview`, then `--apply`; a hand-written policy upgrades with
  `deckent init policy --scope <id> --upgrade --person <issuer>/<subject> --preview`, then `--apply` (without `--person` it changes
  nothing and names the people of the scope). Turn a layer to shadow first, for example
  `deckent config set memoryAutomation.extraction.mode '"shadow"' --scope <id>`.
- **The numbers are seed values, not measurements.** Nervous/recovery bounds, memory/retention defaults and agent
  statistics thresholds remain provisional until measured on N1. Alpha.56 supplies the recovery promotion/grant cards and
  would-stop shadow input; it does not certify the numeric exits, activate recovery or prove production safety.

- **Memory fills from one work kind only.** The Core registry lets only the `small` WorkClass (provisional 90-day retention, no personal
  data) produce memory candidates; accepted work of other kinds adds nothing until its retention is declared.
- **Automatic memory verification needs a second model maker.** The evaluator's model must come from a different maker than every
  model that did the source work, and must hold the `memory-evaluator` role and be active. With only one maker connected nothing is
  verified automatically and entries stay candidates. When verification is `shadow` or `on`, the candidate text is sent to that
  second provider; only `on` verifies or contests.
  Calls, spend and contests per scope per day are capped. *Workaround:* review and verify entries yourself with `deckent memory review`.
- **Purge does not delete every copy.** `deckent memory purge` removes the entry's text, its search row and its evaluator calls'
  content, and is applied again after a backup restore (reads wait with `MEMORY_PURGE_REPLAY_HELD` until then). It does not delete
  worker output, the copy frozen into a Run's context, existing backups or the second provider's copy; the evaluator call receipt keeps
  a plain digest of its request. The database's write-ahead log is cleared on a best-effort basis.
- **Memory phases 3 and 4 open only after measurement.** Turning context or verification fully on is refused with
  `MEMORY_ROLLOUT_CRITERIA_UNMET` until the sealed records meet the criteria (for example 20 shadow admissions, or evaluator agreement of
  at least 90 % over 20 blind decisions). *Workaround:* `deckent memory rollout` shows each criterion with its numbers and the next command.
- **The subscription Brain needs bubblewrap and shares your quota.** The `claude-cli-subscription` connection runs only inside Deckent's
  bubblewrap sandbox; without it the connection is refused (`HEADLESS_ISOLATION_UNAVAILABLE`), so native Windows and macOS cannot use it.
  It allows one call at a time per connection, and it uses the same subscription quota and login refresh as your own Claude sessions.
  Deckent buys no credit and stops when the CLI reports that credits are required, but if extra usage is enabled on your account the CLI
  may draw on it and Deckent cannot see that. AI or MCP planning and background roles use it only after your `--delegate` consent.
  The sandbox limits file size, open files, core dumps, CPU time (60 s per process), memory (2 GiB per process) and the number of
  processes (64); a CLI stopped by a bound is refused with `HEADLESS_LIMIT_REACHED`, and the turn may already count against your quota.
  These bounds come from measuring `--help` and `auth status`; a full turn's peak has not been measured yet. Connections the gateway
  refused are counted with their host names on the `deckent doctor` Brain-login line. Deckent does not start the CLI while your own
  Claude session is renewing its login (its refresh lock is in the login directory) and runs one spawn per login directory at a time, so
  parallel Brain calls on one login wait and, past the wait, are refused with `HEADLESS_LOGIN_BUSY`; a lock left by a crashed Claude
  session blocks it until you remove that lock, because Deckent never touches the login directory. Whether the CLI's own lock check is
  safe across the sandbox's process namespace is not verified.
  *Workaround:* keep extra usage off in your Claude account if you do not want it used.
- **The Brain's quota wait is short and only on a watching surface.** When the subscription quota is exhausted, `/do` and `deckent do`
  wait at most 15 minutes for the known reset (two attempts, provisional) and then plan once more; a longer reset, an unknown reset or
  MCP `plan_run` gets the typed refusal `HEADLESS_QUOTA_EXHAUSTED` with the reset time at once.
- **Agent promotion is manual until the rules are measured.** A newly defined agent starts as a candidate and always needs the Run
  card; a person promotes it on a card (`deckent agents promote`), or a separately keyed and granted AI does so through a signed MCP
  command (never for a revision that AI wrote, so an installation with one AI principal cannot use this path). The suggestion rules are
  provisional and automatic narrowing runs only for a calibrated rule with `catalogEvolution.mode` `on`, so nothing narrows today.
  Agent statistics count only failures attributable to the worker or the evaluator, are an association and not a cause, and do not
  include tokens for CLI workers (effort is time, API cost and quota parks). A suggestion whose producer key was revoked is refused
  with `CATALOG_SUGGESTION_STALE`, also when the revoke lands after the card was shown; a suggestion written in shadow mode cannot be
  acted on (`CATALOG_SUGGESTION_SHADOW`). *Workaround:* `deckent agents suggestions` lists what the aggregator sealed; decide each on
  its card.
- **Signer keys need the host key store.** AI and system catalog writes need a signer key that a person enrolled; on native Windows
  the host key store is not available and these writes are refused. Revoking a key stops its new and pending actions, but promotions it
  already made stay until a person demotes them (owner's choice). Skills can be imported only with an import key a person added.
  Alpha.56 supplies signed Hub packages; public network use remains bounded below.
- **The Auditor has no live reader or classifier yet.** Policy-turn records are sealed, but the follow-reader has no runtime operation
  (it waits for the next protocol step), and the Auditor's shadow classifier and the K-C sentinels are not built (the owner gave their
  direction on 2026-10-24; design and ordering are pending, with no code yet).

## Hub packages and uninstall

- **Hub networking needs distribution wiring.** Alpha.56 supplies signed packages, local source/trust cards,
  cached offline verification and governed transport ports. Search, remote inspection and publication refuse
  `HUB_CONNECTION_UNAVAILABLE` without the bound first-use, authentication and trust services. No public Hub/source is
  enabled by default; public opening remains a separate owner gate. *Workaround:* grant yourself the Hub cells with
  `deckent init policy --scope <id> --owner-baseline hub-read,hub-trust --apply` (a card), then use verified offline bundles
  and the [signed Hub guide](architecture-overview.md#signed-hub-packages); installing a package grants no tools or policy.
- **Hub online keys need a root-signed delegation.** Bundles and revocation feeds carry `hub-key-delegation:1`, scoped
  to attestation/feed purpose and a validity window (registry defaults: at most 90 days and 5 min clock skew). New content
  needs the trusted clock inside that window; skew does not extend it, and a yanked/revoked key cannot sign new content.
  Stored packages retain their historical validation rules; an expired or untrusted feed withdraws selection.
  *Workaround:* obtain fresh delegated feed evidence from the trusted source; never replace the pinned root to bypass refusal.
- **Skills with support files are refused by owner decision (2026-10-26, H6).** SKILL.md-only skills may be used; a skill
  requiring additional files cannot run. *Impact:* package verification/install does not prove the skill is executable.
  *Workaround:* use a SKILL.md-only alternative; reopening support-file execution needs a new owner decision.
- **Uninstall keeps images and protected data.** `deckent uninstall --dry-run --json` previews any tier; application needs the
  person's real-terminal card. Keep-data removes only caches, stops the service and retires the folder: the service stays down
  until the person opens `deckent` there and chooses Continue. Images remain until a complete usage-reference contract exists;
  the card provides the exact manual step. macOS/Windows service removal is manual.
  *Workaround:* follow the plan's per-item instructions, then the printed program command; see the
  [AI installation guide](ai-install.md#uninstall).
- **Delete everything is complete only for a project-folder installation.** In a project's own `.deckent`, `--all` archives
  (encrypted, verified before the first removal) and deletes the files whose names their Deckent owner writes. It also removes
  `DECKENT.md` and the bridge init wrote: a file init created whole goes whole, otherwise only that exact line goes and every other
  byte stays. This folder's unshared vault slice (its own files) and its records in the instruction-trust store go too. Any
  other file under a Deckent folder, and Git-tracked, linked or changed files, stay and are listed (and keep their folder). An
  installation whose data root is the shared global home keeps the alpha.56 behaviour: only the backed-up authority files go.
  Instruction-trust records tied to a ref that no configured target names stay. This folder's entries in the shared legacy trust
  snapshot are forgotten and a restore does not bring them back: that trust is asked again. The ledger lock file goes only when Git
  does not track it and it is empty. Keep-work keeps earlier ledger backups where they are; it archives and deletes config backups
  and a worker workspace only when the ledger proves it idle: its lease has the workspace owner's form and names this exact attempt,
  whose Run is terminal, and its delivery is not owed or was adopted. Any other workspace (no such Run, another scope, output not yet
  delivered, an unreadable lease) is kept, listed and counted as possibly pending work, so the menu offers keep-work.
  Delete everything treats it as pending work: refused without `--force`; with `--force` it is archived in the encrypted backup,
  then deleted, and the card names how many. Files that worker-image builds
  and toolchain updates write under `workspaces/toolchains` are members; other files there stay and are listed.
  `deckent backup restore --set <path>` brings files and the bridge line back. It never writes over a file that exists again with
  other content, nor through a link: such a file is kept and named.
  *Workaround:* review the listed files; move a kept file aside and run the same restore again.
- **Force and the service have bounded reach.** `--force` cancels runs, rejects approvals and withdraws queued deliveries with
  the person's own authority. Every step's owner decision (runs, approvals, each delivery, the removals and their approval) is
  taken before the card, without writing anything: a removal approval is refused before the card when the person's decide grant
  names approval ids one by one, a four-eyes rule applies, or a policy raises its assurance above what the card attests (the
  peer level). Queue withdrawal preflight uses the queue owner's typed identity in the approved plan and the same policy
  authorization, without opening SQLite or creating its sidecars; after the card the existing queue owner rechecks and cancels
  with CAS and audit. A missing identity or denied authority names the delivery, its scope and next step.
  Unknown results are never closed. `--disable-unit` separately approves a user unit only when the running manager's
  fragment, search path, reload state and disable dry-run links agree with the card, with no Also/Alias or drop-ins and no
  other cgroup process. After governed shutdown, exclusive ledger custody fences new startup through disable and removal.
  A new instance or changed evidence refuses with the exact manual command. The fragment stays; receipts record the actual
  changed links and exact link-restoration commands, without restarting the service. Hand-made launchers are found only in `~/.local/bin` and `~/bin` when they name this folder. Uninstall
  refuses a `require-approval` policy decision (`POLICY_APPROVAL_UNSUPPORTED`): approved removal cannot be modelled yet. An AI
  agent or CI caller (marker variables) is refused through the SDK as through the CLI.
  *Workaround:* stop the unit yourself, or ask the administrator for a direct allow.
- **A partial deletion resumes only after re-verification.** Moved/unsafe authority files stop the data tier before it starts;
  in the alpha.58 candidate an unsafe `policy.json` or `bindings.json` stops every tier as `UNINSTALL_POLICY_UNREADABLE` naming the
  file, with data kept and the file never repaired;
  when Git tracking cannot be read, every project file counts as possibly tracked and stays. A partial final deletion resumes
  only after the remaining bytes, Git tracking, the archive and delete authority are verified again; otherwise files stay and
  managed backup restore remains available. An unknown step stays unknown. The recovery location must be private and lie outside
  every folder the removal changes; otherwise nothing starts.
  *Workaround:* choose the data-keeping uninstall or resolve the stated blocker; never delete by guessed paths.

## Desktop and other surfaces

- **There is no Desktop app, no Dashboard and no remote HTTP API.** Use the terminal, the `deckent` command, MCP or the SDK.
  `deckent monitor` is a read-only live view. Desktop app development starts during the beta, after the core layers are in
  place; it is not shipped today.
- **`deckent runtime` does not show since when the service runs.** The runtime protocol (v29) carries no start time; it waits for
  the next protocol version. The status shows build, configuration, running work and socket only.
- **The monitor shows only the pools you may inspect** (`pool inspect`); other pools appear as one count ("Other work: N
  pool(s) not shown to you"), with no name, capacity or holder. *Impact:* a Run you can see that waits in a pool you cannot inspect
  shows no pool-wait reason. Before first-run template v13 the MCP actor's rules include no `pool inspect`, so `inspect_monitor` over
  MCP shows only that count; v13 (fresh, or after `deckent init policy --upgrade`) gives it `pool inspect` in the installed scope. *Workaround:* ask an administrator for `pool inspect` on that pool; `deckent pool status` uses the same decision.
- **The config window loads choices before its first frame.** With Docker on the path it waits for the local image list (about 0.7 s for
  43 images here, 2.2 s first frame in total); choices are not loaded when a key is opened yet. When the list runs out of time the
  images proven so far are offered and the key says the list is partial ("Showing the N found before the time limit"); a list cut by a size bound
  (`inspection.maxPageSize` images or directory entries, 256 PATH directories) says "Showing the N found before the size limit"; off a
  terminal, `deckent config set <key>` without a value says the same in its refusal and `--json` carries `params.partial` (`time` | `size`)
  and `params.found`; branch and pool lists are still cut at `inspection.maxPageSize` without saying so; a busy
  daemon at the second identity read offers none. *Workaround:* `deckent config set execution.docker.imageId '"sha256:…"'` sets an
  image the list did not reach; `deckent config explain execution` shows the schema.
- **The setup offer is made only for bare `deckent`.** In a folder with no installation, `deckent --full-access` and `deckent terminal`
  keep `TERMINAL_SCOPE_REQUIRED`. *Workaround:* run bare `deckent` or `deckent init`.
- **The monitor names a scope it could not read only to a viewer holding `monitor inspect-scope-diagnostics`.** That viewer (v13:
  the founding administrator, fresh or after `deckent init policy --upgrade`) sees each refused or failed scope by id and reason (in the text and the window the first five, then one "…and K more" line
  pointing to `deckent monitor --verbose`; `--verbose` and `--json` list every one); everyone else, the MCP actor included, sees counts ("access to N scope(s) was refused", "N scope(s) could not be read (<code>)").
  If the permission check itself fails, everyone sees counts and one "scope names could not be checked" line. *Workaround:* the rule
  (`first-run-monitor-scope-diagnostics`) is ordinary policy data; an administrator grants or revokes it through a governed policy
  change. For a failed check, `deckent doctor` and the code.
- **The monitor shows no build time and no release number for a service.** The service reports only its commit and source tree, so
  Installs shows `build <commit> · source tree <hash>`. *Workaround:* `deckent --version` on the machine that runs the service.
- **The interactive `deckent monitor` still uses some CPU while idle, and as much as before while work changes the ledger.** It
  re-reads Runs, workers and permission decisions only after the ledger, policy, bindings or configuration changed (and once
  more in the refresh after a change). Worker files, process state and model availability are still read on every refresh
  (`inspection.workers.heartbeatMs`, default 2 s), and the Config tab only while it is shown. Measured on a test installation
  with 2,000 Runs: about 9–10 % of one core while nothing changes (it was 31–34 %); a live installation was not measured. The
  terminal's `/monitor` window, `--once`, `--json` and MCP read everything on each call. *Workaround:* press `p` to pause it,
  `r` for a full re-read, or use `deckent monitor --once`.
- **`deckent run list`, `report` and the Run pickers show only the Runs the `/runs` query returns** (newest first, at most
  `inspection.workers.maxEntries`) and read each of them once, as `/runs` does; a short id resolves only among those Runs, so an
  older Run needs its full id. Not measured on a large scope. *Workaround:* `deckent run inspect --id <full id>`; `deckent
  inventory` pages every stored record.
- **`deckent doctor` checks Docker the way `deckent init` does** (CLI on PATH, service reachable, your permission) and is read-only:
  it never installs, starts or pulls anything. Not reachable is an error only when the `execution` section is configured, otherwise a
  warning; no answer within the detection deadline reads "not tested". `deckent init`'s own final check does not repeat this probe.
  The interactive doctor offers only fixes that an existing product command applies (today: the worker tool update); making the
  installation folder private waits for its policy action, so that row shows the `chmod 700 <folder>` step to run yourself.
- **Commands that read the installation start in about 0.45–0.6 s** (`doctor`, `config`, `operation`, `approval`, `run`, the terminal)
  on a 16-core host, because Node loads ~1400 modules; `--version` and help start in about 0.12 s. Faster starts for the other
  commands are an open owner decision after beta (bundling or a module-boundary change).
- **`deckent monitor --once` is a summary.** It prints the counts, the tables and why each stopped Run stopped; a worker's full
  detail (task text, report claims, transcript excerpt) is printed with `--once --verbose` (`/monitor --verbose` in the terminal).
  A worker that waits for a person always shows its detail. `--json` is unchanged and carries everything.
- **A Run without a recorded title** (a delivery-queue verify Run records none) is shown as its task and kind, e.g.
  `readme-clone-note (verify task)`; the terminal `/runs` window still says "Untitled run".
- **`deckent terminal status` does not contact the chat model**, so its reachability reads "not tested"; the first answer in
  `deckent` or the `/provider` check shows it. The context window reads "?" until the first answer is measured.
- **The background bell needs focus reports from your terminal.** With `terminal.notify` at `bell` (the default) Deckent asks the
  terminal for focus reports (mode 1004) and rings the bell when work ends or a card waits, only after the window reported that it
  lost focus. A terminal or multiplexer that sends no reports (tmux without `focus-events on`) never rings; whether the bell sounds,
  flashes or does nothing is your terminal's setting. *Workaround:* `terminal.notify` `off` turns it off.
- **Ctrl+G stops the terminal while your editor runs.** The draft goes to a private temporary file (folder 0700, file 0600) and
  `$VISUAL`, else `$EDITOR`, runs on it with no shell. Until the editor exits, Deckent reads no key and draws nothing, so progress,
  answers and cards appear only afterwards. An editor that returns at once (a GUI editor without its wait flag, such as `code`
  without `--wait`) gives the draft back unchanged; with neither variable set, after an editor error or above 1 MiB the draft is
  unchanged. *Workaround:* set `EDITOR` to a terminal editor or a GUI editor with its wait flag.
- **`terminal.responseStyle` is a request to the model, not a rule.** `concise` and `explanatory` add one line to the terminal chat
  model's instructions (`standard` adds nothing); the model may not follow it, and it does not change workers or `/do` plans.
- **`deckent workers watch` has no row selection.** It redraws one window on a terminal (Esc or q closes); details come from
  `deckent workers --verbose`. `--json` returns the whole observation report, history included, whatever `--all` says.
- **The SDK still exports raw writers** next to the managed ones; a later versioned SDK contract is meant to keep only the
  managed ones.

## Concurrency and scale

- **Nothing here is measured at scale.** Local checks do not establish fleet-scale performance. The worker pool has a
  configured slot count (`executionSlots`, `inFlightSlots`).
- **Conflicts between workers are caught at delivery, not prevented while they work.** Two workers, or a worker and a person,
  editing the same files meet at the patch base check. A source lock does not stop an outside person or an ERP writer.
  Inside one Run, tasks whose declared scope paths or business records overlap now run one after another (the card shows the
  order); tasks of different Runs, and a branch Run's tasks before they start, still meet only at delivery. Declared record
  `resources` order work but are not enforced on the worker yet.
- **A delivery whose base advanced is re-attempted once, and only under your delivery intent.** Enqueue with
  `deliveryIntent: "service-reattempt"` and the service re-runs that task once as a new Run on the current base. A chained task
  is re-run after its predecessor is adopted. The re-run task gets the same two delivery cards. Without the intent, or past the
  bound (`targetQueue.reattempts`, default 1), you create the new attempt yourself. The work is re-run, not merged, so it costs a
  second worker run. Tasks with unproven or unresolved effects are never re-run. The `/deliver` window always sends the intent and says so in one
  line, also on the refused-preview screen where `r` prepares on the current base; with `targetQueue.reattempts` 0 it sends none
  and shows no line. If that setting changes between the line and your key, the request follows the setting at that moment.
- **A Run's delivery intent can be given only in the proposal JSON, by you.** `deckent run propose` with `delivery: { target,
  mode: "enqueue-accepted" }` asks your Run card and then lets the service queue each accepted task for your cards, re-queue one
  that stopped before any effect (up to `targetQueue.requeueMax`, default 2) and re-attempt once on a conflict. `/do` has no
  option for it yet; an AI (MCP) proposer can never carry one (MCP `propose_run` does not accept the field), and an AI-proposed plan cannot get one through your approval yet.
  A re-attempt Run's own tickets are not re-queued. The service reads the intent Runs once per queue lease.
- **A worker's resource use is measured in bounded local traces only.** `run inspect` shows a per-Run cost report from bounded traces
  and `deckent agents stats` shows acceptance statistics; neither is a measured quality score.
- **The ledger is one local SQLite file shared by every process.** Writes are serialized; a write that waits longer than
  `storage.sqlite.busyTimeoutMs` (default 5 seconds) is refused with `ATTEMPT_STORE_BUSY` and nothing is written. *Workaround:*
  retry the command; on a slow or heavily loaded host raise the timeout in `.deckent/config.json`. Opens no longer wait for the write
  lock and the running service keeps the ledger's side files in place; this was measured on one loaded core, not at fleet scale.

A founder who explicitly accepts the managed `decision-steps` baseline can make
unwitnessed pipe/SDK decisions for an operator hold, close or answer. These currently
retain the `ai-policy` audit label with the person's principal and rule id; a separate
versioned decision-evidence migration remains required before beta.1. Safety holds,
quota answers and scripted accept/reject keep their existing person/card floors.
Agent shell authority commands keep the person's card in every mode; a same-user
process launched outside Deckent remains part of the operating-system trust boundary.
