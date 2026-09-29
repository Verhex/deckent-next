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
  readonly writeSet?: boolean }
export function sandboxWriteView(layout: Pick<ShellSandboxLayout, 'repositoryWritable'>,
  write: { readonly writeFloorReadOnly: boolean; readonly projectReadOnly: boolean; readonly writeSet?: boolean }): ShellSandboxWriteView {
  return { projectReadOnly: write.projectReadOnly, writeFloorReadOnly: write.writeFloorReadOnly,
    repositoryWritable: layout.repositoryWritable === true && write.projectReadOnly !== true && write.writeSet !== true,
    ...(write.writeSet && !write.projectReadOnly ? { writeSet: true } : {}) };
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
 * - unattended, the narrow mutating set: the project writes, the write floor's existing paths read-only (its literal targets passed the
 *   write check);
 * - unattended, every other tier: the whole project read-only (the scratch area and bubblewrap's private `/tmp` stay writable), so no name,
 *   existing or new, appears without a card. In a full-access turn an unattended call means the grant no longer holds (a revoked grant reads
 *   as standart): it is read-only whatever its tier, since that turn's layout floor is only the configuration file.
 * The unattended rule itself is `unattendedWritePosture` (above), which a long-lived MCP server's view also takes (C5); its `writeSet`
 * variant is SHELL-OVERLAY's full-auto posture (the project's writes kept aside and applied like edits).
 */
export function shellWritePosture(authority: ShellCallAuthority, tier: ShellPermissionTier, fullAccessTurn: boolean,
  writeSets = false): { readonly writeFloorReadOnly: boolean; readonly projectReadOnly: boolean; readonly writeSet: boolean } {
  if (authority === 'owner-approved') return { writeFloorReadOnly: false, projectReadOnly: false, writeSet: false };
  if (authority === 'full-access') return { writeFloorReadOnly: true, projectReadOnly: false, writeSet: false };
  // Everything else is the one unattended derivation (shared with long-lived MCP servers); SHELL-OVERLAY's write set is its
  // variant for a full-auto relaxation in a realm that keeps writes aside (a full-access turn's unattended call stays read-only).
  return unattendedWritePosture(tier === 'narrow-mutating' && !fullAccessTurn, authority === 'full-auto' && writeSets && !fullAccessTurn);
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
/**
 * A chosen realm. `marker` leads the result's first line (`sandbox: bubblewrap | landlock | degraded | none`; null for the explicit
 * host mode, whose bytes are unchanged), `notice` is shown on the live stream and at the end of the result when the posture falls
 * short (host fallback, degraded Landlock), `posture` renders the approval card's line for where the command runs from the call's
 * actual write view (the notice included when there is one); a realm without a write boundary (host, no sandbox usable) ignores it.
 */
export type ShellRealmResolution = { readonly ok: true; readonly realm: ShellRealm; readonly marker: string | null; readonly notice: string | null;
  readonly posture: (view: ShellSandboxWriteView) => string; readonly containment: ShellRealmContainment;
  /** SHELL-OVERLAY: the realm can run a call with the project as an overlay write set (`ShellRealmRequest.writeSet`); absent = cannot. */
  readonly writeSets?: boolean }
  | { readonly ok: false; readonly code: 'SHELL_SANDBOX_UNAVAILABLE' | 'SHELL_REALM_UNSUPPORTED' };

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
}
/** A sandbox mechanism (S9 bubblewrap, S11 Landlock) as a realm provider: usable on the measured host — then its realm, marker,
 * card posture and a notice when the posture falls short (typed DEGRADED) — or why not. A provider never falls back by itself; the
 * resolver below decides what an unusable mechanism means for the configured mode. */
export interface ShellSandbox {
  readonly kind: Exclude<ShellRealm['kind'], 'host'>;
  usable(capabilities: ShellCapabilities): { readonly ok: true; readonly realm: ShellRealm; readonly marker: string;
    readonly posture: (view: ShellSandboxWriteView) => string; readonly notice: string | null; readonly containment: Exclude<ShellRealmContainment, 'host'>;
    readonly launch?: ShellSandboxLaunch; readonly writeSets?: boolean }
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
 * Picks the realm for one call (S5, S9, S11). `host` is host. Under `prefer-sandbox` / `require-sandbox` the first usable provider
 * wins (list order = preference); with none, `require-sandbox` refuses (typed, before any plan) and `prefer-sandbox` runs on the
 * host with a visible notice naming every mechanism and why it was not usable — never a silent fallback. Capabilities describe
 * mechanisms, never enforcement.
 */
export function resolveShellRealm(mode: ShellRealmMode, capabilities: ShellCapabilities, sandboxes: readonly ShellSandbox[] = []): ShellRealmResolution {
  if (capabilities.platform !== 'linux') return { ok: false, code: 'SHELL_REALM_UNSUPPORTED' };
  if (mode === 'host') return { ok: true, realm: hostShellRealm, marker: null, notice: null, posture: () => HOST_SHELL_POSTURE, containment: 'host' };
  const reasons: string[] = [], restricted: { readonly kind: string; readonly line: string }[] = [];
  for (const sandbox of sandboxes) {
    const usable = sandbox.usable(capabilities);
    if (usable.ok) {
      const writeSets = usable.writeSets ? { writeSets: true } : {};
      // A preferred mechanism the host restricts (S3: AppArmor user namespaces) is a visible fallback, with the fix: the notice reaches the
      // live stream and the model result, the posture the approval card.
      const fallback = restricted.length ? `[deckent] sandbox: ${sandbox.kind} instead of ${restricted.map(item => item.kind).join(', ')} (${restricted.map(item => item.line).join('; ')}).` : null;
      if (!fallback) return { ok: true, realm: usable.realm, marker: usable.marker, notice: usable.notice, posture: usable.posture, containment: usable.containment, ...writeSets };
      const posture = (view: ShellSandboxWriteView) => `${usable.posture(view)}\n${fallback}`;
      return { ok: true, realm: usable.realm, marker: usable.marker, notice: usable.notice ? `${fallback} ${usable.notice}` : fallback, posture, containment: usable.containment,
        ...writeSets };
    }
    reasons.push(`${sandbox.kind}: ${usable.reason}`);
    if (usable.restricted) restricted.push({ kind: sandbox.kind, line: `${sandbox.kind}: ${usable.reason}` });
  }
  if (mode === 'require-sandbox') return { ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' };
  const why = reasons.length ? reasons.join('; ') : 'no sandbox mechanism is available';
  const notice = `[deckent] sandbox: none; running on host (${why}). Files, processes and network are reachable.`;
  // No sandbox ran: the host fallback has no write boundary either, so the card's text is the same fixed notice (never the write view).
  return { ok: true, realm: hostShellRealm, marker: 'sandbox: none', notice, posture: () => notice, containment: 'host' };
}
