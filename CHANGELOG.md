# Changelog

Human-curated. One line per landing, keyed by PLAN.md card id. No product code writes this file.

## Unreleased

- K1-F1/C: pure config-fields unit, registry-backed output defaults, canonical nested provider fields, localized metadata with tier/since, and source-derived config vocabulary checked before lint/build. Accepted (Fable REVIEW1323); parent K1-F1 closed with REVIEW1316. Host-sizing constants remain ASSURANCE work.

- K1-F1/B: config schema, defaults, environment bindings and metadata now derive from one field registry. Removed legacy config aliases, migration command, execution-style/routing-version selectors and home-path fallback. Unregistered fields are rejected; worker capacity accepts safe positive integers without the old100 ceiling. Existing secret/write-lock checks retained. Independent Fable PASS in REVIEW1316 (84 product +9 host tests); parent K1-F1 remains open.

- Owner correction: legacy aliases/config compatibility proposals withdrawn; execution-capability source audit precedes new contracts.

- K1-F1/A (review): grouped config inventory and migration examples; record owner task/run/do/autonomous/Mission semantics, modular task kinds, illustrative capacity and IFS Cloud MCP plus Applications 10 native integration direction; product behavior unchanged.

- HOST-SETUP (accepted, Fable REVIEW 1298): share the refactor skill across Codex/Claude/Cursor, preserve legacy operator cwd and Next product destination, and require small Turkish-explained slices with owner checkpoints; exclude local permissions, secrets and legacy runtime bindings from migration.

- HOST-SETUP (accepted corrections): remove five owner-disabled skills; align Markdown contract; restore legacy memory sync and safety rules; Next destructive-command prompt rules; ACK preserves review debt; document lock recovery and unmigrated legacy Cursor lane. Live Codex delivery independently verified in REVIEW 1298; Windows/macOS remain outside this acceptance.

- FOUNDATION (decision only, 2026-09-17): record owner-accepted product/layer transition, deterministic storage and customer query boundaries, worktree/sandbox/effect isolation, module/version compatibility, Core/private Enterprise distribution, retained TypeScript and conditional Go. Add ordered implementation/acceptance rows; preserve existing WIP and prior evidence. Runtime and gate changes remain pending.

- PLAN: K1-F1 (config schema-as-data, owner finding: flow-value literals in defaults) and ARCH-IMPORTS (`#pkg` aliases) cards; both precede K2 landing.

- K2 (review): port 3,374 exact-list legacy keys into ten bilingual JSON families, preserve 444 K1 keys and add tui.switch_unavailable; synchronous immutable registry, manifest defaults, renderer-safe translation and duplicate/placeholder gates; 13,496 oracle comparisons match. Existing CLI help/version format differences are recorded for review.

- PLAN: CL1 closure/settlement ledger card written (Fable); host-scoped custody, single HMAC audit primitive, cross-host UNSUPPORTED in 1.0.

- PLAN: Backlog section — 25 owner-admitted product outcomes triaged from the legacy MASTER-PLAN (286 candidates), with package/tier, dependency card and absorbed legacy ids.

- K1 REVISE: mask resolved config secrets in both CLI formats; recover stale writer locks with owner diagnostics and preserve live/foreign ownership; package-owned API auth validation, scoped cache inputs, stable doctor tenant view, injected state paths, and removal of unused orchestration validators.
- ARCH tiers gate: enforce tier direction, unit APIs and layout for kernel/providers/surfaces; register base defaults into core; move catalog and CLI entry paths; forbid provider credential env literals outside registry; build before real-binary tests in local/CI verification.

- K1: kernel config v2 with package-owned strict sections, safe migration/global writes, platform and tenant isolation, immutable localized error registry, shared output/exit policy; real CLI `config get`, `config migrate`, and kernel `doctor` wired for review.

- PLAN: K1/K2/R1 port cards written (Fable); W1 (win32 trusted loader authority) added; card location documented.

- K0: repository skeleton — package layout, `arch.json` contract, `lint-arch`, eslint size rules, build, CI, i18n kernel, CLI `--version`, first contract/e2e tests, harvested invariant catalog (`tests/contracts/HARVEST.json`, 40,828 titles from legacy HEAD 509fffa64).

- FOUNDATION/A (Fable PASS1340): shared 1,500-line source cap, 800-line design target, native/app coverage and monotonic build duration.

- PATH-LAYOUT/A+B (Fable PASS1349): consolidate durable roots and resource paths; replace plaintext secret-file reads with per-load secret resolution and redaction. No data migration or sandbox claim.

- FOUNDATION/B + PATH-INSPECTION (Fable PASS1357): native package boundaries, explicit CLI composition, domain import guard and shared path query; alpha.2. Unimplemented MCP binary removed.

- PATH-LAYOUT/C (Fable PASS1358): fixed project config locator, configurable durable root/resources and inspectable frozen layout revision; no implicit migration.

- CONTRACT/A (Fable PASS 1365:2a96fe9cd2db): pure task graph admission and dependency readiness.

- CONTRACT/B (Fable PASS 1366:e0b7a3ec4620): versioned attempt evidence and application transitions.

- STORE/A (Fable PASS1375): real attempt application + SQLite transactional snapshot/receipt, restart replay, scope separation and conditional revision updates. Production composition remains pending.

