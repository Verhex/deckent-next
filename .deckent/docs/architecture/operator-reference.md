# Operator reference

Detailed operator behavior behind the product summary in [README.md](../../../README.md). Türkçe: [operator-reference.tr.md](operator-reference.tr.md).

The interactive terminal is a full window (the terminal's alternate screen, like the Claude Code fullscreen renderer): the
conversation scrolls in the top area, the input bar stays on the same bottom row for the whole session (only a resize or your
own multi-line draft moves it), and under it a fixed information area shows the state, model and mode, the Active work
summary (or the full-access line) and key hints. The conversation follows the newest line; the mouse wheel scrolls it three
lines a notch, PgUp/PgDn by half a view, Ctrl+Home goes to its first line and Ctrl+End back to the newest one; while you read
back a row says how many new messages (or lines) arrived and End/Home jump to the newest/first line (streaming never pulls the
view down; at the bottom it follows again). While scrolled back Ctrl+F searches the conversation this view keeps (the shown,
masked text only; Enter/↑ older, ↓ newer, Esc closes; the draft is untouched), and Ctrl+Up/Ctrl+Down jump to your previous/next
message (Ctrl+R stays input-history search). Windows and cards open right above the input bar, take at most half the screen and scroll inside; they shrink the
conversation area, never move the bar. On exit the conversation is written to the normal screen, so it stays in your
terminal's scrollback; `/clear` empties the view and that scrollback. The full window reports the mouse wheel only while it
is shown (clicks are ignored and never answer a card); select text with your terminal's modifier as in Claude Code — Shift
in most terminals, Option in iTerm2, Fn in Terminal.app. `terminal.layout: inline` keeps the previous
inline layout (native scrollback while running; recommended with screen readers); `terminal.viewportRows` (default 2000)
bounds how far the view scrolls back. Mode colours: standard muted, full auto its own colour, full access the warning tone
with a calm `⏵⏵⏵` mark (NO_COLOR: the words carry the mode). A window opened by your command or selection takes
focus immediately; Escape closes it back to input. Automatic /do planning and progress windows and
run/worker watches leave input focused: type a draft or press Enter to queue it behind the current
operation. Ctrl+O switches between input and the top window. An approval card (and any question) takes the keyboard by
itself and replaces the input bar in place, so no Ctrl+O is needed; its answers are a list — "Yes, once (y)", "Yes, for this
session (s)" and "Always allow in this project (a)" only where the service offers them (never for floor items or always-ask
locks), "No (n)" — moved with ↑↓, j/k or 1–9 and confirmed with Enter, or answered with the letter; the highlight starts on
No, Esc denies. A card counts keys only after a short quiet period (0.3 s, `decision.json`) from the moment it is shown;
until then its hint row says "Just opened · its keys work in a moment" (and "Key not counted … press it again" for a key that
came too early), and its keys appear there once they count:
keys typed for the input just before, a held key, a paste, a key from a just-answered card or a focus switch never answer
it, and one stdin read with several key events never decides. The draft stays and returns with the bar. Several pending
decisions wait one at a time ("1/3"). "Always" is your own standing grant (`deckent policy grants --mine`, removed with
`deckent policy revoke`). Existing decision, reason and verified-TTY requirements apply.
Escape closes or declines in a focused window; from input it retains the draft/cancel behavior. Long window
bodies scroll internally with arrows, PageUp/PageDown and Home/End, with a visible row range. Multiline input
follows its caret within a height budget. Ctrl+S puts the whole draft aside (memory only, never saved or logged) and, on an
empty line, brings it back (a kept draft is never overwritten); Ctrl+_ undoes the last unsent edit (a typing run is one step,
cleared on send). The information row under the bar also shows the conversation's context use (the `/context` measurement,
"context ?" before the first one). `/watch-stop` closes observation. Under input, the "Active work" summary row names
this session's running /do (planning, or waiting for you with the approval time left) and the Runs it started, with title,
state, elapsed time and "+N more"; it never takes input by itself. Ctrl+T opens the full list above input (↑↓, Esc back): Enter on /do focuses its window, Enter on a
Run opens that Run's window; a finished Run leaves the strip once opened. Pipe and line-mode output is unchanged.

## Installation custody

Installation accepts owned group-writable project and bootstrap journal directories (for example,
`0775`), but rejects directories writable by other users. Group members can alter directory entries;
this shares custody of the journal namespace with that group. Journal files still require the current
owner, a single hard link and private `0400`/`0600` permissions. New directories default to `0700`.
Config publication, policy, artifacts and worker resources retain their separate stricter checks;
a group-writable project does not imply support for a shared writable product-data root.

