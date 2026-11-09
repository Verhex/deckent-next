# Agent turn engine, context and sessions — module note

Agent turn loop, durable turns, runtime chatTurn, context measurement, compaction, history, system prompt and reasoning control (moved from ARCHITECTURE.md Packages 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 855–1004, 1028–1101, 1102–1116; the original text below is verbatim; later dated additions are marked separately.

## Subscription agent contract (alpha.63 K0/K1, 2026-11-03)

`adapters/core/native-cli-headless` exports a separate `NativeAgentExecution` v1 capability and `ToolSessionPort`.
The pure schemas, session port and surface guards live in `capabilities/core/native-agent-execution`; adapter exports stay compatible.
K0 defines the contract and registry; K1 connects native proposals to the same call coordinator as pull rounds.
Native drivers, facade and product composition are separate slices. The existing tool-less v1 text-chat profile,
flags, preflight and `headlessFlagSetDigest` remain unchanged. An agent capability is a verified
executable/version, owner uid, profile digest and agent flag-set digest; it grants no consent or authority.

`ToolSession` pins a turn id, generation, unique `AgentToolSpec` set and effective-policy `approvalTtlMs`.
It never exposes `decide_approval`. The existing coordinator owns authorization, approval, execution and durable settlement;
CLI drivers and the bridge only transport proposals/results through `ToolSessionPort`. Claude correlates MCP
`_meta["claudecode/toolUseId"]` with `tool_use.id`. Codex carries `_meta.callId` and `_meta.itemId`, but its JSONL
`item.id` is unrelated: the handler stamps `deckentCallId`, turn id and generation in **every** result, including errors.
Cancellation and revocation fence a generation; their results distinguish confirmed/unverified termination from
settled/unknown external effects. Neither stopping a CLI nor receiving a cancel proves that a business effect was undone.

`nativeCliAgent(protocolFamily)` selects sourced registry data beside `nativeCliHeadless`. It inherits the existing
environment, deny names, login serialization, isolation and resource bounds. Its own argv/guards and the shared bridge
are included in `nativeAgentFlagSetDigest`. Claude keeps restricted mode, empty native tools and `dontAsk`/no prompts,
removes safe mode and the blanket MCP denial, and admits exactly one generated `{mcpConfigFile}` slot, a tool list
and an admission-policy turn bound. Drivers must materialize that file only at the registry file name in the private run
directory; the registry accepts no arbitrary MCP path or inline configuration. The init guard compares the exact session
tool set and built-in plugin provenance; any other tool/plugin refuses sealing. Codex keeps the v1 argv and uses direct MCP
tools (`omit_tools_from`) with `approve`; this value opens the route to Deckent's handler, never bypasses its approval.
Native/unknown item types refuse; only the exact measured code-mode error is allowed (K3 also enforces stream counts/order).

The shared bridge data describes topology R: HTTP MCP through the existing relay to a `.invalid` sentinel host/path,
with a generation-bound **Deckent** turn token, not a subscription credential. Claude's HTTP entry uses headers and a
millisecond timeout; Codex uses URL/bearer-token environment and seconds. Both timeouts derive from the session approval
TTL; no CLI default supplies authority or a policy deadline. HTTP_PROXY stays in effect and NO_PROXY is cleared by schema.
Body/frame limits are sourced provisional policy ceilings, not measured capacity. P is disabled fallback flag data only.
K4 and K15 must supply the facade, token/generation enforcement and login-scope negative evidence before the bridge opens.
Login methods are registry data: Claude `claudeai`, Codex `browser` and `device-auth`; person-witness checks stay with login.
Readiness reasons are typed, with matching EN/TR `headless.agent.reason.*` catalog entries; unknown never means ready.

Sources: retained external `proof/ALPHA63/A0/RESULT.md` (A0-1/2/3/4), `AMENDMENT-BRIDGE.md` v2,
`bridge-research/RESEARCH.md` and `A0/A0-5R/*-relay`; current official
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Claude MCP configuration](https://code.claude.com/docs/en/mcp) and
[Codex configuration reference](https://developers.openai.com/codex/config-reference/) (accessed 2026-11-03).
The `approve` interpretation comes from A0 behavior, not a verified official semantic definition. Real-account,
CLI-update, assembled-product and business-process acceptance remain separate from these schema/guard tests.

### K23 işçi kartı bağlantısı — yazar adayı, 2026-11-03

İşçi kartının mühürlü özeti `worker-tool-call` v1 metadata taşır: exact Run/Task/Attempt,
turn, araç, hedefin redakte sunumu ve SHA-256'sı, argsDigest. Gerçek karar uygulaması ve
minimum güvence değişmez. Attended karar üreticisi kayıt MAC'ini mevcut inspect yoluyla doğrular;
scope/turn/araç/hedef digest/argsDigest bağını kontrol eder, gerçek socket peer ve TTY tanığından
aynı service ring'inde tek kullanımlık karar üretir. AI/MCP ve TTY'siz SDK kişi tanığı kazanmaz.
Sohbet kartının başlatan peer bağı ve istemcinin verdiği geçersiz capability reddi aynen kalır.

Workline `/approvals` mevcut ok tuşlu kartı kullanır; exact kimlik ve tam argsDigest ayrıntıdadır.
Run ayrıntısında bounded pending approval okuması neden ve kalan TTL'yi gösterir; görünüm
worker fazını veya yetkiyi değiştirmez. İşçi kartında henüz bağlı bir standing cevap üreticisi yoktur:
yalnız bir kez/red sunulur; oturum/kalıcı izin uydurulmaz ve taban gevşetilmez.
`ToolSessionPort.terminalFailure` yalnız güvenilir üreticiye ait opsiyonel bir porttur, tel alanı değildir.
TTL dolunca K1 kaydı expired olur; worker driver/supervisor bağlantısı `approval-expired` nedenini
başarısız process sonucu `APPROVAL_EXPIRED` olarak kalıcı tutar; modelin son başarı metni bunu silemez.

K23 worktree'si ortak runtime karar çağırıcısını ve driver/supervisor/workload-wrapper dosyalarını
sahiplenmez: exact bağlantılar dış `proof/ALPHA63/k23/LEAD-CALLERS.patch` içindedir.
Kaynak dal tek başına bu bağlantılar yapılmış gibi değerlendirilmez. Hedefli yazar kanıtı, derlenmiş
fixture yürüyüşü, bağımsız Astra, monte BeUser ve owner kabulü ayrı kapılardır.

### K1 call coordinator

`AgentTurnInput.nativeSession` explicitly selects push mode. `AgentTurnPorts.invokeAgent` receives the projected tools,
messages and `ToolSessionPort`; without that driver the turn refuses rather than falling back to `invokeRound`.
Native proposals require `call.id = correlation.deckentCallId`; provider ids stay in correlation. Each proposal uses the
same argument/ingress checks, authorization, preparation, exact approval, execution and settlement as a pull call.
Concurrent proposals serialize; the same id and body joins its recorded result, while conflicting reuse refuses.
The driver returns a final answer without tool calls; returned tool calls cannot create a second execution path.
The session closes at driver completion and drains accepted work. Cancel/revoke fence new proposals and abort both driver
and call signals. Pending or uncertain non-read effects remain unknown; a completed effect stays successful in its native
result even on cancellation. K1 has no CLI process-termination evidence and reports `termination: unverified`.
`runDurableAgentTurn` binds the session turn id to its claim, records through the existing tool-call store and replays a
finished turn without opening a session. Generation-local replay is not restart recovery. K1 counts one native driver
invocation as one engine round; native model rounds and compaction belong to the driver. Existing admission request-byte
bounds also gate queued proposal input; no new round/call/time policy is introduced.
These are author code/test claims. Real CLI/facade/realm, hosted CI, independent review and assembled acceptance remain
separate; K15 must be GREEN before the product bridge opens.

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
cancels at once (another principal's turn, or an unknown one, is `not-running`); service stop cancels running turns.
**Protocol v30 (tema L6, owner S5).** `ChatTurnResult` carries typed MCP start `notices` (the adapter's structure, at most
`CHAT_TURN_RESULT_NOTICES`; the surface renders them from its own catalog) and `note` no longer carries MCP text. `steerChatTurn` queues one
person line for the same principal's running turn (`queued`, `not-running` for another principal, unknown, cancelled or finished turns,
`full` past `CHAT_TURN_STEER_LINES` lines per turn or when one more id would not fit the turn's result bound whole; a repeated `steerId`
is the same line; ids are identifier-shaped, at most 64 characters). The joined and returned ids are stored with the durable turn, so a
replay answers the same. The result is fitted by its serialized size (`fitChatTurnResult`): the answer's repeat is left out first
(`answerBytes` still names it), then Deckent's note is cut (`…`); notices and steer ids are never cut, because admission measures the
largest result with no answer and no note. The loop takes waiting lines only at the
model-call boundary — after every tool result of the round, before the next round is measured and sent — so a line never enters an
approval or witness wait and never answers a card; each joins once as the person's `user` message (`message` event with its `steerId`),
none joins after a cancel, and the result's `steer.returned` names the lines that did not join. A v29 terminal's `chatTurn` is closed
unanswered (`LOCAL_RUNTIME_TRANSPORT`).
**Protocol v31 (alpha.64 B, /do parity).** A `propose_work` call streams `work` events (`callId`, `phase` `planning` with its `attempt`,
`quota-wait` with `untilMs`, `attempt` and `maxAttempts`, `admitted` with the `runId`): the plan application's progress (`PlanServiceRun`
takes `observe`) as `/do` shows it; the card stays `approval.requested`. The terminal maps them onto `/do`'s own quota-wait window, its
uncommitted-changes line on the Run card and its `/tasks` handoff (one shared workline function each). A v30 terminal's `chatTurn` is
closed unanswered; the lifecycle window is `[31, 30]`. Stores:
`agent_turns`/`agent_turn_tool_calls` (T-L3b2). Errors: `AGENT_TURN_IN_PROGRESS | CONFLICT | CORRUPT | INVALID | UNAVAILABLE`.
MCP `not-decided` notices carry a short `code` (at most 64 characters) and an optional identifier-shaped `detail` (at most 256);
suggested commands are rendered from the surface's EN/TR catalog. Start failure phases include `decision`. A repeated failure with
the same client/definition identity, code and detail adds no new turn notice; `/mcp` still renders the recorded failure on each query.
The MCP client's HTTP and stdio transports bound raw bytes and guard every delivered JSON-RPC message with the shared MCP node/depth
limits before discovery, era codecs and tool list/result validation. The SDK's JSON-RPC envelope parser precedes this guard. Stdio's
disposable discovery sibling uses the same guard; an over-limit reply closes the transport without forwarding or replaying the request.
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
**History lifecycle and bounded turn memory (Astra 2091 fix, Jev 4a702440; W2 owner amendment 2026-10-08, alpha.21 `4afa7c81`).**
The streamed agent path (rich workline) sends and saves the whole conversation; the runtime measures and compacts it, so no count cut drops the
first instruction (Astra 2091 R1). `terminal.chat.historyMessages` windows only the plain (non-streaming) path through `boundAgentHistory`
(complete tool-call exchanges stay together). The W2 lane also capped the streamed path; batch A kept the accepted contract instead
(Jev 280abf6b 0.86, below 0.90: owner decision open) and bounds growth with the absolute token trigger below.
The runtime owns token/byte admission and compaction. Registry `terminal-chat-defaults.json` supplies 40 messages, 16384 output tokens and
`compactionThresholdTokens=100000` as a proposed absolute input trigger alongside the 75 percent window and byte thresholds. The same admission
reaches the producer and terminal phase projection. Explicit configured limits win. Summary quality and live savings remain unmeasured. Compaction is also triggered when the exact serialized history exceeds 75% of the service input bound
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

**Model-facing system prompt (TL-C D4).** The runtime service renders a versioned (`AGENT_TURN_SYSTEM_PROMPT_VERSION`, now 10; W2 adds the running binary version/channel),
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
v19 (v18 is released) and ships with the next protocol bundle. (Option A has not been added through protocol v29; the service locale still decides.)
System prompt **v6** (PROMPT-POSTURE, live 2026-09-30): fetch_url and the shell are separate; the shell note states `createAgentShell().posture()`
(the realm and open-view rule of the turn's calls: open bubblewrap = network, real HOME, Deckent state sealed, the configuration written
only by an owner-approved call (Astra 2192 R9, historical; superseded by W3 on 2026-10-09: configuration remains read-only in every shell call); closed = no network; host; unavailable), and `Network access: none` stays only when the
shell has no network. Every turn's request digest changes again.
System prompt **v7** (TRUNCATED-TOOLCALL, 2026-09-30): when an edit tool is offered it names the per-answer output limit
(`terminal.chat.maxCompletionTokens`) and the write-in-parts recipe; every turn's request digest changes again.
System prompt **v10** (NATIVE-BAGLAM, owner 2026-10-14, beta gate 3; live finding: "hangi moddayız" was answered by reading
`.deckent/config.json`, one answer carried English reasoning): after the tools the segment carries the **session context v1**
(`engine/core/agent-turn/session-context.ts`, `AGENT_SESSION_CONTEXT_VERSION`): Deckent version, scope, session id, the permission mode as
the decision reads it (`principalPermissionMode`; a stored full-access start mode without a launched full-access turn reads standart;
`askEdits` named) with a one-line meaning, thinking (`on` / `off` from `chatTurn.reasoning` / `model-default` when the catalog declares no
`chat-template-enable-thinking`), the binding's supported catalog capabilities per protocol (≤ 4 protocols, ≤ 16 ids), each offered tool's
effect now (runs / asks / refused) for its representative cells (edit: ordinary file, protected path; shell: read-only, narrow change,
destructive in the turn's realm; fetch: listed / other host; MCP call), decided by the turn's own `decideAgentToolCall` over ONE fresh policy
snapshot (`createAgentCallDecisions().probe`: nothing kept, audited or applied), the slash surfaces the person can open (pinned against
`WORKLINE_SLASH_COMMANDS`) and the hard rules (descriptive only; models never decide approvals or grant authority; MCP cannot decide
approvals; do not read ledger/policy/config to learn the mode). Volatile run state is NOT in the segment (it would break the request digest on
replay and the prefix cache): the workline appends a bounded active-work note (≤ 8 rows, titles ≤ 80 chars, marker
`--- deckent session note: active work`) from the active work strip's records to the person's latest message only; resume and fresh-context
displays strip it like attachments. A new read tool **`session_state`** returns the same snapshot as JSON, recomputed at call time; it is
decided like every tool (`agent-tool`/`invoke`) and offered only when that decision is `allow` at turn start — the first-run template does
**not** grant it (a default grant would need a template bump and change the rollback delta: owner decision). Working style adds "keep your
reasoning out of the answer". **Inline reasoning:** the loop routes a LEADING `<think>…</think>` block of the answer text (a model served
without a reasoning parser) to `reasoning` events (the thought line) and keeps it out of the answer and history; the streamed and settled
splits agree (`createInlineReasoningRouter` / `splitInlineReasoning`); provider reasoning fields stay the adapters' (OpenAI chat
`reasoning`/`reasoning_content`, Responses reasoning summaries, Anthropic thinking blocks). The measured block is ≈ 1.9–2.5 KB
(≈ 480–630 tokens at 4 chars/token; proof `NATIVE-BAGLAM-2026-10-14/measure/`). Every turn's request digest changes again.
**Agent tool deny floor per layout (TL-C finding, TERM-FEEDBACK-1).** Agent read tools (and through the same `WorkspaceScope`: edit and
shell path classification, the bubblewrap and Landlock deny views, `@file`) deny the Core floor plus every product resource of the
layout that lies inside the project except the configuration (`AGENT_READABLE_PRODUCT_RESOURCES = ['config']`, default-deny for
resources added later; TERM-FEEDBACK-1: the owner's live session listed and read other saved conversations): each resource, anything
under it, its sidecars (`rel*`: `ledger.db-wal`, `terminal-history.jsonl.<pid>.tmp`) and a writer's hidden temporary
(`.policy.json.<id>.tmp`). The deny list's nested literal heads (`WorkspaceScope.protectedAnchors`: literal nested heads of the deny patterns (`.deckent/live-data/state/ledger.db` from `…/ledger.db*`, `.deckent/host` from `.deckent/host/**`); a pattern starting with a glob has none. A sandbox never grants their ancestors whole, even under an ignored tree; `.gitignore` cannot lift this deny-derived floor (Astra 2162).
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
into it). TC-0 RESUME-REF (TERMINAL-S00-S01, 2026-10-03; landed, `efd2d78e`): ids are exact canonical lowercase ids, never prefixes.
Indices (including picker Enter) resolve only against the last shown list after a fresh scope-bound query compares ordered ids,
update times, message counts and previews. Missing/changed lists load nothing (`SESSION_LIST_STALE`); invalid references return
`SESSION_REFERENCE_EXACT_REQUIRED`; a missing exact snapshot returns `SESSION_NOT_FOUND`, all with visible EN/TR notices.
Successful save/resume and `/clear` invalidate shown indices. The session hook remains the context transition owner; terminal-kit
holds the pure reference/port contract. Fresh list comparison and snapshot load are separate reads, not an atomic versioned read;
same-id concurrent updates between them are not fenced. No service/wire/ledger migration or approval authority is added.
`/clear` (named `/new` at T-L5c) starts a fresh session; `/context` shows the latest measured prompt against the window. Snapshots are client
context, never authority; they follow the composer history switch `terminal.persistHistory`. The shared credential redaction's URL
pattern now bounds the scheme (`{0,31}`): the unbounded form backtracked quadratically on long letter runs (80k chars: 2.7 s).

