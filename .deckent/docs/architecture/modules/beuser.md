# BeUser B1 source integration

B1 shipped in alpha.57 (live 2026-10-29). The mechanism walks end to end on the host; the first walk (walk16) ran three journeys and all three were red, so no journey is accepted yet.

| Responsibility | Source mechanism | Production/acceptance boundary |
|---|---|---|
| Identity and policy | Domain BeUser contract v1; system-policy-rows registry 1/1; narrow evaluator workload floor | Template remains 18. Fresh install includes the data revision in the original publication targets and plan digest. Upgrade publishes template and data together through the authority writer, with sealed audit and a data-bound expect token. Committed replay retains its original exact-byte check; later governed edits require upgrade. Deleted permissions stay deleted; read/startup never grants rows |
| Realm | BeuserRealmApplication and DockerBeuserRealmRuntime | Private reopenable Attempt custody, full file-manifest verification and streaming transport are wired. Destruction needs pinned kernel process/cgroup absence and explicitly sourced filesystem proof (owner amendment A, 2026-10-29); missing evidence remains quarantined |
| Terminal | C3 Python stdlib PTY plus pinned xterm headless/Unicode 11 | Private boot v1 uses one packaged `boot.schema.json` for the C2 producer and both Python modes: `entry`, exact `commands` tuples, bounded resources and opaque `secretFds`. Both ends reject missing/unknown fields as `BEUSER_SURFACE_INVALID` before launch. Packaged `.py`/`.json` assets and private channel are wired. The opaque secret FD producer and verified reset remain open; capture stays fail-closed. Real terminal proof is C7 |
| Controller | C4 campaign, bounded execution/model budget, reliability and supervisor wrappers | C2 created observations reach admission without pretending to carry containment proof; admitted observations still require evidence. Every completed or interrupted walk reads controller A audit and sealed approval records through verified ports after cleanup. Any authority write or approval decision attributed to its BeUser identity invalidates the walk; no time cutoff silently excludes a retained violation. Attributed authority writes or approval decisions invalidate the walk and use the existing refusal/Nervous feed; missing, unreadable or over-bound evidence remains unknown. Verdict readback follows proven outer cleanup; quarantine has no verdict readback. Configured Run admission, task-bound reservation ids and C4 supervisor dispatch are wired. A dry admission exercises the real ledger and pool without a realm or model |
| Evidence | C5 transcript/readback, installed beuser@1 evaluator, retained-output verification, report schema | Existing TaskEvaluationApplication owns acceptance. Every BeUser criterion returns the combined outcome/authorization/safety verdict, including calibration and cleanup gates; a selected diagnostic dimension cannot bypass RED or unknown. harness-readback metadata is carried by metrics and DeliverySummary without relabelling; the human acceptance renderer names harness readback in EN/TR |
| Common consumers | Root exports and architecture registry; localized errors; sealed identity forwarded to BackupApplication and startup ledger upgrade; real BeUser audit feed consumed by Nervous | Target refusal rule remains provisional, no live promotion or recovery grant |
| Report | formatBeuserReport validates one strict document; locale-free JSON, TR/EN human text, null measurements, named unknown/unwalked branches | The CLI host binds walk and read-only report to production composition. Reports are private, persisted per scope/Run, with a per-person latest locator and Run inspection authorization. Installed journey profiles select candidate manifests and finite limits; they cannot select a caller principal. Real realm/readback/calibration proof remains C7 |

## Isolation and effect settlement

The installed journey profile declares its CLI tuple in `entry.args`. One composition projection binds
that tuple to the realm recipe's packaged CLI entry, using the journey id as its command id, and feeds
both boot `commands` and the exact surface catalog. An argv walk starts that trusted tuple before any
read; the walker still receives only look/type/press/wait and cannot supply executable paths or argv.
Argv profiles without arguments are refused at admission. PTY walks retain their initial look.
The local regression uses this projection, the production channel producer, surface and real Python
driver with a substituted Docker transport; it does not establish assembled realm acceptance.

Persona behavior is separate from principal authority. The outer caller uses existing Run admission;
the internal evaluator rechecks the full own Attempt/generation/realm/nonce binding. Model selection,
activation, budget and cancellation stay on the existing invocation path. Core does not gain a second
scheduler, acceptance writer or module-specific effect flow. ERP/CRM adapters can supply general
acceptance subjects and durable readback without Git or a test suite.

