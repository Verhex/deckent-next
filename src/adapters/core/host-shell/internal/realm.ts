import type { ShellRealm, ShellRealmContainment, ShellRealmMode } from '#domain/index.js';
import type { ShellPermissionTier } from '#engine/index.js';
import type { ShellCapabilities } from './probe.js';
import { runHostShell } from './run.js';

/** The host has no write boundary, so it never accepts a write set (SHELL-OVERLAY): such a request is refused, nothing runs. */
export const hostShellRealm: ShellRealm = Object.freeze({ kind: 'host', run: (request: Parameters<typeof runHostShell>[0]) => request.writeSet
  ? Promise.resolve(Object.freeze({ status: 'spawn-failed' as const, exitCode: null, signal: null, output: '[deckent] the host cannot keep writes aside for review; nothing was run.',
    totalBytes: 0, omittedBytes: 0, durationMs: 0, cleanup: 'clean' as const })) : runHostShell(request) });
/** The approval card's line for a host run: what running there means (no write derivation applies — the host is never a boundary). */
export const HOST_SHELL_POSTURE = 'Runs on this machine as your user in the project root: not a sandbox (files, processes and network are reachable).';
/**
 * The write facts one sandboxed call's card describes (merge Astra 2170 x MODES-3, owner 2026-09-29): the same `writeFloorReadOnly`/
 * `projectReadOnly` the effect enforces (`shellWritePosture(authority, tier, fullAccessTurn)`), plus whether the turn's
 * layout writes `.git` (and a worktree's common repository) — a full-access turn's layout only, and never under a read-only project.
 * Both sandbox realms build their actual view from this struct (`repositoryWritable` replacing each realm's own inline copy) and the
 * approval card describes it in words (`describeShellWritePosture`), so the boundary and its text can never drift apart.
 */
export interface ShellSandboxWriteView { readonly projectReadOnly: boolean; readonly writeFloorReadOnly: boolean; readonly repositoryWritable: boolean;
  /** SHELL-OVERLAY: the project's writes go to an overlay and are applied after the call by the edit rules (never with `projectReadOnly`). */
  readonly writeSet?: boolean;
  /** OPEN-SANDBOX: a full-access call's open view (host network, HOME visible and writable, the hard floor sealed structurally); never with
   * `projectReadOnly` or `writeSet`. A realm that cannot build it never receives it (`openShellRealm`). */
  readonly open?: boolean }
export function sandboxWriteView(layout: Pick<ShellSandboxLayout, 'repositoryWritable'>,
  write: { readonly writeFloorReadOnly: boolean; readonly projectReadOnly: boolean; readonly writeSet?: boolean; readonly open?: boolean }): ShellSandboxWriteView {
  return { projectReadOnly: write.projectReadOnly, writeFloorReadOnly: write.writeFloorReadOnly,
    repositoryWritable: layout.repositoryWritable === true && write.projectReadOnly !== true && write.writeSet !== true,
    ...(write.writeSet && !write.projectReadOnly ? { writeSet: true } : {}), ...(write.open && !write.projectReadOnly && !write.writeSet ? { open: true } : {}) };
}
/**
 * The write posture of sandboxed work no card approves call by call (Astra 2170 R1): the write floor's existing paths are read-only (the
 * floor's matcher is required — a view without it is refused, fail closed), and the whole project is read-only (the scratch area and
 * bubblewrap's private `/tmp` stay writable) unless the work is the shell's narrow mutating set, whose literal targets passed the write
 * check. The one derivation of that posture: `shellWritePosture` takes it for an unattended shell call, and a long-lived
 * server takes it through `longLivedWritePosture`.
 * SHELL-OVERLAY variant (`writeSet`: a full-auto relaxation in a realm that keeps writes aside, never the narrow set): instead of the
 * read-only project the writes go to an overlay and are applied afterwards, each decided like an edit of its path; the floor's existing
 * paths stay read-only in that view too.
 */
