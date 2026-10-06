# Registry-driven config and CLI help — module note

ConfigApplication, CLI config surface, help catalog (moved from ARCHITECTURE.md Packages 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 618–689; text below is verbatim.

### Registry-driven configuration contract (CONFIG-SURFACE, owner 2026-10-02)

`engine/core/config` owns one typed `ConfigApplication`: inspect (all registered schema paths or one key), explain,
validate, set and unset. Fields, descriptions, JSON Schema type/enum/range/default, binding and apply mode derive from
`CONFIG_FIELDS` and `registerConfigSection`; there is no surface-owned key/schema list. The file adapter observes
project/global documents and effective default → global → project → env values. Secret provenance and credential keys
are masked before subtree selection; every string also passes through the existing shared redactSensitive matcher (tokens, Bearer credentials, URL passwords, key/value secrets and JWTs). Schema value annotations are masked too. Token resource counts stay visible. Raw JSON Schema conversion is cached per configRegistryGeneration with schema-derived paths (dynamic array indexes/record names share nodes); values, provenance and annotation masking remain fresh per observation.

Writes carry VerifiedPrincipal, scope, command id, explicit project/default or global target, and optional inspect
preimage digest (`--expect`; CLI `--expect absent` asserts no target document yet). Existing policy vocabulary adds `config/write`; first-run template v4 grants it to the
verified local owner. Global writes also require installation-wide delegation. Deny and require-approval fail closed;
config has no broker-supported approval subject yet (`POLICY_APPROVAL_UNSUPPORTED`). Terminal `/config` is read only.
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
explain/validate/set/unset with safe numeric array paths and splice removal. Terminal `/config [key]` and monitor's
read-only Config tab/`monitor --config` use the same inspect operation. Monitor config concerns its current project;
other installation snapshots do not grant config authority. A failing Config read shows a typed unavailable state without discarding successful Run/worker refreshes; recovery replaces it with fresh config. Tab help derives its index from the active tab registry. CLI explain uses the project/effective view and refuses --global with CLI_USAGE. No runtime protocol/ledger version change is required.
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
Top-level help lists command families by purpose; developer families require `--help --all`. Details
and registered children are exposed by `deckent <command> --help [--lang en|tr]`; common flags appear once.
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

`deckent task mark-lost` yardımı EN/TR katalogdadır; sub-help özeti kardeş kalıbında tek satırdır ("Hold a launched attempt whose worker is lost (unknown outcome)" / "Çalışanı kaybolan başlatılmış denemeyi tut (sonuç bilinmiyor)"), reconcile yetkisi `cli.help.task` kullanım metnindedir; `tests/fixtures/cli-help/commands-{en,tr}.json` golden'ları `vitest -u` ile yeniden üretildi (2026-10-06). Yeni config alanları: `installation.machineIdentity.source`, `installation.requireMachineBinding` ([platform-and-layers](platform-and-layers.md)).