Model preflight reserves the provider-measured prompt count plus the completion limit through the
existing invocation measurement port. A local OpenAI-compatible profile can probe same-origin
`POST /tokenize` with the exact bound model, messages, tools, template options and
`add_generation_prompt: true`; a valid typed count establishes availability for that request.
Missing endpoints, rejected models, invalid counts, cancellation and bounded timeout leave no measured
count, so BeUser refuses before inference. Local zero-tariff calls keep zero monetary cost.

A sealed realm cannot export, back up or restore its ledger, even inside the realm. Required-backup
uninstall branches remain named unknown. Unsupported private systemd branches remain unknown and do
not block alpha.57; host Docker/D-Bus sockets, host HOME and additional privileges are never a workaround.
Uncertain cleanup retains quarantine/unknown; Docker rm exit alone is not destruction proof. Persistent cancellation, reconciliation and output recovery select the recorded adapter/version. BeUser v1 reopens its exact realm custody and original grant-derived evaluator identity, without a surface, model or launch; unknown adapter/version is a typed refusal. The BeUser walk binds its supervisor-profile validator when recording dispatch. A recovered realm without a terminal receipt remains execution-unknown after proven destruction; no exit code is invented. Its exact container absence can be consumed by the existing lost-dispatch recovery owner.

## Limits and remaining proof

The limits registry contains one `b1-dogfood-provisional-1` profile. Its finite ceilings are provisional
planning bounds, not measurements, model spend permission or a capacity claim. C7 owns measurement
and replacement. Each model call reserves the invocation adapter's measured prompt count, including
the served template, plus the requested completion cap. A missing, unsupported or failed counter
refuses the call as `BEUSER_LIMITS_UNAVAILABLE` before inference; a byte-based estimate cannot admit
a strict token reservation. The preview, count and send retain the same profile pin. An envelope that
exceeds the configured or provider-reported window or remaining budget is refused before invocation. Valid final provider usage can reduce
only that call's token reservation once; missing or uncertain usage retains it, and an overrun refuses
without widening the bound. Call counts and monetary reservations remain consumed. A typed local
profile with verified literal-loopback/zero-tariff evidence is accepted at zero cost; paid profiles
still require a quote in the envelope's currency. Existing invocation authorization and fresh
profile/spending pins remain authoritative.
The controller audit scan is limited by the recorded BeUser byte/time bounds; an incomplete scope scan remains unknown. Recovery uses current local management access with the retained profile/custody; missing kernel/cgroup custody or unavailable accepted filesystem proof stays quarantined. The real calibration cohort remains open. Author source wiring and dry admission do not prove an assembled journey.
The current final-state probe observes installation existence; preserved-data, card, receipt-location,
forbidden-effect and target lifecycle summaries remain unknown. Only a single final readback reference is
admitted. The secret FD producer/reset, full milestone probes and measured call/cost/reliability evidence
remain explicit gaps; none is replaced with success or an unrestricted host command. Reports retain null
cost when no verified amount is available. No live, hosted, other-platform or independent acceptance is claimed.

## Execution profile installation

The distribution contract hashes every mounted file, including dev-release v1 `manifest.json` and
`release.json`; neither metadata file is exempt from BeUser verification. For a staged dev-release,
the complete unpacked inventory in `manifest.json` supplies required paths and hash/mode pins, bound
by `release.json` schema v1, package version and manifest hash. Both metadata records are measured
with the same bounded, stable regular-file reads. A partial or corrupt pair refuses measurement.
For an ordinary npm package, literal `package.json.files` declarations remain required. Native
artifacts ship inside `dist`; no root `native` directory is declared by new packages. An older
stage's npm inclusion list may still name that absent directory; its complete unpacked inventory
is the installed-file contract. Missing inventory files remain `declaredMissing`; changed bytes or
modes refuse measurement. The pinned full distribution verifier still rejects missing and foreign
files, including files outside npm's inclusion list. These byte checks grant no release authority.