export function unattendedWritePosture(narrowMutating: boolean, writeSet = false): { readonly writeFloorReadOnly: true; readonly projectReadOnly: boolean;
  readonly writeSet: boolean } {
  if (writeSet && !narrowMutating) return { writeFloorReadOnly: true, projectReadOnly: false, writeSet: true };
  return { writeFloorReadOnly: true, projectReadOnly: !narrowMutating, writeSet: false };
}
/**
 * A long-lived sandboxed process (MCP-CLIENT: a local server over stdio; C5, owner 2026-09-29 option "project read-only" until
 * SHELL-OVERLAY): third-party code whose writes no card approves and that has no narrow mutating set, so it gets the unattended
 * posture with the whole project read-only — no name, existing or new, floor or not, appears in the project from it. Its sandbox view
 * and every card that describes it read this, never a copy.
 */
export const longLivedWritePosture = () => unattendedWritePosture(false);
/** Who stands behind one shell call at its effect, as the call decision decided it (`createAgentCallDecisions.execute`, typed, never read from
 * text): the owner's card, the launched full-access mode (an audited `full-access-call`, MODES-3), a full-auto mode relaxation (an audited
 * `permission-mode` event of mode full-auto: nobody approved the call, the person's mode did — SHELL-OVERLAY), or nobody (a silent or
 * standing-approved call). */
export type ShellCallAuthority = 'owner-approved' | 'full-access' | 'full-auto' | 'unattended';
/**
 * The one derivation of a sandboxed call's write posture (SHELL-AUTONOMY, Astra 2170 R1, MODES-3; owner 2026-09-29: full access is
 * comprehensive). The realm reads it with the turn's layout: its write floor (the approval floor; in a full-access turn only the
 * configuration file) and `.git` (writable only in a full-access turn, never under a read-only project).
 * - owner-approved: the project writes, the write floor included;
 * - full-access: the project, the write floor and `.git` write; the configuration file stays read-only (the layout's floor in that turn);
 *   the view is open (OPEN-SANDBOX: host network, HOME visible and writable, the product's state roots and credential-pattern files in
 *   HOME sealed — `ShellSandboxLayout.hardFloor`), as is an owner-approved call of a full-access turn;
 * - unattended, the narrow mutating set: the project writes, the write floor's existing paths read-only (its literal targets passed the
 *   write check);
 * - unattended, every other tier: the whole project read-only (the scratch area and bubblewrap's private `/tmp` stay writable), so no name,
 *   existing or new, appears without a card. In a full-access turn an unattended call means the grant no longer holds (a revoked grant reads
 *   as standart): it is read-only whatever its tier, since that turn's layout floor is only the configuration file.
 * The unattended rule itself is `unattendedWritePosture` (above), which a long-lived MCP server's view also takes (C5); its `writeSet`
 * variant is SHELL-OVERLAY's full-auto posture (the project's writes kept aside and applied like edits).
 */
export function shellWritePosture(authority: ShellCallAuthority, tier: ShellPermissionTier, fullAccessTurn: boolean,
  writeSets = false): { readonly writeFloorReadOnly: boolean; readonly projectReadOnly: boolean; readonly writeSet: boolean; readonly open: boolean } {
  // OPEN-SANDBOX (owner MODES-3 checkpoint 4): a call the launched full-access mode or the owner's card stands behind, in a full-access
  // turn, runs in the open view (network, HOME); an unattended call of that turn (the grant no longer holds) stays closed and read-only.
  if (authority === 'owner-approved') return { writeFloorReadOnly: false, projectReadOnly: false, writeSet: false, open: fullAccessTurn };
  if (authority === 'full-access') return { writeFloorReadOnly: true, projectReadOnly: false, writeSet: false, open: true };
  // Everything else is the one unattended derivation (shared with long-lived MCP servers); SHELL-OVERLAY's write set is its
  // variant for a full-auto relaxation in a realm that keeps writes aside (a full-access turn's unattended call stays read-only).
  return { ...unattendedWritePosture(tier === 'narrow-mutating' && !fullAccessTurn, authority === 'full-auto' && writeSets && !fullAccessTurn), open: false };
}
/**
 * The write part of a sandbox realm's approval-card posture, in words, from `ShellSandboxWriteView` alone — never a second decision a
 * realm could compute differently from the view it actually enforces. A realm's own text wraps this with its provider-specific
 * remainder (ABI, HOME, network, …).
 */
