import type { ShellRealm, ShellRealmMode } from '#domain/index.js';
import { landlockShellRealm, type LandlockSandboxInput } from './landlock.js';
import type { ShellCapabilities } from './probe.js';
import { runHostShell } from './run.js';

export const hostShellRealm: ShellRealm = Object.freeze({ kind: 'host', run: runHostShell });
/** A chosen realm: `marker` leads the result's first line (`sandbox: …`; null for the explicit host mode, whose bytes are unchanged),
 * `notice` is shown on the live stream and at the end of the result when the posture falls short (host fallback, degraded
 * Landlock), `preview` tells the approval card where the command runs. */
export type ShellRealmResolution = { readonly ok: true; readonly realm: ShellRealm; readonly notice: string | null; readonly marker: string | null;
  readonly preview: string } | { readonly ok: false; readonly code: 'SHELL_SANDBOX_UNAVAILABLE' | 'SHELL_REALM_UNSUPPORTED' };
const HOST_PREVIEW = 'Runs on this machine as your user in the project root: not a sandbox (files, processes and network are reachable).';

/** Landlock ABI 6 scopes signals and abstract unix sockets; below it the realm is typed DEGRADED and says what is left open. */
function landlockResolution(sandbox: LandlockSandboxInput, abi: number): ShellRealmResolution {
  const gaps = [...(abi < 6 ? ['signals to other processes of your user are not blocked'] : []),
    ...(abi < 3 ? ['read-only files can be truncated'] : []), ...(abi < 4 ? ['TCP is refused by the socket filter, not by Landlock'] : [])];
  const notice = gaps.length ? `[deckent] sandbox: landlock DEGRADED (kernel Landlock ABI ${abi} < 6): ${gaps.join('; ')}.` : null;
  const preview = `Runs in the Landlock sandbox (ABI ${abi}): read-write only in the project and the conversation scratch area (the project root and `
    + 'folders holding protected files cannot gain or lose entries); .git read-only; protected files, your home directory and other paths '
    + 'unreachable; system paths read-only; no network (sockets refused).';
  return { ok: true, realm: landlockShellRealm(sandbox, abi), notice, marker: notice ? 'sandbox: degraded' : 'sandbox: landlock',
    preview: notice ? `${preview}\n${notice}` : preview };
}

/** Realm choice (S5 port, S11 Landlock): unsupported platform → typed refusal; `host` → host; a sandbox mode with measured Landlock
 * and a described project → Landlock; otherwise `prefer-sandbox` runs on the host with a visible notice and `require-sandbox` is
 * refused before anything is planned. Capabilities describe mechanisms; only an implemented realm here enforces anything. */
export function resolveShellRealm(mode: ShellRealmMode, capabilities: ShellCapabilities, sandbox?: LandlockSandboxInput): ShellRealmResolution {
  if (capabilities.platform !== 'linux') return { ok: false, code: 'SHELL_REALM_UNSUPPORTED' };
  if (mode === 'host') return { ok: true, realm: hostShellRealm, notice: null, marker: null, preview: HOST_PREVIEW };
  const abi = capabilities.landlock.status === 'available' ? capabilities.landlock.abi : null;
  if (sandbox && abi !== null && abi >= 1) return landlockResolution(sandbox, abi);
  if (mode === 'require-sandbox') return { ok: false, code: 'SHELL_SANDBOX_UNAVAILABLE' };
  const notice = '[deckent] sandbox: none; running on host because no sandbox realm is available. Files, processes and network are reachable.';
  return { ok: true, realm: hostShellRealm, notice, marker: 'sandbox: none', preview: notice };
}