Distribution content admission uses the canonical redaction registry's `gate:true` and gate-only
credential patterns. Its private-key `distributionSource` requires an encoded body, including
escaped newlines in source literals; a vendor's header-string constant alone is not key material.
The generic key-value classifier remains in record redaction and is not a distribution rule.
This scan detects credential formats, not all secrets or credential validity; unprefixed generic
config values are outside this distribution scan. Record redaction and worker-tree rules are unchanged.

`deckent beuser setup --profile <path> --scope <id>` previews a bounded admission document on the
person's terminal; `--apply` displays its content and digest on a person card, and `--json` returns
the same result as structured data. The document uses the existing admission schema: `poolId`,
`executionSlots`, `inFlightSlots`, `ordering` and `registry`. Its profiles must all use `beuser@1`
and the existing strict journey profile contract (journey/persona/rubric pins, typed candidate
manifest reference, finite limits revision, explicit walker/evaluator choices and launch/probe data).
A profile author supplies this document; setup does not fabricate missing journey or model data.
The packaged [B1 example](../../../../assets/beuser/setup-profile.example.md) builds one
provisional document for the named journeys from installed references and the measured candidate:
each journey's first branch and persona, that branch's own probe set and a v3 start state naming
the branch's catalogued states, printing those it does not arrange with their reason. It carries no host paths
or credentials and does not claim complete journey coverage.

Journey profile `schemaVersion: 2` replaces inline `files` with `candidateManifest`:
raw manifest `sha256`, complete measured `fileCount` (including both metadata files),
`sourceCommit`, `sourceTreeSha256` and package `version`. The candidate's staged
`manifest.json` remains the full hash/mode inventory. Setup, walk admission and realm
creation share the same loader: bounded stable package measurement recomputes the
manifest digest, checks file count/package measurement and source identity against
both release metadata and the manifest-pinned build identity, then runs the existing
full distribution and credential verifier. Any mismatch returns localized
`BEUSER_CANDIDATE_MISMATCH` before launch. Neither metadata record is excluded.
Old inline journey profiles must be regenerated; generic JSON guards, supervisor
adapter v1, binding/evidence contracts, ledger and protocol versions are unchanged.

The composition validates the candidate manifest and requires both selected model roles to have an
active, configured invocation reference. It creates no model role, activation, provider, credential
or policy permission. `ConfigApplication.submit` owns the protected `admission` write, including
policy, the person's terminal witness, compare-and-set and sealed audit. The existing installation
pool owner provisions the matching pool separately; a failed pool step is returned explicitly and
can be reconciled by repeating setup. An equal registry is not rewritten; a different existing
registry or pool is refused for governed reconciliation. `beuser.*` remains a protected root;
execution profiles continue to live in the general execution registry.

Missing walk profiles return `BEUSER_PROFILE_REQUIRED` with the setup next step. A missing report
directory or record returns `BEUSER_REPORT_NOT_FOUND` with the walk next step. Corrupt records,
unsafe paths and access failures retain their refusal instead of becoming an empty report.
A failed harness preparation closes its execution-budget timer before returning the refusal, so an
unavailable Docker prerequisite does not keep the CLI process alive until the walk deadline.

Walk reports retain the typed root refusal separately from unproven cleanup; EN/TR explanations use the error catalog, never raw adapter messages. Only cancellation or an actual deadline sets an interrupt cause. Critical coverage includes selected personas with no verdict as unknown, even before the first screen; unknown coverage does not imply that the persona walked. Older retained reports remain readable and are not rewritten.
When package verification refuses before publishing a realm handle, the existing identity-bound private
record retains the reason and cleanup state with a null process result. Dispatch remains unresolved;
no handle, exit or destruction proof is invented, and replay does not launch again. Typed surface
failures share the engine's finite BeUser error contract, so production look/argv refusals retain their
catalog code without trusting arbitrary exception codes or messages. Recorded management reads the
same optional reason/cleanup metadata and still requires actual handle and terminal evidence.

## Start state (profile v3, alpha.58)