- CONTRACT/C (Fable PASS1378): signal termination and stale observations, shared bounded identity/counter primitives and sanitized validation paths; SQLite uses shared identity comparison. Combined126-test verify passed.

- FOUNDATION/C (Fable PASS1382): pure colocated metadata artifact; lint/build reject stale manifest projection; renderer forbids runtime package.json dependency.

- STORE/B (Fable PASS1389/1390): bounded native SQLite lock waits, explicit journal/durability options, typed BUSY and conservative unknown rollback outcome; separate-process contention proof.

- STORE/C (Fable PASS1396): layout-selected ledger opening with private file checks and shared validated storage settings; no automatic migration or permission repair.

- STORE/D (Fable PASS1397): separate-process tests prove DELETE commit rollback under reader contention and WAL writer progress with reader snapshot.

- SUPERVISOR/A (Fable PASS1398): bounded Docker execution, retained terminal evidence/replay and explicit release; real deadline/cancel/filesystem-boundary tests. Not EXECUTION/DOGFOOD completion.

AUTH/A PASS: v2 command rejects caller identity; verified scope and authorization precede replay/store. Local OS verifier is direct-process only; remote policy and stable installation issuer remain gaps.

WORKSPACE/A PASS: private pinned Git checkout with copied objects and replay-safe lease. Real Git and Docker tests passed; layout binding, dispatch custody, history policy and allocation recovery remain gaps.

WORKSPACE/B PASS1415: shared managed-directory preflight and configured workspaces registry;149 tests including real Git→Docker isolation. Independent source-repository authorization and per-test container custody checks remain.

DISPATCH/A PASS1416: atomic one-time launch claim, unresolved custody retained, Next SQLite schema1→2 preserves attempt/receipt data.150 tests; downgrade unsupported. Signal result parity and unresolved inventory remain.

DISPATCH/B PASS1417: authenticate/authorize every execution/replay/release; durable claim→supervisor→terminal record; real Docker release then replay does not rerun.152 tests. Atomic Attempt projection and retained-artifact release gate remain pending.

DISPATCH/C PASS1419: read-only daemon observation and separately authorized reconciliation settle exited containers without relaunch.154 tests; active-worker recovery/cancel and concurrent finish enrichment remain pending.

DISPATCH/D PASS1422: engine/domain terminal projection and dispatch terminal persist atomically;155 tests including injected transaction rollback. Task acceptance and artifact durability remain separate.

DISPATCH/E PASS1428: shared exit cause and field-wise request equality;161 tests. Transport interruption is read from dispatch evidence, never inferred as a process signal.

DISPATCH/F PASS1429: execute/reconcile merges only compatible unknown→known interruption evidence;164 tests. Future metadata must preserve canonical outcome and have explicit merge tests.

ARTIFACT/A PASS1430: scoped content-addressed POSIX store and configured artifact layout;163 tests. Authenticated callers, retention/GC/encryption and production maxBytes config remain required.

ARTIFACT/B PASS1437: attempt-bound retained output is mandatory before container release;171 tests. Missing/partial/oversize output remains explicit operator work; no silent cleanup.

ARTIFACT/C PASS1438: bounded per-container local logs, explicit capture completeness and authorized partial recovery;172 tests. Blocking log backpressure and partial-history release policy remain open.

CANCEL/A PASS1439: durable cancellation actor/intent precedes actual Docker kill;174 tests. Created/start race and post-controller-crash watchdog remain open; cancellation request is not terminal proof.

RUNTIME-CONFIG/A PASS1442: shared runtime/artifact policy schemas and one-snapshot composition;176 tests. Execution defaults disabled. Source authorization, localized composition errors and output/artifact budget consistency remain before public ingress.

POLICY/A PASS1447: verified principal/scope/action/resource grant checks and deny-only restrictions;179 tests. Admission decision evidence, shared action catalog and measured cache policy remain pending.

INVENTORY/A PASS1448: bounded authenticated keyset inventory without argv/workspace data;181 tests. Moving ID order is not claim chronology; artifact completeness/owner liveness and public inspection budget remain pending.

POLICY/B DONE: pinned-layout, owner-checked fresh file policy; 184 tests/12 Docker; Fable1455 PASS. Before DOGFOOD resolve layout registry revision/upgrade compatibility; installation must separate administrative policy ownership where required.

INVENTORY/C DONE: inspect existing managed files without creation/permission repair; 183 tests/12 Docker; Fable1457 PASS. POSIX trusted-host preflight remains non-atomic with subsequent database opening.

INVENTORY-B: Read-only SQLite inventory reader; exact rebase preserves policy exports;189 tests/12 Docker.

INVENTORY-D: Configured local inventory query;191 tests/12 Docker; public binding awaits policy-derived membership in INVENTORY/F.

INVENTORY-E: Readonly WAL missing-shm failure is typed, without immutable fallback;192 tests/12 Docker. Native corruption classification remains follow-up.

INVENTORY-F: Inventory scope membership derives from trusted policy, not project config;195 tests/12 Docker. Future public execution must use equivalent trusted membership.

INVENTORY-G: Shipped read-only CLI/SDK inventory parity;198 tests/12 Docker. Follow-ups: signal/code labels, narrow text layout, config locale/output-mode, catalog prefix lint.

RUN-A: Pure revisioned Run graph/progress/attempt bindings;199 tests/12 Docker foundations. No durable store or acceptance closure claimed.