export function describeShellWritePosture(view: ShellSandboxWriteView): string {
  if (view.projectReadOnly) return 'the project is read-only, .git included';
  if (view.writeSet) return 'the project\'s writes are kept aside and applied after the call like edits (write floor changes are not applied), .git read-only';
  const git = `.git ${view.repositoryWritable ? 'writable' : 'read-only'}`;
  // Named, not just implied: an owner-approved call also writes what the write floor would otherwise protect (SHELL-AUTONOMY, "the
  // floor means the owner approves, not never") — the one case that unlocks it is the one the card should say so about out loud.
  return view.writeFloorReadOnly ? `the project is writable except its write floor's existing paths, which stay read-only; ${git}`
    : `the project is writable, its write floor included, ${git}`;
}
/** A provider the resolver passed over, and why (its own `usable()` reason; `restricted` when the host restricts it, S3). */
export interface ShellSandboxRejection { readonly kind: string; readonly reason: string; readonly restricted?: boolean }
/** The longest rejection reason a notice carries (the AppArmor fix, the longest shipped reason, is ~300 characters). */
export const SANDBOX_REASON_MAX_CHARS = 480;
/** One rejection reason as a notice shows it: one line (control characters become spaces), bounded. Reasons are the providers' own
 * trusted metadata (paths, versions, the fix) — never command output. */
export function boundSandboxReason(reason: string): string {
  // eslint-disable-next-line no-control-regex
  const line = reason.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  return line.length > SANDBOX_REASON_MAX_CHARS ? `${line.slice(0, SANDBOX_REASON_MAX_CHARS - 1)}…` : line;
}
/** `bubblewrap: <reason>; landlock: <reason>` — the rejections as every sandbox notice names them. */
export const describeSandboxRejections = (rejected: readonly Pick<ShellSandboxRejection, 'kind' | 'reason'>[]) =>
  rejected.map(item => `${item.kind}: ${boundSandboxReason(item.reason)}`).join('; ');
/**
 * REALM-NOTICE (live 2026-09-29): the one line that says a later sandbox runs because every preferred one was passed over — whatever the
 * reason (a host restriction, a launcher inside the project, an unavailable mechanism). Shell realms and MCP launches both use it; null
 * when nothing was passed over.
 */
export function describeSandboxFallback(chosen: string, rejected: readonly Pick<ShellSandboxRejection, 'kind' | 'reason'>[]): string | null {
  return rejected.length ? `[deckent] sandbox: ${chosen} instead of ${rejected.map(item => item.kind).join(', ')} (${describeSandboxRejections(rejected)}).` : null;
}
/**
 * A chosen realm. `marker` leads the result's first line (`sandbox: bubblewrap | landlock | degraded | none`; null for the explicit
 * host mode, whose bytes are unchanged), `notice` is shown on the live stream and at the end of the result when the posture falls
 * short (host fallback, degraded Landlock, a preferred provider passed over), `posture` renders the approval card's line for where the
 * command runs from the call's actual write view (the notice included when there is one); a realm without a write boundary (host, no
 * sandbox usable) ignores it. `rejected`: the providers passed over before the choice, in order (doctor reads it; absent = none).
 */
