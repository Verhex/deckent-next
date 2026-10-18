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
  list the full-access deny view and the shell hard floor use), matched case-insensitively; a deny-listed directory is reported, never
  descended. Content is matched against the installation's configured secret values (`known-secret`, never liftable) and against the
  canonical redaction table rows marked `"gate": true` (row `source`, the precise expression). `key-value` is `"gate": false`: it matches
  ordinary code (`token = identifier`) and refused 44 non-test source files of this repository. Every regular file is read whole, binary
  included (UTF-8, and both UTF-16 alignments when it holds NUL bytes); a symlink's target text is scanned, never followed; a FIFO, socket or
  device is refused as unscannable; an I/O error rejects. The scanned set is the whole checkout including the clone's `.git` metadata
  (config, refs, logs) except `.git/objects` (history, owner-deferred) and `.git/index`.
- **Acknowledgements (`execution.secretGate`, v1, empty by default):** `allowPatternPaths` (≤ 64 globs) lifts content-pattern hits only;
  `acknowledgedDenyPaths` (≤ 64 exact paths) lifts the deny-path rule for a settings-only file such as `.npmrc`, whose content is still
  scanned. Bounds `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `timeoutMs` fail closed as `WORKER_TREE_SCAN_INCOMPLETE` naming the setting.
- **Dependency class (owner 2026-10-17, before beta; replaces the live/N1 interim `allowPatternPaths: ["node_modules/**"]` + 32 MiB):**
  the signal is profile data, never a path string: a `readOnlyMounts` entry declares `dependencyTree: { lockfile }` (a path inside the
  bind), pinned with the Run and its profile fingerprint; the checkout, task inputs, handoff files and prompt text never take the class,
  and a declared bind keeps it only when its real path shares no tree with the attempt workspace or the work-target checkout
  (`checkoutRoot`; without a work target that is the project root, so the class then never applies to project-relative binds), judged by
  device and inode along both real paths (`pathsShareTree`; an unresolvable path counts as overlapping). The scanned source is the exact
  bind source: composition hands the same resolved list to the gate and the supervisor, which re-checks it at launch (real path, no link)
  and proves the created container's mount set (`assertDockerMountsMatch`).
  In such a bind deny paths (with `acknowledgedDenyPaths`) and configured values refuse exactly as elsewhere, on every dispatch; text-pattern
  hits (`pattern:*`, `config-secret`) are audited exceptions `dependencyTree:<target>` (the `worker-tree-excluded` subject, the attempt
  journal and the Run card); archives stay `unscannable` (liftable only by `allowPatternPaths`), decided before and never by a pattern
  result or a cache entry (Astra 2626 F1), and an oversized native header that is also an archive signature stays `incomplete`, as does
  an oversized native body holding an archive start or end anywhere (engine `embeddedArchive`: zip local/central/end records, gzip
  members, xz, 7z, rar, bzip2, zstd, ustar), each judged by the structure its most lenient common extractor enforces (zip method and
  offsets, but an end record whose directory sits its stated size before it, or in the last 65,558 bytes, whatever its stated offsets,
  because Python zipfile and Info-ZIP re-base them (Astra 2629 F2); gzip method 8 and a
  deflate stream that yields output, reserved flags ignored as Python's gzip does; xz header CRC; tar checksum unsigned or signed as GNU tar
  accepts) so chance signatures in machine code do not count. Compressed data without a container header (raw deflate, zlib, brotli,
  LZMA-alone, lz4) cannot be told from machine code and is a documented residual (`docs/known-limits.md`). A file above `maxFileBytes` (size and
  `maxTotalBytes` checked before any read) is never allocated whole: its 1 KiB header is read first and only a native signature with a
  NUL-bearing header (ELF, Mach-O, PE, wasm; engine data `dependency-binaries.json`) is read further, in 1 MiB windows that are hashed and
  checked for configured values (carrying the bytes that may begin one), with the deadline checked per window; it is recorded as
  `native-binary:<kind>:sha256=<digest>`; any other oversized file stays `incomplete`. Review 4: such a file's body (a polyglot) is
  checked per window for configured values and all pattern rows in every reading (carry: `pendingStart` × 24 bytes with a trailing partial
  escape set aside, at least `patternCarryBytes` 64 KiB, kept per stream — raw bytes, and NUL-dropped bytes counted in their own
  coordinates, so a NUL run of any length cannot split a value or a family across windows (Astra 2626 F2); a carry above
  `maxCarryBytes` 1 MiB makes the file `incomplete`; no early exit except a refusal); in any native-claimed file of the class (any size)
  the credential families of `refuseInNativeFiles` (private-key blocks, provider and cloud tokens) refuse, while the same shapes in text files
  stay exceptions (zod url-userinfo, jose private-key-block); native-claimed files bypass the pattern cache, so the cache never decides; the lockfile only scopes the cache (node loads files, not the lockfile,
  and every reuse is keyed by the file's own bytes); the bind is live, so a host change after the scan is not seen (as for any bind). Cache keys longer than 4096 characters are not
  stored and a cache document above 16 MiB is not written. Pattern results are cached
  per file (path + SHA-256 of the bytes read on this dispatch) inside a scope of the lockfile bytes, the rule table, the product version
  and the bind target, in the product resource `treeScanCache` (`state/tree-scan-cache`, one file per bind, atomic 0600 writes). A
  changed lockfile, rule table or release starts empty; a changed file is evaluated again. The cache never decides: deny paths and configured
  values are evaluated in full each time, so a stale, corrupt or forged entry can only change which pattern exceptions are listed. An
  unreadable cache reuses nothing; a failed save is reported in the scan (`dependencyTrees[].saved`) and costs the next dispatch time only.
  Existing profiles without the field keep the full workspace rules; adding it changes the profile fingerprint (template upgrade path).
- **Refusal:** both codes are permanent launch refusals (the Run base is pinned; a fix needs a new Run). The checkout is released; no
  container, connection or claim exists. The text (EN/TR, shared renderer) names up to 16 `path (rule)` pairs and the omitted count; paths
  pass through the record redactor and never carry a value. The `worker-tree-refused` audit subject keeps up to 50 findings, the full
  count and the exhausted bound. No audit, no closure: an audit failure is thrown (transient) and the next turn scans and records again.
- **config-secret (owner 2026-10-15):** the redaction vocabulary narrowed to config-like files (`.env*`, `.json`, `.yaml/.yml`, `.toml`, `.ini`,
  `.properties`, `.conf/.cfg`, `.xml`, `docker-compose*`, `*.config`) and non-placeholder literal values (`${VAR}`, `$VAR`, `%VAR%`, `<...>`,
  `{{...}}`, `changeme`/`example`/`xxx`/`***`, shorter than 6): table data `configSecret` beside the rows. Source files stay out of scope.
- **Credential families and regex semantics (security review):** gate-only table rows `gatePatterns` add PEM/OpenSSH private-key
  blocks, GitLab, AWS temporary keys and secret-key assignments, Stripe, Slack (`xox*`/`xapp`), PyPI and Azure account/shared-access keys;
  PKCS12 stays name-only (binary ASN.1). All rows use one JS (V8 irregexp) flavour with flags `''`/`i` only and run in the terminable regex
  worker bound to the scan deadline, so a backtracking input ends the scan as `incomplete`, never as a pass; the config expressions are
  linear by construction. config-file names match in case/NFC/NFD/NFKC/trailing-dot forms (`.env.production.local`, `*.config.json`,
  `docker-compose.override.yml`); YAML `|2-`, aliases, `${VAR:-default}` and `{{ 'literal' }}` are read as their parsers do.
- **Parser parity:** every reading a worker's tools can take is scanned — UTF-8 with BOM, NUL-stripped bytes (ASCII in UTF-16/32 of either
  byte order), UTF-16 in both alignments, JSON/YAML `\uXXXX`/`\xHH` escapes, CRLF, YAML block scalars; compressed/archived files
  (signatures in `gate.json`) are `unscannable:archive-<kind>`. Deny forms also strip trailing dots/spaces (Windows-backed binds).
- **Exclusions (owner 2026-10-15):** a hit lifted by `allowPatternPaths` (globs) or `acknowledgedDenyPaths` (exact) is audited
  (`worker-tree-excluded`: path, rule, lifting entry), journalled on the attempt before launch and shown on `run inspect`, `task inspect` and
  the monitor detail ("Excluded by config: N path(s)" + entries). Both lists stay empty by default.
- **Every view:** besides the checkout, the profile's read-only binds, mounted task inputs, handoff files and the prompt dependency
  context are scanned (`workerTreeViews`), matched by their container path (e.g. `deckent/mounts/shared/.env`).
- **Sibling paths:** the only launch site is `DispatchApplication.execute` in `executeConfiguredTask` (SDK `executeTask`, MCP/CLI task
  execution, run progression, retries and recorded-workspace restarts all call it); reconcile, cancel, output recovery and release reuse a
  recorded dispatch. `worker-tree-gate-paths.test.ts` fails on a new launch site or a reordering.
- **Open limits:** Git history (`.git/objects`, packs) is not scanned: workers keep full history (owner 2026-10-15 declined a depth-1
  clone) and a secret removed from the tip but present in history still reaches the worker's `.git`; the history scan is a later card. Encodings other than UTF-8/UTF-16, values shorter than six
  characters and credential shapes outside the gated rows (e.g. a PEM block inside source) are not detected; the time bound is checked
  between entries. No Next surface lists Core audit events yet; a later Run view shows the recorded code only.
  Author proof and the base-tree-only clone measurement: external `proof/S6-SIR-KAPISI-2026-10-14/`.