## Worker toolchain currency

`deckent doctor --toolchains` compares the CLI versions pinned by prepared native profiles with the published
npm `latest` tag of `@openai/codex` and `@anthropic-ai/claude-code` (one bounded read per package, no credentials).
It runs only with the flag and only when `toolchains.currency.mode` is `report`; `registryEndpoint` may point at a
private registry, and unreachable registries report `unknown-offline`. Cursor has no documented version endpoint and
is reported `unsupported`. The report never updates, rebuilds or activates a worker. The same report is available as
the MCP tool `inspect_toolchain_currency` and the SDK function `inspectToolchainCurrency`.

`deckent toolchains update [--apply]` turns a stale report into the next worker image version under
`toolchains.update.mode` (`off | propose | auto`, default `auto`): a typed plan is written under
`<data root>/workspaces/toolchains/plans/`; with `--apply` (in every mode; under `auto` the running service's own refresh applies by itself) the shipped builder is copied into
`workspaces/toolchains/builds/<version>/`, built with a bounded timeout, and its receipt produces a
`not-applied` profile-revision proposal (`proposals/<version>.json`). Installed config is never rewritten;
apply the proposal as a new installation profile revision. Running work keeps its image; old versions stay for
rollback. `toolchains.update.atStartup` makes `runtime serve` emit the currency report (report only).

## Worker image versions

`npm run worker:image -- /abs/path/worker-images/<version>.json` builds the three-provider
`deckent/worker` image from `assets/worker-image`. `recipe.json` (schema 2) names `imageVersion`
(`r<N>-<YYYYMMDD>`) and `previousVersion`; the Dockerfile keeps a newest-first `# version …` comment
history that must match the recipe and is copied into the image at `/opt/deckent-worker/Dockerfile`.
Each version maps to one immutable imageId tagged `deckent/worker:<version>` with OCI labels; a version
whose tag already names another image is refused. To update: add a new history line, bump
`imageVersion`/`previousVersion`, rebuild, then reference the receipt's `imageId` in a new execution
profile revision. Keep old images, tags and archived receipts (`worker-images/archive/`) for active
Runs and rollback; the product binds by `imageId` only and never pulls, tags or deletes images.

## Native coding profiles

`coding prepare --input <file|-> --json` and SDK `prepareNativeCodingProfile` author a profile;
preparation does not activate it or grant execution permission. The outer request remains
`{schemaVersion: 1, template, invocation}`. New `invocation` data requires `schemaVersion: 2`,
`provider`, `cliVersion`, `permissionMode: "unattended"`, `model` and either `prompt` or `composition`. Use the exact
CLI version string measured in the selected image's preflight receipt, not the host CLI version.

Structured `composition` v1 requires `task`, `scope` and `acceptance` text. It accepts an optional
`core`, optional `persona`, and `skills`/`context` arrays; each selected part has `{id, version, text}`.
Omitting `core` selects the packaged, versioned common worker instructions. Selection is explicit:
no persona/skill catalog or host file is searched. Duplicate persona/skill IDs are rejected.
Each text is limited to 16 KiB; the serialized composition to 32 KiB, with at most 16 skills and
8 context parts. Prompts persist as task data: never include credentials in either input form.

The compiler binds content, selected-part hashes and command arguments in the prepared profile.
The worker verifies the binding, then supplies Claude's core via `--system-prompt`, Codex's via
an instruction file in private tmpfs, and Cursor's inline with the task. Codex additionally disables
automatic project-document loading; this does not establish complete discovery suppression.
Docker command arguments contain placeholders for composed prompt bodies. A bounded
`native-prompt-delivery` output records hashes and selection metadata when the native process
spawns, without prompt bodies or credentials. This proves process input handoff, not model
compliance; acceptance still needs observed task results. Persona and skill content grants no authority.

`discovery` is versioned data: `{schemaVersion: 1, mode: "disabled"}` is the default.
Claude maps it to subscription-compatible `--safe-mode`. Codex and Cursor currently reject
that mode because complete discovery suppression has not been established for their adapters.
For an explicitly authorized repository-discovery profile, select
`{schemaVersion: 1, mode: "repository"}`; this permits repository instructions/configuration
and can start repository hooks or MCP processes. It does not grant additional host/network access.
Discovery suppression controls automatic loading; native tools can still read files inside the workspace.

Only Claude repository mode currently accepts `discovery.settings`, with the typed field
`disableAllHooks: boolean`. This becomes explicit `--settings` JSON; arbitrary settings files,
helpers, environment variables and credentials are rejected. Disabling hooks alone does not
suppress repository MCP or instructions. Settings with discovery-disabled mode are rejected.

The worker checks its CLI version and required flags in an empty temporary directory before
writing its credential file and launching the task. A mismatch exits with a sanitized `preflight`
failure; there is no API/authentication fallback. Image re-probing uses the current inspector
and records its hashes even for an existing image. Capability help is not authenticated proof.
Old invocation-v1 authoring requests are rejected, rather than silently changing their meaning.
Already persisted execution profiles keep their exact behavior and replay; migration means
preparing and admitting a new profile revision explicitly.

## Patch custody and integration

Patch capture compares the workspace with the base tree by Git object id and reads only changed base blobs;
exhausted Git output/time or scan budgets fail as `PATCH_LIMIT` with a `detail` param (`git-output`,
`git-timeout`, `time`, `bytes`, `entries`, `depth`, `path`). `execution.git.outputBytes` defaults to 4 MiB.

For a retained workspace patch, `deckent task integration-check` checks the recorded base
against HEAD and the affected index/worktree files. Use the same identity flags as
`task patch-preview`. `task integration-prepare` additionally takes `--command-id <id>`
and the check's `--proposal <code>`, and requires `prepare-integration` policy permission.
Both commands support `--json` and use local storage without a runtime service.

`deckent task` for a person (alpha.48 C-TASK). Every `task` view uses the call's language (`--lang`, then
`DECKENT_LANGUAGE`, then config `language`, then the system locale); `transcript` and `patch-preview` keep their
format. `--run` takes a short id: an exact id or the unique prefix of a Run the terminal's `/runs` lists resolves;
several candidates are `CLI_ID_AMBIGUOUS` (exit 2); anything else is passed on unchanged. `task inspect` reads in
`run inspect` order (task and state, request, result, what an accepted result rests on, delivery); a secret-gate list
longer than five paths is one line naming the deny-list exceptions, and `--verbose` adds every path and the acceptance
metadata line. In `patch-preview` a diff line whose control characters were neutralised is followed by a
`\ control characters in the line above were neutralised` meta line (`--stat` and `--json` unchanged). On a real
terminal, `task inspect|transcript|patch-preview` without `--run`/`--task` pick scope, Run and task; bare
`deckent task` (once the catalog marks the family bare-handled) opens a menu of only the task's valid actions:
inspect, transcript and diff once an attempt exists, accept/reject while a decision is open, delivery for an accepted
patch awaiting delivery. Accept/reject read the revision just before their card and generate the command id; a Run
that changed meanwhile is refused (`RUN_STORE_CONFLICT`), read again and asked again. Delivery uses the same port and
applications as `/deliver`; every write (candidate + delivery, adoption, queue batch) waits for its own exact card,
and Enter alone, Esc or silence (the session approval time) answer no. A pipe, AI agent, CI or `--json` caller is never
asked: bare `deckent task` names the missing argument and lists the actions in four groups (Inspect, Execute and
evaluate, Deliver, Queue), exit 2. The AI path keeps every long name and flag.

