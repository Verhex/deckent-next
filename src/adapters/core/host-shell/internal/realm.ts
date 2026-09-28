import type { ShellRealm, ShellRealmContainment, ShellRealmMode } from '#domain/index.js';
import type { ShellCapabilities } from './probe.js';
import { runHostShell } from './run.js';

export const hostShellRealm: ShellRealm = Object.freeze({ kind: 'host', run: runHostShell });
/** The approval card's line for a host run: what running there means. */
export const HOST_SHELL_POSTURE = 'Runs on this machine as your user in the project root: not a sandbox (files, processes and network are reachable).';
/**
 * A chosen realm. `marker` leads the result's first line (`sandbox: bubblewrap | landlock | degraded | none`; null for the explicit
 * host mode, whose bytes are unchanged), `notice` is shown on the live stream and at the end of the result when the posture falls
 * short (host fallback, degraded Landlock), `posture` tells the approval card where the command runs (the notice included when
 * there is one).
 */
export type ShellRealmResolution = { readonly ok: true; readonly realm: ShellRealm; readonly marker: string | null; readonly notice: string | null;
  readonly posture: string; readonly containment: ShellRealmContainment } | { readonly ok: false; readonly code: 'SHELL_SANDBOX_UNAVAILABLE' | 'SHELL_REALM_UNSUPPORTED' };

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
  readonly writeFloor?: (rel: string) => boolean;
}
/** A sandbox mechanism (S9 bubblewrap, S11 Landlock) as a realm provider: usable on the measured host — then its realm, marker,
 * card posture and a notice when the posture falls short (typed DEGRADED) — or why not. A provider never falls back by itself; the
 * resolver below decides what an unusable mechanism means for the configured mode. */
export interface ShellSandbox {
  readonly kind: Exclude<ShellRealm['kind'], 'host'>;
  usable(capabilities: ShellCapabilities): { readonly ok: true; readonly realm: ShellRealm; readonly marker: string; readonly posture: string;
    readonly notice: string | null; readonly containment: Exclude<ShellRealmContainment, 'host'> } | { readonly ok: false; readonly reason: string };
}
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
  if (mode === 'host') return { ok: true, realm: hostShellRealm, marker: null, notice: null, posture: HOST_SHELL_POSTURE, containment: 'host' };
  const reasons: string[] = [];
  for (const sandbox of sandboxes) {
    const usable = sandbox.usable(capabilities);
    if (usable.ok) return { ok: true, realm: usable.realm, marker: usable.marker, notice: usable.notice, posture: usable.posture, containment: usable.containment };
    reasons.push(`${sandbox.kind}: ${usable.reason}`);
  }
  if (mode === 'require-sandbox') return { ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' };
  const why = reasons.length ? reasons.join('; ') : 'no sandbox mechanism is available';
  const notice = `[deckent] sandbox: none; running on host (${why}). Files, processes and network are reachable.`;
  return { ok: true, realm: hostShellRealm, marker: 'sandbox: none', notice, posture: notice, containment: 'host' };
}