export type ShellRealmResolution = { readonly ok: true; readonly realm: ShellRealm; readonly marker: string | null; readonly notice: string | null;
  readonly posture: (view: ShellSandboxWriteView) => string; readonly containment: ShellRealmContainment;
  /** SHELL-OVERLAY: the realm can run a call with the project as an overlay write set (`ShellRealmRequest.writeSet`); absent = cannot. */
  readonly writeSets?: boolean;
  /** OPEN-SANDBOX: the realm builds the full-access open view (`ShellRealmRequest.open`); absent = cannot (`openShellRealm` decides). */
  readonly opens?: boolean; readonly rejected?: readonly ShellSandboxRejection[] }
  | { readonly ok: false; readonly code: 'SHELL_SANDBOX_UNAVAILABLE' | 'SHELL_REALM_UNSUPPORTED'; readonly rejected?: readonly ShellSandboxRejection[] };

/** What a sandbox realm needs to lay out its view of the machine: the project scope (real root, deny floor, ignored names) and the
 * turn's scratch area (SCR-A); nothing about the command. */
export interface ShellSandboxLayout {
  /** The turn's workspace scope: real root, deny floor, ignored names, and the deny list's nested literal heads (`protectedAnchors`) —
   * the product's own state (ledger, policy, sessions, …) and the Core floor's nested paths — which the realms protect together with
   * their ancestors even under an ignored tree (`node_modules`, `.cache`, a `.gitignore` entry) that they otherwise do not scan; a chain
   * that cannot be protected (a symbolic link on it) refuses the call (Astra 2162). */
  readonly project: { readonly root: string; readonly ignoredDirs: ReadonlySet<string>; readonly protectedAnchors: ReadonlySet<string>; denied(rel: string): boolean };
  readonly scratchDir: string | null;
  /** SHELL-AUTONOMY: the write floor over a workspace-relative path (a call the owner did not approve sees its existing paths read-only). */
  readonly writeFloor: ((rel: string) => boolean) | null;
  /** MODES-3: a full-access turn — `.git` (and a worktree's common repository) is writable (commit, branch) unless the call's project is
   * read-only; the inode floor still holds. */
  readonly repositoryWritable?: boolean;
  /**
   * OPEN-SANDBOX: the hard floor an open view seals structurally (a full-access turn's layout only; an open request without it is refused,
   * fail closed). `roots`: the absolute state roots of this installation — the project's product root, the data root, the bootstrap
   * configuration's directory, the global state root(s); one inside the project is bound read-only (its product state masked by the deny
   * walk), one outside it is hidden (an empty read-only tmpfs), so no name, existing or new, is created in either. `homeDenied`: the Core
   * floor's credential patterns over HOME-relative paths (a bounded walk of HOME masks the matches).
   */
  readonly hardFloor?: { readonly roots: readonly string[]; readonly homeDenied: (rel: string) => boolean;
    /** Owner Y (2026-09-30): whether a project-relative path is, holds or lies in Deckent's own state; an EXISTING subdirectory of a sealed
     * root that is not (e.g. a tracked `.deckent/docs`) is bound writable, so the root itself still takes no new name. Absent: none is. */
    readonly product?: (rel: string) => boolean };
}
/** A sandbox mechanism (S9 bubblewrap, S11 Landlock) as a realm provider: usable on the measured host — then its realm, marker,
 * card posture and a notice when the posture falls short (typed DEGRADED) — or why not. A provider never falls back by itself; the
 * resolver below decides what an unusable mechanism means for the configured mode. */
export interface ShellSandbox {
  readonly kind: Exclude<ShellRealm['kind'], 'host'>;
  usable(capabilities: ShellCapabilities): { readonly ok: true; readonly realm: ShellRealm; readonly marker: string;
    readonly posture: (view: ShellSandboxWriteView) => string; readonly notice: string | null; readonly containment: Exclude<ShellRealmContainment, 'host'>;
    readonly launch?: ShellSandboxLaunch; readonly writeSets?: boolean; readonly opens?: boolean }
    | { readonly ok: false; readonly reason: string; readonly restricted?: boolean };
}
/** A mechanism that can also hold a long-lived process (MCP-CLIENT: a local MCP server over stdio) gives the launcher and its arguments for
 * the view resolved now (always `longLivedWritePosture`); the caller appends `--`, the command and its arguments. `view` is the write view
 * that launch enforces and `posture` the mechanism's words for it (the cards read these, never a fixed text). Absent: the mechanism only
 * runs one command at a time. */