**MODEL-INGRESS P2 (2026-10-06, `wave/2`, `363fd061`, `9dd85f7b`).** Modele giden ham alanlar (kullanıcı/araç mesajları, onay kartı önizlemesi, MCP araç açıklaması pini) P1 yardımcısı `projectModelIngressField` ile işlenir; gizli/bidi/tag Unicode model görmeden `[hidden-unicode: N cp, aralık, özet]` notuna çevrilir. Tag/şifreli payload çözülürse karar `quarantine`: model yalnız "result withheld" cümlesini görür, çözülmüş metin modele ve loga girmez (decode model dışında). ZWNJ/LRM/RLM işaretlenir, silinmez; ZWJ/VS15/16 korunur; düz metin `unchanged` kalır ve kayıt yazılmaz. Karantinada tam erişim değilse araç sonucu onay ister; full-access'te onay sorulmaz, alan withheld edilir (`AgentTurnInput.fullAccess`). Sıra: mesaj → projeksiyon → carry/compaction guard projekte mesajlardan kurulur (gizli payload carry'ye girmez). Audit subject `model-ingress` yalnız özet taşır, disposition kapalı `note|quarantine`; `AgentTurnPorts.recordIngress` hatası alanı withheld eder. Aynı not onay kartında ve terminalde (`terminal.safety.hiddenCount`) EN/TR görünür. P3 W9: ortak anahtar/değer JSON reddi ve şema description/title/$comment projeksiyonu ARCHITECTURE ingress bölümünde; proof `proof/INGRESS-P3-2026-10-10/`. P3 W9 indi (`bc74e165b`, alpha.25, CHANGELOG MODEL-INGRESS-UNICODE P3). Açık kalan: native worker kendi araç yürütücüsü, scopesuz MCP audit ve eşleşmemiş ZWJ/VS sınırı. Proof `proof/W2-INGRESS-P2-2026-10-06/`.

