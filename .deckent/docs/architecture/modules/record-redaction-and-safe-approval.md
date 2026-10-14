# Record redaction, terminal S06 and SAFE-APPROVAL-A1 — module note

Section "Current closure — 2026-10-05" of ARCHITECTURE.md; its product contracts stay in force (landing evidence is in COMPLETED-PLAN).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 3360–3371; text below is verbatim.

## Current closure — 2026-10-05 (main’e indi)

CI + Batch34 + Batch35 + SAFE-APPROVAL-A1, PR #2/#3 üzerinden main `8b33f9d8` içinde; tamamlanan kanıt COMPLETED-PLAN 2026-10-05’tedir. Aşağıdaki ürün sözleşmeleri korunur; eski kaynak/compiled/native/hosted kimlikleri sonraki birleşimi veya canlı kurulumu kabul etmez. DOGFOOD/N1/provider aktivasyonu ayrı yetkidir.

The corrected canonical record redactor restores the legacy nonempty Bearer mask for RECORD only through optional recordSource in the same pattern table. DECISION, raw pattern counters, hasSecret and standing authority continue using their original default matchers. The opaque per-operation KnownSecretSnapshot has a required pure recordSpans matcher in canonical and standalone generated producers. It retains raw known matches and adds same-snapshot named-label attribution; real raw-known overlap takes priority. That is attribution, not authenticated provenance of arbitrary label-shaped text. Unknown labels and no-snapshot Bearer values stay anonymously masked. Config inspectors and human/JSON/error surfaces consume the same canonical record path; existing 11-character Config oracle remains unchanged. Earlier missed short-Bearer and repeated-marker failures remain in immutable proof.

Terminal S06 projects complete source fields before display cuts: record mask, terminal-control guard and record mask again for reconstructed text; complete preview/assistant source and source-derived hidden-marker metadata precede omission. Original stored/history fields stay raw. Streaming future splits and upstream already-lost text are separate open scopes. Exact hidden classification and prose visibility are distinct; host Unicode property data is not declared universal across runtimes.

SAFE-APPROVAL-A1 uses private ephemeral WeakMap custody for complete display fields keyed by the existing frozen ledger notice. Public ledger/bridge/history schemas receive catalog placeholders; raw display data, capability, revision and original action identity never move into that presentation sidecar's public output. Existing Workline Provider supplies the actual canonical snapshot to private children. Fixed DECISION projection, control guard and DECISION projection precede field cuts and exact marker rendering; credential-like pattern counts are informational and do not grant approval or become confirmed-secret claims. The public approval-presentation unit renders completed projection data; the corrected cancellation adapter preserves the original DTO callback/revision/once-only action ownership. No new operation, runtime protocol, secret resolver, persistence or approval authority is introduced. Actual fixture-backed Workline tests establish current dynamic re-projection and original action/refusal/cancellation ownership for the accepted A1 input. A later snapshot cannot retract already printed Ink Static history; secrecy before snapshot knowledge is not claimed. Private WeakMap clone and bridge-tail injection negatives remain source-trace-only because no test-only raw getter or injection seam is exposed. Public placeholder clone/bridge and history separation are tested. PR #3 kaynak inişi COMPLETED-PLAN 2026-10-05’te kayıtlıdır; canlı kabul ayrıdır. Original A1 public raw-lines REVISE and failed fixture receipts remain historical proof.

CI-R7 ve devamındaki PR #4/#6 düzeltmeleri üretim güvenlik kapılarını gevşetmez; tarihsel koşumlar COMPLETED-PLAN 2026-10-05’te, kalan CI-DEBT PLAN’dadır. Eski 6/6 veya hedefli yeşil sonucu güncel main/canlı kabulü değildir.

## W12 SECRET-REDACTOR remaining — author candidate, 2026-10-10

RECORD now matches registered known values across inserted LF/CRLF line breaks as well as exact multiline values.
DECISION retains exact bytes, match counts and approval semantics. The generated standalone worker shares this canonical record matcher.
The opaque snapshot adds `pendingStart`; it exposes only a suffix offset, never known values or a serialized registry.

