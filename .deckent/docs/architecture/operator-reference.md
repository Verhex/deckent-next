# Operator reference

Detailed operator behavior behind the product summary in [README.md](../../../README.md). Türkçe: [operator-reference.tr.md](operator-reference.tr.md).

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
`toolchains.update.mode` (`off | propose | auto`, default `propose`): a typed plan is written under
`<data root>/workspaces/toolchains/plans/`; with `auto` or `--apply` the shipped builder is copied into
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

```sh
deckent backup create --scope <id> --set /private/recovery/set-1
deckent backup verify --scope <id> --set /private/recovery/set-1
deckent backup restore --scope <id> --set /private/recovery/set-1 --target /private/new-install
```

The passphrase is read by a masked terminal prompt or stdin; there is no passphrase argument.
Keep it separately from the set. The set contains the online ledger snapshot, fingerprint,
manifest, small state archive and encrypted authority key. Worker clones, provider logins and
secret-store credentials are excluded. Files and directories must be private (0600/0700).
SHA hashes alone do not authenticate a changed set: verification also opens the AEAD envelope.

Stop the target service first. An empty target needs no replacement confirmation; for an
existing target add `--confirm-target /exact/absolute/target`. A target bound to another
installation is refused. For an existing installation run restore from its project root;
a different target with an incompatible configured layout is refused. Old state stays in `.damaged-<uuid>` copies. A relocated identity is
reported, its installationId is kept, and `deckent init identity --keep` requires explicit
operator consent. Internal configuration paths are rewritten; external paths stay external.
Restore resets scheduling to off. Re-provision excluded credentials before enabling service.
Restoring into the same project keeps its current resource layout: every resource is published
where the current configuration places it and the restored configuration names that layout.
Before the first replacement restore writes `.deckent/restore-hold.json` in the target; it is
removed only after the last one. While it exists, service start and every command that loads the
project configuration refuse with `BACKUP_RESTORE_HOLD`. If `BACKUP_RESTORE_INCOMPLETE` occurs (or
the process dies), keep the staging directory, damaged copies and external audit receipts for
diagnosis, then rerun the same restore with `--confirm-target`; it uses the retained set's policy
only while the hold exists. Publication across resources is not atomic.

In the interactive configuration picker select `backup.schedule`: off, daily, or
before-upgrade; select `backup.retention`: 3, 7, 14, or 30. Daily backups run while the service
is up; before-upgrade runs before ledger migration. Set `BACKUP_PASSPHRASE` through the
selected secret store (the existing `secret set` masked/stdin flow). The default environment
backend must instead be provisioned by the service launcher. Missing credentials block an
admitted before-upgrade migration. Only authenticated scheduled sets are retained/pruned;
operator files with other names remain. Shutdown waits for a backup already in progress.

Backup audit receipts contain principal, scope and policy, without credentials. Create/verify
receipts live under `audit/backup-operations`; restore receipts live beside the set under
`.deckent-backup-audit`, so replacement of the ledger cannot erase the restore intent.
A failure before trusted authority exists cannot be sealed, and performs no storage effect.
Linux kernel custody is verified here; other hosts refuse unsupported custody. KMS, independent
review, packaged acceptance and owner DOGFOOD admission remain separate gates.

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