**W2 FIRST-TEST-FIXES (alpha.21 `4afa7c81`, PR #60; owner live test pending).** System prompt v9 states the shipped `PACKAGE_VERSION` and release channel without timestamps; it warns that the project checkout may differ from the running service. Paid-call evidence corrected: request output bound was 16384 (`terminal.chat.maxCompletionTokens` → `max_completion_tokens` → Anthropic `max_tokens`), while profile 128000 is a ceiling. Anthropic prepare optionally receives cancellation and counts the exact prompt through its admitted same-origin endpoint; the resulting estimate is pinned to that prepared token. Pure repeated quotes reserve count + 25 percent + 2048 tokens, output cap and the dearest applicable input class/tier; failures retain the byte bound. The provider does not guarantee an estimate error ceiling: a formal never-under-reserve claim is unproven; existing overrun hold/freeze remains. Context measurement and invocation prepare may each count; no cross-request cache or prompt-cache policy change. Proof/decisions: `proof/FIRST-TEST-FIXES-2026-10-08/W2-TERMINAL/`.

W2 cache telemetry keeps runtime protocol25 unchanged. The shared model inspection application adds local `ModelInvocationCommandQuery` v1 (scope, reference, command id) for read-only lookup, then delegates to the exact invocation query after fresh read authorization and immutable identity verification. SQLite uses the existing verified receipt decoder in a read-only reader, not a model replay or new effect path. The terminal normalizes only settled measured-tariff cache dimensions; missing/held/denied/mismatched measurements stay unknown.

**Policy-turn summary record (alpha.55 S5).** A turn that decided at least one agent tool call seals at most one `policy-turn` audit record
after the turn, however it ends: refused decisions and plain allows that ran, lists bounded and counts exact (mode relaxations, standing
and full-access allows keep their own audit events). A turn that decided nothing writes none. The write is best effort: a refused write
does not fail the turn and is not reported (`src/engine/core/audit/internal/policy-turn.ts:45`,
`src/composition/core/agent-turn/internal/turn.ts:360`). See [core layers](core-layers.md#auditor-and-safety-holds-s5-s5b).


**Login scope (alpha.63 K15/K15B/K15C).** Composition passes the selected invocation profile and the global state roots into the same shell handler
used by agent tools. Global-state path names are rejected as `PRODUCT_STATE_PROTECTED` before approval, in every realm. Subscription
profiles cannot resolve a usable host shell (`SUBSCRIPTION_HOST_SHELL_REFUSED`), whether host was configured or chosen as fallback.
With global state present, host calls using directory changes (`cd`, `pushd`, `popd`), path-producing `find`/`xargs`, command or parameter
expansion, dynamic tilde names, braces, process substitution or unparseable syntax require a per-call approval with a localized warning
that the working directory could not be verified and the command may reach Deckent's state folder (owner 2026-11-03, K15C).
The warning precedes the command in the bounded preview and is also carried in the structured shell reason. These host calls use the
existing always-ask tier unless already destructive/authority; mode and standing approvals cannot allow them automatically. Explicit
global-root names still refuse before any card; subscription host/fallback refusal is unchanged. K15B's prior hard refusal was a lead
instruction, not owner acceptance of broken API workflows. Host names remain a best-effort check, not an isolation boundary; arbitrary programs
and concurrent path replacements still require OS containment. Shell hard-link checks compare `(dev, ino)` metadata only against global
login files projected from the CLI registry's `configVisible` names. Ordinary pnpm/cp-al names no longer hit the global-state hard-link refusal (other sandbox inode floors still apply);
file tools retain their existing multi-link refusal, descriptor custody and symlink confinement.

Project MCP launches receive the same global hard floor in their sandbox layout. In subscription turns only tools attesting the long-lived
sandbox's read-only project view are offered (`projectReadOnly` is false on host, remote and prefer-sandbox fallback launches); withheld
servers have a typed `not-decided` / `SUBSCRIPTION_HOST_MCP_REFUSED` notice. Their tool names are omitted from both specs and the system
prompt. API MCP tool selection stays unchanged. This is a turn-composition gate, not a new trust or effect flow. The runtime tool name is
`run_shell`; no alternate command execution path is added. Assembled bridge/CLI stdout canary acceptance remains a separate fan-in gate.

### Path custody and shell contracts

The detailed contracts below accompany the concise comments in the touched adapters. They retain the existing guarantees; K15 adds the global-root and subscription-host refusals described above.

`src/adapters/core/shell-paths/internal/paths.ts`: SEC-6 F31: a segment is the engine's exact sh regex (brackets, POSIX classes) run by the platform's linear engine under a step  budget, never a backtracking RegExp; the engine's leading-dot lookahead (`NO_DOT`) is checked here. `null`: unsupported (fail closed).

`src/adapters/core/shell-paths/internal/paths.ts`: sh-style expansion of one glob argument (no brace expansion; `**` is `*`), bounded; `null` over the bound. A `..` after a glob  segment is unsupported: joining it lexically would name the match's lexical parent, not the one the kernel opens (Astra 2111).  Every name test of the whole expansion is charged to one step budget; exhausting it is unsupported (fail closed, SEC-6 F31).

`src/adapters/core/shell-paths/internal/paths.ts`: The shell classifier's path check over the workspace scope (T-L4 slice 3a): one mechanism with the read tools and edits. A path argument is read-only only when it lies lexically inside the root, is not denied, exists, and its real path (every symlink resolved) is inside and not denied. A path with a `..` component is checked as the kernel opens it (Astra 2111): components in order, so `link/..` is the parent of the link's target, never the lexical parent; that object must exist, be inside and not denied. A glob is expanded with sh rules against the real directory (dotfiles only for a leading dot, bounded), and every match passes the same check; no match (sh would pass the literal) or too many is GLOB_EXPANSION, a `..` after a glob segment is GLOB_UNSUPPORTED, as is one exhausting `globSteps` (SEC-6 F31). Git pathspecs are checked lexically only (git normalizes them itself). Not covered: intermediate symlink hops that leave the root and return (the final real path is what the shell reads); the verdict is taken before the command runs, so a later swap is not excluded.

`src/adapters/core/shell-paths/internal/paths.ts`: Write targets of the narrow mutating tier (T-L4 slice 4a), over the same workspace scope and write floor as agent edits: inside the workspace, not denied, parent a real directory inside, not on the write floor (a new directory is refused when anything under it would be), and the target absent (new directory), absent or a single-link regular file (file), or such an existing file (the source of `mv`). Anything else makes the command not narrow — it then asks, as before. An absolute path inside a second root (SCR-A: the conversation's scratch area) is checked the same way against that root's scope.

`src/adapters/core/shell-paths/internal/paths.ts`: SHELL-AUTONOMY: whether a word of a command names a protected path — the write floor or the product state (its glob patterns, relative to the project root) — by name only, lexically (no file system): as resolved from the project root when it lies inside, and with leading `./`/`../` segments dropped (a `cd` earlier in the same command moves the base). A path or its directory form (`.github` for `.github/**`) counts. A name is not a boundary: the sandbox realm keeps existing floor paths read-only itself.

`src/adapters/core/agent-workspace-floor/internal/floor.ts`: The only product resources the agent tools may read (TERM-FEEDBACK-1): the installation's configuration, which the model is told about and which names credentials only by reference (the keys live under `approvals`). Every other resource of the layout is product state or authority (ledger and its sidecars, backups, saved conversations and history, logs, the runtime socket, approvals and their key, previews, audit, policy and bindings, runs, workspaces, scratch, ...) and is never opened to the agent tools; a resource added to the registry is protected until it is listed here.

`src/adapters/core/agent-workspace-floor/internal/floor.ts`: The Core read floor plus every product resource of this layout inside the project except the readable ones (TL-C D4, TERM-FEEDBACK-1): the resource, anything under it, its sidecars (`ledger.db-wal`, `terminal-history.jsonl.<pid>.tmp`) and a writer's hidden temporary beside it (`.policy.json.<id>.tmp`). The floor names them under the default `.deckent`; a data root moved inside the project (e.g. `.deckent/live-data`) would otherwise leave them readable. The same scope classifies edit and shell paths and feeds both shell sandboxes' deny views, and the composer's `@file` picker uses it too.

`src/adapters/core/agent-workspace-floor/internal/floor.ts`: MODES-3 `edit-authority`: the installation's configuration file inside the project (it decides where policy, bindings and approvals live, the realm and the network), its sidecars and a writer's temporary — never written without the owner's card, full access included.

`src/adapters/core/agent-workspace-floor/internal/floor.ts`: OPEN-SANDBOX (owner MODES-3 checkpoint 4): the hard floor of a full-access turn's open shell view (`ShellSandboxLayout.hardFloor`). Roots: the project's `.deckent` (MCP registry's directory), the data root, the bootstrap configuration's directory unless it holds the project, the global state root of the configuration and process environments, the conventional `~/.deckent` (sealed even before it exists, P5a). Credentials: the Core read floor without repository internals. `product` (owner Y, 2026-09-30): registry resources under this and the default layout, the data root, the bootstrap configuration, the MCP registry, the Core floor's `.deckent/` heads — any other existing subdirectory of a sealed root is the project's.

`src/adapters/core/agent-workspace-floor/internal/floor.ts`: Astra 2486 P1: a write set keeps a sealed in-project root (`.deckent`) inside the overlay, so its entries are refused here unless they lie in the owner-Y exception — the root's `docs` subtree (creatable) or another EXISTING non-product, non-link subdirectory; the root's own names and product paths never reach the host from a write set.

`src/adapters/core/agent-workspace-floor/internal/floor.ts`: The global state roots of the configuration and process environments: each one's resolved root and the conventional `~/.deckent`, which is protected even before it exists (P5a, lead 2026-10-31: nothing can be planted for a later default-root CLI). One derivation for the shell hard floor and the edit/read deny lists.

`src/adapters/core/agent-workspace-floor/internal/floor.ts`: The deny patterns of the product's own state: each protected resource, anything under it, its sidecars and a writer's hidden temporary; a shell command naming one of these is refused outright — no approval opens product management (owner F2, Astra 2162). P5a: the same for every global state root inside the project (`env` and this process's environment, as the shell hard floor), e.g. its compile cache.

`src/adapters/core/agent-workspace-floor/internal/floor.ts`: The edit path rules for one write-set path: a denied path (`writablePath`), the configuration file (`edit-authority`), the write floor (`edit-floor`), the additional self-source floor (`edit-self-source`), else `edit`. A directory — one removed, or a new parent one (Astra 2182 R3: `src/package.json/` is the floor name, whatever it holds) — is classified by its own name and as a tree (`dir/` denied, `dir/-` on the write floor): the rules for what it holds.

`src/adapters/core/workspace-read/internal/scope.ts`: Paths no read tool returns, matched against the workspace-relative real path (registry data; the default is the Core floor). Reading them needs an explicit, reviewed change of this list, never a model argument.

`src/adapters/core/workspace-read/internal/scope.ts`: The read floor without the repository internals: the credential and product-state paths that stay closed everywhere — a full-access turn, the shell hard floor and the S6 pre-dispatch gate over a worker's tree (a clone legitimately carries `.git`). One list, never a copy.

`src/adapters/core/workspace-read/internal/scope.ts`: The workspace boundary for read tools (T-L1, Astra 2072 R1). A path check followed by opening the same pathname again is a race: a parent directory can be swapped for a symlink in between. So every open walks the real path's components from a root descriptor (`/proc/self/fd/<fd>/<name>`, openat semantics on Linux) with no-follow on each component, and the opened descriptor's own path is checked again. Files with more than one link are refused, because a hard link can alias a protected file under an innocent name. Platforms without per-descriptor paths fail closed.

`src/adapters/core/workspace-read/internal/scope.ts`: Descriptor-relative walk over regular files: each directory is opened from its parent descriptor with no-follow, entries are listed through the descriptor, symlinks are never followed, ignored names and denied paths are skipped. What could not be covered (depth, unreadable or changed directories) is counted, never silently treated as absent.

`WorkspaceScope.protectedAnchors`: The literal, nested heads of the deny patterns (`.deckent/live-data/state/ledger.db` from `…/ledger.db `, `.deckent/host` from `.deckent/host/  `; a pattern starting with a glob has none): paths whose ancestors a shell sandbox must never grant whole, even under an ignored tree (Astra 2162). Derived from the deny list, so a `.gitignore` change cannot lift them.

`NativeCliCapabilities.discovery`: How `disabled` discovery is realised. Argv: non-empty `disabledArgs`, the help flags they need and hidden probes whose invalid value must draw the exact parser refusal (a CLI that silently ignores an unknown key would otherwise leave repository instructions on). Checkout (C2, owner Q4 2026-10-23): a CLI without a suppression flag gets a worker checkout without the registry's `instructionSurface` (G1: one list for checkout shaping and the delivery floor; empty `disabledArgs`, no flags, no probes). Null = no `disabled` mode.

`createAgentShell.posture`: v6 PROMPT-POSTURE: the posture the system prompt states for this turn's shell, from the same realm resolution and open-view rule its calls take. A full-access turn's calls run as `full-access` or `owner-approved`, both open (`shellWritePosture`; the tier does not change `open` or the floor for either); any other turn's calls are closed whatever their authority. In the open view the turn's write floor is the configuration file (turn.ts): read-only for a `full-access` call, and for an `owner-approved` one as `shellWritePosture` says (W3: the owner's card never opens configuration content). The realm is known now: the configuration, the memoized host measurement and the turn's providers are those of every call. Per call only an exception differs, and that call's result says so (its `sandbox:` marker and notices): a full-access call whose grant no longer holds runs unattended in the closed view, and an open view that cannot be built (a state root holding HOME, the HOME walk over its bound) refuses the call.


### K20: first guarded subscription turn

The invocation owner may run a no-model preflight when surface observations are absent or incomplete.
CLI, login, environment and the exact execution identity must pass before this verification turn opens;
known negative observations keep tools closed. Readiness readers remain read only. The existing running-turn
cancellation controller owns the no-model probe too; it transfers into the admitted turn, and an early
cancellation records a cancelled turn without model/tool work. Steering explicitly waits for admission. Claude init/plugin guards
and Codex item order/allowlists precede proposals; the ordinary policy, approval and effect owners remain
unchanged. A completed guarded turn records the current profile/agent-flag digests. A surface refusal (unoffered
tool, plugin, parented event, registry `stopEvents`) stops only that turn and writes no negative observation
(owner 2026-11-05); an unrecognised CLI event is kept as an identifier in the turn's note and the turn goes on.
No alternate tool envelope is introduced.
The same retained observation is readable for workers; it is prerequisite evidence, never the separate F08
worker execution/settlement proof. Registry capability lookup includes agent-capable headless chat families.
Pure command schemas, environment/argv shaping, Claude stream validation and diagnostic projection live in
`capabilities/core/native-agent-execution`; asset loading, filesystem custody and spawning stay in adapters.
Codex agent argv disables agents and plugins using sourced registry data; the v1 text argv/digest stays unchanged.
Actual CLI subagent suppression must be verified in owner R / the assembled BeUser walk; fake CLI cannot prove it.

### K22: retained worker verification and input views

A worker with current CLI/login/environment observations and no F08 record may open its first guarded
verification Attempt. The tree gate, K5 recheck, K6 reservation and ordinary policy/approval owners still
precede execution. A host-private exclusive claim serializes this binding/seal; contention waits visibly.
The CLI init/item guards precede every proposal. After the CLI realm closes, effects settle and terminal
custody is retained, release publishes F08 for the exact connection, scope, reference, execution seal and
Attempt. A guard refusal instead retains a terminal negative; observing it again cannot trigger a retry.
Unsafe or unreadable records fail closed; a claim left by an unknown process is never stolen or aged out.
The record follows no-follow, owner, private-mode, single-link and bounded-read rules and is absent from
both CLI and tool views. An observation still does not constitute F08 or product acceptance.

K26 places no-model preparation in the authorized task owner before the worker readiness gate. Missing
or expired observations invoke the existing native-agent preflight and retain its prerequisite observation;
an existing observation, including a known refusal, is never reprobed by preparation. Readiness queries
remain read only. The current K5 binding is rechecked before preparation, and an exclusive host-side claim
for the profile serializes concurrent preparations across processes. Contention and probe failures park the
Run with a typed reason; an abandoned claim is never stolen. This claim grants neither model execution nor
F08: the tree gate, lease/delegation checks, K6 reservation and guarded verification Attempt still apply.

Admitted task artifacts and predecessor handoffs appear only in tool views at `/deckent/inputs/...`;
dependency binds retain their admitted targets. Read tools use the shared scoped reader; shell calls and
read-only environment probes use the shared bubblewrap view resolver/process owner with read-only aliases.
Receipts, source roots, scope, byte limits and link checks are rechecked before consumption. A realm unable
to provide those views refuses them. The CLI receives neither these mounts nor their paths in argv.
Native template defaults derive their Node requirement from the native CLI registry's hard `dataBytes`
bound and `native-agent-execution/internal/worker-environment.json`'s heap policy; Docker defaults and
explicit environment declarations retain their own values. Both read-only probes and governed worker
shell calls use that same native bound: `prlimit` sets soft and hard RLIMIT_DATA before the command,
and the fixed Node environment sets old-space to the registry share (currently 1536 MiB of 2 GiB).
Children inherit the hard limit; this is a per-process data bound, not an aggregate RSS/cgroup limit.
The existing heap probe still checks minimum available V8 heap, not exact old-space size. A missing
executable or unmet declaration refuses before model launch. An Attempt inside installation state uses
a closed bubblewrap view that first hides its state ancestor, then binds only that Attempt subtree;
sibling state remains absent. This trusted composition-only layout rejects open views; ordinary chat
shell layouts are unchanged. Generic template/probe shaping and the native bound wrapper live in
`capabilities/core/native-agent-execution`; adapters supply registry data and the existing realm owner.
`GitWorkspacePatchSource` selects capture and release observation from the recorded supervisor adapter:
native workers use their exact retained terminal custody, while Docker records keep Docker observation.
Unknown or mismatched terminal custody cannot produce a patch; path, symlink and snapshot bounds remain
unchanged. Patch retention, task acceptance, queue admission and authorized custody release retain their
existing application owners; a worker's successful exit alone does not establish coding-task acceptance.
Legacy profile selection and `projectionRetired=false` are unchanged. Real-account R08, assembled BeUser,
independent review and hosted acceptance remain separate from author fixtures and compiled evidence.
Background worker approval binds the fresh deciding terminal peer through
`attendedWorkerApprovalInput` before the existing approval application consumes its turn-bound capability.
This does not lower the self-source or static hard floors. Author fixtures, compiled customer-project
execution and assembled self-source interaction remain separate evidence scopes.