export type ShellSandboxLaunch = (environment: Readonly<Record<string, string | undefined>>) =>
  Promise<{ readonly ok: true; readonly file: string; readonly args: readonly string[]; readonly view: ShellSandboxWriteView; readonly posture: string }
    | { readonly ok: false; readonly reason: string }>;
/** Composition's (code-only) port: the providers a turn may pick, in preference order, built for the turn's layout. */
export type ShellSandboxFactory = (layout: ShellSandboxLayout) => readonly ShellSandbox[];

/**
 * MCP-CLIENT (Astra 2188 R8): whether one provider can hold a long-lived launch, not just run a single command — a provider usable for
 * the shell (`sandbox.usable(capabilities).ok`) but with no `.launch` (Landlock: it runs one command at a time) is rejected here the same
 * way `McpClientPool`'s own launch walk (`launchOf`, mcp-client/internal/pool.ts) rejects it. One rule, so a provider `resolveShellRealm`
 * would pick for a one-shot shell call never reports as usable for an MCP server's long-lived process when the pool itself cannot launch it.
 */
export function shellLaunchUsable(sandbox: ShellSandbox, capabilities: ShellCapabilities):
  Extract<ReturnType<ShellSandbox['usable']>, { readonly ok: false }> | (Extract<ReturnType<ShellSandbox['usable']>, { readonly ok: true }> & { readonly launch: ShellSandboxLaunch }) {
  const usable = sandbox.usable(capabilities);
  if (!usable.ok) return usable;
  if (!usable.launch) return { ok: false, reason: 'runs one command at a time' };
  return usable as Extract<ReturnType<ShellSandbox['usable']>, { readonly ok: true }> & { readonly launch: ShellSandboxLaunch };
}
/**
 * MCP-CLIENT (Astra 2188 R8): the provider list as a long-lived MCP launch sees it — `resolveShellRealm` walks this exactly like the
 * shell's own list (same preference order, same fallback notice), narrowed through `shellLaunchUsable` first. Doctor's `preferSandbox`
 * report is this walk (`inspectShellRealmSelection`); the pool's real launch (`launchOf`) asks `shellLaunchUsable` per candidate directly
 * (it also needs to try the next provider when an eligible one's actual `.launch()` call fails at runtime, which this list does not run).
 */
export function shellLaunchSandboxes(sandboxes: readonly ShellSandbox[]): readonly ShellSandbox[] {
  return sandboxes.map(sandbox => ({ kind: sandbox.kind, usable: (capabilities: ShellCapabilities) => shellLaunchUsable(sandbox, capabilities) }));
}

/**
 * Picks the realm for one call (S5, S9, S11). `host` is host. Under `prefer-sandbox` / `require-sandbox` the first usable provider
 * wins (list order = preference); with none, `require-sandbox` refuses (typed, before any plan) and `prefer-sandbox` runs on the
 * host with a visible notice naming every mechanism and why it was not usable — never a silent fallback. A later provider that wins
 * after an earlier one was passed over, for any reason, is a visible fallback too (REALM-NOTICE). Capabilities describe mechanisms,
 * never enforcement.
 */
