import type { ShellRealm, ShellRealmMode } from '#domain/index.js';
import type { ShellCapabilities } from './probe.js';
import { runHostShell } from './run.js';

export const hostShellRealm: ShellRealm = Object.freeze({ kind: 'host', run: runHostShell });
/** The approval card's line for a host run: what running there means. */
export const HOST_SHELL_POSTURE = 'Runs on this machine as your user in the project root: not a sandbox (files, processes and network are reachable).';
export type ShellRealmResolution = { readonly ok: true; readonly realm: ShellRealm; readonly notice: string | null; readonly posture: string }
  | { readonly ok: false; readonly code: 'SHELL_SANDBOX_UNAVAILABLE' | 'SHELL_REALM_UNSUPPORTED' };

/** What a sandbox realm needs to lay out its view of the machine: the project scope (real root, deny floor, ignored names) and the
 * turn's scratch area (SCR-A); nothing about the command. */
export interface ShellSandboxLayout {
  readonly project: { readonly root: string; readonly ignoredDirs: ReadonlySet<string>; denied(rel: string): boolean };
  readonly scratchDir: string | null;
}
/** A sandbox mechanism (S9 bubblewrap, S11 landlock) as a realm provider: usable on the measured host, or why not. A provider never
 * falls back by itself; the resolver below decides what an unusable mechanism means for the configured mode. */
export interface ShellSandbox {
  readonly kind: Exclude<ShellRealm['kind'], 'host'>;
  /** The approval card's line when this realm runs the command. */
  readonly posture: string;
  usable(capabilities: ShellCapabilities): { readonly ok: true; readonly realm: ShellRealm } | { readonly ok: false; readonly reason: string };
}
/** Composition's (code-only) port: the providers a turn may pick, in preference order, built for the turn's layout. */
export type ShellSandboxFactory = (layout: ShellSandboxLayout) => readonly ShellSandbox[];

/**
 * Picks the realm for one call (S5, S9). `host` is host. Under `prefer-sandbox` / `require-sandbox` the first usable provider wins
 * (list order = preference); with none, `require-sandbox` refuses (typed, before any plan) and `prefer-sandbox` runs on the host
 * with a visible notice naming every mechanism and why it was not usable — never a silent fallback. Capabilities describe
 * mechanisms, never enforcement.
 */
export function resolveShellRealm(mode: ShellRealmMode, capabilities: ShellCapabilities, sandboxes: readonly ShellSandbox[] = []): ShellRealmResolution {
  if (capabilities.platform !== 'linux') return { ok: false, code: 'SHELL_REALM_UNSUPPORTED' };
  if (mode === 'host') return { ok: true, realm: hostShellRealm, notice: null, posture: HOST_SHELL_POSTURE };
  const reasons: string[] = [];
  for (const sandbox of sandboxes) {
    const usable = sandbox.usable(capabilities);
    if (usable.ok) return { ok: true, realm: usable.realm, notice: null, posture: sandbox.posture };
    reasons.push(`${sandbox.kind}: ${usable.reason}`);
  }
  if (mode === 'require-sandbox') return { ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' };
  const why = reasons.length ? reasons.join('; ') : 'no sandbox mechanism is available';
  return { ok: true, realm: hostShellRealm, posture: HOST_SHELL_POSTURE,
    notice: `[deckent] sandbox: none; running on host (${why}). Files, processes and network are reachable.` };
}