Journey profile `schemaVersion: 3` requires `startState` (`schemaVersion: 2`, the installed
`catalogRevision` and the branch's start state ids, normally its `initialStates`); v2 profiles stay
valid and start in today's unarranged realm. The versioned catalog
[`assets/beuser/arrange.json`](../../../../assets/beuser/arrange.json) (revision `beuser-arrange-2`)
holds `kind`-discriminated steps and one entry for every start state the installed journeys name.
A state either names its steps, carries a typed unknown reason (`witness-required`, `realm-external`,
`driver-limit`, `no-producer`, `enterprise-only`), is established by the persona during the walk
(`cancel`), or is a profile fact (persona language or accessibility: `tr`, `en`, `narrow-terminal`,
`screen-reader`) checked when the profile is read. Invariants are code: a `cli` step is an exact
product argv tuple carrying `--json`, without control characters; `file` and `git` steps act only on
relative paths inside the realm work target (no empty, `.` or `..` segment); `git` runs only `init`,
`add` or `commit` and refuses repository, config, helper and template options; a `check` step has no
effect. Duplicate steps, unknown state ids and unresolvable references refuse the catalog or the
profile (`BEUSER_INPUT_INVALID` at setup, admission and walk), and so does a profile fact the persona
does not have.

The engine plans a branch purely from the catalog: each step once, in branch order, plus the states
it does not arrange with their reason. After realm admission and before the persona's first look, a
branch with any typed-unknown state stops as `BEUSER_START_STATE_UNREACHABLE` before any effect, so
the persona never walks a different start state than its rubric names; otherwise each step runs
through `BeuserArrangePort` and is gated on its own readback. The port's target is the admitted
binding, not a realm; the first adapter (`createBeuserArrange`) runs over `docker container exec`
without `--interactive`/`--tty`, with explicit `--user uid:gid`, `LANG`/`LC_ALL`, realm HOME and
workdir, through a fixed in-realm wrapper whose child has `/dev/null` stdin and pipes only. A `file`
step creates missing parents (0700), writes without following a symlink, refuses a symlinked parent
and sets the catalogued mode; a `git` step runs with a fixed fixture identity, no system or global
config and no prompt. Readbacks are read-only observations in the realm: the installation through the
target's own identity adapter, a path's type, mode and digest, whether Git tracks a path, the absence
of the target's own runtime socket and whether the target can prove its install method; every field a
readback names must match. The adapter never uses the PTY driver: anything sent through the driver is
person-equivalent for the product's terminal witness, so a witnessed command honestly refuses here.
Step count is bounded by `maxSteps`, and a step timeout must stay below `maxWaitMs`. A non-zero exit,
a timeout or a readback mismatch stops the branch as `BEUSER_START_STATE_UNMET` before any persona
action. Both codes are unknown, never RED or a refusal audit, with no retry and cleanup unchanged.
Each step leaves one transcript row of kind `arrange` (contract v2) with the step reference, the run
result (exit code, stdout size/digest, or none for a `check`) and the readback result; target output
is never retained. `arrange` rows carry time 0 (setup precedes the walk clock) and are not persona
actions or screens: they neither consume the step bound nor count as walked, persona evidence is
looked up by the surface's own reference, the evaluator model cannot cite them, and a RED stuck
finding does not cite them. The walk report lists every start state a branch did not arrange, with
its reason (`unarranged`), next to the branch's unknown code.

Catalog revision `beuser-arrange-2` arranges, each measured in a disposable no-network realm-equivalent
container against the built package: the installed state (`init --yes --scope beuser-realm --json`,
relying on the kept headless first-install decision U4E: uninstall `T1`, self `fresh-own-installation`
and `missing-model-or-realm-or-binding`); a Git project with a tracked file under `.deckent/` (`T3`,
and with a user README `sealed-owner-like-fixture`); an unknown file under `.deckent/` (`S10a`); a
stopped service (`S1`, runtime socket absent); a second installation in `second-project` via
`init --here` (`S13`); an unreadable ledger (`S19`, mode 0000); an unsafe authority file (`S20`,
`policy.json` mode 0666); a hand-made launcher in `home/.local/bin` (`S22`); an unproven install
method (`S24`, the package is not under an npm prefix); an empty cache (scratch and tree-scan cache
absent); a fresh home, session and no prefilled model or consent (installation and global home
absent; also `model-unavailable` in the network-less realm); `docker-unavailable` (no Docker socket);
`existing-folder` (a user file); and `assembled-candidate` (`/package/manifest.json`, verified at realm
admission). States that need a person's witness, lie outside the sealed realm, need a driver mode the
PTY driver cannot give, have no witness-free producer, or belong to Enterprise stay unknown with that
reason; no flag or PTY step bypasses the witness. An ERP/CRM journey adds its own fixture step kind
and adapter through the general effect contract without changing Core.

## Walker/evaluator model output

The versioned English instructions in `assets/beuser/model-instructions.json` are
system messages. Persona, goal and redacted screen remain data in the walker user
message; sealed rubric and harness evidence reach only the evaluator. The model
binding can explicitly declare `response-format-json-object` v1 as `supported`
under `openai-chat-completions` v1. BeUser then requests JSON object output through
the common governed chat command; chat sends `response_format`, while the Responses
dialect sends `text.format`. No support is inferred from an endpoint or model name.
Bindings without that capability retain instructions and strict local validation;
existing connections require a governed catalog/binding update to declare support.

The codec accepts one complete object or one complete `json` fence and validates
exact action/assessment fields. Separate provider reasoning is never an answer;
unmarked inline reasoning, prose, extra keys, multiple objects, truncated output
and evaluator references absent from the transcript are invalid. Format failures
carry `BEUSER_MODEL_OUTPUT_INVALID` in EN/TR. Corrections send only that typed error
as feedback, consume the existing call/token/cost budget and walker step/patience
bounds, and retain the admitted deadline. There is no extra retry limit or model
substitution. Invalid actions never reach the surface, and model assessments do
not replace harness readback or the existing acceptance owner.

## Interrupted walk diagnostics

The surface records every walker action before sending it, including look and bounded wait
(duration included). Typed plaintext remains omitted and secret-step capture stays blocked.
Each redacted event is retained separately; the private terminal record's optional version-1
`diagnostic.trace` maps transcript references and kinds to immutable artifact hashes, including
walks whose acceptance evidence could not be finalized. Recorded supervision reads the same
optional schema; older terminal records and reports remain readable.

The same key or text on the same screen stops on its second repeat, before a third effect (walk17
S2, 2026-10-29: a first repeat may be a key the product swallowed); `look` and `wait` are observation
and never count, so a walker that only observes ends at its patience bound (unknown), not RED. Each
walker call carries its own last three actions (typed text withheld) and whether its last action left
the screen unchanged. A stop's friction event retains the blocked
proposal as metadata (typed plaintext omitted) and identifies its screen. The walk report's optional `findings`
contains a named `persona-stuck` RED diagnostic for that branch/persona with the last redacted
screen, its transcript reference/digest, controller validity and event artifact references.
This reports an observed failure to progress, not a proven product root cause or acceptance
verdict. Cleanup uncertainty remains separately unknown; the diagnostic grants no authority,
calibration, safety pass or independent acceptance. Only retained screen observations count as
walked; missing verdict coverage remains explicitly unknown.


## Realm destruction assurance (owner amendment A, 2026-10-29)

Before storage inspection, the adapter writes kernel snapshot v2 with exact binding/incarnation,
container ID, PID/start time, an observed container cgroup and host namespace identities. Storage
observation cannot discard this record. Reinspection never replaces the original pin. Legacy pins
remain readable for direct kernel filesystem proof; missing pins cannot be reconstructed after removal.

A merged root observed through the guarded canonical path keeps the existing direct absence rule.
If that root is unavailable at capture, destruction requires both pinned process and cgroup paths
absent, the same captured local daemon identity, typed `No such container` for the exact ID, and an
empty `container ls --all --no-trunc --quiet` result for the exact incarnation label. A failed daemon
query, changed daemon, surviving process/cgroup, listed incarnation or missing pin stays quarantined.
An originally observable root never falls back to daemon assurance after a later read failure.

Removal artifacts v2 retain `filesystemAbsent` only for direct filesystem observation. The separate
`filesystemProof` v1 source is `kernel-proven`, `daemon-attested` or `unknown`; the realm decision,
private custody, walk/terminal result and persisted report preserve it. Human reports label both
assurances in EN/TR; legacy documents without the optional field remain readable without inventing
an assurance. Daemon attestation describes the daemon-managed container lifecycle, not secure disk
erasure, independent observation of every storage object, or absence of open mounts/file descriptors.
It proves no ERP/CRM business result and grants no recovery for existing pins-less quarantines.
Author fixtures are not assembled-host, independent-review or release acceptance.
