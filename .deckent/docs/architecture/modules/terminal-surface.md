# Operator terminal surface — module note

Terminal contract v1, phases, tool lines, `@` index, TC-M harness (moved from ARCHITECTURE.md Packages 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 690–842, 1005–1027, 1117–1127, 1268–1277; text below is verbatim.

### Operator terminal contract v1 (accepted target, partial implementation)

The operator terminal is a presentation of the same typed operator actions as CLI, MCP and (later) Desktop,
not a second shell. Principal, scope, resource and policy travel with every turn; persona grants nothing.
Market notes live outside the repo (`/home/alperen/deckent-refactor-work/proof/TERMINAL-UI-LANDSCAPE/`).

- **Regions:** banner, status strip (scope, chat model, busy/cancelling), work ledger (append-only chat,
  run, worker and notice rows), single input owner, hints. **Events:** `slash`, `submit`, `cancel`, `exit`;
  the slash catalog is data (`slash-registry`). **Composer (P2):** the single input owner is a pure reducer plus a
  small Ink view (unit `surfaces/core/terminal-composer`): grapheme/cell-aware caret, readline editing and kill/yank, multiline
  (Shift/Alt+Enter, Ctrl+J, trailing `\`), in-session history and Ctrl+R, atomic paste chips expanded on submit, a
  slash palette (typing filters by prefix, then subsequence; Up/Down select; Enter runs the highlighted command — a command
  that takes an argument completes to `/name ` and waits, a fully typed name runs as typed; Tab completes; Esc closes until
  the text changes; Enter without suggestions sends the text), `?` shortcuts, and an `@file` picker (T-L5, protocol v15: typing
  inside an `@token` opens candidates from the runtime service, debounced 60 ms with earlier lookups aborted; a single candidate is
  offered, never typed for the user; Esc closes it for that text and a late answer never reopens it; Enter/Tab insert the picked path in the form the
  submit parser reads back exactly: `@path ` for a plain name, `@"path" ` when the name has whitespace, trailing sentence punctuation,
  a leading `@` or `"` (only `\"` and `\\` are escapes; Astra 2134 R3); Enter on a typed-out name sends the line only when it is already
  in that form; a quoted query (`@"my f`) looks names with spaces up); it emits `submit`/`cancel`/`exit` intents only. Idle Ctrl+C
  clears a draft or arms exit (second press within 2 s exits); Ctrl+D exits on an empty idle line; while busy
  Esc/Ctrl+C cancel the turn. History and `@` candidates/attachments are ports; the surface reads no files. History persistence is the
  `terminal-history` adapter: private per-project `state/terminal-history.jsonl` (0600, no-follow, append-only, last 500
  entries, compacted when doubled), visible line only — entries that carried pasted content are never stored and secret
  shapes are redacted; `terminal.persistHistory: false` disables it.
- **Kimlik admission’ı (batch 36 R6):** interaktif açılış runtime/session yazımından önce kimliği ensure eder. `POLICY_UNAVAILABLE`, `POLICY_DENIED`, `SCOPE_UNKNOWN`, `ATTEMPT_STORE_VERSION` retleri `ADMISSION_DEFERRED` kümesidir: terminal açılır, eksik kimlik yaratılmaz; varsa doğrulanmış kimlik okunur, yoksa panel custody’sinde yalnız bellek-içi `unadmitted` kullanılır (saklanmaz, kullanıcıya gösterilmez, yetki değildir). Her yönetilen komut kendi kapısından geçer; invalid/relocated/locked/unsupported kimlik retleri ölümcül kalır. Tipli açılış bilgi notu ve follow `not-initialized` yüzeyi kabul edilmiş **IDENTITY-UX hedefidir**, henüz teslim iddiası değildir.
- **Entry (owner 2026-09-23, T0):** `deckent` with no arguments on a real terminal (TTY stdin and stdout, `TERM` not
  `dumb`) opens the interactive terminal, as does bare `deckent terminal`; piped or dumb terminals print help, and
  `deckent --help` is always help. The scope comes from `--scope` or `terminal.scopeId`; without either the typed
  `TERMINAL_SCOPE_REQUIRED` screen says how to set one. **Runtime auto-start:** when no service answers on the
  configured endpoint and absence is positively observed (absent socket, never-created state directory, or a refused
  connection — nothing listens on a crashed host's stale socket), an interactive terminal
  starts `runtime serve` of the same executable as a **detached background process** (no shell, no stdin, output
  appended to the private `runtimeLog` resource `state/runtime-service.log`, 0600, no-follow) and waits for a
  successful describe within `terminal.serviceStartTimeoutMs` (default 20 s); one monotonic budget covers the first describe,
  the launch and readiness, so a peer that accepts and stays silent cannot hold the terminal. `/service-restart` and flagless
  `runtime shutdown` carry one budget through describe, the shutdown answer, the wait for absence and readiness; running out
  is an unknown outcome (the command may still be admitted), never proof of stop or permission to replace the service. A peer that accepts but fails or stays silent may be a
  live incompatible or unhealthy service: it is reported (`LOCAL_RUNTIME_TRANSPORT`), never replaced. The launch is shown
  as ours only when the descriptor's `processId` equals the launched pid; a concurrent winner is shown as connected
  (Astra 2054 R2). The service keeps running after the
  terminal exits so runs and workers continue (owner decision after Jev 0198c77c abstained in effect); it stops with
  `deckent runtime shutdown`. An existing service is reused; an endpoint that fails ownership checks is never replaced;
  a start failure is shown in the view (`RUNTIME_AUTOSTART_FAILED` with the log path) and is not fatal. Piped line
  mode and other CLI/MCP commands never start a service; `terminal.autostartService: false` only connects.
  **Lifecycle (T0b, Jev 8bb2a0c7):** the service descriptor carries an optional `build` (source tree digest and commit);
  a compiled terminal compares it with its own build and shows a typed notice when the service runs another or an unknown
  build, offering `/service-restart` (governed shutdown, then auto-start) — it never restarts on its own, because runs may
  be in flight. **Lifecycle compatibility window (Jev 898c8af3):** `describeService` and `shutdownService` are accepted
  in the previous and the current protocol version ([16, 15] since v16; the window moves with each released version) and answered in the request's version; a client retries these two only, once per
  older version, when the connection closed unanswered — so an upgraded terminal can describe and stop a service started
  from an older build (proven live: v11 terminal → v10 service → skew notice → `/service-restart`). A retry resends the same
  shutdown command and instance, never a new one, and every other operation — anything effectful — is current-version only. `deckent runtime shutdown` without command fields builds the governed shutdown command from the live
  descriptor; a service without `service.identity` cannot be stopped that way (`RUNTIME_SHUTDOWN_UNAVAILABLE` says how
  to configure identity and a shutdown grant) and the terminal banner says so. **Upgrade:** `runtime serve` upgrades an
  existing older ledger once at startup, before accepting connections and only under ledger and endpoint custody: the
  service first takes an exclusive kernel `flock` on the ledger's private companion file `<ledger>-lock` (created 0600 beside
  the ledger, opened `O_NOFOLLOW|O_CLOEXEC` by the local runtime socket native adapter, required to be a regular single-link
  file of the service user and re-checked by path identity after locking), then binds the kernel-owned abstract guard socket
  of its endpoint. Both are held by any live host of this build and released together (after admitted work settled, or by
  the kernel when the process dies). A second start against a live service — on the same endpoint or on another endpoint of
  the same ledger (`layout.resources.runtimeSocket` changed) — fails `LOCAL_RUNTIME_ALREADY_RUNNING` without naming the other
  endpoint (LEDGER-SINGLETON, owner 2026-09-28: one runtime service per ledger) before any backup or migration, and custody is kept until the listener is up (Astra 2054 R1). A consistent copy is written first
  (`VACUUM INTO` the `ledgerBackups` resource `state/backups/ledger-v<N>-<time>.db`, 0600, never over an existing file),
  then the normal single-transaction migration runs and the service reports from/to versions. A missing or current
  ledger is untouched; clients and read paths never migrate. Typed error responses carry bounded message
  parameters (≤ 8 keys, strings ≤ 512 chars; omitted for older lifecycle versions), so a remote error renders the same
  text as a local one. Open: idle stop policy for the background service.
- **Adapters:** `deckent terminal workline [--scope <id>]` is the Ink view and requires TTY stdin and stdout
  (`TERMINAL_TTY_REQUIRED` otherwise); `terminal session [--scope <id>]` is line mode and also serves piped
  input (slash input stays local: `/status` answers locally, unknown commands are reported, never sent to the model); `terminal status|chat-plan|snapshot` are one-shot JSON/text reads. Ink/React are Core runtime
  dependencies pinned exactly; `NO_COLOR`, `--no-color` and non-TTY stdout render without colour.
- **Chat is one governed model invocation per turn:** the `terminal.chat` config section names a declared
  catalog model and `maxCompletionTokens`; catalog revision and binding are read per turn; the turn goes
  through the runtime model client in the caller's `--scope` (same path as `models invoke`), so principal,
  policy, activation and spending apply. Abort (Esc, or Ctrl+C while busy) stops the wait and requests
  cancellation of that invocation. There is no direct/unmanaged HTTP backend and no silent fallback.
  **Streaming (S-STREAM, implemented end to end 2026-09-24):** `streamTerminalChatTurn` yields the surface
  `TurnDelta` contract over runtime protocol `invokeModelStream` (since v11): the same governed invocation as `invokeModel`
  (authorization, activation, reservation before send, settlement, durable command replay), answered by ordered delta
  frames and exactly one ordinary response frame. Delta frames are presentation: each ≤ `service.responseMaxBytes`, all
  together ≤ one more `responseMaxBytes`, coalesced per event-loop turn; when exhausted they stop for good, so the client
  always holds a prefix and completes the answer from the recorded result. This is an upper bound on buffered delta bytes,
  not strict per-write backpressure: the send loop may continue after a socket write reports a full buffer (Astra 2054). A replayed command sends no deltas and never
  reaches the provider again (a concurrent duplicate gets the pending receipt without deltas, engine-tested; the terminal
  composition reports that as `TERMINAL_CHAT_INVOCATION_PENDING`: still running elsewhere, recorded, not failed). Disconnect
  stops delivery only; the client sends the same governed cancellation command as the plain turn (the peer's session
  ends with its connection, so the service cannot cancel on its behalf). `openai-chat-http` v4 accepts `stream: true`
  with required `stream_options.include_usage` and parses SSE incrementally with the same deadline, redirect, model-match
  and tool-call rules; `responseMaxBytes` bounds the retained evidence prefix and the assembled `chat.completion` (with a
  wire digest in a `deckent_stream` block — the native object of a streamed call is assembled provenance, never the
  provider's verbatim body), and total wire bytes are bounded at 16× it plus 1024 bytes per requested completion token (4× the
  measured vLLM framing), so a long legitimate answer is not rejected after it was billed (an allowance, not a guarantee for
  every provider's framing); the bound limits bandwidth, not memory. The first invalid chunk (malformed, tool call, model change, usage over budget, data after `[DONE]`) ends the read
  at once and closes the connection (whether a remote provider then stops computing or billing is not proven by it); its
  cause is recorded only when every observed byte
  is retained (evidence `complete` means that, not that the provider finished), otherwise the reason is `response-limit`,
  because a semantic rejection cause is only claimed with complete evidence (S decisions, Jev aac0af98/e2faa91b).
  A stream without `[DONE]`, finish and usage is interrupted (uncertain, never retried). Streamed text is withheld while it could still begin an echoed bearer credential.
- **Rendering (P3, unit `surfaces/core/terminal-render`):** a pure `renderAssistantStream(state, delta, now)` state
  machine feeds the workline: a stream segmenter emits finished units (prose line, list item, quote, heading, whole fenced
  code block or table) to `Static` scrollback as they complete and keeps only the unfinished tail live (an unclosed
  fence renders live, is chunked into scrollback past 200 lines and is flushed on `done`, fixing the legacy freeze);
  a dependency-free markdown renderer (headings, emphasis, inline code, lists, quotes, links as label + URL, fenced code
  with a small built-in highlighter for ts/js/json/py/sh/sql/diff, width-aware tables, diff colouring) produces a span
  model resolved through the palette (`none` tier = no colour, ASCII glyph set). Reasoning deltas are narrated in one
  muted live line (tokens, seconds) that collapses to "thought for Xs" when the answer starts; reasoning text is never
  stored or sent back as history. (Note 2026-10-01: this is the terminal's history; the governed model-invocation content of
  a chat round still retains the provider's native response including its `reasoning` field — OpenAI-chat stream assembly,
  Anthropic thinking text. Owner 2026-10-01 (D5 A, Jev dc3c1d0b): retention becomes a scoped setting, default text not kept —
  reasoning digest, length and token count stay, a company may opt in to keep the text; the turn's streamed-reasoning prefix
  check moves to the digest; the retained response is then a documented redacted evidence form. PLAN REASONING-RETENTION.)
  A turn footer shows elapsed time, tokens and truncation/cancel/failure. The status row
  is one width-fitted line (scope · model · state · elapsed · queue · notice, dropped by priority, never wrapping).
- **Units (2026-09-24; TUI1 split 2026-10-07):** `terminal-theme` (generated palette, colour roles) ← `terminal-kit` (palette
  context, slash registry, `TurnDelta` stream contract) ← `terminal-render` ← `terminal-picker` (ArrowPicker) and
  `terminal-composer`; `terminal-ledger` (pure work-ledger model, `notice()`, run/worker/approval watches, bridge snapshot)
  ← `terminal-work` (work surface, slash dispatch, approval/cancel flow, cards) ← `terminal` (workline root, sessions, mode;
  its barrel re-exports the lower units); split by responsibility to keep each unit within the 2000-line budget.
- **Local/free models** use `openai-chat-http` v4 with an operator-declared `operator-static` tariff (v1: zero rates only).
  The quote is reserved against the scope budget and a responded call settles `settled-local 0` in the spend ledger;
  there is no unmetered bypass class. Positive chargeback rates need a separate measurement basis.
- **Delivery fit (SESSION-RESULT-LIMIT-2026-09-28):** the worst-case delivered size of every declared provider profile —
  `modelInvocationNativeResponseUpperBound` (one formula shared by the adapters) plus the same arithmetic as
  `assertInvocationDeliveryFit` — is reported ahead of time by `deckent doctor` (`modelInvocationDelivery`, unconditional, `[]` when
  clean) against the runtime-service and MCP surfaces; `models activate` refuses the admission when a profile is already declared for
  the reference and can never deliver on some surface (`MODEL_ACTIVATION_DELIVERY_UNFIT`, before `app.admit()`, no claim or ledger
  effect). The check lives in `engine/core/model-activation` / `engine/core/model-invocation`; composition only wires the surfaces
  (the MCP capacity comes from `adapters/core/mcp-transport`, never from the surface layer). A profile declared later, or a
  `service.responseMaxBytes` lowered after activation, is reported by doctor only (the one ongoing authority).
- **Ledger:** run/worker rows come from the same inspection handlers as `run inspect`/`workers list`.
  `/runs` reads that same inventory page and appends one inspection card per id; it does not create or cancel a run.
  Chat text is not run truth. **S18/S18B/S18B-AUTH (batch 36):** üretim yolu runtime SQLite ledger’ına salt okunur `fs.watch` + heartbeat takibidir; servis tek yazardır, okuyucu outbox silmez/etki açmaz. `inspectMonitor` ile ortak principal/scope/policy kapısı okuma öncesi ve takip boyunca yeniden değerlendirilir; ret/veri bağlamı değişimi takibi durdurur. R4 yetkili açılış snapshot’ı, sıra boşluğunda resync ve reconnect başlangıç cursor’ını; R5 çalışan worker’ın canlı panel gözlemini korur. Takip portu olmayan tüketici bounded single-flight poll kullanır. The Ink `Static`
  printer only appends; compaction starts a new epoch so rows past any count keep printing.
- **Work surface (P4, 2026-09-24):** worker cards and a bounded live panel (dynamic region, shown while `/watch-workers`
  runs, fed only by that single-flight poll or `followWorkers`) render one line per worker from the `activity`/`usage`
  of `inspectWorkers` (`worker 2 · claude <model> · editing src/x.ts · 12 s ago · 18.4k tokens (cache 83%)`): phase text
  from `cli.worker.phase.*`, age = observation time − host `receivedAt` (never `atMs`), truncated/dropped markers, a
  finished/failed session labelled "worker reported"; `starting` with unmapped events is muted progress, not an error.
  `/transcript <n|attempt>` reads the sealed transcript through the `task transcript` producer (`read-output`; denial
  and unsealed attempts are visible). `/approvals` opens an arrow-key picker of pending items (runtime `listApprovals`; Enter opens
  the highlighted item's y/N card, Esc closes) and `/approvals <n|id>` lists them and opens that card; the decision goes through the runtime `decideApproval` (same peer-authenticated live-session path as
  `approval decide`). Only a single typed `y` approves; `n`, Enter, Esc and Ctrl+C deny; an `/approvals` card has no remember/always key
  (the standing-scope keys `s`/`a` exist only on in-turn tool-call cards the service marks, PERSISTENT-APPROVALS G6 below) and there is no auto-approval. Pending approvals are announced on the heartbeat (one bounded page per tick, rotating), on by
  default whenever approvals are wired, never more often than every 10 s (lead integration decision; tests may override).
  `/cancel <runId>` inspects the run, asks y/N and calls the `run cancel`
  handler against the inspected revision. Read-only commands never prompt; an open card owns the keys.
- **Local inference serving** (`inference_serving`, `deckent inference plan|budget`) is a separate
  configuration card: pure capacity/launch estimates with loopback-only publish. `loopbackMetricsUrl` only
  derives a loopback `/metrics` URL. `deckent inference metrics` reads that URL through the bounded
  inference-metrics adapter (loopback only — the name `localhost` is resolved and every answer must be a valid 127.0.0.0/8 or `::1` address before contact, then connections go only to the checked addresses, in answer order after a connection failure; one total deadline covers resolution and every attempt, and a late answer starts no connection — the profile's metrics limits, no redirect follow) and never
  through a surface fetch. Deckent does not start the server. `previewEmptyInferenceSlot` is an empty-budget estimate and
  is not Run admission. MCP `inference_plan` and `inference_budget` are the same read. The Desktop bridge
  snapshot carries work rows only (no chat content) and is not a live file channel. İzlemeler
  S18 üretim ledger takibiyle beslenir; `followWorkers` / `followRuns` portu bulunmayan tüketicide bounded single-flight poll kalır.

**Terminal turn phases (TL-A, 2026-09-28).** Protocol v15 is unchanged. The runtime service emits no phase event; the terminal derives
"the service is summarizing" from the `context` event it already receives, the history it holds, the engine's compaction rule and the
service's admission values from the same configuration; the engine alone decides and compacts, the mark is presentation (a parity test
runs the real service). Live lines: "model is preparing a response · Ns", "summarizing earlier messages · Ns"; the status row shows
"Esc cancels" while a turn runs. On Esc the engine's closure note never reaches the surface (the socket closes), so the footer names the
stopped part from the client's stream state (`compaction` | `model` | `tool`); a summary stopped halfway is not kept and the screen says
so; a completed summary is kept. Reasoning streams as a dim, sanitized (`terminalSafeText`) 2-line preview, never printed to the
scrollback nor added to history; `/reasoning [on|off]` toggles the preview for the session (default on). Limits: against a service of
another build or configuration the mark can be wrong until `compacted` or the first model delta; the chat-turn admission is one pure engine function (`agentTurnAdmission`: output reserve, 2048 safety reserve, request bytes and
next-request reserve) used by both the service and the terminal; it sits in the engine next to the compaction rule because composition
may not call domain decision functions. The compaction predicate itself is still expressed twice (engine loop and terminal), guarded by
the parity test.
**Tool lines and read limits (TL-B, 2026-09-28).** The terminal derives a display target (grep/glob pattern first) and a finished-call
result summary ("12 matches", "243/269 lines, more available") client-side from `message` events already on the wire; the engine's `describeAgentCall` — the C12 approval `resource` — is unchanged byte for byte; the terminal renderer (`surfaces/core/terminal-render` assistant stream) derives both from the `message` deltas the turn already
streams, with the derivation functions in `surfaces/core/terminal-kit`; the terminal agent stream in composition carries the engine's
target only and imports surfaces as types only, so composition (SDK, runtime service) never loads the surface layer (Ink/React) at
runtime — guarded by `tests/contracts/composition/sdk-import-graph.test.ts` over the built `dist/index.js` graph. Read results default to 64 KiB (`terminal.chat.readResultMaxBytes`,
1 KiB–1 MiB, chat schema 1 unchanged); `grep` accepts `context` (0–5) and `maxHits` (≤ 200). `maxHits` caps **seed hits** (hits that open a context window); hits inside an
opened window are shown, marked `:` and counted too; with `context=0` it is the number of hits shown. A grep result with hits ends
with `[deckent] grep: matches=N` (`N` = `:`-marked hit lines actually returned, counted after the result byte cap; `N+` when fewer
than found: hit cap, byte-cap cut, skipped or unscanned files). The terminal's grep count comes only from that last line, or 0 from
the "no matches" line (`+` when the search was not complete); without it (older result, other producer, final byte-cap cut) no
summary is shown — hit rows are never parsed back, since a workspace path may contain `:` (Astra 2145 R2). Tool `version` unchanged.

**TC-M host measurement harness (TERMINAL-S00-S01 source candidate, 2026-10-03).** The existing fake Workline TTY harness
observes frame bytes at the in-memory stdout writer with same-process monotonic clocks. One host collector retains raw samples,
nearest-rank p50/p95, invalid/missing counts; unresolved/invalid/backward/equal clock readings remain `unmeasured` with null
percentiles, never zero. Version/source/harness/lock digests, installed dependency versions, host environment and fixed workload
are pinned in external proof. Warm mount→first READY frame, submit→BUSY, text event→frame, approval event→card and
Esc→cancelled footer+READY are control intervals; fake model generation and compaction wall intervals are separate.
No product behavior or runtime telemetry producer is added. K-LATENCY-METRICS has no producer in base `0388c2cf` (source,
test, script and host-tool search); that wider runtime work remains open and should reuse this collector rather than duplicate it.
Process boot/import/service connection, physical terminal paint/flush, real model/GPU/provider/approval polling, long sessions and
loaded-host acceptance are unmeasured. Event→human surface 500 ms p95 remains a target. Proof: external
`proof/TERMINAL-S00-S01-2026-10-03/S00/`; author verification, independent review and landing are separate.

**`@` index, `/resume` replay and `/context` (TERM-UX-1, seventh batch).** The terminal's `@` index (`RuntimeWorkspaceFileHost`) waits for
its first walk; after its 10 s ttl the old list returns at once while one background walk refreshes it; a list older than `maxStaleMs` (1 h)
is not served; a failed refresh keeps the old list. The terminal warms the index at opening (`findTerminalMentions('')`, same authority and
deny) and a bare `@` does not wait for the 60 ms quiet period. `/resume` prints the chosen conversation (last 24 messages, user text ≤ 600
characters, attached file bodies not printed, tool results as one count line, summaries marked); the model context was already whole.
`/context`: window bar and percentage, the automatic summary threshold (display constant 0.75 = `AGENT_COMPACTION_HIGH_WATER`, held
equal by a contract test) and the tokens left, a size-estimate split of the visible history (the service's own instructions are not in
it), the last summary, the three largest items and a `/clear` suggestion at ≥ 60 %. Protocol unchanged (v16). Open: `/compact` (protocol
decision), redrawing an open suggestion list when the index refreshes.