Preparation creates a separate Git candidate under the configured workspaces resource's
`integrations` directory. It contains the recorded base plus patch and leaves source files,
HEAD and index unchanged. A prepared candidate is not Task acceptance or live delivery.
Repeating a completed command verifies its candidate; an interrupted command reports
`PATCH_INTEGRATION_PENDING` and preserves its files without automatic repair or takeover.
Existing ledgers require explicit installation/storage migration to version 30 before prepare;
read-only check and ordinary preparation never silently migrate them.

`task integration-inspect` takes the same identity flags plus `--command-id <id>`
and requires only `read-output`. It reports `absent`, `pending`, or `manifest-recorded`
from the existing ledger and immutable manifest. It works without execution configuration
and does not migrate storage, repair candidates, or recheck their current files.


## Installation recovery sets

`deckent backup create|verify|restore` uses one governed contract. The installation owner
needs the installation-wide `backup` policy grant. Existing installations can preview
`deckent init policy --scope <id> --upgrade --preview`, then apply the add-only plan with
`--apply --expect <previewed-revision>`; conflicting rules are preserved.
For a missing pool on an existing current installation: `deckent init pool --scope <id> --preview`, then `--apply`; capacity comes from admission config and a differing existing pool is never overwritten.

```sh
deckent backup create --scope <id> --set /private/recovery/set-1
deckent backup verify --scope <id> --set /private/recovery/set-1
deckent backup restore --scope <id> --set /private/recovery/set-1 --target /private/new-install
```

