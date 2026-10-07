# Agent tools: read, edit, scratch, shell, fetch, tool calls — module note

Composer `@file`, file edits as C11 effects, scratch area, run_shell, fetch, tool-call transport and terminal direction (moved from ARCHITECTURE.md Packages 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 1128–1267, 1499–1648; text below is verbatim.

**Composer `@file` over the runtime (T-L5, protocol v15, owner 2026-09-27).** Two bounded control operations, current version only:
`findWorkspaceFiles {scopeId, query ≤ 256, limit 1..50}` → `{paths, truncated, incomplete}` and `attachWorkspaceFile {scopeId, path,
maxBytes ≤ 32768}` → `{path, status: 'attached', content, bytes, totalBytes, truncated}` | `{path, status: 'refused', reason}` (reason: the
read boundary's typed path errors, `binary`, `read-error`, `cancelled`; a refusal is a result, not a failure). Both require `delivery`;
the answer always fits it. The caller is the connection's verified peer and must be a member of the scope under current policy (read
access); files come only from the project workspace through `workspace-read` (Core deny floor, ignored/generated directories, no
symlink followed, regular single-link files, UTF-8-boundary prefix, NUL = binary, a file changed while read is refused). Candidates
come from a per-project index walked at most every 10 s (single flight, ≤ 50 000 files; a measured walk took 170–460 ms on 1.3k–2.6k
files, so a per-key walk was rejected); ranking: file name before path, exact (with or without extension) > prefix > substring >
subsequence, then fewer segments, shorter path. The attach path always resolves fresh, so a stale candidate that disappeared or became
denied is refused. On submit the draft's mentions outside paste chips (at most 8, no repeats, exact paths) are attached; one tokenizer owns
lookup, completion and submit (`@` at text start or after whitespace, never `@@` or an email; `@"…"` keeps every character; a bare
`@path` runs to whitespace and drops trailing sentence punctuation; an unclosed `@"` reads as bare and never swallows later mentions;
a quoted mention reaching into a paste chip is dropped): the user message is
the typed text plus one labelled block per file (`--- attached file <path> (…) ---` … `--- end of <path> ---`, model-facing protocol
text), ≤ 32 KiB per file and ≤ 128 KiB per message; the ledger shows the typed text and one notice per file. Content is part of the
user message, so the chatTurn request digest, session snapshots and compaction cover it; no ledger change. The client rejects an
attachment larger than it asked for. A v15 terminal on a v14 service shows no candidates. Authorization is scope membership only (no
separate policy resource); whether `@file` needs its own grant is an open owner question.
**Operation-keyed approval for agent tool calls (C12 minimal, T-L4 slice 1, Jev 9266755b, ledger v38, protocol v14).** An approval
request is a union: task admission (schemaVersion 1, unchanged, so every sealed record verifies byte for byte) or an operation-keyed
request (schemaVersion 2) whose `subject` is `agent-tool-call` {turnId, round, index, tool, toolVersion, resource, argsDigest}; its
action digest (`agent-tool-call:1` over scope + subject) makes it call-exact and single use (never renewed; the next call opens its
own). Ledger v38 rebuilds `approvals` with `subject_kind`, nullable run/task and a per-(scope, action digest) index for tool calls.
When policy says `require-approval` for an `agent-tool` call, the turn opens the request (the agent turn is an approval producer and
creates the integrity key on first use, like Run reservation), emits `approval.requested` (call id, approval id, revision, audit
summary `tool · resource · digest`, presentation preview ≤ 16 KiB, expiry = `approvals.requestTtlMs`) and waits (store polled every
250 ms) until the existing `decideApproval` (session-authenticated, `approval`/`decide` grant) decides it, it expires, or the turn is
cancelled — expiry and cancel close the request as `expired` through the one sealed pending → expired transition (shared with lazy
expiry). A failed close is re-read: a record another writer already settled is authoritative (at expiry a decision committed first is
returned; a cancelled turn still runs nothing); a record still pending or unreadable after 3 short attempts is `APPROVAL_UNSETTLED`,
never reported as closed. Once `approval.requested` went out, `approval.settled` always follows; its outcome adds `unsettled` (v14
amended before release, no v15: no v14 peer was ever shipped), and the terminal closes the card and says the pending request permits
nothing and closes at its expiry or the next service start. At start, under ledger and endpoint custody and after interrupting turns, every
still-pending tool-call approval is closed as expired in bounded pages (task approvals untouched; an unverifiable record is counted;
a missing integrity key is reported, never created); the host reports `tool-call-approvals-expired`. An allow is followed by a fresh policy
evaluation (a deny since the request wins). Outcomes are typed call results: `ok` after the run, `denied` (owner or policy),
`approval-expired`, `cancelled`, or `approval-required` when no approval could be obtained; nothing but an explicit, re-authorized
allow runs the call. The terminal shows the request on the existing decision card (summary, preview up to 24 lines, expiry; a single
`y` allows, every other key denies) and closes it when the approval settles elsewhere; a late answer to one decision closes only its
own card, never a newer call's (Astra 2092 R1). v14 also carries `tool.output` for slice 3.
**Agent file edits as C11 effects (T-L4 slice 2).** `edit_file` (exact `old_string` → `new_string`, unique unless `replace_all`; no
`$` pattern interpretation) and `write_file` (whole content) are declared beside the read tools (tool class `edit`). Policy is
asked first (a denied call is answered before the file is touched, so its result never depends on content); then the loop's
`prepare` port plans the call from the file as it is: resolved workspace-relative path (normalized,
inside the root, not denied, parent not a symlinked directory), the file's version (sha256 of its bytes, or `absent`), the new
content and a bounded unified diff (LCS ≤ 4M cells, else summarized); a plan error is the call's result and nothing is asked. The
call's decision is the stricter of the `agent-tool` decision and the `operation` decision for `workspace.file.write` (`execute`), and
the write floor (`.github/**`, CI files, hooks, package manifests, `.deckent/**`, agent configuration, `AGENTS.md`/`CLAUDE.md`,
`Makefile`, `Dockerfile`) raises `allow` to `require-approval` in standart and full-auto (a launched full-access turn lowers it,
MODES-3 — except the installation's configuration file, `edit-authority`); an approval shows the planned diff. The write is one
C11 effect of the Core `workspace.file.write` operation on the `workspace-file` target (record id = the workspace-relative path,
resolved only through the workspace scope): live peer session, operation policy re-evaluated right before the effect, intent
before effect, precondition = the planned version (a file changed since it was planned or shown is refused, nothing written),
atomic write (exclusive temporary file in the same directory, fsync, directory re-verified, version re-checked, rename, directory
fsync; mode kept). Each attempt journals its own phases under the wire key (journal v2, atomic, 0600, managed `fileEffects`
directory; Astra 2094 R1): `prepared` with a unique temporary name before that file exists, `committed` after the rename, `aborted`
before the temporary file is removed — and the temporary file is removed only once `aborted` is durable; if that journal write
fails the temporary file stays as evidence that the rename did not happen (Astra 2100) — `escaped` when the parent left the workspace during the write. Crash settlement decides from
that evidence, never from content: committed → applied (even if the file changed later); aborted or no journal →
absent (resend; a stale temporary file of the earlier attempt is removed first); prepared with its temporary file present → absent;
prepared with it gone → unknown whatever the file holds (`prepared` precedes the temporary file, so a crash before it existed and
a crash after the rename look the same, and content equality is not causal evidence; Astra 2100); escaped, unreadable or a retired v1 journal → unknown — never a blind
retry. After the rename the parent is verified again: a directory moved out of the workspace meanwhile is journaled `escaped` (with
where it went) and the effect is unknown, never reported as done, and nothing is written again to undo it (Astra 2094 R2: detection,
not prevention — Node has no openat2/renameat; a same-user process, including the planned unsandboxed host shell, can move directories;
owner 2026-09-26 accepted this as a documented limit — no native/Landlock writer for now; COMPLETED-PLAN "Owner kararları 2026-09-26 (akşam)" (1)). Approval previews are bounded to 16 KiB UTF-8 bytes (whole lines first, never
a split character) under a first-line marker naming what is not shown and the sha256 of the whole text; a cut edit diff is kept whole,
owner-only (0600, exclusive, not redacted: it must be exactly the change approved), in the managed `approvalPreviews` directory while
the approval is pending, removed when it settles and swept at service start (Astra 2094 R3). The effect's identity is the turn, the call's position (round,
index), the arguments and the planned version (Astra 2113: the version alone collided after writes B, A, B and reported a write that
did not happen); the effect's approval gate (C12 G3) admits only from the durable `agent-tool-call` record of exactly the executed call: a sealed (MAC) `allow`, subject and action digest rebuilt from the executed call (turn, round, index, tool@version, resource, arguments digest), requested by the effect principal, decided on the request it names, inside its expiry at the claim (judged by the requesting process, I40-c B). It applies whenever the owner was asked — tool decision, write floor or operation decision. The claimed intent pins `approval {approvalId, actionDigest}` (its consumption); later passes verify the pin without a window; a settled record replays. In-turn state is only a pointer to the record and the per-turn one-approval-one-command map; it never admits. Not excluded: another writer between the final
version check and the rename (no advisory locks). `adapters/core/sqlite-agent-turn` stores `agent_turns` and `agent_turn_tool_calls` in the ledger.
**Agent scratch area (SCR-A, owner 2026-09-28).** Three tools, no new class or decision cell: `scratch_write {path, content}` (class
`edit`, cell `edit`, never on the write floor), `scratch_read` (= `read_file` over the area) and `scratch_list` (= `list_dir`), class
`read`. A scratch write is a C11 effect of the Core operation `workspace.scratch.write@1` on target kind `scratch-file` (namespace
`workspace` is Core-closed; registry module `core.scratch-write`); record ids are `<owner>/<session>/<path>` because the effect
store's busy check and sequence are per target kind and id across scopes. The physical write reuses the workspace-file target over
the session area (conditional on the planned version, atomic, journaled, 0600). Silence comes only from policy: `agent-tool/invoke
scratch_*` and `operation/execute workspace.scratch.write` both `allow` → no card in ask mode; otherwise the normal C12 flow or
`POLICY_DENIED`; a mode relaxation uses the existing `permission-mode` event (audit schema unchanged). Missing directories are
created at the effect (after the decision), never through a link. Quotas are configuration (`terminal.scratch`: write 1 MiB, session 64 MiB, installation 512 MiB). The check when planned (before any card) is advisory; the binding check runs at the effect inside the service's one scratch custody (`createScratchActivity`, adapter `scratch-store/internal/custody.ts`): every scratch write goes through `ScratchSession.spend(rel, bytes, write, signal?)`, which takes the custody's single write lane, measures the session and installation usage (the replaced file counted once), refuses or runs the write, and hands the lane on whatever the outcome (written, refused, failed, unknown, cancelled while waiting). The lane is an exclusive reservation of the resource's byte budget for one check→write transition: no other scratch write changes the usage between the measurement and the rename, so two concurrent writes never spend the same free bytes, and an unknown outcome is measured from the disk by the next write (never spent twice nor lost). Reservation is in-process only: the LEDGER-SINGLETON custody (held from start to dispose) leaves one service per ledger/layout, and only that service writes the scratch resource through Deckent. A refusal is the tool result `error=scratch-quota-exceeded (<write|session|installation>: …)`, never a cut. The encoded effect input must also fit the catalog
bound (1 MiB), so the effective content ceiling is 1 MiB minus JSON escaping. The area belongs to the conversation:
`chatTurn.sessionId` (v16, optional) keys it; without it the turn has its own area. Project tools never reach the scratch resource
(`agentWorkspaceDeny` adds it beside approvals and previews). Retention: a session area whose newest change (lstat walk, links not followed) is older than `terminal.scratch.retentionDays` (7) is removed at service start under ledger custody and by the running service every `sweepIntervalMs` (1 h, unreferenced timer, started once the listener is up, stopped with the service). Open/hold and measure/remove use one ownership mechanism, the same custody: a turn holds its area (and its owner directory) before the area is opened, waiting while a removal of it is in flight and then opening a fresh area; the sweep claims an area before measuring it and keeps the claim until the removal ended, so a held area is never claimed and a claimed area is never opened; the owner directory is removed only under its own claim, which any held area of that owner refuses. A failed open or a failed removal releases what it took. Service stop closes the custody (no claim succeeds any more) and waits for a removal in flight before the endpoint and ledger custody are released. Non-area entries are left alone; an area past the walk bounds is kept and counted `unreadable` (observer `onScratchSwept({ removedSessions, removedBytes, kept, unreadable })`). Open limits: content is stored
in the effect intent (ledger growth under heavy use; content-addressed input is a follow-up); the installation quota walks the whole
resource per write (bounded 100 000 entries / depth 64, fail-closed past them); shell writes are measured but not stopped by the
quota; scratch writes of one installation are serialized in the service (each holder writes at most `writeMaxBytes`; a throughput choice, no measured capacity); `/scratch clear` (the person's own request) may empty an area a running turn uses; scratch content is not redacted.
**Read-only shell classification (T-L4 slice 3a, Jev d6909e28).** `engine/core/shell-classification` is pure: a POSIX `sh -c`
scanner (pipelines of stages; redirection only to /dev/null or between stdout/stderr; substitutions, expansions, subshells, braces,
heredocs and background jobs refused with typed reasons), the legacy program allowlist and option grammars (argv semantics: quoting
never demotes an option), sed/awk script grammars, `find` and `git` read grammars, and the risk tiers (destructive table as the
always-ask floor, worst part wins, redirection/tee → modify; `safe-read` only from the classifier). It is a port of legacy
`shell-readonly-classifier.ts`/`shell-risk.ts` @a8b67e2a1 (POSIX only; PowerShell is `UNSUPPORTED_DIALECT`, so a Windows host asks for
every shell command). Paths go through a port: `adapters/core/shell-paths` checks each argument over the same `WorkspaceScope` as the
read tools and edits (lexically inside, not denied, existing, real path inside and not denied; a path or glob prefix with a `..`
component is checked as the kernel opens it — native realpath of the unnormalized text, so `link/..` is the parent of the link's
target — and must exist inside and not denied (Astra 2111); a `..` after a glob segment is GLOB_UNSUPPORTED; sh globs expanded against the real
directory, bounded at 10,000 matches, each match checked; git pathspecs lexical). The shared deny list gained the legacy credential
carriers (`*.pfx`, `*.keystore`, `*.jks`, `.pypirc`, `credentials`, `credentials.json`, `secrets.json`, `.brain/memory.db*`) and the
`.git` directory itself, so read tools refuse them too; legacy `.deckent/private/` is dropped (Next keeps private state under the
already denied `.deckent/host`, `audit-key`, `approvals`). Not covered: intermediate symlink hops that leave the root and return (the
final real path is what the shell reads), a swap between classification and execution, and — legacy-inherited, verified —
traversal (`grep -r x .`, `rg x .`, `find . -type f`) and git object reads (`git show HEAD:.env`, `git log -p`, `git cat-file -p`)
classify read-only with risk `low` although the shell then walks into denied files or prints objects no path check sees; slice 3c
must not run `low` silently on this verdict alone. Since slice 3c the agent `run_shell` tool uses it
(`composition/core/agent-turn/internal/shell.ts`).
`classifyShellContainment` (SHELL-AUTONOMY) is a second pure layer over the lenient risk scanner (command substitutions exposed):
a command is contained unless a part runs a program-floor program (privilege, interpreter, eval-like wrapper, xargs, package manager,
network tool, `env <program>`, `find -exec/-execdir/-ok/-okdir`; `tee` is not on it — it writes like a redirection), its program word is not a plain name (`$x`, `$(…)`, a path), it has a
process substitution, a `case` construct or anything unparseable, or a word (redirection targets and `--opt=value` values included)
names a protected path — the write floor or the product state — lexically, from the project root and with leading `./`/`../` dropped.
It is an intent filter, not a boundary: the sandbox realm is the boundary (awk `system()`, `git -c`, `make` and similar are not seen).
**Host shell execution (T-L4 slice 3b, Jev 52f9b6f9).** `adapters/core/host-shell` runs one command: `bash --noprofile --norc -c`
(no rc-file side effects; legacy used `-lc`), stdin closed, cwd = workspace root, its own process group; environment = an allowlist
copied from the service (PATH, HOME, USER, LOGNAME, LANG, LC_ALL/CTYPE/MESSAGES, TZ, TMPDIR, SHELL) plus operator-allowed names and
fixed non-interactive settings (TERM=dumb, NO_COLOR, PAGER/GIT_PAGER=cat, GIT_TERMINAL_PROMPT=0) — credentials in the service
environment never reach the command unless their name is allowed. The process group is the call's lifetime (Astra 2112 R1,
2119): cancellation and the timeout (default 300 s) signal the whole group (SIGTERM, SIGKILL after 2 s); when the shell exits by
itself, surviving group members get the same SIGTERM → 2 s → SIGKILL; inherited pipes still open afterwards are drained for a 1 s
grace and then released, and the timeout or a cancellation releases them at once (the status stays `exited`). The result reports
`cleanup`: `clean`, `group-ended`, or `unverified` (the group could not be observed empty after SIGKILL, or pipes were released while
held); the agent shell tool puts that note in the model's result and the owner's stream (Astra 2124). Protocol v15 also carries the value as an optional `cleanup` field on the
`tool.finished` event and on the agent tool outcome — the host shell tool's outcome only, enforced at the single emission point in the
agent-turn loop; the terminal's finished call line shows a short suffix for `group-ended`/`unverified` and nothing for `clean` or an absent
field (CLEANUP-MARK; closes Astra 2124 open item 1, owner 2026-09-27); the line reserves its elapsed/status/cleanup tail and shortens
the command text instead, and below the room for the tool name the tail takes its own wrapped line (Astra 2139 R3). This is a process-group
contract, not a sandbox (the bubblewrap realm adds a PID namespace; the Landlock realm does not): a descendant that left the group (setsid, a daemon) is not observed and can outlive the call. Output streams
in chunks ≤ 8 KiB without splitting a UTF-8 character; the result keeps 16 KiB (`HOST_SHELL_RESULT_MAX_BYTES`; a quarter head, the
rest tail), cut on UTF-8 boundaries — a character split across two pipe reads is carried to the next read, never replaced by U+FFFD
(Astra 2112 R2) — with the omitted byte count (legacy kept everything). `durationMs` is monotonic elapsed time (I40). Results: exited (code/signal), timed-out, cancelled, spawn-failed,
unsupported-platform (Windows). On the host realm it is not a sandbox: the command has the service user's file, process and network
access (the sandbox realms below narrow this). Open:
the command runs in its own process group so it can be killed, which also means a service crash leaves a running command orphaned
(the turn is closed as interrupted at the next start, but nothing signals the group; legacy had the same property; Node has no
parent-death signal) — candidate: record the group id in the effect journal and signal it at start.
**Independent integration review (Astra re=2125, 2026-09-27; `5a25b10`, not yet main):** the 2119 unbounded post-exit pipe wait and 2124 missing cleanup notice are fixed in the reviewed integration. Timeout/abort release retained pipes and a separate drain grace bounds completion; `cleanup:unverified` reaches the model result and owner output stream. Process-group signaling still cannot prove escaped descendants died. A persistent finished-call cleanup marker remains a protocol/owner decision. This review does not admit a sandbox or live activation. The follow-up review of `1e896fb` (2127, integration only) closes H34 read-side pinning and A04 registry mutability. The follow-up `b596eee` review (2130) closes both C12 violations: protocol subject visibility now participates in SQL page selection before LIMIT/capacity, and fresh unconsumed approval admission is rechecked after observation before the first claim. Already-consumed intent recovery remains separate. I40-c in that candidate uses trusted producer/consumer time and a monotonic TTL; the decider subtracts usability, never adds lifetime, with a 5 s conservative allowance. A decider already 5 s ahead may reject about 10 s early relative to the producer, and small TTLs can be wholly unusable; a single expiry authority remains a separate owner option. These are reviewed integration properties, not claims that current main or the live service has been updated (PLAN). Open limit (Astra 2145): the ledger upgrade, interrupted-turn close, orphaned tool-call approval expiry and preview sweep still rely on
endpoint custody alone; a service started on another socket over the same ledger is not excluded from them (ledger-level custody is
the proposed class fix, owner decision).

**Agent shell tool (T-L4 slice 3c-i, Jev 82858581).** `run_shell {command}` (tool class `shell`) is declared beside the read and edit
tools. Policy first: the `agent-tool` decision and the `operation` decision for Core `host.shell.run` v1 (`execute`), stricter wins, a
deny is answered before anything else and never offered. Then the command is classified (slice 3a over the turn's workspace scope):
only a read-only command of bounded reach (risk `none`) runs without asking, and only under allow; `low` (traversal, repository
objects), modify and the destructive table ask the owner in standart and full-auto (a launched full-access turn lowers them, MODES-3). In full-auto inside an enforced sandbox realm a contained command of any other tier but destructive runs without asking when the company rule is mode-eligible (SHELL-AUTONOMY; outside the narrow mutating set such a run sees the project read-only, Astra 2170); the realm, not the classifier, bounds it — paths outside the project are left to the realm (bubblewrap: private `/tmp` tmpfs, empty HOME; Landlock: writes outside the project and scratch area refused). The
approval preview shows the exact command, its risk tier and reason, and where it runs (the realm's posture: bubblewrap, Landlock and its limits, or the host: not a sandbox — described from the call's own write posture). Every run is a C11 effect on the
`host-shell` target (live peer session, operation policy re-evaluated before the effect, intent before spawn; the approval subject's
`resource` shows at most the first 200 characters of the command, and the exact command is bound by the arguments digest); each run is its own
record, so an uncertain run never makes the shell busy; its effect identity is the turn, the call's position (model round, index in
the response) and the arguments digest — a replay of the same call is the same effect, a later identical command is another; the
provider's call id is not identity (providers reuse it; Astra 2113); an owner approval admits the run only through the same durable-record gate as edits (C12 G3) and is pinned in the run's intent. A shell keeps no idempotency record: exited is the effect (any exit code), a
cancelled or timed-out run is `unknown` (the result says what it changed is unknown) and is never re-run, a run that could not start is
refused. Turn cancellation reaches the running command (group killed). Output streams as `tool.output` while the turn channel has
room (a new channel `room()`); past half of it the display stops with one visible marker, and the streamed display is drained before
the result is emitted. The result keeps 16 KiB (head + tail, omitted bytes counted), like a read tool. `terminal.shell` configures the
per-command timeout (default 300 s) and extra environment names. Live use needs owner grants (`agent-tool` `run_shell`, `operation`
`host.shell.run` execute). The terminal (slice 3c-ii) shows the last three lines of the running call's output under its live line
and nothing of it afterwards (the finished call stays one line; the output reached the model as the result). Command output is
untrusted: before display every escape sequence (CSI, OSC — titles, clipboard —, other ESC forms) and every control character but
newline and tab is removed and carriage returns become line breaks; the live tail keeps 2,048 characters. The same sanitizer
applies to model answer text, a tool call's display target and the approval card's summary and preview (slice 3c-iii): a probe showed
Ink drops cursor and OSC sequences but passes SGR, and SGR can conceal text (ESC[8m) — e.g. hide a line of a diff on the card.
Astra review of `95c3a14` + `6a53765` (2026-09-26, 2094): content-equality recovery, the moved-parent write and the unbounded preview —
corrected locally as described above; for R2 the owner accepted (2026-09-26) the documented residual race between the last check and the
rename (no native or isolated writer for now); awaiting Astra re-review.
Astra review of `e6085ca` (2026-09-26, 2092): swallowed close failures and a late answer clearing a newer card — corrected locally
as described above; Astra re-review of `7e0e349` (2095) confirmed both original corrections with 71 targeted tests. The subsequent
observer-dependent startup recovery defect is corrected in `a4604fc`: recovery runs before optional notification. Astra 2097
re-review confirms observed/unobserved starts both expire the orphan, and a missing integrity key leaves it pending, reports
`keyUnavailable` and creates no key (3 fresh real-service tests). This scoped review closes 2092/2096; T-L5 and file-write findings
remain open, and full verification/deployment acceptance are separate.
Astra 2099 re-review (2026-09-26): retaining read dedupe by provider call ID is insufficient because IDs may repeat across rounds;
a recent unrelated call can keep a compacted-away read marked visible. Also the pre-round 75% request-byte threshold does not
ensure the completed answer plus next user input can enter the service transport; a valid configuration reproduces rejection in
the client before runtime compaction. Both were corrected in `2900a8d` (dedupe bound to result messages; request headroom and a typed
refusal, owner decision 2026-09-26); Astra 2117 scoped PASS (2026-09-27, 46 fresh engine/runtime tests) closes these two repros.
The selected four-bytes-per-completion-token reserve is a sizing allowance, not a universal tokenizer byte bound; oversized
requests still receive the typed refusal. Large compacted frames and tails above the watermark remain open limitations.
**Shell TMPDIR = scratch area (SCR-A).** `run_shell` gets `TMPDIR` = the conversation's scratch area (a fixed value that wins over
the service environment and over an operator naming `TMPDIR` in `terminal.shell.environment`). The shell path port takes the area as
a second root: an absolute path inside it is checked against the area's own scope (read-only `none` → may run without asking under
allow; `cp/mv/mkdir/touch` into it → `narrow-mutating`); leaving it lexically or through a link is `PATH_OUTSIDE_ROOT`.
`$TMPDIR/...` is a variable expansion and asks unless full-auto in an enforced sandbox (SHELL-AUTONOMY) or full access lowers it. Project-root classification is unchanged. In the Landlock realm the area
is also the command's `HOME`; in the bubblewrap realm HOME is an empty tmpfs and the area is a separate read-write bind.
**Agent fetch tool (FETCH S6/S7/S10, owner 2026-09-28).** `terminal.fetch` (schemaVersion 1, optional): `egress: none | allowlist |
approval` (default `none`), `allowedHosts[]` (exact lowercase DNS names; no wildcard, no IP), `maxBytes` (4 MiB), `timeoutMs` (30 s),
`maxRedirects` (3); no proxy field (corporate proxy is a separate slice). `none` builds nothing: no `fetch_url`, no transport use, and
the system prompt says there is no network access (v6: unless the shell's posture reaches the network — then fetch_url is named not offered). **Egress mapping (decided, Jev ee030c0e 0.90 / sufficiency 0.77): `allowlist`
refuses every host outside `allowedHosts` without a card or a DNS lookup (`host-not-allowed`); `approval` runs listed hosts under
policy and opens an owner card for any other host.** A redirect is followed only to the call's own host (for an approved call: the host
the owner approved) or an allowlisted host (decided, Q2). A timeout before the TLS handshake finished sent no HTTP request and is
`refused`; after it, `unknown` (decided, Q3). `fetch_url {url, maxBytes?}` (class `deckent`) is planned before anything is resolved —
no DNS query leaves the machine before a decision: https only, no userinfo, port 443, no IP literal, ≤ 2048 characters, fragment
dropped. Decision: the one `decideAgentToolCall` over `agent-tool/invoke fetch_url` and `operation/execute network.fetch`; cells
`fetch-listed` (the policy decision stands) and `fetch-unlisted` (allow → card); neither is relaxable, so no permission mode lowers a
fetch and the `permission-mode` audit event is never written for one (schema unchanged) — except a launched full-access turn (MODES-3;
owner 2026-09-29: a trial, decided again after use), which lowers `fetch-unlisted` like every other cell and records it as a
`full-access-call`; refusals of the egress setting stay refusals. A fetch is not counted by the silent-decision
counters. The card shows `GET <whole URL>`, the allowlist verdict, the byte limit and `sha256(url)`; the approval resource is the URL
cut at 200 characters and the arguments digest binds the rest (C12 G3 unchanged). Each call is a C11 effect of Core
**`network.fetch@1`** on target kind **`network-fetch`** (root registry module `core.network-fetch`; the id closes the `network`
namespace to overlays; `write` class, policy approval, no precondition, no compensation, input `{url, maxBytes}` ≤ 4 KiB), its own
record, identity = turn + call position + arguments digest. Adapter `adapters/core/http-fetch`: every hop resolves the host, requires
every answer to pass the gateway's `isPublicNativeAddress` (extended to IPv6: global unicast `2000::/3` minus `2001::/23`,
`2001:db8::/32`, `2002::/16`, `3fff::/20`; mapped/NAT64/ULA/link-local/multicast/loopback are outside; the machine's own addresses
excluded; the gateway still resolves IPv4 only), connects to the checked address (no second resolution) with SNI and Host = host and
certificate verification on, sends one GET with `User-Agent: Deckent-Fetch/1`, `Accept-Encoding: identity`, no
`Authorization`/`Cookie`; a redirect (301/302/303/307/308) is followed only over https to an allowlisted host or the call's own host,
anything else stops (`redirect-refused`, `too-many-redirects`); the body is cut at `min(maxBytes, args.maxBytes)`; `timeoutMs` bounds
the whole call. Outcomes: nothing sent (bad URL, DNS, non-public address, TLS/connect failure, or a timeout before the TLS handshake
finished) → effect `refused`; answered (any status, a stopped redirect included) → `settled`; sent then timed out, cancelled or broken
→ `unknown`, never sent again (`lookup` is always unknown). The body lands in the conversation's scratch area as
`fetch/<sha256(body)>.<ext>` (extension only from a fixed media-type table) through `ScratchSession.deposit` — not a `scratch_write`
effect (its content would ride in the intent, bounded at 1 MiB) but the same scratch write lane: `deposit` runs inside
`ScratchSession.spend`, so its quota check and write are one transition with no other scratch write in between (Astra 2149 R2);
exclusive 0600 temporary file, flushed, renamed; over quota the body is not kept (`scratch-quota-exceeded`); the fetch call's signal
abandons the wait for the lane (result `not saved: error=cancelled`). The model gets status, content type, size, cut flag, redirects,
final URL, the saved path and, for a text type, the first 16 KiB through the existing secret-shape filter (`redactText`); a binary body
is not shown. The transport (resolve / connect / trust anchors) is a code-only port: the product always uses the system transport;
`startConfiguredRuntimeService(…, { fetchTransport })` exists for in-process tests and `runtime serve` never passes it; the
public-address check is not part of the transport and cannot be turned off. Open limits: prompt-injection in fetched text is inherent
(the head is data, a body line may imitate a `[deckent]` meta line); the saved file is not redacted (as scratch); the deposit path is
created link-free but the final rename is by path (same-user race, as scratch); fetched bodies wait in the one installation-wide
scratch lane (a 4 MiB write holds it for its write); no proxy, no POST, no cookies/auth by design; an allowlisted host that resolves to
a private/intranet address is always refused (the on-prem/Enterprise intranet need belongs to the proxy slice).
**Allocation without a lifetime total (T-L3a, owner 2026-09-25, ledger v36).** A model invocation profile's allocation may set
`maxCalls: null`: no lifetime total of calls, an explicit and audited profile choice (the local terminal profile can use it;
live since the owner's 2026-09-25 migration, API profiles keep theirs). `maxInFlight` still bounds concurrency, and policy, activation, provider availability and spending authority
still apply. The allocation contract of an id is fixed: changing its limits is `MODEL_INVOCATION_ALLOCATION_CONFLICT`, so a profile
moves to an unbounded allocation under a new id; existing receipts keep verifying against their own allocation. Ledger v36 rebuilds
`model_invocation_allocations` row for row with a nullable, positive-when-set `max_calls`.
**Tool calls over openai-chat (T-L2).** `openai-chat-http` v4 sends `tools`/`tool_choice` and accepts assistant `tool_calls` and
`tool` messages only when the model binding declares the `tool-calls` capability as supported (catalog data); otherwise any tool
call is refused as before. Responses may carry calls only to declared tool names, with unique ids and `finish_reason:
tool_calls`; the legacy `function_call` is never accepted and `tool_choice: none` forbids calls even with tools declared (Astra 2079). Streamed calls are assembled by index (fixed id, name and arguments in
pieces, contiguous indexes) and pass the same check; a streamed name that no declared name can still match stops the read and presentation at once; a cut stream is interrupted
(uncertain) and yields no call. Arguments stay the provider's raw text: invalid JSON is the loop's typed tool error to the model.
The loop sees the provider-neutral `AgentToolCall` (`id`, `name`, `argumentsJson`); native details stay in the native result.
The OpenAI chat wire shape (request messages, response reading, the uncounted prompt bound) belongs to the `provider-openai-chat`
adapter; the compaction call protocol and the approval preview bound belong to engine `agent-turn` (COMP-BUDGET-2).
The 2026-09-25 review limits (Astra 2079: `tool_choice: none` on responses, an undeclared streamed name rejected only at finish) were
corrected in `e12a253`; Astra 2091 found no new blocker in them.
**Agent terminal direction (owner 2026-09-24) and tool contract (T-L1).** The terminal becomes a Claude Code-class agent
terminal: one full-context model, an engine-owned governed tool loop, permission modes, Deckent tracking and management through
commands, queries and MCP, no terminal budgets (automatic compaction for an endless flow), local model first and API providers
after; the local vLLM worker lane is separate. The shell runs on the user's machine with permission modes — a policy/permission
boundary, not an isolation claim. Tools are data (`domain/core/agent-tool`: name, version, class `read|edit|shell|deckent|mcp`,
JSON input schema); a tool never grants authority. T-L1 ships the read class as `adapters/core/workspace-read`, ported from the
legacy native tools minus their defects: `read_file` (bounded content view from line 1 for a plain path, `outline` with headings
and size/longest-line statistics, numbered ranges with long-line elision naming the exact `lineByteOffset` continuation, search),
`list_dir`, `grep` (long lines are searched and elided, skipped binary/oversized files are reported instead of a bare "no
matches"), `glob`. Every result is byte-bounded by the tool itself (16 KiB default at T-L1; 64 KiB since owner 2026-09-27,
`terminal.chat.readResultMaxBytes`) and states any cut; fitting results into the
model context is the loop's job in one token unit. Reads resolve the real path inside the workspace (traversal, absolute paths and
symlink targets outside are refused), a Core deny floor (`.env*`, keys, credentials, `.git/**`, Deckent host/approval/audit state)
is registry data, generated directories are skipped. **Boundary under races (Astra 2072):** every open walks the real path's
components from a root descriptor (`/proc/self/fd/<fd>/<name>`, openat semantics) with no-follow on each component and re-checks
the opened descriptor's own path, so a parent or root swapped for a symlink after the check is refused; files with more than one
link are refused (a hard link can alias a protected file); files open non-blocking and must be regular, so FIFOs and devices never
stall the service; walks list directories through their descriptors and count what they could not cover (depth > 32, unreadable,
changed, special files) instead of reporting absence; every directory and file opened during a walk is re-verified against its
workspace path too, so a parent moved out mid-walk yields a refusal, not its outside content (Astra 2078). Globs (the glob tool, grep's
filter and the deny floor) are matched by a dynamic program bounded by pattern × path length, never by a backtracking regex; glob
patterns are capped at 512 bytes. A descriptor verified at open is read as that object even if it is moved afterwards. Regular expressions run in a worker thread that is terminated on cancel, the
signal reaches every tool, and every result branch is cut to the cap with a stated marker; path/pattern arguments and limits are
validated. The guarantee is Linux-only (WSL included); other platforms fail closed until they have an equivalent. Engine per-call
authorization is not wired in T-L1; the read adapter is not an admitted terminal execution surface by itself (T-L3).
The 2026-09-25 review limits (Astra 2078: no path recheck of walked descriptors, backtracking glob on the service thread) were
corrected in `e12a253` (every walked directory and file is re-verified; globs match by a bounded dynamic program); Astra 2091 found
no new blocker in them.