export function resolveShellRealm(mode: ShellRealmMode, capabilities: ShellCapabilities, sandboxes: readonly ShellSandbox[] = []): ShellRealmResolution {
  if (capabilities.platform !== 'linux') return { ok: false, code: 'SHELL_REALM_UNSUPPORTED' };
  if (mode === 'host') return { ok: true, realm: hostShellRealm, marker: null, notice: null, posture: () => HOST_SHELL_POSTURE, containment: 'host' };
  const rejected: ShellSandboxRejection[] = [];
  for (const sandbox of sandboxes) {
    const usable = sandbox.usable(capabilities);
    if (usable.ok) {
      const writeSets = { ...usable.writeSets ? { writeSets: true } : {}, ...usable.opens ? { opens: true } : {} }, passed = Object.freeze([...rejected]);
      // A preferred mechanism passed over — the host restricts it (S3: AppArmor user namespaces, with the fix) or it is unusable for any
      // other reason (a launcher inside the project) — is a visible fallback: the notice reaches the live stream and the model result,
      // the posture the approval card.
      const fallback = describeSandboxFallback(sandbox.kind, passed);
      if (!fallback) return { ok: true, realm: usable.realm, marker: usable.marker, notice: usable.notice, posture: usable.posture, containment: usable.containment, ...writeSets, rejected: passed };
      const posture = (view: ShellSandboxWriteView) => `${usable.posture(view)}\n${fallback}`;
      return { ok: true, realm: usable.realm, marker: usable.marker, notice: usable.notice ? `${fallback} ${usable.notice}` : fallback, posture, containment: usable.containment,
        ...writeSets, rejected: passed };
    }
    rejected.push({ kind: sandbox.kind, reason: usable.reason, ...(usable.restricted ? { restricted: true } : {}) });
  }
  const passed = Object.freeze([...rejected]);
  if (mode === 'require-sandbox') return { ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE', rejected: passed };
  const why = passed.length ? describeSandboxRejections(passed) : 'no sandbox mechanism is available';
  const notice = `[deckent] sandbox: none; running on host (${why}). Files, processes and network are reachable.`;
  // No sandbox ran: the host fallback has no write boundary either, so the card's text is the same fixed notice (never the write view).
  return { ok: true, realm: hostShellRealm, marker: 'sandbox: none', notice, posture: () => notice, containment: 'host', rejected: passed };
}

/**
 * OPEN-SANDBOX: the realm a call whose posture is open actually runs in. A realm that builds the open view keeps the call; the explicit host
 * mode and a host fallback are the host already (unchanged). Otherwise — a sandbox that cannot open the network and HOME (Landlock) —
 * `prefer-sandbox` runs the call on the host, as the owner's full access asks (owner 2026-09-29: host shell, network, HOME), and says so:
 * Deckent's state and credentials are then protected by name only; `require-sandbox` keeps the closed sandbox (the configuration asked for
 * one) and says the open view is not available. Never silent.
 */
export function openShellRealm(resolution: Extract<ShellRealmResolution, { ok: true }>, mode: ShellRealmMode): Extract<ShellRealmResolution, { ok: true }> {
  if (resolution.opens || resolution.containment === 'host') return resolution;
  const why = [...(resolution.rejected ?? []).map(item => `${item.kind}: ${boundSandboxReason(item.reason)}`), `${resolution.realm.kind} cannot open the network and HOME`].join('; ');
  if (mode === 'require-sandbox') {
    const notice = `[deckent] full access: no open sandbox (${why}); terminal.shell.realm require-sandbox keeps this call in the closed ${resolution.realm.kind} view (no network, HOME hidden).`;
    return { ...resolution, notice: resolution.notice ? `${resolution.notice} ${notice}` : notice, posture: view => `${resolution.posture(view)}\n${notice}` };
  }
  const notice = `[deckent] full access: no open sandbox (${why}); running on host: files, processes and network are reachable, Deckent's state and credentials are protected by name only.`;
  return { ok: true, realm: hostShellRealm, marker: 'sandbox: none', notice, posture: () => notice, containment: 'host', ...(resolution.rejected ? { rejected: resolution.rejected } : {}) };
}
