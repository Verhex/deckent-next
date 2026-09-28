import type { ShellRealm, ShellRealmMode } from '#domain/index.js';
import type { ShellCapabilities } from './probe.js';
import { runHostShell } from './run.js';

export const hostShellRealm: ShellRealm = Object.freeze({ kind: 'host', run: runHostShell });
export type ShellRealmResolution = { readonly ok: true; readonly realm: ShellRealm; readonly notice: string | null }
  | { readonly ok: false; readonly code: 'SHELL_SANDBOX_UNAVAILABLE' | 'SHELL_REALM_UNSUPPORTED' };
/** Only host is implemented in S5. Capabilities describe mechanisms, never enforcement. S9/S11 add sandbox adapters here. */
export function resolveShellRealm(mode: ShellRealmMode, capabilities: ShellCapabilities): ShellRealmResolution {
  if (capabilities.platform !== 'linux') return { ok: false, code: 'SHELL_REALM_UNSUPPORTED' };
  if (mode === 'require-sandbox') return { ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' };
  return { ok: true, realm: hostShellRealm, notice: mode === 'prefer-sandbox'
    ? '[deckent] sandbox: none; running on host because no sandbox realm is implemented. Files, processes and network are reachable.' : null };
}