**Anthropic Messages provider (ANTHROPIC-PROVIDER G8, seventh batch; ANTHROPIC-PROFILE, eighth batch).** Provider adapters: `openai-chat-http` (v4), `openrouter-chat-http`
(v1) and `anthropic-messages-http` (v2, family `anthropic-messages`, API version `2023-06-01`; unit `adapters/core/provider-anthropic-messages`).
The adapter takes the provider-neutral (OpenAI-shaped) local request and returns an assembled neutral `chat.completion` evidence; consumers
do not know the family (one exception: the capability check knows both). `provider-http-json` credential kinds are `none | bearer |
header(x-api-key)` with bounded static headers; `header` only over https. Spend: price id `anthropic-published-tariff` v1 (published rates
are profile data; the quote ceiling is integer arithmetic); settlement of usage × tariff does not exist yet, so a responded call stays
`held` (checkpoint A, blocks real Anthropic use). HAIKU55-CATALOG (2026-10-08): `pricing.json` schema 2 and tariff v2 add prompt-length
tiers (Claude Haiku 5.5: more than 100,000 prompt tokens pays the upper rates, output included; basis input + cache write + cache read, the
docs do not define it); flat models keep byte-identical v1 tariffs. The reservation prices the tier of its byte-based prompt bound (a real
prompt is never larger, so it never under-reserves) and records `promptTier` in the evidence; the pricing version is the tariff version.
`anthropicTariffRates` / `anthropicReportedPromptTokens` give the settlement-side tier of reported usage, unused until checkpoint A exists. Thinking continuity: a process-local bounded cache inside the adapter, bound to the
unchanged request prefix (checkpoint B: `providerContinuation`, v17). Error codes reuse `OPENAI_CHAT_*`. Per-model request contract
(ANTHROPIC-PROFILE, adapter v2): an adapter-owned, dated and sourced capability registry (`internal/models.json`, docs read 2026-09-29;
owner 2026-10-01 D6: becomes a dated seed of the ledger v43 model catalog, PLAN CATALOG-SEED)
lists per model the accepted thinking types (adaptive, manual budget), the single off type (`disabled` | `between_tools` | none) with its
effort ceiling, `output_config.effort` levels and default, and the synchronous max output. A profile is checked against its pinned model's
row at load (`OPENAI_CHAT_DEFINITION_INVALID`, no call); an unlisted model admits only no thinking field and no effort. `effort` is profile
data sent as `output_config.effort` (GA, no beta header) and forwarded to `count_tokens`. Not supported: per-message effort,
`display: "updates"`, structured output, task budgets. The registry must be re-read from the official pages at least every 30 days or on a new
model announcement (no refresh mechanism yet). Not yet: SSE byte/token metering in live streaming, an OS keyring backend for the key (K2; the key resolves through the installation's configured secret store since SECRET-K1),
the owner's first billed smoke call (Opus 5.5 `effort`, Sonnet 5.5 `between_tools`), tariff rows for legacy models, a neutral
`reasoning: {mode, effort}` (P2).