The passphrase is read by a masked terminal prompt or stdin; there is no passphrase argument.
Keep it separately from the set. The set contains the online ledger snapshot, fingerprint,
manifest, small state archive and encrypted authority key. The project and global configuration
layers are archived apart. Worker clones, provider logins and secret-store credentials are
excluded. Set files are 0600 in a 0700 directory and no `ledger.db-wal/-shm` is left in a set.
SHA hashes alone do not authenticate a changed set: verification also opens the AEAD envelope, so
`BACKUP_PASSPHRASE_INVALID` means a wrong passphrase or a modified set.
Before any decryption, verify and restore name the other causes with their own codes (exit 78):
`BACKUP_SET_NOT_FOUND` (no folder with `MANIFEST.sha256` at the path), `BACKUP_SET_UNREADABLE`
(this user cannot read the set), `BACKUP_PASSPHRASE_REQUIRED` (empty passphrase) and
`BACKUP_MANIFEST_INVALID` (a file no longer matches the manifest: the set was modified). A restore of a set that does not exist is
refused before its recovery audit (kept next to the set) is written, so no audit folder appears at a mistyped path.

Stop the target service first. An empty target needs no replacement confirmation; for an
existing target add `--confirm-target /exact/absolute/target`. A target bound to another
installation is refused. For an existing installation run restore from its project root;
a different target with an incompatible configured layout is refused. Old state stays in `.damaged-<uuid>` copies. A relocated identity is
reported, its installationId is kept, and `deckent init identity --keep` requires explicit
operator consent. Internal configuration paths are rewritten; external paths stay external.
Restore resets scheduling to off. Re-provision excluded credentials before enabling service.
The project layer becomes the project configuration. The global configuration
(`$DECKENT_GLOBAL_HOME/config.json`) is shared by your installations: restore adds only the archived
sections it lacks (for example the `secrets` store selection after a machine loss) and keeps present
ones (`globalConfig.added` / `kept` in the result). If the kept global layer names another approvals key
file, the restored project configuration names the set's key (`/approvals/keyFile` in `changedPaths`);
your global file is not changed. If a kept global section cannot be used with the restored project
configuration, restore stops before any work with `BACKUP_TARGET_CONFIG_CONFLICT`, naming the file and
section: align or remove that section, then rerun. A set made by alpha.18 holds one merged document;
its `secrets` selection goes to the global layer, never into the project configuration.
Restore writes into an existing directory only if it is yours and others cannot write to it (a
`.deckent` at 0755 is fine; `doctor` still shows its mode). Otherwise it stops before any work
with `BACKUP_DIRECTORY_UNSAFE`, naming the directory: run `chmod 700 <path>` and rerun. A damaged
policy file stops restore with `BACKUP_POLICY_UNREADABLE`: move the named file aside
(`mv <path> <path>.damaged`) and rerun; restore then uses the set's authenticated policy.
Restoring into the same project keeps its current resource layout: every resource is published
where the current configuration places it and the restored configuration names that layout.
Before the first replacement restore writes `.deckent/restore-hold.json` in the target; it is
removed only after the last one. While it exists, service start and every command that loads the
project configuration refuse with `BACKUP_RESTORE_HOLD`. If `BACKUP_RESTORE_INCOMPLETE` occurs (or
the process dies), keep the stage (`.deckent/.backup-restore-<uuid>`, private, without the
authority key), damaged copies and external audit receipts for diagnosis, then rerun the same
restore with `--confirm-target`; it uses the retained set's policy only while the hold exists.
Publication across resources is not atomic. A successful restore removes earlier interrupted
stages (also an alpha.18 `.backup-restore-<uuid>` in the project root); `doctor` lists any left.

In the interactive configuration picker select `backup.schedule`: off, daily, or
before-upgrade; select `backup.retention`: 3, 7, 14, or 30. Daily backups run while the service
is up; before-upgrade runs before ledger migration. Set `BACKUP_PASSPHRASE` through the
selected secret store (the existing `secret set` masked/stdin flow). The default environment
backend must instead be provisioned by the service launcher. Missing credentials block an
admitted before-upgrade migration. Only authenticated scheduled sets are retained/pruned;
operator files with other names remain. A set that no longer verifies (for example after a
passphrase change) is reported and kept, and does not block the next daily backup; before an upgrade it stops the migration. Shutdown waits for a backup already in progress.

