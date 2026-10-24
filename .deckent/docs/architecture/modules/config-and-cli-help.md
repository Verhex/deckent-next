# Registry-driven config and CLI help — module note

ConfigApplication, CLI config surface, help catalog (moved from ARCHITECTURE.md Packages 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 618–689; the original text below is verbatim; later dated additions are marked separately.

### Registry-driven configuration contract (CONFIG-SURFACE, owner 2026-10-02)

`engine/core/config` owns one typed `ConfigApplication`: inspect (all registered schema paths or one key), explain,
validate, set and unset. Fields, descriptions, JSON Schema type/enum/range/default, binding and apply mode derive from
`CONFIG_FIELDS` and `registerConfigSection`; there is no surface-owned key/schema list. The file adapter observes
project/global documents and effective default → global → project → env values. Secret provenance and credential keys
are masked before subtree selection; every string also passes through the existing shared redactSensitive matcher (tokens, Bearer credentials, URL passwords, key/value secrets and JWTs). Schema value annotations are masked too. Token resource counts stay visible. Raw JSON Schema conversion is cached per configRegistryGeneration with schema-derived paths (dynamic array indexes/record names share nodes); values, provenance and annotation masking remain fresh per observation.

Writes carry VerifiedPrincipal, scope, command id, explicit project/default or global target, and optional inspect
preimage digest (`--expect`; CLI `--expect absent` asserts no target document yet). Existing policy vocabulary adds `config/write`; first-run template v4 grants it to the
verified local owner. Global writes also require installation-wide delegation. Deny fails closed. T3 adds approval-aware `submit` with subject `config-change`; allow-only `set`/`unset` retain `POLICY_APPROVAL_UNSUPPORTED` for require-approval. The previewed digest, accept window, policy recheck and consumed approval audit are specified in ARCHITECTURE’s T3 contract. Terminal `/config` selections use the same approval-aware submit path; embeddings without a principal write route remain read only.
Reads require no config-write grant. Composition supplies verified scope context; the engine plans, adapters own IO.

Authored object overlays validate supplied members against the original registry nodes (including union branches);
arrays replace whole values. Full merged semantics still validate through CORE_SCHEMA and registered sections. JSON-only
inputs reject undefined, nonfinite, cyclic or accessor values before publication. Union leaf explanations include all branches.

The existing writer lock serializes publication: validate each authored layer, full CORE_SCHEMA + registered section
validators and resulting effective document; check preimage; seal a value-free audit intent through the existing audit
port; retain the existing file as a versioned adjacent product backup; fsync temporary file, rename and fsync directory. Governed writes prune adjacent backups under that same lock using configFile.backupKeep (registry default 3), protecting the newly created backup. A CONFIG_BACKUP_PRUNE_FAILED failure occurs after publication and does not roll back saved bytes; inspect reconciles actual document state. Config writer waiting uses configFile.writeLockTimeoutMs (registry default 2000ms); compatibility writeConfig and healing reuse the registry source, while installation publication keeps its separate installation setting. A malformed project document heals with registry defaults because it cannot supply valid config policy.
Audit carries principal/scope/key/command/layer and before/after document digests. Audit and filesystem publication are
separate stores: the audit intent is not an effect-settlement receipt; after an IO failure inspect reconciles actual
bytes. Audit failure prevents config publication. Without an initialized ledger/policy/key custody, writes refuse.
Secrets section set/unset is refused and remains owned by `deckent secret`.

Config schema 4 removes `mode`, `spawn_backend`, `auth_mode`, `providers` and `live_trace` (no consumers). Explicit v3
Next documents normalize on read with values-free warnings; reads preserve bytes, the next governed write publishes v4.
Current/unversioned documents carrying retired keys receive typed CONFIG_FIELD_RETIRED issues; other old schemas remain
unsupported. This is Next version evolution, not legacy conversion. Every field/registered section declares binding
and apply metadata; registration refuses missing metadata/declared-only sections. Source AST lint checks declared
consumer references and rejects new declared-only fields; the frozen historical allowlist is empty and may only shrink.
The lint proves references, not end-to-end causality. Nested fields inherit their section's declared consumers/apply mode.

`max_workers` narrows admission execution/in-flight capacity and the SQLite reservation transaction's shared pool
occupancy; `auto` adds no ceiling. Monitor reports effective capacity while retaining actual occupancy. Existing Run
snapshots remain immutable. Every Docker profile admitted through the registry (including compiled templates) must be
within configured `execution.docker.memoryBytes/cpus/pids`; excess is EXECUTION_RESOURCE_CEILING, never silent clamping.
Existing admitted Docker profiles are not rewritten; the existing first-scope pin can precede refusal, but no Run,
receipt, progression intent or attempt is created on a resource-ceiling rejection.

CLI config has a dedicated `surfaces/core/config` unit: an 80-column grouped human view, compatible `get [key] --json`,
explain/validate/set/unset with safe numeric array paths and splice removal. Line-mode `/config [key]` and monitor's
read-only Config tab/`monitor --config` use the same inspect operation. Monitor config concerns its current project;
other installation snapshots do not grant config authority. The monitor's Config tab (`surfaces/core/monitor-view`, PB-MON-UX) opens on the settings whose source is not the default, under the human name of their top-level section (sections in a fixed reading order, an unknown one last under its key), each row showing its full key; `a` shows all of them and `/` searches (view state only, the read is unchanged), and a declared-only field is flagged as not read. A failing Config read shows a typed unavailable state without discarding successful Run/worker refreshes; recovery replaces it with fresh config. Tab help derives its index from the active tab registry. CLI explain uses the project/effective view and refuses --global with CLI_USAGE. No runtime protocol/ledger version change is required.
The owner-only provider cleanup sequence and temp-project command evidence are outside Git in
`proof/CONFIG-SURFACE-2026-10-02/owner-vllm-steps.md`. Historical invocation inspection keeps its immutable old reference
and profile after provider removal; the test uses a seeded valid durable claim/unknown settlement, not a model request.
Native runtime transport, a freshly built executable, live restart and independent acceptance remain outside this lane's
verified evidence. Fixed architecture budgets are retained; filesystem/authority adapters and pure admission helpers
keep composition as wiring, and previous comment-only wiring notes move to the external proof packet.

### CLI help catalog (CLI-HELP, owner 2026-10-02)

`surfaces/core/cli-kit` owns the typed dispatch catalog and plain-text help renderer. Each registration
has a purpose group, an i18n summary key and a detail key; nested registrations inherit their family's
existing execution handler. `cli` binds the handlers once, uses the catalog for dispatch, and recognizes
help before initialization. Run/Task action admission reads this same catalog. Argument parsers, runtime
operations, authority, JSON envelopes and exit codes remain owned by the existing handlers.
Main help (L-HELP, owner 2026-10-19) is 100–150 lines in both locales: the three surfaces (bare `deckent`,
the CLI, `deckent-mcp`), every family by purpose group with its live actions and an argument synopsis
(catalog `args`, `<placeholder>` words localized through `cli.help.placeholder.*`), then a separate Options
section; developer families have their own heading and `--help --all` is retired (still tolerated, same
output, never initializes). Details and registered children are exposed by `deckent <command> --help [--lang en|tr]`.
Bare behaviour is catalog metadata (`bare`): a reviewed read action runs once its required flags are present
(`audit`→`verify`, `pool`/`policy`→`status`, `mcp`/`secret`→`list`, `runtime`→`describe`,
`workers --scope <id>`→`list`); `handler` families act on their own (`identity` shows the current selection, people and
bindings); any other family lists its actions and names
the missing argument as the typed `CLI_ARGUMENT_MISSING` (exit 2). A default never mutates.
A scope picker on a terminal in a folder with no installation (no product directory or policy file, detected once by the
`scopes` choice source) answers the typed `CLI_INSTALLATION_MISSING` (exit 2) naming only `deckent init`; with an installation
but no scope to pick it stays `TERMINAL_SCOPE_REQUIRED`, and off a terminal `CLI_SCOPE_REQUIRED` is unchanged. Handler action words and catalog
actions are kept equal by a source test in both directions; the usage echo (`cliUsage`) and the composition signal list
(`SIGNAL_COMMANDS`) read or are pinned to the same catalog. No `planned` name is reserved today (`run list` and `policy scopes`
are implemented); a later reservation adds `planned: true`, and such a name is neither dispatched nor shown until its slice implements it.
Canonical help outputs have bilingual goldens and an 80-display-column gate, and every registration's
group, summary and detail must exist in both locales. New actions register metadata and localized details
in this catalog (A1/A3 `run close|resume` and `task accept|reject` are registered since batch 27);
no top-level help string is hand-edited. The `config` family keeps its lazy handler edge (terminal-render/Ink).
Help locale (owner 2026-10-03): explicit `--lang`, then `DECKENT_LANGUAGE` / `DECKENT_LANG`, then project/global `language`, then system locale/default. CLI ingress supplies the read-only `loadConfigLanguage` projection to the help recognizer. It reuses the config layer readers and version/language schema, preserves absent language, and does not initialize provider sections, resolve secrets, heal, write or lock. Invalid/unreadable language configuration silently falls back; unrelated execution sections are not validated by help. Explicit/environment locale skips the config read.
Help paragraphs are authored without soft line breaks; intentional blank lines and command lists remain separate.
Wrapping keeps bracket/angle tokens, flag-placeholder pairs and inline commands whole, and balances short prose tails.
Sub-help renders an optional `<detail-key>.examples` message (shared by the family); absent examples are omitted.
This is presentation discovery, not an authorization registry. Source-surface evidence does not establish
packaged-binary or cross-platform acceptance; the lane excluded build and full verify by owner direction (batch-27 integration runs full verify).

`deckent task mark-lost` (önce `close-abandoned`) bu dalgadan çıkarıldı (owner 2026-10-06, takip kartına ertelendi); `task` yardımı ve `tests/fixtures/cli-help/commands-{en,tr}.json` golden'ları dalga öncesi hâline döndü (`vitest run <dosya> --update`; `-u <dosya>` biçimi dosya yolunu değer olarak yutar). Yeni config alanları: `installation.machineIdentity.source`, `installation.requireMachineBinding` ([platform-and-layers](platform-and-layers.md)).

## Coding template authoring

`deckent coding template --provider <id> --kind <kind> [--image <sha256>] [--discovery disabled|repository] --preview|--apply`
adds a reusable native coding template (`native-coding-template@1`) without per-task model, prompt or effort through the existing
project config writer. `--json` returns profile, kind, proposed registry revision, preimage digest and (on apply) config write receipt.
`--lang en|tr` selects human output. Preview writes nothing; preview and apply use the same validated profile and add-only registry
proposal. Apply retains old rows, creates a registry revision and backs up the previous config. Repeating the same kind/profile is
unchanged; a different profile for an existing kind binding is refused rather than overwritten.

Configure `admission` (registry, poolId, executionSlots, inFlightSlots) through `deckent config set
admission` or `/config` first. The command does not invent pool capacity or evaluator policy. Configure
effective `execution.docker` limits and an immutable image; an optional image must have an admitted provider
pin. The CLI version and discovery selection are copied from one unambiguous admitted provider/image pin (an explicit
`--discovery` overrides the mode as a new template content id); absent or ambiguous pins refuse.
Apply requires the configured service/terminal scope and goes through project `ConfigApplication.set`: config/write allow-only
policy (approval-required policy returns POLICY_APPROVAL_UNSUPPORTED), digest compare-and-set, sealed audit and atomic
backup/publication. A stale project digest, a global registry contribution or changed effective Docker settings refuses publication.
This command does not launch, build, grant policy or prove image/worker readiness. This source slice is author-verified separately
from packaged CLI, independent review and live worker acceptance; evidence is in external RUN-HAZIR-KURULUM-2026-10-13/B-SABLON.

Checkout shaping (alpha.53 C2): a CLI without a suppression flag (Cursor) realises `disabled` by its worker
checkout. The native CLI registry's one `instructionSurface` list holds the default hidden paths (`name` at
any depth or `/root/path`; also the delivery floor for every provider, alpha.53 G1): `AGENTS.md`, `CLAUDE.md`, `.agents`, `.claude`, `.codex`, `.cursor`, `/DECKENT.md`,
`/.deckent/worker-instructions.md`); a template's `invocation.discovery.hiddenPaths` replaces them for that
project (new template content id). Compilation freezes the set into the pinned profile
(`nativeSubscription.checkout`); the Git broker clones sparse (non-cone, skip-worktree, clean `git status`);
patch capture reads the set from the Run's frozen profile and completes absent hidden paths from their base
blobs, so sparse and full checkouts give the same patch and a hidden path the worker writes stays a visible
change. Queue verification and integration checkouts stay full; a non-Git workspace has no checkout to shape.
This hides files from automatic discovery only; objects stay in the clone (`git show HEAD:AGENTS.md`).
Claude and Codex stay argv-only, so their compiled profiles are unchanged.

