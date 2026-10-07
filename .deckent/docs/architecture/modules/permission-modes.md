# Permission modes, shell write postures and full access — module note

MODES-3, slice 4a decisions/audit, write postures, full access, FA-TRACKED-WARN, `/mode` (moved from ARCHITECTURE.md Packages 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 1670–1951; text below is verbatim.

**Permission modes (MODES-3, owner 2026-09-29; supersedes the slice 4a mode set).** Three modes: `standart` (the default — no bindings
entry: reads, scratch and the in-project edits the company marked mode-eligible run without a card; shell and the write floor ask),
`full-auto` (+ the narrow mutating shell set and MCP calls; inside an enforced sandbox also contained unbounded shell — SHELL-AUTONOMY),
`full-access` (launched only; below). The person's "ask for edits too" preference is `askEdits: true` on their bindings entry — not a
mode — and suppresses the `edit` lowering in standart and full-auto. `bindings.json` v3: `modes[] = {id, principal, scopes, mode ∈
standart|full-auto|full-access, askEdits?: true}`; `standart` without `askEdits` is the absence of an entry; zero entries = standart,
two for one person and scope = standart with every edit asked (fail closed). The reader accepts v1, v2 (mapped in memory: `ask` →
standart + askEdits, `auto-edit` → standart, `full-auto` → full-auto; `upgradeBindingsDocument`) and v3; every write is v3 (the first
`/mode` write upgrades the file; the authority writer's archive keeps the v2 document). A build before MODES-3 refuses v3 as a whole
(`POLICY_INVALID` → `POLICY_UNAVAILABLE`). In the slice 4a and SHELL-AUTONOMY text below, `ask` reads as standart + `askEdits` and
`auto-edit` as standart.
**Permission modes — decision and audit (T-L4 slice 4a, owner 2026-09-27 q1–q5).** The company marks a v2 `require-approval` rule or role permission
`modeEligible: true` (invalid on any other effect; v1 policy has no such field). A mode creates no authority. One pure function
(`engine/core/policy` `decideAgentToolCall`) decides every agent tool call over the policy + bindings snapshot: the stricter of the
`agent-tool`/`invoke` and operation/`execute` decisions (deny ends it, before the call is planned) → the floor raise (write floor,
shell `low`, destructive, always-ask, other modify, narrow mutating raise allow) → the mode lowering, only when the policy decision
itself is `require-approval`, every matching `require-approval` rule on each asking side is eligible, the cell is relaxable in the
mode (ordinary edit: standart/full-auto unless `askEdits`; narrow mutating shell: full-auto) and the person's mode is unambiguous (two
entries decide as standart with every edit asked). Allow rules
never lower; a raised allow is never lowered; read tools and read-only shell commands under require-approval always ask. The narrow mutating shell tier is a separate classifier layer (`classifyShellMutation`): exactly one simple command (one pipeline of
one stage; no `&&`, `;`, `||`, newline or pipe — an earlier part could change what a later part writes, Astra 2133) of `mkdir [-p -v]`,
`touch [-c]`, `cp [-n -v] src dst`, `mv [-n -v] src dst` whose sources pass the read check and whose targets pass a write check
(inside the workspace, not denied, not on the write floor, parent a real directory, target absent or a single-link regular file — an existing directory target is not narrow;
no glob, `~`, `..`, leading `-`); interpreters, privilege, eval, xargs, tee, package managers, network tools, anything the strict
scanner refuses and PowerShell are the always-ask floor, decided first; `rm` is not narrow. The turn authorizes with the whole
decision and `prepare` repeats it. At the effect a call the owner was not asked for is decided again on fresh policy: a
relaxation first writes one sealed `permission-mode` audit event (audit port, ledger v41; event id = scope, turn, round, index,
arguments digest; summary = workspace path or first 200 characters + arguments digest) — if it cannot be written nothing runs
(`audit-unavailable`) — and the effect gate re-decides on every admission and admits only the audited decision: allow on the same effective revision with
the same mode, cell, company rule ids and person entry; a deny since → `POLICY_DENIED`, anything else (a lost relaxation, another
mode, revision or grant, a plain allow) → `EFFECT_APPROVAL_REQUIRED`; nothing runs and nothing is re-audited (Astra 2133/2134 R2);
a decision that was silent without a mode increments `agent-tool.silent.edit|shell` (summary, not evidence: a counter failure does
not stop the call). Owner-approved calls keep the C12 G3 gate unchanged. The protocol and ledger v41 are unchanged by 4a; the
mode is not on the wire yet (status row and `/mode` join the v15 package). Version note: a policy document carrying `modeEligible`, or
bindings v2, is refused as a whole by a build before this slice (strict schemas) — fail closed, never a silent relaxation. Side effect: on an installation that never produced an approval, the first silent call creates the approval/audit
integrity key through the counter path. Open (owner): read-only shell under an eligible rule still asks in full-auto (needs audit event v2);
`rm` stays outside the narrow set; permanent exact resources are slice 4d.
**Full-auto inside an enforced sandbox (SHELL-AUTONOMY, owner 2026-09-28 live test, lead decision).** The decision request carries,
for a shell call, the planned realm's containment (`ShellRealmContainment`: `sandbox` = bubblewrap or Landlock at ABI ≥ 6, `degraded` =
Landlock below 6, `host` = host mode or a `prefer-sandbox` fallback; typed on `ShellRealmResolution`, never parsed from the marker) and
whether the command is contained (`classifyShellContainment`). In full-auto, in a `sandbox` realm, for a contained command, the cells
`shell-read-none`, `shell-read-low`, `shell-other-modify` and `shell-always-ask` (the strict scanner's construct refusals: compound,
expansion, redirection, subshell) are relaxable too, under the same rule as before (policy decision itself `require-approval`, every
asking rule `modeEligible`, one mode entry), and such a run sees the project read-only (shell write postures, below);
`shell-destructive`, the write floor, read tools and fetch never are; host, fallback and degraded realms, and standart, are unchanged. The relaxation is audited as the existing `shell-modify` cell (ledger/audit schema
unchanged; the realm is not in the record — open, audit event v2). This reopens, for the sandbox realm only, the earlier open note
"read-only shell under an eligible rule still asks in full-auto". What a call may write in a sandbox is the one derivation under
shell write postures (below). The destructive table asks in standart and full-auto; the earlier `unrestricted` design note became the
launched full-access mode (MODES-3, below), which lowers it.
The one decision orders its lowerings: the mode relaxation first (`relaxableFor(request)`: the static `RELAXABLE` cells, and in full-auto,
in an enforced sandbox realm, for a contained command, the sandbox cells), the standing approval (PERSISTENT-APPROVALS G6) last — it lowers
a standing cell only where no mode did. `shell-read-low` is both: in full-auto inside a sandbox it is lowered by the mode (a
`permission-mode` audit event), on the host, a degraded sandbox, for a command that is not contained or in standart by the standing
approval (a `standing-approval` event); the existing audit kinds already tell the two paths apart (no schema change). `standingWouldLower`
takes the same request (shell field included), so no standing scope is offered where the mode already lowers the call. Every call the
owner did not approve at its card — a mode relaxation, a standing approval, a decision silent without a mode — runs unattended in the
sense of the postures below.
**Shell write postures (Astra 2170 × MODES-3, lead merge 2026-09-29).** A sandboxed shell call's write posture is derived once, at the
effect, from who stands behind the call (the call decision hands the effect a typed authority `owner-approved | full-access |
unattended`, never text) and the planned tier (`shellWritePosture`, host-shell, beside `unattendedWritePosture`):
- **owner-approved** (the owner's card): the project writes, the write floor included; `.git` stays read-only except in a full-access turn.
- **full-access** (an audited `full-access-call` of a turn launched in full access while the company grant holds; owner 2026-09-29: full
  access is comprehensive and owner-authorized by the mode): the project, the write floor (existing and new names) and `.git` (and a
  worktree's common repository) write; the configuration file stays read-only (that turn's sandbox floor is only the configuration
  file); the hard floor — product state, credentials, the MCP registry — stays masked/denied. In a full-access turn the view is **open**
  (OPEN-SANDBOX, e376f546): `shellWritePosture` returns `open` for the `full-access` authority and for an `owner-approved` call of a
  full-access turn (never for an unattended or full-auto call); `sandboxWriteView` carries it (never with a read-only project or a write
  set) and the card says "network on, HOME visible, Deckent state and credentials hidden/read-only".
- **unattended, narrow mutating set**: the project writes, the write floor's existing paths read-only (literal targets passed the write
  check; bubblewrap `--ro-bind` before the deny masks, Landlock `r` rules with the parent carved).