A pure per-field record stream holds unresolved known prefixes and open credential atoms/headers before irreversible output or display cuts.
The retained lookback is at most 4096 UTF-16 units. Overflow emits one anonymous mask and withholds the rest of that field through its end;
this deliberately sacrifices that record's remaining presentation rather than leaking a long unresolved value. It is not a secret-length
admission limit. Known prefixes may include newlines. Stable terminal-control boundaries allow complete visible lines to commit early;
an open escape remains buffered, and projected reconstruction is checked before committing. Live previews mask unresolved known prefixes
and incomplete credential-shaped atoms. Answer, reasoning and active-tool output use separate state; a new call/turn resets it.
Only RECORD presentation uses this mechanism; raw agent/history messages retain their existing custody, and approval DECISION stays unchanged.
A snapshot is pinned at turn entry; text printed before a secret was known cannot be recalled.

MCP result text is masked whole before its UTF-8 display cut. Agent audit summaries and tracked-path copies are masked before bounds,
while action inputs, argument digests, principal/scope and seals retain their original contracts. Desktop contract snapshots clone and mask
notice/worker display fields and serving labels before export; chat remains excluded and routing identities stay intact. The terminal snapshot
command supplies the loaded config's existing opaque snapshot. No new resolver, cache, protocol, store schema or approval authority is added.

Author proof: external `proof/REDACTOR-REMAINING-2026-10-10/`. A fictitious registered credential is exercised on real Workline/window fixtures,
monitor brief rendering, MCP results, sealed audit storage, crash/fatal logs and the exported Desktop snapshot contract. Monitor/log coverage
uses a credential-shaped fixture through the existing pattern guard; it is not proof of discovering arbitrary unregistered credentials.
Encoded values, text already lost upstream, independently framed native message fields and post-print retraction remain outside this candidate.
Targeted author checks do not supply independent review, hosted, native-other-platform, running Desktop, live or N1 acceptance.

## S6 pre-dispatch worker tree secret gate — author candidate, 2026-10-14

Owner decision S6: a Docker worker receives a full Git clone of the Run's pinned base (plus accepted predecessor patches), and everything
in it can reach the model provider through the worker's one egress. The terminal read floor was not applied to that tree before S6.

- **Where:** `executeConfiguredTask` scans the prepared checkout after predecessor patches are applied and before the handoff record, the
  native connection, the Docker profile capture and the dispatch claim. The scan is the adapter `worker-tree-gate` (`scanWorkerTree`); the
  decision, audit event and typed refusal are the engine's `enforceWorkerTreeGate`.
- **Rules (one source each):** deny paths are `CREDENTIAL_WORKSPACE_DENY`, the terminal read floor without repository internals (the same
  list the full-access deny view and the shell hard floor use); a deny-listed directory is reported, never descended, and a symlink is
  checked by its path, never followed. Content is matched against the installation's configured secret values (`known-secret`, never
  liftable) and against the canonical redaction table rows marked `"gate": true` (row `source`, the precise expression). `key-value` is
  `"gate": false`: it matches ordinary code (`token = identifier`) and refused 44 non-test source files of this repository. Binary files
  (NUL within the first 8000 bytes) are path-checked only. The clone's own `.git` (history) is not scanned.
- **Acknowledgements (`execution.secretGate`, v1, empty by default):** `allowPatternPaths` (≤ 64 globs) lifts content-pattern hits only;
  `acknowledgedDenyPaths` (≤ 64 exact paths) lifts the deny-path rule for a settings-only file such as `.npmrc`, whose content is still
  scanned. Bounds `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `timeoutMs` fail closed as `WORKER_TREE_SCAN_INCOMPLETE` naming the setting.
- **Refusal:** both codes are permanent launch refusals (the Run base is pinned; a fix needs a new Run). The checkout is released; no
  container, connection or claim exists. The text (EN/TR, shared renderer) names up to 16 `path (rule)` pairs and the omitted count; paths
  pass through the record redactor and never carry a value. The `worker-tree-refused` audit subject keeps up to 50 findings, the full
  count and the exhausted bound. No audit, no closure: an audit failure is thrown (transient) and the next turn scans and records again.
- **Open limits:** Git history is not scanned (a secret removed from the tip but present in history still reaches the worker's `.git`);
  binary and non-UTF-8 content, values shorter than six characters and credential shapes outside the gated rows are not detected; the
  time bound is checked between entries. No Next surface lists Core audit events yet; a later Run view shows the recorded code only.
  Author proof and the base-tree-only clone measurement: external `proof/S6-SIR-KAPISI-2026-10-14/`.