Backup audit receipts contain principal, scope and policy, without credentials. Create/verify
receipts live under `audit/backup-operations`; restore receipts live beside the set under
`.deckent-backup-audit`, so replacement of the ledger cannot erase the restore intent.
A failure before trusted authority exists cannot be sealed, and performs no storage effect.
Linux kernel custody is verified here; other hosts refuse unsupported custody. KMS, independent
review, packaged acceptance and owner DOGFOOD admission remain separate gates.

## Administration commands in human words (alpha.48, owner CLI review 2026-10-19)

Without an action `deckent pool`, `audit`, `secret`, `runtime`, `backup` and `toolchains` read: the pool's state and capacity, the
audit result with the last checkpoint, the keys (name · used by · store, never a value), the service status (build, configuration,
running work, socket; no start time until the next protocol version), the recovery sets (`state/backups/recovery`: date · size · kind ·
last verified · name) and the toolchain table (network use stated first). `deckent paths` groups the layout with exists/missing and
names the socket really used (`/tmp/dk-<uid>-<sha256>/s`). Output is text in a pipe; JSON only with `--json`, in the same contracts.
A change never takes a silent scope: off a terminal `pool hold|resume|set-capacity|quota-release`, `secret set|delete|store --to`
and `backup create|restore` need `--scope`, and `runtime shutdown` without identities needs `--reason`. On a person's terminal the
scope, the set, the key or the store are picked and the change is confirmed on a card first (an AI, CI or pipe is never asked):
a weaker secret store needs a second warning card, a restore shows target, service state and where replaced files are kept,
`toolchains update` shows the plan before it builds, `audit rebaseline` confirms on a card.

## Provider keys, models and spending

Keys: `deckent secret set NAME` (hidden prompt or piped stdin) writes to the store selected by `secrets.store`
(`core.secret-store.env@1`, `core.secret-store.file@1`, `core.secret-store.encrypted-file@1`); `deckent secret store`
copies every key to another registered store, verifies it, publishes the selection and then deletes the old copy (a move
to a weaker store asks for approval; set, delete and switch share one installation-wide custody section). Workers never
receive a key. `deckent doctor` names the active store and reports `unverified` when a store listing fails.

Models: `deckent models connect --scope <id> --connection <kind> --command-id <id> (--model <id> | --reference <ref>)`
declares a model from the kind's packaged catalog, writes the scope's invocation profile with the key name and activates
it (kinds: anthropic-api, openai-api, deepseek-api, zai-api, zai-cn-api, openai-compatible, local-openai). A remote model
without a verified published tariff is refused and shown locked with the reason. `terminal.defaultModel` (user layer) is
the terminal's default; the session pin from `/model` wins, then a project-authored reference.