- **unattended, every other tier** (the full-auto sandbox relaxation, silent or standing-approved reads): the whole project read-only
  (bubblewrap `--ro-bind`, Landlock `r` rules; the scratch area and bubblewrap's private `/tmp` stay writable), so no name, existing or
  new, appears without a card (Astra 2170 R1); a failed such run tells the model the project was read-only. In a full-access turn an
  unattended call means the grant no longer holds (it reads as standart): it is project read-only whatever its tier.
Standart and full-auto keep exactly the Astra 2170 postures. A read-only project also keeps its repository read-only (Landlock `git`
class, bubblewrap's writable common repository follow the project posture). The write floor holds inside a Landlock carve too (an
ignored ancestor holding product state, e.g. `.deckent/` in `.gitignore` with the data root beneath it): a floored entry takes a
read-only rule and a floored directory's subtree is read-only (869c01f; before it, the carve granted every other entry read-write, so
the `.deckent/**` floor of a narrow unattended call and the full-access configuration file were writable under Landlock — bubblewrap
held). MCP server starts — in a turn and from the CLI (trust, health, restart) — build the same layout with the write floor
(`writeFloor` is required on `ShellSandboxLayout`); both realms refuse a read-only-floor request whose layout carries no matcher (fail
closed, the server does not start). MCP server views take the unattended posture with the whole project read-only (C5, owner 2026-09-29, until
SHELL-OVERLAY): one derivation, host-shell `unattendedWritePosture(narrowMutating)` — host-shell's `shellWritePosture` takes it for
unattended shell calls, `longLivedWritePosture()` (not narrow) for a long-lived server; the bubblewrap launch binds the project
`--ro-bind`, keeps the floor's matcher required (fail closed) and returns the write view it enforces, from which the launch and tools
cards say "the project is read-only, .git included" and that `realm: host` lets a server write. A sandboxed server therefore creates no
name in the project, existing or new, floor or not (Astra 2177 R1 closed for bubblewrap); only a bound scratch area, bubblewrap's
private `/tmp` and the empty HOME tmpfs are writable. The same in every mode; MODES-3 defined no full-access MCP posture. The host realm
has no OS boundary for any posture.
**Sandbox write set (SHELL-OVERLAY, owner 2026-09-29: the permanent C5 fix for the shell; `f906c31` + `57bdbf1`, merged with C5-MCP-RO in
`ee854a8`, tenth batch).** The write set is the `writeSet` variant of host-shell `unattendedWritePosture`, the one unattended derivation. A shell
call a full-auto relaxation let run (`ShellCallAuthority 'full-auto'`: an audited `permission-mode` event of mode full-auto; tier past the
narrow set) in a realm that can keep writes aside (`ShellRealmResolution.writeSets`: bubblewrap whose selected launcher has the overlay
options — `launcher.overlay` from the probe's version reading, ≥ 0.11.0; BWRAP-SELECT merge, eleventh batch) runs with the project as an overlay (`--overlay-src P --overlay <upper> <work>
P`; `.git`, the floor's existing paths and the deny masks are bound over it as before). The upper/work directories are Deckent's own (0700;
host-shell `sandboxWriteSetRoot`: the project data root's `fileEffects/sandbox-writes`, else the global state root's; the first whose real path
neither holds nor sits in the project — bubblewrap: overlay layers may not nest; none → the read-only posture with a result note). When the
command exits (any code), the native lister `shell-overlay-scan` (reads the kernel's `user.overlay.opaque`; Node has no xattr API) and
`scanSandboxWriteSet` produce the change set: `c 0:0` whiteouts and opaque directories are deletions (a rename is delete + create: `userxattr`
forces `redirect_dir=nofollow`, `metacopy=off`), symbolic links, special files, hard links and setuid/setgid files are refused per entry,
`redirect`/`metacopy`/whiteout-xattr metadata refuses the whole set, bounds (2 000 entries incl. subtree deletions, 64 MiB, 16 MiB per file,
depth 32) refuse the whole set, and a lower path whose ctime is not older than the call directory's own ctime (start mark, kernel clock) — or
a whiteout whose lower entry is gone — is a conflict: nothing is applied. Every entry is decided exactly like an edit of its path
(`decideAgentToolCall`: `run_shell` × `workspace.file.write`, cell `edit` / `edit-floor` / `edit-authority`; a relaxation is audited per entry
— `permission-mode` `edit-non-floor`, summary `{kind: 'edit', path}` — before its effect; the write floor and the configuration file are not
applied and the result tells the model to use the edit tools, which card; a deny keeps it out) and applied as its own C11 effect of
`workspace.file.write@1` on `workspace-file` (target-internal `writeSet` input: bytes read from the upper and digest-checked, mode applied;
removal journaled with `next: absent`, a removal left `prepared` is unknown). Deletions first, then emptied directories, then writes with
their missing parents; a changed precondition or an unknown outcome stops the rest. A stopped/timed-out run applies nothing; the directory is
removed after every call, and a crashed service's leftovers are swept (never applied late). Landlock and host refuse a write-set request.
Owner-approved, full-access, narrow-set and standart postures are unchanged. Cost (this machine): overlay mount +4 ms per call, native listing
6 ms / 200 entries, **≈ 85–95 ms per applied entry** (measured split: ≈ 79 ms the entry's C11 effect — ledger intent/settle at full
durability, journal and file fsyncs —, ≈ 16 ms its sealed audit event; 100 files ≈ 9 s; the same class as one edit per file) — open (O6/O7).
Production: **active** wherever the selected launcher has overlay — the bundled 0.13 (or a system ≥ 0.12); on this machine the system 0.9.0 is
rejected and the bundled copy is selected, so a full-auto relaxation's writes now go through the write set (measured end to end through the
production sandbox list and the service's own measurement, `runtime-shell-overlay.test.ts`; without a `workspace.file.write` grant every
entry is "not applied … (denied by policy)" and `.git` stays read-only inside the overlay view). MCP servers: same mechanism,
checkpoint = server stop at the end of a turn whose server wrote (design §10), later slice; until then C5-MCP stays open (read-only view above).
**Full access (MODES-3).** A turn is full access only when `chatTurn.fullAccess: true` (protocol v17) — set by the terminal launched with
`deckent --full-access` / `deckent terminal --full-access` or by the person's stored start mode `full-access` — and only while a company
grant allows `permission-mode`/`set` on id `full-access` (`fullAccessGrant`; the decision asks it on every call, so a grant revoked
mid-turn stops the next effect at its gate). A stored `full-access` entry without the flag decides as standart (headless/SDK/MCP need the
explicit parameter; MCP/SDK expose no `chatTurn`). Admission (`admitFullAccessTurn`): no grant → `PERMISSION_MODE_DENIED {mode:
full-access}`, recorded when possible; allowed → a sealed `full-access-turn` event before the first round (no record →
`AUDIT_UNAVAILABLE`, no turn). Decision: a deny ends it (every mode); a company `require-approval` that is not `modeEligible` still asks
(the Claude "ask rule" analog, Enterprise's lever); otherwise every cell runs without a card — the floor raise and eligible
require-approvals are lowered — except `mcp-floor` (the owner's `alwaysAsk` pin / pinned `destructiveHint`) and the new `edit-authority`
cell (a write of the installation's configuration file inside the project: it decides where policy, bindings and approvals live, the
realm and the network; raising in every mode, never lowered, no standing approval). Every allowed effect call (edit, shell, fetch, MCP)
writes a sealed `full-access-call` event (cell, policy decision, raised, lowered company rules, grant rule, summary; fetch = host +
argument digest, never the URL) before its effect; the effect gate admits only that decision (`isAuditedDecision`). Read tools are not
recorded per call. Hard floor unchanged in every mode: product state (every layout resource but `config`), credential patterns,
`.deckent/host|audit-key|approvals`, the MCP project registry. A full-access turn opens only the repository internals: the workspace
deny drops `REPOSITORY_INTERNALS_DENY` (`.git`, `.git/**`, `**/.git`, `**/.git/**`), and both sandboxes make Git metadata writable
(`ShellSandboxLayout.repositoryWritable`: bubblewrap binds no `.git` read-only and binds a worktree's common repository read-write;
Landlock gives clean Git entries `w`; the inode floor's masks stay); the sandbox posture is the full-access bullet above. Host realm (explicit, or a fallback): the
shell hard floor stays name-based (a command naming product state is refused; an expanded name is not caught).
**FA-TRACKED-WARN (owner 2026-09-30, option A).** A full-access shell call keeps running without asking. What it measurably did to
the project's git-tracked files is shown and audited — never blocked, never a card.

- **Measurement.** Before the call, `git ls-files -z -s` lists the tracked files of the repository that holds the project. It runs
  from the project root with a fixed environment: no system/global config, `core.fsmonitor=false`, `core.hooksPath=/dev/null`,
  `GIT_OPTIONAL_LOCKS=0`. It reads the index only and hashes no content, so no filter or other repository-configured program runs.
  Each listed file is `lstat`ed before and after the call. Present before and gone after = deleted; inode, size, mtime or ctime
  changed = overwritten. No git process runs after the command, so a rewritten `.git` cannot hide anything or make Deckent run anything.
- **Output (protocol v18: result text only).** The result's first line starts with `[deckent] run_shell: tracked: deleted=N
  overwritten=M; …`, the first metadata after the tool prefix and before the realm marker, exit status and command, so neither the
  command's text nor its output can supply it. The finished tool line reads the counts only from there (`trackedChangesOfToolResult`)
  and shows the `terminal.render.toolTracked` suffix in the warning tone. The end of the result carries `[deckent] tracked files changed:
  deleted N (a, b, … +k more), overwritten M (…) — during this full-access call; nothing was blocked.` (at most 8 names per list, control
  characters shown as `?`), also streamed to stderr. A marker printed or written by the command produces no suffix (forgery tests).
- **Audit.** A sealed `tracked-files-changed` event (audit event schema 1, additive) is written after the effect with the call reference
  and policy revision of the call's `full-access-call` event, at most 50 paths per list plus the full count; paths are plain text (hashed
  paths for SIEM export are a follow-up). If it cannot be written, the line says so.
- **Coverage.** A stopped or timed-out run is measured too. Only `authority === 'full-access'` calls are measured; standart, full-auto
  and an owner-approved card call in a full-access turn are unchanged; `write_file`/`edit_file` keep their own audit.
- **Bounds.** At most 100,000 tracked files, otherwise the line says "not checked". The listing is capped at 64 MiB / 5 s, and the
  `lstat` passes yield to the event loop every 4,096 files. A non-git project is a no-op; a linked worktree and a project inside a
  repository resolve as git resolves them (paths relative to the project root); a nested repository's files are its own.
- **Limits.** A change another process makes during the call is attributed to it. A `chmod` or a new hard link reads as overwritten
  (ctime); a rename reads as a deletion. Submodule entries and files absent before the call are not measured. git is looked up on the
  fixed PATH `/usr/bin:/bin`.
- **v19.** The typed `tool.finished.trackedChanges` (hook: `agentToolOutcomeSchema`, turn event schema on a v19 envelope, loop,
  shell outcome, terminal-chat delta, `ToolDelta`, text reading kept as fallback) waits for the v19 bundle (Jev 34a8df5c).

**Open view (OPEN-SANDBOX, owner MODES-3 checkpoint 4; live findings 3/4 of session 1d428e9f).** A full-access call in a realm that
`opens` (bubblewrap) runs with `--unshare-all --share-net`, `--bind / /` then a fresh `/proc` and minimal `/dev` (PID namespace,
`--die-with-parent`, `--new-session` kept): host network, the real HOME readable and writable, the project and `.git` writable. The hard floor
is structural, from `ShellSandboxLayout.hardFloor` (`agentShellHardFloor`, `adapters/core/agent-workspace-floor`, full-access turns only): the
project's product root (`.deckent`), the data root, the bootstrap configuration's directory, the global state root of the service's
configuration and process environments, and an existing conventional `~/.deckent`. A root inside the project is bound read-only over it (its
product state still masked by the deny walk) — no name, existing or new, is created there (`.deckent/mcp.json` EROFS); a root outside it is an
empty tmpfs remounted read-only after the scratch bind (bubblewrap copy, user MCP registry/trust, secrets hidden; man page: `--remount-ro`
changes only that mount point). Owner Y (cef933a7, 2026-09-30): the sealed `.deckent` root takes no new name, but an EXISTING subdirectory
that is not Deckent's state (`hardFloor.product`: every registry resource under the turn's and the default layout, the data root, the
bootstrap configuration, the MCP registry, the Core floor's `.deckent/` heads; denied paths and protected anchors never) is bound writable
over it — a tracked `.deckent/docs` checks out clean. Commits e376f546 + 46148e4f + cef933a7. A missing root is created empty (0700) first
(bwrap would otherwise `mkdir` it on the host, measured 0.13). The Core credential patterns are masked in HOME over a bounded walk (depth 3,
20 000 entries — over it the call is refused; vendored trees and symbolic links not entered). Astra 2189 R7: a mount protects a path, not
its parent — every ancestor of a protective target (sealed/hidden root, read-only path, mask, scratch) up to `/` is self-bound
(`ancestorPins`), so renaming it fails EBUSY instead of carrying the mount away; the pins come right after `--bind / /`, before every
other mount (a later host bind would otherwise cover the floor); a non-canonical ancestor or more than `BUBBLEWRAP_ANCESTOR_PIN_MAX`
(1 024; measured 32, +1.8 ms) refuses the view. A closed view with a writable project (owner-approved; unattended narrow) pins the
in-project ancestors right after the project bind, before every protective mount (measured 0–10 pins, ≤ +1 ms); an overlay (a pin would
bypass the write set) or read-only project (EROFS) view pins nothing. An owner-approved call of that turn keeps the
existing configuration file writable (content only). Fail closed: an open request without the hard floor, a root that holds the project,
HOME or `/`, a read-only project. A realm that cannot open (`openShellRealm`): `prefer-sandbox` runs the call on the host with a visible
notice ("full access: no open sandbox (…); running on host … protected by name only"), `require-sandbox` keeps the closed view with a
notice; the explicit host mode and a host fallback are unchanged. MCP server views are unchanged (`longLivedWritePosture`). Cost (this
machine, empty project, wall clock with view resolution): open ≈ 55–63 ms, closed ≈ 11–13 ms. Open limits: HOME credential masking is by
pattern and depth-bounded (deeper, linked or hard-linked credential files open); credential stores outside the Core patterns
(`~/.config/gh/hosts.yml` — used by `git push` here —, `~/.codex/auth.json`, `~/.gnupg`, arbitrarily named `~/.ssh` keys) stay open (owner
2026-09-30: name patterns for now; follow-up card OPEN-SANDBOX-HIDDEN-PATHS: a policy-managed hidden-path list); other projects' state and a
missing `~/.deckent` under an override are not sealed; minimal `/dev`; Landlock has no open view; the view seals Deckent's state, not its
code (the service's node under HOME and a dogfood checkout's `dist/` are writable, so a full-access shell can change what the next restart
runs); non-product FILES at the `.deckent` root and NEW subdirectories stay read-only (a commit adding one fails to check out there).
**Mode status and `/mode` (T-L4 slice 4c, owner q7, protocol v15).** Two v15 operations, current version only (a v14 envelope is
refused; window stays [15,14]). MODES-3 shapes (protocol v17): `inspectPermissionMode {scopeId}` → `{supported, mode, askEdits, revision, eligible,
fullAccess}` over the request's
policy + bindings snapshot (scope admission `read`; `eligible` = a mode-eligible require-approval rule can apply to this person here;
`supported: false` for a v1 policy), and `setPermissionMode {scopeId, mode, askEdits?, expectedRevision}` → the view + `previous`, `changed`.
No actor field: the socket peer is the principal and only that exact issuer + subject's bindings `modes` entries change (the
scope leaves them; unless standart without `askEdits`, it joins the caller's entry of that mode or a new `m-<hash>` entry); every other entry and the role
`bindings` are kept. `PermissionModeApplication` (engine/core/policy) owns the transition: conditional on the effective
`policy+bindings` revision (`PERMISSION_MODE_CONFLICT`), a company `permission-mode`/`set` grant whose resource id is the target
mode (deny/no grant → `POLICY_DENIED`, require-approval → `POLICY_APPROVAL_UNSUPPORTED`); tightening to `standart` or setting `askEdits` needs no set grant (owner 2026-09-27, R4: the grant/deny rules
are not consulted for them; a company deny cannot keep a person in a relaxed mode, the scope boundary still applies; audited as
`decision {effect: 'allow', ruleId: null}` — a grant always names its rule, so a null rule means no grant was required), v1 policy →
`PERMISSION_MODE_UNSUPPORTED`. Every decision writes a sealed `permission-mode-change` audit event (audit subject union extension;
ledger v41 unchanged): `requested`, `previous`, `decision {effect, ruleId}`, `bindingsRevision {before, after|null}`; an allowed
change is recorded before the file changes (no record, no change; an unrecordable refusal is still a refusal) — so an `allow`
record's `after` revision is intent, not proof: a rename failure or a replacement detected by the identity check (typed conflict)
leaves a record whose revision never reached the file. `FilePolicySource.update`
is the conditional store: per-file serialization in the service process, policy + bindings read under the usual guards, the new
document written to a same-directory `O_CREAT|O_EXCL|O_NOFOLLOW` file with the original 0400/0600 mode, flushed, the identities (dev/ino/size/mtime/ctime) of both authority files re-checked — the bindings target and the policy file that
authorized the change and fixed the compared revision (Astra 2139 R1; either replaced → `PERMISSION_MODE_CONFLICT`, nothing replaced), then `rename` + directory fsync; the writer must be the trusted owner uid. The new
bindings revision is `m-` + sha256(previous revision, new body) (chained, no ABA). Every write is bindings v3 (a v1/v2 file is upgraded on
the first write). The terminal shows the mode as a droppable status-row segment (catalog text only; drop order notice → elapsed →
mode → model → queue; hidden when unknown or unsupported), refreshed at open, after `/mode` and after each turn; `/mode` shows it
and `/mode <mode>` sets it with the revision last read. The surface reads and writes no file. MODES-3: `full-auto` and the stored
`full-access` start mode need their grant; the `permission-mode-change` event gains optional `askEdits {requested, previous}` and the
`permission-mode` event's `grants.person` may be null (the default standart). Terminal: the status segment `full-access` is
non-droppable (role error); `/mode full-access` is refused in the surface (the service is not asked) with how to launch; `/mode
standart|full-auto` in a full-access session ends full access for the session; `/mode ask-edits on|off`; `/mode start full-access`
stores the start mode (next launch). Launch: the flag without the grant → the terminal does not open (`PERMISSION_MODE_DENIED`); a
stored start mode without the grant → a standart session with a notice; full access → an opening warning notice.
After a written entry's own decision, each new parent directory it needs is decided like an edit of that directory (its own name and as a tree:
deny, write floor, configuration name), once per set and before any is made; a refused one keeps the entry, every entry beneath it and all its new
ancestors out (Astra 2183 R3, `dc57015`); `ensureWorkspaceParents` refuses a floor-named or undecided parent before the first `mkdir` (defense in
depth). Parent creation is not a C11 record of its own (decided and audited, reported as `new directories created`). The write floor's `.github/**`
is anchored at the project root (T-L4 §5): a nested `a/.github/workflows/x.yml` is an ordinary path (owner checkpoint in PLAN).

**`/mode` messages (MODE-UX G3, seventh batch).** On a v1 policy (`view.supported = false`) the surface never calls `set`; `/mode` shows
the current mode with a one-line effect, the other modes with theirs, and says when nothing in this scope can change it. Typed refusals:
`PERMISSION_MODE_DENIED` (`{mode}`; no allow grant on `permission-mode`/`set`, instead of the generic `POLICY_DENIED`; `require-approval`
stays `POLICY_APPROVAL_UNSUPPORTED`) and `PERMISSION_MODE_LOCKED` (the authority write lock is held; `CONFIG_WRITE_LOCKED`'s path/pid/age
carried, only on `setPermissionMode`). Protocol and view schema unchanged (v15). Open: which modes are actually settable (per-mode `set`
grant) is not in the view (checkpoint).

**Derived self-source floor (SELF-SOURCE-FLOOR A2, owner 2026-10-01 narrowing (a/b/c), implemented in the D4 night 2026-10-03).** The build identity v1 optionally records the
canonical Git common directory of the source checkout as `sourceCommonDir`; old/missing/unreadable identities remain valid negatives.
At each turn start the adapter compares that field with the project's canonical Git common directory. Linked worktrees match;
separate clones/customer repositories do not. No configuration field or default switch is added. In a non-full-access self-source
turn, one frozen table beside the static floor adds `src/**`, `dist/**`, `scripts/**`, `assets/**` as `edit-self-source`. Classification
precedence is denied → `edit-authority` → static `edit-floor` → `edit-self-source` → `edit`: static hard-floor paths stay `edit-floor`
even in the self-source repository, never session/standing approvable. Shell protected names stay on the static floor unchanged;
self-source applies only to write classification. No permission mode lowers `edit-self-source`. Edits, the host narrow
mutation classifier, both shell sandbox views and overlay settlement share this floor. An unapproved overlay floor entry is withheld
and directs the agent to the edit tools for an owner card. Full access keeps its prior authority-only sandbox floor and decisions.
The card summary names source/running code, path and mode in en/tr; the terminal derives its marker once at startup, even beside the
full-access marker. `--version` shows the optional common directory; the runtime descriptor protocol is unchanged.
Internal session patterns are distinct from ordinary standing keys, scope/principal/conversation bound, sealed before memory/use;
`standingPattern` refuses the new cell as `cell-not-standing`, and persisted grants never lower it. **Public session answers remain
unwired:** the stream has no standing offer and terminal decisions return `saved: false, reason: protocol`; the production turn does
not supply session memory. Adding those fields is outside this lane's pre-approved contracts. This is an implementation limit,
not S1 closure. Owner D4 (2026-10-03) admits DEV-RELEASE-SOURCE-ORIGIN option D: retain the separate clone, declare the
origin checkout common directory through `DECKENT_BUILD_SOURCE_COMMON_DIR` (absolute existing readable directory, canonicalized),
and record optional `sourceCommonDirOrigin: declared|derived` in identity v1. Invalid declarations fail the build without fallback.
Stage checks origin common directory and selected commit in the built and unpacked identity before installing; mismatches,
missing/malformed identities and stale cached provenance refuse with `DEV_RELEASE_IDENTITY_MISMATCH`. release.json records
`sourceCommonDir`; old identity readers accept the additive origin marker. The producer and host-kit candidate have targeted
author evidence (fake repository staging); delivered as one lane commit `03d8807a` (the lead applied the sandbox patch), Fable 5.1 bounded
PASS 2026-10-03. Landing and real deployed proof (a real stage + a live/N1 turn) remain open. Lead checkpoints: external
`proof/SELF-SOURCE-FLOOR-2026-10-03/review.md`, `revise-1/review.md` (Fable R1 PASS `08eb1d6c`) and `proof/DEV-RELEASE-SOURCE-ORIGIN-2026-10-03/review.md`.

**Standing approvals (PERSISTENT-APPROVALS G6, owner 2026-09-28 "kapsam seçmeli", seventh batch).** A standing approval is the person's
own v2 grant on resource kind `agent-tool-call` (ids `standing-*`, one person, one scope list, id = key `v1:<tool>:<kind>:<pattern>`), or
"this session" (`SessionStanding`, the service process's memory keyed by scope + person + conversation). Only the lowering step of
`decideAgentToolCall` reads it (step 4): it lowers the floor raise of a standing cell, or an eligible `require-approval` that no mode
lowered; a deny is never lowered, and only the edit, `shell-read-low` and `shell-narrow-mutating` cells can stand (write floor,
destructive, always-ask, other-modify, fetch and MCP cells cannot). A role's all-ids authority over the kind is authority to delegate,
never an approval. Persisting goes through `policy.administer@1` (P3): `PersistentStanding` submits the change, allows the pending
operation approval as the same person through `ApprovalApplication.decide` (separation of duties applies) and resubmits; the delegation
bound is that person's authority. Every use and every "this session" answer is a sealed `standing-approval` audit event (`remembered` /
`used`) written before the memory holds it or the effect runs. The card offers a scope only when `standingWouldLower` holds. In the
default standart an eligible ordinary edit is lowered by the mode first; a standing approval on an edit matters for a person who asks
for edits too (`askEdits`) or where the mode does not lower. CLI:
`deckent policy grants --mine` / `deckent policy revoke`. No version changed (policy v2, bindings v1/v2, ledger v42, protocol v16, layout 4);
the vocabulary gains `agent-tool-call`. Not yet: the card scopes + decision field on protocol v17 (introduced by MODES-3; MCP has no approval decision tool), the
service wiring from the turn's `requestApproval` to `offer`/`remember`/`persist`, the installation root (P4; a v1 live policy cannot offer
"always"), `/policy`, listing this session's memory.

**Shift+Tab cycle and in-session full access (TERMINAL-UX T2 T-MODE-CYCLE, owner 2026-10-07, corrected; supersedes "launched only" and the
surface refusal of `/mode full-access` above; implemented on `tui2/readable-startup-mode`, not landed).** Shift+Tab (Alt+M where the console
cannot report Shift+Tab) walks every stop the person may take here: `standart` → careful (`standart` + `askEdits`) → `full-auto` →
`full-access` → `standart`; no plan mode. `full-access` is a stop only when the view's `fullAccess` grant holds; `full-auto` unless the view
says the company's set grant leaves it out (`fullAuto`, a view field of runtime protocol v21 — wave/tui-2 bumps once because the v20 view is
strict; every v21 service sends it, and a view without it lets the service answer the set itself). Every step, and `/mode full-access`, is the existing `setPermissionMode` with the revision last read and an explicit
`askEdits`: the engine decides the grant and records `permission-mode-change` (principal, time, previous → requested, rule) before the
bindings change, so a stored `full-access` also becomes the next launch's start mode (as `full-auto` and `standart` already persist). Every
following full-access turn is admitted on the grant again and audited (`full-access-turn`, `full-access-call`); a grant revoked meanwhile
reads as standart at the decision and the effect gate. The hard floor holds in every mode (PTY proof: a write of `.deckent/config.json`
in a full-access session entered with Shift+Tab fails at the workspace floor; nothing changes, no `full-access-call`). The status row shows
the stop as mark and catalog word (`⏸ standart`, `⏸ dikkatli`, `⏵⏵ tam otomatik`, `⚠ tam erişim`; ASCII `||`, `>>`, `!!`); full access stays
non-droppable in the error role. While a card or picker owns the keyboard, Shift+Tab is theirs and the mode does not change; while a turn runs the step is not taken (the
turn keeps the mode it was admitted with, as a queued `/mode` does). The `--full-access` launch flag still works.

