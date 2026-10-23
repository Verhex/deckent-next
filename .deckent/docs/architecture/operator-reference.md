# Operator reference

Detailed operator behavior behind the product summary in [README.md](../../../README.md). Türkçe: [operator-reference.tr.md](operator-reference.tr.md).

The sections follow the README's order: build and first setup, models and the first job, delivery, the runtime service and
safety, keys and spending, then everyday terminal and command-line use. [Internal details](#internal-details) at the end
covers custody, worker images, native profiles and patch handling for administrators and contributors. Each topic has
one section; other sections link to it.

## Source build and sandbox posture

- A fresh source build needs Docker to build and stage the locked bubblewrap (currently 0.13.0); it downloads the locked
  source and verifies the source and binary digests. A verified staged bundle can be reused offline. System bubblewrap,
  when selected, must be 0.12.0 or newer. A C build toolchain is required for the native sandbox helper.
- Use a fresh `--out` directory for another `build-bwrap` run. The build ends with `bubblewrap=present` or
  `bubblewrap=staged from …`. On Linux a build that cannot stage the locked bubblewrap stops with `BUBBLEWRAP_BUILD_REQUIRED`
  instead of finishing; start Docker and run both `build-bwrap` commands again with a new `--out` directory, or use
  `DECKENT_BWRAP_BUILD=<verified build-bwrap output> npm run build`. Only off Linux does it print
  `bubblewrap=absent (not Linux)`, which means there is no bubblewrap sandbox; inspect the sandbox posture with `deckent doctor`.
- The very first `doctor`, before any service has run, can report Landlock instead of bubblewrap (`doctor --verbose` names the
  reason): `doctor` only measures, and the runtime service places the bundled bubblewrap under `.deckent/bin` when it measures
  the host. Start the service (`deckent`) and run `doctor` again.
- **Ubuntu 24.04 and later.** The kernel may restrict unprivileged user namespaces, which bubblewrap needs. Check with
  `sysctl kernel.apparmor_restrict_unprivileged_userns`: `1` means restricted; on WSL a missing key (`cannot stat`) means there
  is no restriction. Deckent then reports the restriction, falls back to Landlock visibly, and refuses full-access shell calls
  because they need the open bubblewrap sandbox. An administrator can install bubblewrap root-owned as `/usr/local/bin/bwrap`
  together with an AppArmor profile that allows `userns` for it.
- After `npm link`, work in your own project folder, outside the Deckent source checkout. Long paths and spaces work: the local
  socket uses a short private directory per installation.
- **Platforms.** The local runtime socket and the verified-terminal witness exist only on Linux (WSL included). On macOS the
  runtime service does not run yet, so chat, jobs and backup cannot be used; on any non-Linux system delivery, adoption and
  rollback are refused with `DELIVERY_INTERACTIVE_REQUIRED`, and the first-use key card and `secret grant` are refused too.
  Native Windows is not supported ([known limits](../../../docs/known-limits.md)).

## First-run setup

- `deckent init policy --scope <id> --apply` installs the first-run policy, writes the default terminal scope
  (`terminal.scopeId`) and chat limits, and initializes cancellation settings and an empty, current ledger. On Linux, WSL and
  macOS a fresh installation starts on the encrypted key store. Reuse the same scope id in later commands; for an existing
  installation use its configured scope id.
- **Upgrading an older installation.** An installation set up before the current first-run policy template (template v13,
  since alpha.48) upgrades with `deckent init policy --scope <id> --upgrade --preview`, then `--apply --expect <value>` with the
  exact value the preview printed. The plan only adds rules; conflicting rules you wrote are kept. The value binds the policy
  revision and the runtime service identity, so a change of either in between is refused and asks for a new preview. If the
  apply sets `service.identity`, see [Runtime service](#runtime-service) before restarting.
- `deckent init` is the guided setup: it shows the plan and what is still missing, with the exact command for each step;
  `deckent init --yes --scope <id>` installs a fresh first-run policy, sets the language and runs the final check.
- `deckent init --preview` previews the project instruction file `DECKENT.md` that Deckent's own terminal agent reads, and which
  host-tool bridges it detects. Docker coding workers do not read it; they get the worker file described in
  [Worker instructions and discovery](#worker-instructions-and-discovery).
- `deckent doctor` reports what is ready and exits non-zero if setup cannot start. `deckent init preview --profile <file>`
  previews an installation profile file (advanced).

## Provider connection details

- `/provider` offers Anthropic API, OpenAI API, DeepSeek API, Z.ai GLM, Zhipu GLM China, OpenRouter, a local server such as
  vLLM, Ollama or LM Studio, and an OpenAI-compatible endpoint with published pricing. A key the free check rejects is never
  stored. Where a provider has no free check, the key is kept unverified and the first turn shows any rejection.
- **Connect a model:** providers with a packaged catalog offer those models; for a provider without one, choose an address,
  then select an exact ID from its bounded `/v1/models` list. Deckent stores that ID unchanged. Local loopback models are
  free-measured; a remote model without a verified published price is listed but locked, with the reason and the next step
  (Zhipu GLM China stays locked because its prices are in CNY). OpenRouter offers model connections; paid calls still
  require verified pricing and routing.
- **From the command line:** `deckent models connect --scope <id> --connection <kind> --command-id <id> (--model <id> |
  --reference <ref>)` declares a model from the kind's packaged catalog, writes the scope's invocation profile with the key name
  and activates it. The kinds are `anthropic-api`, `openai-api`, `deepseek-api`, `zai-api`, `zai-cn-api`, `openrouter`,
  `openai-compatible` and `local-openai`. `--command-id` is any unique name you choose; repeating it never connects twice. On a
  person's terminal, `models connect`, `models activate|deactivate` and `models catalog activate|deactivate` without their long
  flags ask for the scope, provider or channel and the exact model id (never an alias), read the binding digest and revisions
  themselves and confirm on a card; the long flag forms are unchanged for AI tools.
- **Secret names** per connection kind: `DECKENT_ANTHROPIC_KEY`, `DECKENT_OPENAI_KEY`, `DECKENT_DEEPSEEK_KEY`,
  `DECKENT_GLM_KEY`, `DECKENT_GLM_CN_KEY` or `DECKENT_OPENROUTER_KEY` (`/provider` stores under the same name). A local server
  uses the optional `DECKENT_LOCAL_ENDPOINT_KEY`; an OpenAI-compatible endpoint uses a name derived from its host,
  `DECKENT_OAICOMPAT_<HOST>`. `--model` takes an exact API model ID; the packaged catalogs are in
  `assets/model-catalog/<connection>.json` in the source checkout, and `/model` lists them in the terminal. Where keys are kept
  and who may use them: [Secret stores and strict install](#secret-stores-and-strict-install).
- **Model choice:** `/model` locks a model with its reason (no budget, not connected, key missing, not activated). **This
  session only** pins it for the session; **This session, and make it my default** also writes `terminal.defaultModel` (user
  layer). The session pin wins, then the default, then a model the project names; the window says which setting chose the
  model in use.
- **Budget window:** 5, 10, 25, 50 or 100 USD, or another whole-dollar amount from 1 to 1000 with the arrow keys, then a confirm
  step; afterwards the first `/provider` row reads **Change budget**. Local loopback models and subscription workers (Claude
  Code, Cursor) run without a budget. `/usage` shows reasoning tokens as *not measured* when the provider did not report them;
  open a budget there to read its spend account (limit, reserved, settled). How money is reserved and settled:
  [Spend settlement](#spend-settlement).
- **Subscriptions today:** a Claude Code worker runs with your own Claude login; a subscription-backed Brain (the planner
  behind `/do`) is being prepared and is not available yet; terminal chat with a Claude subscription is not supported for now,
  so use an Anthropic API key for chat. Sign in with ChatGPT is listed in `/provider` as not available yet.
- **Cursor workers:** register the packaged Cursor subscription catalog with `deckent models catalog register --scope <id>
  --command-id <id> --seed cursor-cli-subscription`, then switch models on with `models catalog activate`. A Cursor attempt
  reports turns, tokens, duration and tool calls and ends with its report JSON; the model it really used is read from its
  session-start name (`start-name-matched`, `provider-chosen` for `auto`, `substituted`, or `unverified`). Cursor cost stays
  unreported (subscription).
- **Model tables:** bare `deckent models` is one table of the scope's worker catalog (model, channel, state, effort; a retired
  model with its day; a switched-on model retiring within `models.retirementWarningDays`, default 15, is warned about);
  `--declared` lists what the connected providers declare for chat (`models --declared --json` is its JSON form);
  `models --json` is the catalog inspection.
- **Prompt cache:** new Anthropic profiles use the 5-minute prompt cache and existing ones change only by your choice; `/usage`
  shows the live account in USD, cache reads and writes, and the estimated net benefit.

## First job setup in detail

- **Before you start:** your installation needs the current first-run policy; an older one upgrades first (see
  [First-run setup](#first-run-setup)).
- **Worker image:** `npm run worker:image -- <new receipt path>` runs in the Deckent source checkout, needs Docker and writes a
  new receipt file at that path. It prints one JSON line with the immutable image id, for example
  `{"imageId":"sha256:f296…5250","tag":"deckent/worker:r4-20260930","imageVersion":"r4-20260930","receipt":"…","activation":"not-activated"}`.
  Nothing is activated; the `execution` setting names the image. Versions and updates:
  [Worker image versions](#worker-image-versions).
- **`execution` values:** the README example uses 2 GiB memory, 512 processes, 1 CPU, a 20-minute deadline and bounded logs
  and output. Saving prints
  `Saved execution in project. Apply: restart. Backup: …/.deckent/config.json.bak.<time>.…` and
  `Restart required: the running service started with the previous configuration. Restart it with `deckent runtime restart` (or /service-restart in the terminal).`
- **Registry and pool:** `deckent init registry` writes the first admission registry and pool settings from the coding CLI it
  detects. Preview detects the CLI's exact version in a temporary, network-free container and shows the proposed versioned
  profile and kind without writing anything; apply repeats the detection and writes through config policy, revision checks and
  audit. An existing registry is never overwritten (typed refusal); add another kind with
  `deckent coding template --provider <id> --kind <kind> --preview|--apply`. `deckent config explain admission` shows the result.
  `--discovery` chooses what the worker CLI may load from the repository (see
  [Worker instructions and discovery](#worker-instructions-and-discovery)). For a pool missing on an existing installation run
  `deckent init pool --scope <id> --preview`, then `--apply`; capacity comes from the admission configuration, and a different
  existing pool is never overwritten.
- **Restart:** `deckent runtime restart` answers `Runtime service restarted (pid …, instance …).` A fresh `init policy --apply`
  already names the service (`service.identity`) and lets only the installing person stop it. On an older installation see
  [Runtime service](#runtime-service).
- **Plan card:** the `/do` card's Risk and Undo lines read "not classified by the tool" and "not declared by the tool"; it expires
  after `approvals.requestTtlMs` (10 minutes). After `y`: `Run <run-id> admitted. Follow /tasks or /monitor.` "Admitted" means
  the Run started; a task's result is accepted later, today on the worker's exit code.
- **Delivery and adoption lines:** `/deliver` is titled "/deliver · tasks awaiting delivery"; it checks the patch against the
  current source and ends with `Delivered: commit <commit> → refs/deckent/deliveries/<digest>`. Adoption asks
  `Adopt commit <commit> into a branch? This moves the branch and needs its own y.` and ends with
  `Adopted: refs/heads/deckent/first-job <from> → <to>`; `main` is not offered while it is checked out here. Your checkout, index
  and working files are unchanged. Details: [Delivery](#delivery).

## Worker instructions and discovery

Two separate things decide what a coding worker knows about your repository.

- **The worker instruction file.** A Run passes one instruction file from the work target, selected by
  `execution.workerInstructions.source`: `worker-md` (`.deckent/worker-instructions.md`, used by default when it exists),
  `agents-md` (`AGENTS.md`) or `none`. Without Git execution this is an explicit no-op. `deckent coding instructions` (or
  `status`) shows the file's path, size, SHA-256 and whether workers get it now. `deckent coding instructions trust|revoke
  [--target <id>] --scope <id>` trusts, or takes back, exactly the file's current content for that folder: a card at your own
  terminal shows the path, size, SHA-256 and first lines; AI tools, MCP, pipes and `--json` are refused; the decision uses the
  config write permission for `execution.workerInstructions` and is recorded in the audit log. A changed file is untrusted
  again. Until it is trusted, workers get the task text only and Run creation warns `WORKER_INSTRUCTIONS_WITHHELD`; a file that
  does not fit the prompt bounds refuses the Run (`WORKER_INSTRUCTIONS_TOO_LARGE`).
- **Discovery: what the worker CLI loads by itself.** `disabled` (the default) hides the repository's own instruction files
  (`AGENTS.md`, `CLAUDE.md`, `.agents`, `.claude`, `.codex`, `.cursor`, `DECKENT.md` and the worker file): Claude runs with
  `--safe-mode`, Codex with strict configuration keys that its preflight proves (verified on Codex 0.163.0 only; re-probe
  after a Codex update), and Cursor, which has no such flag, gets a
  sparse checkout without those paths (the retained patch is the same as from a full checkout). `repository` lets the CLI load
  the repository's instruction files and configuration and can start repository hooks or MCP processes; it grants no extra host
  or network access. Hiding is a context measure, not confidentiality: the objects stay in the clone, and native tools can
  still read files inside the workspace.
- **Instruction paths are protected at delivery.** Delivery refuses a worker change to those instruction paths unless the task
  scope names them (`PATCH_INSTRUCTION_SURFACE_WRITE`).

How a profile carries discovery and hook settings: [Native coding profiles](#native-coding-profiles).

## Delivery

Delivery has three steps, each with its own `y`: the change is written to a dedicated reference (delivery), the reference is
moved into a branch you allowed (adoption), and an adoption can be moved back (rollback). Nothing is automatic: a rule
records whether it *would* deliver a queued item, but it only advises.

### Delivery window in the terminal

- **Opening.** When a task of a Run that this terminal's `/do` started reaches "accepted · patch ready, awaiting delivery", a
  delivery window opens by itself without taking input (Ctrl+O, or "awaiting delivery" in the Active work strip with Ctrl+T and
  Enter, moves input to it). `/deliver` lists every waiting task of the scope and opens the chosen one with focus.
- **What it shows.** First a summary in plain words: title, what changed, why it was accepted (the worker's own report is
  marked as a claim), risk and what yes or no will do. Then the task's Run/Task ids, the integration check against the current
  source (affected files match the base), the changed files with `patch-preview --stat` counts, that only a dedicated
  `refs/deckent/deliveries/` reference is written (branches, index and working tree stay unchanged) and, only when
  `execution.adoption.targets` is configured, the target branches as a later, separate choice.
- **Viewing a diff.** ↑↓/j/k choose a file, Enter opens its hunks with the attempt, base and proposal the preview was built
  from, Esc returns to the list. Diff bodies are bounded by `deliver-port.json` (`maxDiffFiles`, `maxDiffLinesPerFile`,
  `maxDiffBytesPerFile`); a binary or over-large file shows "Cannot show: binary or too large", and cut lines are counted.
  Every row passes the same redaction and terminal-text cleaning as the rest of the window. Viewing never prepares, delivers or
  adopts: inside a diff `y`, `n` and Enter do nothing.
- **Delivering.** `y` checks, prepares and delivers in one flow through the same applications as
  `task integration-check|prepare|deliver` and the confirmation below: the window's `y` answers the confirmation only when its
  card shows exactly the operation, ids, command, file set and base the window showed; otherwise the exact card is shown and
  needs a fresh `y`. A `y` typed in the input never confirms.
- **Adopting.** After delivery a configured branch is adopted only with a second `y` (↑↓ chooses the branch); `n`/Esc does
  nothing. With `execution.adoption.verification` configured, that `y` first opens a verification step: the scope's accepted
  Runs of the configured kind (one task), plus "adopt without verification" only when verification is not required; ↑↓
  chooses, a single typed `y` adopts with the choice, `r` reads the list again, `n`/Esc go back. With none it says so and names
  `deckent run create … --delivery-command-id <this delivery>`. The adoption still checks that the Run verified exactly this
  commit with the current profile and the installation's criteria; a refusal returns to the choice with its reason.
- **Results and refusals.** The delivered and adopted lines and the transcript summary show the delivery and adoption command
  ids (for `task integration-rollback --adoption-command-id`). A stale base, a missing grant (`scope inspect` for the attempt
  lookup plus the integration actions) or a session that is not a verified terminal is refused in plain words with the next
  step.

### Delivery confirmation

- `task integration-deliver`, `task integration-adopt` and `task integration-rollback` each require one explicit `y` in a
  verified human terminal. A rollback moves the adopted branch back, so it asks like an adoption; its card shows the branch and
  current → previous commit.
- The card shows the task title, Run/Task ids, reference or branch, from/to commits and changed files. An empty answer, `n`,
  end of input, redirected input or output and a new effect from the SDK or MCP refuse. Prepare and check only build a
  candidate.
- A completed command replayed, or a crash that is proven settled, does not ask again; an unfinished effect needs a fresh
  confirmation.
- Adoption also requires `execution.adoption.targets`, policy, the task's acceptance and any configured verification; on the
  command line pass `--verification-run <run>`.
- Delivery commits carry the task title, ids and a bounded acceptance state. Author and committer time come from the trusted
  delivery planning clock and are fixed in the delivery intent so a replay writes the same commit. Deckent is the default
  identity; `execution.git.deliveryIdentity` can set `authorName`/`authorEmail`. Preview Git objects are prepared only in the
  candidate before the answer; a refusal writes no Git object, ref, branch or delivery intent in your repository.
- The verified-terminal witness exists only on Linux (WSL included); elsewhere these commands are refused with
  `DELIVERY_INTERACTIVE_REQUIRED`.

### Delivery queue: inspect and undo

A registered integration target uses the service queue. It has delivered real changes in Deckent's own development since
alpha.43; that is not yet evidence for packaged, hosted or other-platform use, which the beta has to show. `/deliver` prepares
on the current base; after a base or target refusal, `r` offers re-preparation. Inspect last-known state with `r`; publish and
adopt each show their exact frozen batch and ask a separate `y/N`. `/runs` details show the authorized scope's position,
responsibility and outcome. Main, default, protected, checked-out and foreign targets stay refused even when allow-listed.
Conflicting paths require a new attempt; no user branch is rebased or merged.

```sh
deckent task integration-queue-list --scope my-project --json
deckent task integration-queue-inspect --scope my-project --command-id <ticket> --json
deckent task integration-queue-confirm --scope my-project --command-id <ticket>
deckent task integration-queue-rollback --scope my-project --source-command-id <ticket> --command-id undo-1
deckent task integration-queue-confirm --scope my-project --command-id undo-1
```

The rollback card covers one settled item. A failure stops the rest of the batch and keeps the adopted part; an unknown
effect holds that target until it is reconciled. Older direct integration commands keep their historical receipts but cannot
write through an activated queue. Queue bounds and ticket lifetime come from `targetQueue`; a verification profile and policy
are required. The queue list, inspect, enqueue and rollback views and the `/deliver` window show the delivery summary above the
unchanged consent card. An advisory rule (`autonomy@1`) records `would-deliver` or `would-hold` per ticket and never acts
([known limits](../../../docs/known-limits.md)).

```text
Source <source> · affected files match base · proposal <proposal>
Candidate prepared: <path>
Delivered commit <commit> at <ref>. Source HEAD, index and working files are unchanged.
Adopted: <ref> moved from <from> to <to> (sequence 1). Basis: recorded Task acceptance, not verification; checkout, index and working files are unchanged.
Rolled back: <ref> moved from <to> to <from> (sequence 2). Checkout, index and working files are unchanged.
```

## Runtime service

- **Start.** `deckent` starts it in the background when none is running and reuses a running one. Its output goes to
  `.deckent/state/runtime-service.log` (under your data root if you moved it). `deckent runtime serve` runs it in the foreground
  instead; Ctrl+C stops it.
- **Idle stop.** A service the terminal started stops itself after 15 minutes without work (`service.idleShutdown.afterMs`); the
  next `deckent` starts it again. A service you started with `runtime serve` never stops by itself. `deckent-mcp` does not start
  the service.
- **Restart and stop.** `deckent runtime restart` (or `/service-restart` in the terminal) stops the service through the governed
  stop and starts the current build and configuration; `deckent runtime shutdown` only stops it (without service identities it
  needs `--reason`). `deckent runtime describe` shows the running one. Restart and shutdown both need the service's identity
  (`deckent config explain service.identity`) and your `shutdown` rule on it, which the first-run policy gives the installing
  person only; by default the local MCP actor cannot stop the service (a policy that grants it the `service` MCP group can).
- **Older installations.** A first-run policy older than template v12 has neither the service identity nor the `shutdown` rule,
  so `runtime restart` and `runtime shutdown` are refused. Upgrade it (see [First-run setup](#first-run-setup)); if the apply
  sets `service.identity`, stop a service that is already running once by hand (Ctrl+C on `runtime serve`) before
  `runtime restart` works.

## Sandbox views

- In standard, careful and full auto, sandboxed shell commands get a **closed view**: the project is writable within the call's
  approval rules, `.git` is read-only, HOME is hidden and network access is off. Approved commands still cannot write Deckent
  authority files. Landlock also refuses permission and ownership changes, and cannot add or remove entries in directories
  holding protected paths.
- Full access requires a usable **open bubblewrap sandbox**: network and HOME are available, while Deckent state, configuration,
  credential patterns and host Docker/session D-Bus sockets remain masked or read-only. Without an open sandbox, full-access
  shell calls are refused, including an explicit `host` realm.
- **Host fallback.** If no sandbox is available, a closed mode falls back to the host and says so (`terminal.shell.realm`,
  default `prefer-sandbox`); that fallback has no filesystem boundary, so set `require-sandbox` when confinement is required.
- **MCP servers** run by default in a sandbox with network access and their own persistent home folder (`sandbox-net`); a
  server whose entry names `host` runs without a sandbox, and `/mcp` shows where each one runs.
- The shared credential registry covers gh, Docker, kube, Codex, Git credentials and common cloud CLIs. HOME masking is bounded
  (depth 3, 20,000 entries); custom locations, arbitrary filenames and aliases outside those masks need separate isolation.
- Full auto still asks before `find -delete`, file truncation (`>`, `>|`) and moves (`mv`); appends (`>>`) remain modifications.
- The hard floor (Deckent configuration, policy, approvals, audit, secrets and the MCP registry) is enforced in every sandbox
  mode.

## Permission modes

Full auto and full access stay closed until the installation owner opens them for a scope with `deckent init policy --scope
<id> --modes <list>|none --preview|--apply` (`<list>`: `full-auto`, `full-access` or both, comma-separated; `none` closes them;
`--expect <rev>` guards against a concurrent change). The apply asks a y/N card at the owner's own terminal on the previewed
revision and is audited; AI tools, pipes and CI cannot run it. A fresh first-run policy opens no mode. After `--modes none` the
very next call no longer has the mode; the stored choice stays, and the terminal says it is not granted. Contract:
[owner-opened modes](modules/permission-modes.md#pre-9-solo-mod-izni-alpha51).

## Secret stores and strict install

| Store (`secrets.store`) | On disk | Who can read the key |
|---|---|---|
| `core.secret-store.env@1` (when no store is selected) | nothing; read from the environment | every program that inherits that environment |
| `core.secret-store.file@1` | plain text, a 0600 file | Deckent and other programs running as your user |
| `core.secret-store.encrypted-file@1` (recommended; fresh installs start here) | encrypted (AES-256-GCM); the unlock key sits in the same folder, no passphrase | Deckent; other programs running as your user can still open it |

Provider calls resolve keys inside the runtime; keys are not placed in prompts or the shell environment, and workers never
receive a key. Supported sandbox views hide the store; a host realm or fallback has no filesystem confinement. A provider
answer that echoes a stored key is refused. `deckent doctor` names the active store, reports `unverified` when a store listing
fails and names keys a model here cannot use, with the exact next command; `deckent doctor --verbose` also says who can read
the store. When a provider refuses a key (401/403) or a limit is reached, the terminal says so in plain words.

**Strict install**, for keys no other program on the machine should read. Fresh Linux/WSL/macOS installations select the
encrypted store through `init policy --apply` and Docker `init apply` when the installed policy permits the switch; existing
installations keep their selection.

1. Move your keys into the encrypted store: `deckent secret store` lists the registered stores to pick from; leaving env lists
   config reference names missing in the target and asks yes/no (scripts require `--confirm-env-missing`); `doctor` shows the
   same names. It copies every key, checks it, selects the new store and then removes the old copy; a move to a weaker store
   asks for approval on a second warning card. Set, delete and switch share one installation-wide custody section.
2. Keep other AI tools out of Deckent's state folder, e.g. `Read` deny rules for the store files in Claude Code's
   `~/.claude/settings.json`. This stops their file tools and common shell commands, not every script.
3. Planned: run the Deckent service under its own OS user (or the macOS Keychain) so no program of your account can read the
   keys.

The file stores are not available on native Windows.

### Project key vault

- **Two kinds of vault.** The main vault is the installation's store above. A project vault is an encrypted store that belongs
  to one project folder.
- **Storing a key.** `deckent secret set NAME --main|--project` takes the value only at the hidden prompt of a person's own
  terminal. From a pipe, script, agent or CI it is refused before stdin is read (`SECRET_SET_TERMINAL_REQUIRED`). A terminal
  without `--main`/`--project` asks on a card which vault; `--json` without it is `SECRET_VAULT_REQUIRED`.
- **The `.deck` file.** A project uses its own key only when its `.deck` file declares `NAME=project`, and a main-vault key only
  after a grant. `.deck` holds references, never values, so it can be committed: the first entry is `DECK_FORMAT=1`, then one
  `NAME=main` or `NAME=project` per line (`#` comments and empty lines are allowed; at most 64 KiB and 256 entries); any other
  line refuses the whole file (`DECK_FILE_INVALID`, naming only the line number).
- **Grants.** A grant is a card at the person's own terminal: the first-use card in the solo terminal chat, or
  `deckent secret grant NAME --scope S`; `secret revoke NAME --scope S` takes it back, and AI sessions cannot grant. Both need
  the Linux terminal witness.
- **Moving and listing.** `secret handover --scope S` takes the key vault along when a project folder moves (refused while the
  original folder still holds it). `secret list` shows name · vault · project · used by · `.deck` · grant · stored, never a
  value; `--all` lists every project vault of this main vault.

Contract: [project key vault](modules/permission-modes.md#pre-8-project-key-vault-alpha51).

## Spend settlement

Each scope has one shared budget in USD for every API provider. Before a paid call, Deckent reserves the most it could cost at
the dearest price tier that can apply; afterwards it settles the call from the usage the provider itself reported in its final
answer, multiplied by the verified published price (`measured-tariff`). OpenRouter calls are the exception: they settle from
the cost OpenRouter reports in its answer. Where a provider does not say which price tier it used (DeepSeek), the call settles
at the published peak price and is labelled an upper bound. Before the first paid OpenRouter call, check
https://openrouter.ai/settings/plugins that no plugin is enabled with "Prevent overrides", and set an OpenRouter credit limit no
higher than your Deckent budget; Deckent cannot see either setting.

- The scope's first budget is created with `deckent models create-budget --scope <id> --usd <n>` or the budget window (the
  first row of `/provider`), and changed with `deckent models revise-budget --scope <id> --usd <n>`.
- A call that never received its final usage stays reserved until you resolve it with `deckent models reconcile-spending`.
- If a charge exceeds what was reserved, the scope stops new paid calls until `revise-budget … --unfreeze`.
- `deckent models spending` without `--input` shows the scope's API budget (limit, used, held, left).

## Terminal window and keys

- **Layout.** The interactive terminal is a full window (the terminal's alternate screen, like the Claude Code fullscreen
  renderer): the conversation scrolls in the top area, the input bar stays on the same bottom row for the whole session (only
  a resize or your own multi-line draft moves it), and under it a fixed information area shows the state, model and mode, the
  Active work summary (or the full-access line) and key hints. The information row also shows the conversation's context use
  (the `/context` measurement, "context ?" before the first one). `terminal.layout: inline` keeps the previous inline layout
  (native scrollback while running; recommended with screen readers).
- **Scrolling and search.** The conversation follows the newest line; the mouse wheel scrolls it three lines a notch,
  PgUp/PgDn by half a view, Ctrl+Home goes to its first line and Ctrl+End back to the newest one. While you read back, a row
  says how many new messages (or lines) arrived and End/Home jump to the newest/first line (streaming never pulls the view down;
  at the bottom it follows again). While scrolled back, Ctrl+F searches the conversation this view keeps (the shown, masked
  text only; Enter/↑ older, ↓ newer, Esc closes; the draft is untouched), and Ctrl+Up/Ctrl+Down jump to your previous/next
  message (Ctrl+R stays input-history search). `terminal.viewportRows` (default 2000) bounds how far the view scrolls back.
- **Exit and selection.** On exit the conversation is written to the normal screen, so it stays in your terminal's scrollback;
  `/clear` empties the view and that scrollback. The full window reports the mouse wheel only while it is shown (clicks are
  ignored and never answer a card); select text with your terminal's modifier as in Claude Code — Shift in most terminals,
  Option in iTerm2, Fn in Terminal.app.
- **Slash-command windows and focus.** Slash-command windows and cards open right above the input bar, take at most half the
  screen and scroll inside (arrows, PageUp/PageDown and Home/End, with a visible row range); they shrink the conversation area
  and never move the bar. A window opened by your command or selection takes focus immediately; Escape closes it back to input.
  Automatic /do planning and progress windows and Run/worker watches leave input focused: type a draft or press Enter to queue
  it behind the current operation. Ctrl+O switches between input and the top window. `/watch-stop` closes observation.
- **Approval cards.** An approval card (and any question) takes the keyboard by itself and replaces the input bar in place, so
  no Ctrl+O is needed. Its answers are a list — "Yes, once (y)", "Yes, for this session (s)" and "Always allow in this project
  (a)" only where the service offers them (never for hard-floor items or always-ask locks), "No (n)" — moved with ↑↓, j/k or
  1–9 and confirmed with Enter, or answered with the letter; the highlight starts on No, and Esc denies. "Always" is your own
  standing grant (`deckent policy grants --mine`, removed with `deckent policy revoke`). Several pending decisions wait one at
  a time ("1/3").
- **Key safety on cards.** A card counts keys only after a short quiet period (0.3 s, `decision.json`) from the moment it is
  shown; until then its hint row says "Just opened · its keys work in a moment" ("Key not counted … press it again" for a key
  that came too early). Keys typed for the input just before, a held key, a paste, a key from a just-answered card or a focus
  switch never answer it, and one stdin read with several key events never decides. The draft stays and returns with the bar.
- **Drafts.** Multi-line input follows its caret within a height budget. Ctrl+S puts the whole draft aside (memory only, never
  saved or logged) and, on an empty line, brings it back (a kept draft is never overwritten); Ctrl+_ undoes the last unsent
  edit (a typing run is one step, cleared on send). Escape from input keeps its draft/cancel behavior.
- **Active work.** Under input, the "Active work" row names this session's running /do (planning, or waiting for you with the
  approval time left) and the Runs it started, with title, state, elapsed time and "+N more"; it never takes input by itself.
  Ctrl+T opens the full list above input (↑↓, Esc back): Enter on /do focuses its window, Enter on a Run opens that Run's
  window; a finished Run leaves the strip once opened.
- **Mode colours.** Standard is muted, full auto has its own colour, full access the warning tone with a calm `⏵⏵⏵` mark
  (with NO_COLOR the words carry the mode). Pipe and line-mode output is unchanged.

## Runs, tasks and approvals

### Run controls in the terminal

`/runs` lists the scope's Runs with a selection. `h` holds a Run that is not finished, cancelling or already held, `r` resumes a
Run parked by an operator hold or a failed progression (a question, a decision or a quota wait survives resume, so `r` is not
offered there) and `c` closes a parked Run; the hint row names only the keys the selected Run's state offers. Each key re-reads
the Run and opens a y/N card with what the control does, the state and the revision it will send; only a single typed `y` sends
it (Ctrl/Alt chords, pasted or coalesced keys never do; `n`, Enter, Esc and Ctrl+C keep the Run). Hold takes your reason (Tab)
or a default sentence as its note. The control is the CLI's own `run hold|resume|close` command against the shown revision;
policy (`run cancel` for hold and close, `run reserve` for resume) and the Run's state decide, and a refusal is shown as the
typed reason above the list. The result line names the Run's new state and the command id. Hold stops new reservations; work
already running continues. Answering a task's question and accepting or rejecting a task are separate decisions, not keys here.

### Task and Run commands

- **Language and short ids.** Every `task` and `run` view uses the call's language (`--lang`, then `DECKENT_LANGUAGE`, then
  config `language`, then the system locale). `--run` (and every `run` action that names an existing Run) takes a short id: an
  exact id or a unique prefix of a Run that `/runs` lists; several candidates are `CLI_ID_AMBIGUOUS` (exit 2); anything else is
  passed on unchanged. `run create --id` never resolves; it names the new Run.
- **Scope.** A read without `--scope` uses the configured `terminal.scopeId` and says so on its first line; without one, off a
  terminal, it is `CLI_SCOPE_REQUIRED` with the valid scopes.
- **`deckent run list`** reads the same Runs as `/runs`, each through the same inspect application: waiting (parked) Runs first,
  then newest, with a short id, the `/runs` state words, accepted tasks and the title; `--json` returns the Run views.
- **`run inspect`** reads request, result and tasks (each with what an accepted result rests on, e.g. "accepted on: exit code ·
  content not independently verified", then delivery); the authority record, cost summary, acceptance metadata, profile and
  criteria lines, full ids and a secret-gate list longer than five paths are `--verbose`. `task inspect` reads in the same order;
  a longer secret-gate list is one line naming the deny-list exceptions.
- **On a person's terminal** `run inspect` and `report` without an id pick the Run; `run cancel|hold|resume|close` without
  `--command-id`/`--expected-revision` pick the scope (a change never takes the default silently) and the Run (only Runs whose
  state offers the control), read the revision just before a card that names scope, Run, state and consequence, and send with a
  system command id; `n`, Esc or silence send nothing, and a Run that changed meanwhile is read and asked again. `task
  inspect|transcript|patch-preview` without `--run`/`--task` pick scope, Run and task.
- **Bare `deckent task`** opens a menu of only the task's valid actions: inspect, transcript and diff once an attempt exists,
  accept/reject while a decision is open, delivery for an accepted patch awaiting delivery. Accept and reject read the revision
  just before their card and generate the command id; a Run that changed meanwhile is refused (`RUN_STORE_CONFLICT`), read again
  and asked again. Delivery uses the same applications as `/deliver`; every write (candidate and delivery, adoption, queue batch)
  waits for its own exact card, and Enter alone, Esc or silence (the session approval time) answer no.
- **Pipes, AI agents, CI and `--json`** are never asked: every typed flag stays mandatory, and bare `deckent task` names the
  missing argument and lists the actions in four groups (Inspect, Execute and evaluate, Deliver, Queue), exit 2.
- **`patch-preview`** keeps its format; a diff line whose control characters were neutralised is followed by a
  `\ control characters in the line above were neutralised` line (`--stat` and `--json` unchanged).
- **`deckent report`** shows Known (result, what acceptance rests on, duration, CPU, memory, model, in readable units) and Not
  measurable (each axis with its reason, e.g. a subscription call has no per-call charge); without `--run` it lists the scope's
  recent Runs.
- **`deckent inventory`** is the developer view of this installation's dispatch journal (short ids, `--verbose` full ids);
  `workers list` also reads the configured `inspection.workers.sources`, so it can show more records. A page above
  `inspection.maxPageSize` is `DISPATCH_INVENTORY_LIMIT` naming the maximum.

### Approvals and decisions from the CLI

- **Listing.** `deckent approval list` (and bare `deckent approval`) reads the default scope, named on the first line
  (`--scope` overrides): waiting approvals first with the time left ("8 min left"), then the rest newest first, at most the
  `approval.json` page and row limits, with "more"/"not scanned" lines instead of a silent cut; `--json` is the raw page.
- **Answering.** On a person's terminal a waiting approval can be picked and answered on the terminal's card: once or no. A
  stored approval has no running turn, so no "this session" or "always" is offered for it; a hard-floor request says it can
  only be allowed once. Revision and command id come from the system, the channel is `local-cli`, and the reason is your
  `--reason` or the default "Approved on the terminal". A cancelled or silent card decides nothing; the decision goes through
  the same runtime check (attested terminal, minimum assurance) as every approval. `approval decide` without `--input` is that
  same pick on a terminal and names the missing `--input` everywhere else.
- **For AI tools** the JSON path (`--input`) is unchanged. Its input is checked against the application's schema first, so a
  wrong field is named (`CLI_INPUT_FIELD_INVALID`, exit 2, with an example); a decision without a reason is refused before
  anything is sent; results are readable text, raw JSON only with `--json`; `--schema` prints the input contract.
- **Decisions.** `deckent decide` without an action lists the scope's recent decisions; it needs the decision port's `inspect`
  grant, which the first-run policy template has from v13 (an older installation gets it with the upgrade). On a terminal one
  decision opens in a window with its options, advice, choice and outcome. `decide <action> --schema` and field-named input
  errors work as for `approval`. MCP has no decide tool yet.

## Administration commands

- **Bare reads.** Without an action `deckent pool`, `audit`, `secret`, `runtime`, `backup` and `toolchains` read: the pool's
  state and capacity, the audit result with the last checkpoint, the keys (name · used by · store, never a value), the service
  status (build, configuration, running work, socket; no start time until the next protocol version), the recovery sets
  (`state/backups/recovery`: date · size · kind · last verified · name) and the toolchain table (network use stated first).
  `deckent paths` groups the layout with exists/missing and names the socket really used (`/tmp/dk-<uid>-<sha256>/s`). Output is
  text in a pipe; JSON only with `--json`, in the same contracts.
- **Changes.** `deckent pool hold|resume` pauses or resumes a pool. A change never takes a silent scope: off a terminal
  `pool hold|resume|set-capacity|quota-release`, `secret set|delete|store --to` and `backup create|restore` need `--scope`. On a
  person's terminal the scope, the set, the key or the store are picked and the change is confirmed on a card first (an AI, CI or
  pipe is never asked): a restore shows target, service state and where replaced files are kept, `toolchains update` shows the
  plan before it builds, and `audit rebaseline` confirms on a card. Key rules: [Project key vault](#project-key-vault).

## MCP and identity

- **MCP servers for Deckent's agent.** `deckent mcp` / `mcp list` is a table (waiting servers first with their next step) and
  starts nothing; `--check` starts trusted servers only. Every trust decision (`mcp approve`, `mcp add` to a local or user scope)
  is a card on a person's terminal; off a terminal it is refused (`MCP_APPROVAL_NEEDS_TERMINAL`), and `--yes` does not skip the
  card. Where servers run: [Sandbox views](#sandbox-views).
- **Permission groups for outside AI clients.** In `/policy` (**MCP permissions**) pool control, catalog registration and global
  model configuration are marked **all scopes**. Revoking a group preserves other grants, which may still allow a tool.
  "Dogfood worker" is a proposed preset with only work permissions; which tools it really needs is not verified yet. Revoke
  uses the same two steps as grant (`deckent policy mcp revoke … --preview`, then `--apply --expect <digest>`).
- **Identity.** Bare `deckent identity` states the selected identity profile — or how to select one with
  `deckent config set identity.profile` —, the people and the role bindings; `identity profiles` lists the profiles;
  `identity preview` without a selected profile reports `IDENTITY_PROFILE_NOT_SELECTED`; `identity distribute --scope <id>
  [--apply]` on a terminal is chosen with arrow-key cards and a preview card.

## Installation recovery sets

`deckent backup create|verify|restore` uses one governed contract. The installation owner needs the installation-wide
`backup` policy grant; an older installation gets it with the policy upgrade ([First-run setup](#first-run-setup)).

```sh
deckent backup create --scope <id> --set /private/recovery/set-1
deckent backup verify --scope <id> --set /private/recovery/set-1
deckent backup restore --scope <id> --set /private/recovery/set-1 --target /private/new-install
```

**What a set holds.** The online ledger snapshot, fingerprint, manifest, small state archive and the encrypted authority key.
The project and global configuration layers are archived apart. Worker clones, provider logins and secret-store credentials are
excluded. Set files are 0600 in a 0700 directory, and no `ledger.db-wal/-shm` is left in a set. Only the authority key is
encrypted with your passphrase; the ledger and the state archive are plain files, so keep sets on storage you trust
(full-set encryption is not available yet).

**Passphrase and integrity.** The passphrase is read by a masked terminal prompt or from stdin; there is no passphrase argument.
Keep it separately from the set. The manifest's file digests are bound into the passphrase-sealed key envelope, so changing a
file and rewriting its digest is still detected: `BACKUP_PASSPHRASE_INVALID` means a wrong passphrase or a modified set. Before
any decryption, verify and restore name the other causes with their own codes (exit 78): `BACKUP_SET_NOT_FOUND` (no folder with
`MANIFEST.sha256` at the path), `BACKUP_SET_UNREADABLE` (this user cannot read the set), `BACKUP_PASSPHRASE_REQUIRED` (empty
passphrase) and `BACKUP_MANIFEST_INVALID` (a file no longer matches the manifest: the set was modified). A restore of a set that
does not exist is refused before its recovery audit (kept next to the set) is written, so no audit folder appears at a mistyped
path.

**Restoring.**

- Stop the target service first; a restore runs only while it is stopped. An empty target needs no replacement confirmation;
  for an existing target add `--confirm-target /exact/absolute/target`. A target bound to another installation is refused. For
  an existing installation run restore from its project root; a different target with an incompatible configured layout is
  refused. Old state stays in `.damaged-<uuid>` copies.
- A relocated identity is reported, its installationId is kept, and `deckent init identity --keep` requires explicit operator
  consent. Internal configuration paths are rewritten; external paths stay external. Restore turns scheduling off.
  Re-provision excluded credentials before enabling the service.
- The project layer becomes the project configuration. The global configuration (`$DECKENT_GLOBAL_HOME/config.json`) is shared
  by your installations: restore adds only the archived sections it lacks (for example the `secrets` store selection after a
  machine loss) and keeps present ones (`globalConfig.added` / `kept` in the result). If the kept global layer names another
  approvals key file, the restored project configuration names the set's key (`/approvals/keyFile` in `changedPaths`); your
  global file is not changed. If a kept global section cannot be used with the restored project configuration, restore stops
  before any work with `BACKUP_TARGET_CONFIG_CONFLICT`, naming the file and section: align or remove that section, then rerun.
  A set made by alpha.18 holds one merged document; its `secrets` selection goes to the global layer, never into the project
  configuration.
- Restore writes into an existing directory only if it is yours and others cannot write to it (a `.deckent` at 0755 is fine;
  `doctor` still shows its mode). Otherwise it stops before any work with `BACKUP_DIRECTORY_UNSAFE`, naming the directory: run
  `chmod 700 <path>` and rerun. A damaged policy file stops restore with `BACKUP_POLICY_UNREADABLE`: move the named file aside
  (`mv <path> <path>.damaged`) and rerun; restore then uses the set's authenticated policy.
- Restoring into the same project keeps its current resource layout: every resource is published where the current
  configuration places it, and the restored configuration names that layout.
- Before the first replacement, restore writes `.deckent/restore-hold.json` in the target; it is removed only after the last
  one. While it exists, service start and every command that loads the project configuration refuse with
  `BACKUP_RESTORE_HOLD`. If `BACKUP_RESTORE_INCOMPLETE` occurs (or the process dies), keep the stage
  (`.deckent/.backup-restore-<uuid>`, private, without the authority key), damaged copies and external audit receipts for
  diagnosis, then rerun the same restore with `--confirm-target`; it uses the retained set's policy only while the hold exists.
  Publication across resources is not atomic. A successful restore removes earlier interrupted stages (also an alpha.18
  `.backup-restore-<uuid>` in the project root); `doctor` lists any left.

**Scheduled backups.** In the interactive configuration picker select `backup.schedule`: off, daily or before-upgrade; and
`backup.retention`: 3, 7, 14 or 30. Daily backups run while the service is up; before-upgrade runs before a ledger upgrade.
Store `BACKUP_PASSPHRASE` with `deckent secret set BACKUP_PASSPHRASE --main` at your own terminal (hidden prompt); with the
environment store (no store selected) the service launcher must provide it instead. Missing credentials block an admitted
before-upgrade ledger upgrade. Only authenticated scheduled sets are retained or pruned; operator files with other names
remain. A set that no longer verifies (for example after a passphrase change) is reported and kept and does not block the next
daily backup; before an upgrade it stops the upgrade. Shutdown waits for a backup already in progress.

**Audit.** Backup audit receipts contain principal, scope and policy, without credentials. Create/verify receipts live under
`audit/backup-operations`; restore receipts live beside the set under `.deckent-backup-audit`, so replacing the ledger cannot
erase the restore intent. A failure before trusted authority exists cannot be sealed and performs no storage effect. Backup
and restore rely on Linux file-custody checks; on other systems they are refused.

## Internal details

### Installation custody

Installation accepts owned group-writable project and bootstrap journal directories (for example, `0775`), but rejects
directories writable by other users. Group members can alter directory entries; this shares custody of the journal namespace
with that group. Journal files still require the current owner, a single hard link and private `0400`/`0600` permissions. New
directories default to `0700`. Config publication, policy, artifacts and worker resources retain their separate stricter
checks; a group-writable project does not imply support for a shared writable product-data root.

### Worker toolchain currency

`deckent doctor --toolchains` compares the CLI versions pinned by prepared native profiles with the published npm `latest` tag
of `@openai/codex` and `@anthropic-ai/claude-code` (one bounded read per package, no credentials). It runs only with the flag and
only when `toolchains.currency.mode` is `report`; `registryEndpoint` may point at a private registry, and unreachable
registries report `unknown-offline`. Cursor has no documented version endpoint and is reported `unsupported`. The report never
updates, rebuilds or activates a worker. The same report is available as the MCP tool `inspect_toolchain_currency` and the SDK
function `inspectToolchainCurrency`.

`deckent toolchains update [--apply]` turns a stale report into the next worker image version under `toolchains.update.mode`
(`off | propose | auto`, default `auto`): a typed plan is written under `<data root>/workspaces/toolchains/plans/`. `--apply`
builds it in every mode; under `auto` the running service also applies it on its own refresh. Building copies the shipped
builder into `workspaces/toolchains/builds/<version>/`, builds it with a bounded timeout, and its receipt produces a
`not-applied` profile-revision proposal (`proposals/<version>.json`). Installed config is never rewritten; apply the proposal as
a new installation profile revision. Running work keeps its image; old versions stay for rollback.
`toolchains.update.atStartup` makes `runtime serve` emit the currency report (report only).

### Worker image versions

`npm run worker:image -- /abs/path/worker-images/<version>.json` builds the three-provider `deckent/worker` image from
`assets/worker-image`. `recipe.json` (schema 2) names `imageVersion` (`r<N>-<YYYYMMDD>`) and `previousVersion`; the Dockerfile
keeps a newest-first `# version …` comment history that must match the recipe and is copied into the image at
`/opt/deckent-worker/Dockerfile`. Each version maps to one immutable imageId tagged `deckent/worker:<version>` with OCI labels; a
version whose tag already names another image is refused. To update: add a new history line, bump
`imageVersion`/`previousVersion`, rebuild, then reference the receipt's `imageId` in a new execution profile revision. Keep old
images, tags and archived receipts (`worker-images/archive/`) for active Runs and rollback; the product binds by `imageId` only
and never pulls, tags or deletes images.

### Native coding profiles

`coding prepare --input <file|-> --json` and SDK `prepareNativeCodingProfile` author a profile; preparation does not activate
it or grant execution permission. The outer request remains `{schemaVersion: 1, template, invocation}`. New `invocation` data
requires `schemaVersion: 2`, `provider`, `cliVersion`, `permissionMode: "unattended"`, `model` and either `prompt` or
`composition`. Use the exact CLI version string measured in the selected image's preflight receipt, not the host CLI version.

Structured `composition` v1 requires `task`, `scope` and `acceptance` text. It accepts an optional `core`, optional `persona`,
and `skills`/`context` arrays; each selected part has `{id, version, text}`. Omitting `core` selects the packaged, versioned
common worker instructions. Selection is explicit: no persona/skill catalog or host file is searched. Duplicate persona/skill
IDs are rejected. Each text is limited to 16 KiB; the serialized composition to 32 KiB, with at most 16 skills and 8 context
parts. Prompts persist as task data: never include credentials in either input form.

The compiler binds content, selected-part hashes and command arguments in the prepared profile. The worker verifies the
binding, then supplies Claude's core via `--system-prompt`, Codex's via an instruction file in private tmpfs, and Cursor's
inline with the task. Docker command arguments contain placeholders for composed prompt bodies. A bounded
`native-prompt-delivery` output records hashes and selection metadata when the native process spawns, without prompt bodies or
credentials. This proves process input handoff, not model compliance; acceptance still needs observed task results. Persona
and skill content grants no authority.

`discovery` is versioned data: `{schemaVersion: 1, mode: "disabled"}` is the default and
`{schemaVersion: 1, mode: "repository"}` the explicit alternative ([what each mode loads](#worker-instructions-and-discovery)).
A profile may replace the hidden path list only in `invocation.discovery.hiddenPaths`, and only for a checkout-realised
`disabled` mode (Cursor); there is no CLI for it yet. Only Claude repository mode accepts `discovery.settings`, with the typed
field `disableAllHooks: boolean`. This becomes explicit `--settings` JSON; arbitrary settings files, helpers, environment
variables and credentials are rejected. Disabling hooks alone does not suppress repository MCP or instructions. Settings with
discovery-disabled mode are rejected.

The worker checks its CLI version and required flags in an empty temporary directory before writing its credential file and
launching the task. A mismatch exits with a sanitized `preflight` failure; there is no fallback to an API key or another login.
Image re-probing uses the current inspector and records its hashes even for an existing image. A CLI's help output is not proof
that a capability works. Old invocation-v1 authoring requests are rejected rather than silently changing their meaning. Already
persisted execution profiles keep their exact behavior and replay; upgrading means preparing and admitting a new profile
revision explicitly.

### Patch custody and integration

Patch capture compares the workspace with the base tree by Git object id and reads only changed base files; exhausted Git
output/time or scan budgets fail as `PATCH_LIMIT` with a `detail` param (`git-output`, `git-timeout`, `time`, `bytes`,
`entries`, `depth`, `path`). `execution.git.outputBytes` defaults to 4 MiB.

For a retained workspace patch, `deckent task integration-check` checks the recorded base against HEAD and the affected
index/worktree files. Use the same identity flags as `task patch-preview`. `task integration-prepare` additionally takes
`--command-id <id>` and the check's `--proposal <code>`, and requires `prepare-integration` policy permission. Both commands
support `--json` and use local storage without a runtime service.

Preparation creates a separate Git candidate under the configured workspaces resource's `integrations` directory. It contains
the recorded base plus patch and leaves source files, HEAD and index unchanged. A prepared candidate is not task acceptance or
delivery. Repeating a completed command verifies its candidate; an interrupted command reports `PATCH_INTEGRATION_PENDING` and
preserves its files without automatic repair or takeover. An older ledger must be upgraded explicitly (installation/storage
upgrade) before prepare; the read-only check and ordinary preparation never upgrade it silently.

`task integration-inspect` takes the same identity flags plus `--command-id <id>` and requires only `read-output`. It reports
`absent`, `pending`, or `manifest-recorded` from the existing ledger and immutable manifest. It works without execution
configuration and does not upgrade storage, repair candidates, or recheck their current files.

### Distribution extension entry

The public extension entry lets a CLI distribution register effect adapters, secret-store adapters and secret helpers,
approval-assurance producers, MCP capability groups and provider no-charge certifications. Since alpha.20 that distribution can
also start the service and MCP entry with its registrations; automatic service start and restart replay the distribution's
entry (checked by the manual `npm run smoke:dist`, not in CI). Core's bare executables do not discover those modules.