Spending: paid calls reserve the dearest applicable published tier and settle from the provider's returned usage times
the pinned tariff (`measured-tariff`). The scope's first budget is created with `deckent models create-budget --scope <id>
--usd <n>` (or the budget window, the first row of `/provider`), changed with `revise-budget [--unfreeze]`; a held call that never received
final usage is resolved with `reconcile-spending`. Details: ARCHITECTURE "Spend settlement".

### Delivery confirmation (TESLIM-GUVENLIK author candidate)

`task integration-deliver`, `task integration-adopt` and `task integration-rollback` require one explicit `y` in a verified human terminal (a rollback moves the adopted branch back, so it asks like an adoption; its card shows the branch and current → previous commit). The card shows task title, Run/Task ids, reference/branch, from/to commits and changed files. Empty, `n`, EOF, redirected input/output and SDK/MCP new effects refuse. Prepare/check remain candidate-only. Completed replay and proven crash settlement do not ask again; an unfinished effect needs fresh confirmation. Adoption still requires `execution.adoption.targets`, policy, acceptance and configured verification; with `execution.adoption.verification` configured the terminal delivery window lets the person choose an accepted verification Run of the configured kind (see below); a refusal shows the reason and keeps the exact `task integration-adopt … --verification-run <run>` command as the command-line alternative. No autonomous policy is enabled. Known limit: the verified-terminal witness exists only on Linux (WSL included); on other hosts delivery, adoption and rollback are refused with `DELIVERY_INTERACTIVE_REQUIRED`.

Delivery commits carry the admitted task title, ids and bounded acceptance state; author/committer time comes from the trusted delivery planning clock and is frozen by the intent for replay. Deckent is the default identity; `execution.git.deliveryIdentity` can set `authorName`/`authorEmail`. Preview Git objects are prepared only in the candidate before the answer; refusal writes no source Git object, ref, branch or delivery intent.

### Run controls in the terminal (Y1 author candidate)

`/runs` lists the scope's Runs with a selection. When the terminal has the lifecycle handler (the CLI's in-process `run hold|resume|close` application), `h` holds a Run that is not finished, cancelling or already held, `r` resumes a Run parked by an operator hold or a failed progression (a question, a decision or a quota wait survives resume, so `r` is not offered there) and `c` closes a parked Run; the hint row names only the keys the selected Run's observed state offers. Each key re-reads the Run and opens a y/N card with what the control does, the state and the revision it will send; only a single typed `y` sends it (Ctrl/Alt chords, pasted or coalesced keys never do; `n`, Enter, Esc and Ctrl+C keep the Run). Hold takes the person's reason (Tab) or a default sentence as its note. The command is the CLI's own lifecycle command against the shown revision; policy (`run cancel` for hold/close, `run reserve` for resume) and the Run's state decide, and a refusal is the typed reason in the session language above the list. The result line names the state the Run is in afterwards and the command id. Hold stops new reservations; work already running continues. Answering a needs-input task and accepting or rejecting a task are separate decisions and are not keys here.

### Delivery window in the terminal (TESLIM-PENCERESI author candidate)

When a Task of a Run that this terminal's `/do` admitted reaches "accepted · patch ready, awaiting delivery", a delivery window opens by itself without taking input (Ctrl+O, or "awaiting delivery" in the Active work strip with Ctrl+T and Enter, moves input to it); `/deliver` lists every waiting task of the scope and opens the chosen one with focus. The window shows the task title, Run/Task ids, the integration check of the current source (affected files match the base), the changed files with `patch-preview --stat` counts, that only a dedicated `refs/deckent/deliveries/` reference is written (branches, index and working tree stay unchanged) and, only when `execution.adoption.targets` is configured, the target branches as a later, separate choice. `y` checks, prepares and delivers in one flow through the same applications as `task integration-check|prepare|deliver` and the verified-terminal confirmation above: the window's `y` answers the confirmation only when its card shows exactly the operation, ids, command, file set and base the window showed; otherwise the exact card is shown and needs a fresh `y`. After delivery a configured branch is adopted only with a second `y` (↑↓ chooses the branch); `n`/Esc does nothing. With `execution.adoption.verification` configured (Y1), that `y` first opens a verification step: the scope's accepted Runs of the configured kind (one task), plus "adopt without verification" only when it is not required; ↑↓ chooses, a single typed `y` adopts with the choice (the kind is read from configuration at that moment, as `task integration-adopt --verification-run` does), `r` reads the list again, `n`/Esc go back. With none it says so and names `deckent run create … --delivery-command-id <this delivery>`. The adoption application still checks that the Run verified exactly this commit with the current profile and the installation's criteria; a refusal returns to the choice with its reason and a fresh adoption command. The delivered and adopted lines and the transcript summary show the delivery and adoption command ids (`task integration-rollback --adoption-command-id`). A typing `y` in the input never confirms. A stale base, a missing grant (`scope inspect` for the attempt lookup plus the integration actions) or a non-verified session is refused in plain words with the next step. Delivery never starts by itself; a future owner-set "autonomous by rule" broker would plug into the same confirmation port and is not implemented. The ready step also offers a read-only diff of each changed file (alpha.46; no new command): ↑↓/j/k choose a file, Enter opens its hunks with the attempt, base and proposal the preview was built from, ↑↓/j/k scroll, Esc returns to the list. The port carries per-file diff bodies of the same patch the counts come from, bounded by `deliver-port.json` (`maxDiffFiles`, `maxDiffLinesPerFile`, `maxDiffBytesPerFile`); a binary or over-large file shows "Cannot show: binary or too large" instead of a body and cut lines are counted. Every row passes the same redaction and terminal-text cleaning as the rest of the window. Viewing never prepares, delivers or adopts: inside a diff `y`, `n` and Enter do nothing, and delivery stays the list step's separate verified-terminal `y`. A stale base or a denied access is still the typed refusal row.
