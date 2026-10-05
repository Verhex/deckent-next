# Agent turn engine, context and sessions — module note

Agent turn loop, durable turns, runtime chatTurn, context measurement, compaction, history, system prompt and reasoning control (moved from ARCHITECTURE.md Packages 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 855–1004, 1028–1101, 1102–1116; text below is verbatim.

**Agent turn loop (T-L3b, engine core; runtime and terminal wiring below).** `engine/core/agent-turn` `runAgentTurn` runs one turn over ports: a
governed model round (the composition derives the round command id from the turn so a replay never bills twice) → each declared
tool call checked against its JSON schema subset, authorized per call (policy resource `agent-tool`, id = tool name, action
`invoke`; `deny` and `require-approval` are typed results, never bypassed — tool approvals arrive with T-L4) and executed → results
back to the model → next round, until the model answers without tools, the user cancels, or a round has no answer. No round, call
or time budget (owner 2026-09-24). Every call emits `tool.started` (display target) and `tool.finished` (status, ms, bytes); the
turn ends with one `done`; a turn without a model answer (reasoning spent the output budget, a round rejected/unknown, cancel) gets
an engine-written closure note instead of silence. Identical read calls in one turn are answered with a reference to the earlier
result, other classes are never deduplicated. The runtime operation, context admission/compaction and terminal rendering are
implemented in the slices below; the T-L5 review limits remain open.
**Truncated rounds (TRUNCATED-TOOLCALL, Jev 6192a348; live with the next switch).** A round is truncated when its reported completion
count reaches the completion limit every round requests (`AgentTurnAdmission.completionLimitTokens` = `terminal.chat.
maxCompletionTokens`) or its finish is `length`; the finish alone is not trusted (vLLM v0.30.0 streams a tool call cut at
`max_completion_tokens` as `tool_calls` — serving.py overwrites `length`, fixed upstream by PR #46303 after v0.30.0 — and its
qwen3_xml parser may leave unterminated or, with PR #53739, terminated half arguments). No call of a truncated round runs:
each is refused before argument checks, policy, approval and execution (no partial effect), recorded as `invalid-arguments`
without an argument digest, answered to the model with the engine protocol text `error=output-limit` naming the limit and how
to write in parts, and counted as no progress; the turn's note names the refused calls. A text answer cut by `length` keeps
its behaviour (finish `length`). Without a known limit only `length` marks a round. The openai-chat adapter still rejects a
response that carries calls with a finish other than `tool_calls` (`invalid-response`, T-L2), so a provider that reports
`length` honestly fails the round instead (no effect). Tool-call arguments in history stay the provider's raw text (vLLM coerces
unparsable history arguments to `{}`, PR #48922). Timeouts: the profile's `limits.timeoutMs` bounds the model call, while
`service.responseTimeoutMs` only bounds the final frame write (`server.ts`), so a raised `maxCompletionTokens` must raise the profile's
`maxOutputTokens` and `limits.timeoutMs` together. Open decision (lead/owner): a distinct `truncated` tool-call status (Jev 0.84,
below the 0.90 criterion, so the safest reversible `invalid-arguments` was kept; needs domain/wire `callStatusSchema`, sqlite record
enum, en/tr label keys, v18 or v19).

**Durable agent turns (T-L3b2, ledger v37, Astra 2074 D3).** `runDurableAgentTurn` claims `(scopeId, turnId)` before any round:
the turn id is bound to the principal key and the composition's request digest. A new id runs the loop; the same request of the
same principal after the turn finished returns the stored outcome (the last answer and `done` are re-emitted, no model round);
while it runs a second claim is `AGENT_TURN_IN_PROGRESS`; a different request or principal is `AGENT_TURN_CONFLICT`; a row whose
state and record disagree is `AGENT_TURN_CORRUPT`. Every settled tool call is recorded (round, index, call id, tool and version,
arguments digest, display target, status, bytes and result digest — not the result text); a finished turn accepts no further
call or finish. The turn is finished with its outcome even when the loop throws (a store failure never masks the loop's error);
an answered turn whose outcome could not be stored is returned with `recorded: false` and stays running until the next start.
Turns left running by a stopped service are closed as interrupted (`error` with a fixed note) by `interruptRunning`, never
resumed; a damaged row is reported and left as it is without blocking the others. The service start wiring (after exclusive
socket ownership, like the ledger upgrade) runs at every `runtime serve`.
**Runtime agent turn (T-L3c, protocol v12, Jev 9df04efb).** `chatTurn` runs one durable agent turn inside the runtime service:
the principal comes from the connection; the model, `maxCompletionTokens` and tools from fresh configuration (`terminal.chat`);
the client sends only its history ending with the new user message (untrusted context, bound to the turn id by a digest over
history, model, catalog revision, binding, completion limit and tool list). Every round is the existing governed invocation under
`commandId = sha256('turn-round:1', scope, turn, round)`; its failure closes the turn with the typed code in the note. Tools are
declared to the model only when its binding declares `tool-calls`; each call is decided by `AgentToolPolicyAuthorization`
(`agent-tool`/`invoke`, id = tool name; an unreadable policy is `deny`) and runs as a workspace read tool on the project. The answer
streams as v12 **event frames** (`text`, `reasoning`, `tool.started`, `tool.finished`, `usage`, `message`) followed by one response
frame with the bounded `ChatTurnResult` (finish, note, rounds, tool calls, the final answer when it fits the replay bound and the
delivery, `replayed`, `recorded`). Event frames are required data, not presentation: the client's history continues from exactly the
`message` events. Each frame is bounded by `service.responseMaxBytes`; the stream as a whole is not (no turn budget); the loop waits
for the peer to drain before each round and tool call, and at most `4 × responseMaxBytes` may wait unread before the turn is
cancelled; an event that cannot fit one frame cancels the turn instead of being dropped. A peer that disconnects cancels the turn
at the next write (a Unix peer that closed after its request is not visible earlier); `cancelChatTurn` of the same principal
cancels at once (another principal's turn, or an unknown one, is `not-running`); service stop cancels running turns. Stores:
`agent_turns`/`agent_turn_tool_calls` (T-L3b2). Errors: `AGENT_TURN_IN_PROGRESS | CONFLICT | CORRUPT | INVALID | UNAVAILABLE`.
Reading tools needs an explicit policy grant (`agent-tool`, ids `read_file`, `list_dir`, `grep`, `glob`, action `invoke`);
without it every call is `denied`.
**Terminal agent turns (T-L3d).** The interactive terminal's turns are `chatTurn` turns (`streamTerminalAgentTurn`): a fresh turn id per
turn; service events become surface `TurnDelta`s — `tool` (started, then finished with status and duration; the target carried from
the start), `message` (history, never rendered) and `done` with the engine's closure note. Each finished tool call prints one line
(`name target · seconds · status` when not ok); the running call shows a live spinner line; text before a tool call is printed first;
a later round's reasoning starts a fresh narration; the footer sums completion tokens over rounds and shows the note. The next turn's
history is exactly the previous turn's `message` events; the history window (until T-L5 token admission) starts at a user message,
so a tool result never loses its call, and keeps the newest exchange whole. Aborting (Esc/Ctrl+C) sends `cancelChatTurn` at once.
Line mode (`terminal session`, piped) still sends plain governed invocations without tools.
**Context measurement and admission (T-L5a, protocol v13, Jev 90c2e32b).** Before every round the loop measures the prompt once and
every decision reads that one measurement: the `context` event (round, prompt tokens, window, quality), admission, and — with T-L5b —
compaction. Measurement is the provider's own count of exactly the round's request: `ModelInvocationApplication.measure` runs the
same principal, policy (`invoke`), binding, activation and profile checks as `invoke` (shared `admittedTarget`), then the native port's
optional `measure` — no claim, receipt, spending or model execution. `openai-chat-http` counts through a same-origin
`tokenizeEndpoint` (vLLM-style `POST /tokenize` with the same model, messages and tools the round sends), only when the binding
declares `token-count`; its own deadline is 2 s + 250 ms/KiB (≤ 30 s), its answer ≤ 8 MiB, and any failure is `null`, never a failed
turn. Without a counter the prompt is a conservative upper bound (every UTF-8 byte of messages and tools a token, plus 64 per
request, 16 per message, 32 per tool), always labelled `upper-bound`. The window is the smaller of the profile's
`contextWindowTokens` and the provider's report (unknown → no admission decision; the provider stays the arbiter). A round whose
prompt + `maxCompletionTokens` + 2048 safety tokens exceeds the window is never sent: the turn closes with a note naming the
numbers and quality. The footer shows `context [~]N% of W`. v13 also fixes the `compacted` event shape: its `messages` replace every
non-system message the client holds (the client keeps its system prompt); the workline applies it.
**Automatic compaction (T-L5b, Jev 6460731d).** On the same measurement, when a round's prompt + reserves passes 75% of the window,
the engine plans a compaction: the system message and the newest 8 messages (widened so a tool result never loses its call) stay;
the older part is summarized by a governed, tools-off invocation (`turn-compact:1(scope, turn, n)`, the older messages as a bounded
plain transcript, legacy JSON shape: objective, findings, decisions, unresolved, next actions, inspected areas). It becomes one
labelled `user` message: the model-written summary plus the earlier user messages verbatim (each ≤ 4000 characters, cut with length
and digest) and the earlier tool calls, both copied from the history, never from the model; it is context only and grants no
authority. (Finding 2026-10-01, wave 5 TUI-COMPLETION G4, code reading at `a2971850`, not tested: the compaction message itself is
`role: 'user'` (`engine/core/agent-turn/internal/compaction.ts:95`), so the next compaction treats it as an earlier user message and cuts it
at 4000 characters (`:11,78`); the model summary comes first, so with a long summary the first user directives survive the second
generation only as a `[cut … sha256]` marker — the verbatim carry above does not hold across generations. The fix applies this contract,
it does not change it; the harvest card input TC-1 COMPACT-CARRY regenerates a canonical block outside the compaction message from the
turn ledger/history in every generation, with a compaction render version bump. TC-0…TC-7 are inside the owner's full-TUI acceptance
(2026-10-01); the TC-1 mechanism is card input, not yet decided in detail (PLAN TUI-COMPLETION); not implemented.) The turn emits `compacted` (surface: one line "N earlier messages were summarized"), measures again and applies
admission. The summary answer is normalized into the bounded shape before validation (TERM-FEEDBACK-1, live turn 975da614 answered every list
field as one string): a string, scalars or objects become items, an absent list is empty, text longer than an item is split at a space
(no text dropped), a count past the bound is named (`[N more items omitted by Deckent]`), a too long objective is cut with its length
and digest; an answer without a string objective is unreadable. The `summarize` port distinguishes a summary, `unreadable` (the call
answered, nothing usable) and `null` (the call failed). `unreadable` compacts with Deckent's mechanical excerpt, labelled not
model-written (earlier assistant texts and tool results, each ≤ 400 characters with length and digest, newest within 12 000 characters;
user messages and tool calls copied as before), and the turn's closure note says so (`AGENT_TURN_MECHANICAL_COMPACTION_NOTE`, shown in
the footer). A failed call keeps the history unchanged and closes the turn with a note that says to send again or start a new
conversation. Re-asking the model was not chosen: a second governed call would need another command id scheme and can fail again; the
mechanical excerpt is deterministic, free and labelled. Open: the `compacted` event does not carry the summary kind (a protocol field
would be a checkpoint), and a newest exchange larger than the window cannot be compacted (admission then refuses).
**History lifecycle and bounded turn memory (Astra 2091 fix, Jev 4a702440).** The interactive workline's agent path sends the whole
conversation (no message-count cut; `terminal.chat.historyMessages` now bounds only the plain line mode); the runtime owns its
lifecycle. Compaction is also triggered when the exact serialized history exceeds 75% of the service input bound
(`service.inputMaxBytes`, passed by the composition as `admission.requestMaxBytes`), so a conversation keeps fitting the client's next
request even when the window is unknown. The loop keeps no copy of appended messages: the result carries the final answer, a count and
the incremental digest (same value as the digest of the whole array); a replay appends nothing (count 0, recorded digest). Read dedupe
answers only with a result the model can still see: an entry is bound to the result message itself (providers reuse call ids across
rounds; Astra 2106 R1), a compaction drops entries whose message left the prompt, and a successful non-read call clears it. Byte
pressure also counts headroom (owner 2026-09-26, Astra 2106 R2): the longest answer (`maxCompletionTokens` × 4 bytes) plus one user
message (an eighth of the bound, at most 32 KiB) must still fit the next request; a request that cannot fit even so is refused by the
client before anything is sent as `RUNTIME_CHAT_TURN_TOO_LARGE` (start `/clear` or write less), never as a transport fault. Open: a `compacted` event must fit one event frame (`service.responseMaxBytes`); a tail of very large tool
results, or a summary copying many long user messages (each ≤ 4000 characters), can exceed it and then cancels the turn (fail
closed, not silent); and a tail that alone stays above the high-water mark is summarized again every round (billed, no progress;
candidate guard: skip when the last compaction did not shrink the history). The byte check needs no counter port. Evidence: engine repeated-compaction/edit/byte tests, real service byte-bound compaction, workline → service →
session snapshot → `/resume` with 44/46 messages sent whole; mutations 1–7 (`proof/F26-T-L5-FIX-2091/`).
**Concurrency slot = locally open request (INFLIGHT-FIX, owner 2026-09-28; replaces PROVIDERS/A3A "unknown outcomes retain
capacity").** An allocation's `inFlight` counts claims without an outcome. Every outcome — `responded`, `rejected`, `not-sent` and
`unknown` — is recorded only after the native `send` settled, and the native port contract requires `send` to settle only after its
transport request is closed locally (`provider-http-json` destroys its per-request agent before resolving/rejecting), so each
settlement releases the slot. The `unknown` record, its evidence, its spending hold and `lifetimeCalls` are unchanged: uncertain
effect and billing stay; only concurrency is corrected. Replay of a settlement never releases twice. The allocation integrity audit
counts only open claims. `maxInFlight` therefore bounds locally open requests, not provider work that may continue after a disconnect
(vLLM aborts a streamed request on disconnect; an API provider may keep computing — billing uncertainty is the spending hold's job).
A claim left by a crashed **service** process is settled at the next start (FIX-2143-SLOTS, owner 2026-09-28): the service's model send owner is `runtime-service:<custodyId>:<instanceId>` (minted only by `runtimeServiceModelOwnerId`), where
`custodyId` is the digest naming the endpoint custody the instance holds (`LocalRuntimeSocketGuard.custodyId`; the guard socket is
`\0deckent-<custodyId>`, `custodyId = sha256(endpoint \0 uid)`). Holding one endpoint's custody proves only that no service instance is
alive **on that endpoint** (the kernel frees the guard socket when a process dies; a clean stop releases it only after every admitted
operation settled); the runtime socket is a configurable layout resource, so another endpoint may share the ledger (Astra 2145 R1).
Since LEDGER-SINGLETON the start also holds ledger custody, so no other service of this ledger is alive; the owner predicate still
names the endpoint custody (deriving it from ledger custody, which would also close a dead owner's claim after the socket moved, is
a follow-up slice). Ledger custody is a filesystem lock: it excludes services in other network or PID namespaces on the same kernel
and any path to the same ledger directory (bind mounts). Not claimed: NFS or other network filesystems, and a same-UID actor that
deletes `<ledger>-lock` while it is held (trusted-host model, as for the ledger itself); builds before the lock do not hold it. The
lock file is never removed by the product.
A start therefore proves ended only owners that name the custody it holds now (`endedRuntimeServiceModelOwner(custodyId)`; no
prefix-only match exists). An open call whose control is `permitted` with such an
owner settles `unknown` through the ordinary settlement (`transport-error`, no evidence; spending hold `unknown`, `lifetimeCalls`
unchanged, slot freed). Untouched and still holding their slot: `permitted` calls of an instance of another endpoint (proven only by a later start on that endpoint), the earlier unpublished owner shape without custody, `pending` (claim without send permission), `unobserved` (v18
migrated), and `permitted` calls of any other owner (host-less direct call, a build before this one). The durable record does not
carry "owner ended" as a separate reason (outcome schema v4 allows only `transport-error`); the start observer reports the count.
**Start reconciliation.** Under ledger and endpoint custody (with the ledger upgrade and interrupted-turn close), per allocation, one
transaction: an allocation with `inFlight = 0` and no `claimed` row is skipped (nothing can be written). Otherwise every retained row
of the allocation is decoded with the ordinary record decoder (column/receipt/control/cancellation/content agreement), the number of
rows must equal `lifetimeCalls`, each receipt's allocation limits must equal the checkpoint's, and open claims may not exceed
`inFlight`; any failure rolls the transaction back and reports the allocation `inconsistent`, untouched (Astra 2143 R1). From the
verified records: open calls of ended service owners settle `unknown` (above); then, from the counts after those settlements, only
`open < inFlight <= open + unknown` is rewritten to `open` (earlier-build surplus). Observer:
`onModelAllocationSlotsReleased({ allocations, released, settled, inconsistent })`, called when anything was released, settled or
reported. No ledger schema or version change. Cost: O(retained rows) of the allocation, only when a slot is held or a row is open.

**Model-facing system prompt (TL-C D4).** The runtime service renders a versioned (`AGENT_TURN_SYSTEM_PROMPT_VERSION`, now 6),
English, deterministic instruction segment in code (protocol text like tool descriptions, never a catalog string): project root,
Deckent data root (workspace-relative when inside the project, else marked unreadable; v4 names Deckent's own state protected),
the configuration path, protected places, the declared tools by class (read / edit / shell), that policy and the permission mode
decide every call (runs, waits for the operator, or is denied; a denial is final), declared-parameters-only, bounded-result
continuation (`hasMore=true` → `nextStartLine`), same-argument read references, and one short progress line between tool rounds.
Each sent round has exactly one system message: the segment, then the client's own system text (catalog: persona + reply language).
The client's history, `message`/`compacted` events and saved sessions never hold the segment; measurement counts exactly what is
sent. The turn's `requestDigest` binds `sha256(segment)`: a turn id replayed after the segment changed (new version, other project
root or layout, other tool set) is `AGENT_TURN_CONFLICT`, never an answer to another prompt. System prompt **v2** (SCR-A): the renderer moved
to `engine/core/agent-turn` (pure text; composition budget); v2 adds the scratch line (path, tools, diagrams as Mermaid/SVG text,
`run_shell` TMPDIR, retention). The request digest changes with it: a turn id replayed across the update is `AGENT_TURN_CONFLICT`.
System prompt **v3** (FETCH): the network line (`fetch_url`, allowlisted hosts ≤ 32 named, what happens to other hosts) or `Network
access: none`; every turn's request digest changes again.
System prompt **v4** (TERM-FEEDBACK-1): one line naming the running model from the bound catalog definition (native id; provider and
model reference with versions; "running inside Deckent"; answer identity questions with it), and the data-root line no longer points at
the ledger and saved conversations: Deckent's own state and authority, keys and credential files are named protected (the tools and the
shell refuse them); the configuration is named readable. Every turn's request digest changes again.
System prompt **v5** (LANG-CRASH): the reply language of the person's locale as the first rule and again as the last line
(`AGENT_TURN_REPLY_LANGUAGES`: en → English, tr → Turkish (Türkçe); keyed like the catalog locales, so a new catalog locale without an entry
does not compile). The service resolves the locale as elsewhere (its environment, then `config.language`). The compaction instruction ends with
'Write every string in <language>' instead of 'the language of the conversation'. Every turn's request digest changes again. Not forced: a
local model can still drift; no post-check exists (a post-answer language check is a separate card). The terminal's own locale is not on the
wire: terminal and service differ only for `terminal --lang` or a service started from another environment. Lead decision (2026-09-30): B now —
the live installation sets `language: tr` in its configuration at the next live restart; A — `chatTurn.language?` on the wire — needs protocol
v19 (v18 is released) and ships with the next protocol bundle.
System prompt **v6** (PROMPT-POSTURE, live 2026-09-30): fetch_url and the shell are separate; the shell note states `createAgentShell().posture()`
(the realm and open-view rule of the turn's calls: open bubblewrap = network, real HOME, Deckent state sealed, the configuration written
only by an owner-approved call (Astra 2192 R9); closed = no network; host; unavailable), and `Network access: none` stays only when the
shell has no network. Every turn's request digest changes again.
System prompt **v7** (TRUNCATED-TOOLCALL, 2026-09-30): when an edit tool is offered it names the per-answer output limit
(`terminal.chat.maxCompletionTokens`) and the write-in-parts recipe; every turn's request digest changes again.
**Agent tool deny floor per layout (TL-C finding, TERM-FEEDBACK-1).** Agent read tools (and through the same `WorkspaceScope`: edit and
shell path classification, the bubblewrap and Landlock deny views, `@file`) deny the Core floor plus every product resource of the
layout that lies inside the project except the configuration (`AGENT_READABLE_PRODUCT_RESOURCES = ['config']`, default-deny for
resources added later; TERM-FEEDBACK-1: the owner's live session listed and read other saved conversations): each resource, anything
under it, its sidecars (`rel*`: `ledger.db-wal`, `terminal-history.jsonl.<pid>.tmp`) and a writer's hidden temporary
(`.policy.json.<id>.tmp`). The deny list's nested literal heads (`WorkspaceScope.protectedAnchors`:
`.deckent/live-data/state/ledger.db`, `.deckent/host`, …) are protected together with their ancestors by both sandboxes even under an
ignored tree (`node_modules`, `.cache`, a `.gitignore` entry) — the ignored-tree exception never reaches Deckent's own state; a chain
through a symbolic link refuses the call. In the shell plan a `PATH_PROTECTED` verdict on one of these patterns is a hard floor
(`PRODUCT_STATE_PROTECTED`, no card, no effect intent): product management is not opened by any approval (owner F2); the Core floor's
other paths (`.env`, keys) keep asking and are then refused by the sandbox. Policy and bindings are authority sources and stay closed;
config names credentials only by reference and edits of it stay on the write floor. In a bubblewrap shell the runtime socket inside the
project is masked too (no connection). The glob matcher tests a pattern's literal head first (20k paths, 97 patterns: 1617 ms without
it, 199 ms with the shipped matcher; the old 28 patterns 197 ms). Open limits: the agent can no longer read or `@`-attach saved
conversations, the ledger, logs or policy (owner reads them outside the agent); Landlock (measured ABI 7; `LANDLOCK_ACCESS_FS_RESOLVE_UNIX` is ABI 9+, not measured) does not restrict connect() to a pathname
socket, but the realm's seccomp filter refuses every `socket()` except AF_INET/AF_INET6 stream sockets (measured on ABI 7: a unix
socket otherwise reached `/var/run/docker.sock`), so the runtime socket inside the project is unreachable in both realms; a data root equal to the
project root would also close same-named project files. Product paths the deny language cannot name literally are refused at layout admission (Astra 2166): an effective project root,
data root or bootstrap configuration path holding `*` or `?` is `LAYOUT_PATH_UNEXPRESSIBLE` (config reason `layout`; service start,
installation preview and every turn resolve through the same function); brackets and braces stay accepted; the glob grammar
(`GLOB_WILDCARD`, `globLiteralHead`, `hasGlobWildcard`) lives once in `platform/core/common`. History: previously a data root moved inside the project (`.deckent/live-data`)
left approval records, the integrity key directory and whole pending diffs readable, and `state/approval-previews` was readable even in
the default layout. `@file` candidates and attachments use the same `agentWorkspaceDeny(projectRoot, layout)` (OPEN-REASONING-FILE):
approval records and pending diffs are neither listed nor attachable (`refused`/`path-denied`); the candidate index is cached per
project root and deny list.
**No-progress note (TL-C D7).** A round is without progress when it has tool calls, every call ended `duplicate`,
`invalid-arguments` or `error`, and the model wrote no text; `denied`, approval outcomes and `cancelled` are not the model's failure.
At the second consecutive such round the engine appends one `user` message `[deckent] The last two rounds made no progress: …`
(once per streak; a round with progress resets it; never on a cancelled turn). No counter or limit ends the turn. The note is part
of the appended history (`message` event; v15 schema already admits `user`), so a replay and the next turn see it.
**Reasoning control (TL-C D8, legacy 7108 descriptor).** A catalog capability `chat-template-enable-thinking` v1 (openai-chat
family; catalog schema v1 unchanged, capability ids are data) declares that the served chat template reads `enable_thinking`. The
`openai-chat-http` adapter (version stays 4: the field is optional and catalog-gated) accepts `chat_template_kwargs:
{ enable_thinking: boolean }` only for a binding that declares it supported, else `OPENAI_CHAT_REQUEST_INVALID` before any network.
The compaction call sends `enable_thinking: false` when declared; rounds are unchanged. **Thinking off per turn (protocol v16, OPEN-REASONING-FILE).** `chatTurn` accepts an optional `reasoning: 'on' | 'off'` (command
schema 1 unchanged; the wire version carries it). With `off` the service sends `chat_template_kwargs: { enable_thinking: false }` in
every round of a model whose binding declares the capability, and the provider counter (`/tokenize`) body carries the same switch,
so the count is of exactly what is sent. The request digest binds `reasoning` only when present (default turns keep their digest;
the same turn id with and without it is `AGENT_TURN_CONFLICT`). A model that does not declare the capability refuses a
thinking-off turn by name (`AGENT_TURN_REASONING_UNSUPPORTED`, usage) before any claim, model call or spending; it is never
ignored silently. The terminal's one `/reasoning` state drives both the preview and the request (a `/reasoning` queued before a
message holds for it); the terminal never sends `on`. `reasoning_effort` stays open (TL-C review §3b).

**Conversation sessions (T-L5c, Jev 9ae569b1).** The workline saves the whole current history (system prompt excluded) after every
turn as one snapshot per session in the managed `terminalSessions` directory (`openTerminalSessionStore`: owner-only 0600, no-follow,
atomic temp + rename, known secret shapes redacted, at most 50 sessions per scope and 16 MiB each, oversize refused before redaction). A
compaction simply rewrites the snapshot, so a resumed conversation can never carry pre-compaction messages twice (legacy defect).
`/resume` opens an arrow-key picker of this scope's recent sessions (Enter continues the highlighted one, Esc closes; TERM-PICKERS) and `/resume <n|id>` continues one (its messages become the history; later turns save
into it). TC-0 RESUME-REF source candidate (TERMINAL-S00-S01, 2026-10-03): ids are exact canonical lowercase ids, never prefixes.
Indices (including picker Enter) resolve only against the last shown list after a fresh scope-bound query compares ordered ids,
update times, message counts and previews. Missing/changed lists load nothing (`SESSION_LIST_STALE`); invalid references return
`SESSION_REFERENCE_EXACT_REQUIRED`; a missing exact snapshot returns `SESSION_NOT_FOUND`, all with visible EN/TR notices.
Successful save/resume and `/clear` invalidate shown indices. The session hook remains the context transition owner; terminal-kit
holds the pure reference/port contract. Fresh list comparison and snapshot load are separate reads, not an atomic versioned read;
same-id concurrent updates between them are not fenced. No service/wire/ledger migration or approval authority is added.
`/clear` (named `/new` at T-L5c) starts a fresh session; `/context` shows the latest measured prompt against the window. Snapshots are client
context, never authority; they follow the composer history switch `terminal.persistHistory`. The shared credential redaction's URL
pattern now bounds the scheme (`{0,31}`): the unbounded form backtracked quadratically on long letter runs (80k chars: 2.7 s).