Worker instructions (alpha.53 F1): `deckent coding instructions [status] | trust | revoke [--target <id>] [--scope <id>]`.
Config `execution.workerInstructions.source` is `worker-md` (`.deckent/worker-instructions.md`, default when the file exists),
`agents-md` (`AGENTS.md`) or `none`; the file is read once per admission, bounded, from the commit the configured work target's base ref
names (alpha.54 R1; never the working tree; status and the card show `ref@commit`), or at the Git work target root without a configured target. `status` is read-only
(`--json` allowed). `trust` and `revoke` are decided on `config`/`write` for `project:execution.workerInstructions`, sealed before the
record changes, and need the person's terminal witness: a card shows path, size, sha256 and the first lines; AI actors, MCP, pipes and
`--json` are refused. Trust holds for exactly that folder and digest, with a work target that folder, ref and digest (alpha.54 REVISE 2738 R1; an
folder + digest record counts at a ref only when it existed as alpha.54 first opened the trust folder (sealed list), and a revoke there
ends that without removing the folder's own record); a change
makes it untrusted. Untrusted: workers get the task text
only and run create, MCP and `--json` carry `WORKER_INSTRUCTIONS_WITHHELD`.

Action arguments (alpha.53 D2): a catalog action may list `requires`; help prints "Required: …" (and "Required without a terminal: …" when a
terminal picker fills them). A handler's usage refusal of an action called without a required argument becomes `CLI_ARGUMENT_MISSING`
naming it (exit 2); a present but invalid value stays `CLI_USAGE`. Scope rules (D1/D4, `resolveCommandScope`): a read uses `--scope`, else the configured `terminal.scopeId`, and prints which scope answered; a
change never takes a silent default. Without a scope a person on a terminal picks from the valid scopes; a pipe, agent or CI gets
`CLI_SCOPE_REQUIRED` (exit 2) naming them. Queue and task refusals are typed errors, not raw schema output.

## alpha.55 switches

alpha.55 adds protected configuration switches for memory automation, Nervous, recovery and the agent statistics pass; no AI principal
or MCP actor may write them. The switch table, modes and defaults are in
[core layers](core-layers.md#one-rule-for-every-switched-layer-off-until-a-person-turns-it-on). The S3-3 key `models.headless.preview`
is retired: it still parses and is no longer offered.
