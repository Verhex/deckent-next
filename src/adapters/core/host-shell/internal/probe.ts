import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ShellCapabilityStatus = 'available' | 'unavailable' | 'unknown' | 'unsupported';
export interface ShellCapabilities {
  readonly platform: string;
  readonly bubblewrap: ShellCapabilityStatus;
  readonly userNamespace: ShellCapabilityStatus;
  readonly landlock: { readonly status: ShellCapabilityStatus; readonly abi: number | null };
}
/** Probe seam: inputs are observations, not assertions that a sandbox runner is implemented. */
export interface ShellProbeEnvironment {
  readonly platform: string;
  findBubblewrap(signal: AbortSignal): Promise<boolean>;
  kernel(): Promise<unknown>;
}
const environment: ShellProbeEnvironment = {
  platform: process.platform,
  async findBubblewrap(signal) {
    // Read only PATH, never the environment as a whole. No command from PATH is executed by this probe.
    const paths = (process.env['PATH'] ?? '').split(':');
    let incomplete = paths.length > 256;
    for (const dir of paths.slice(0, 256)) {
      signal.throwIfAborted();
      if (!isAbsolute(dir)) { incomplete = true; continue; }
      const path = join(dir, 'bwrap');
      try { if ((await stat(path)).isFile()) { await access(path, constants.X_OK); return true; } }
      catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    if (incomplete) throw new Error('SHELL_PROBE_INCOMPLETE');
    return false;
  },
  kernel() {
    return new Promise((resolve, reject) => {
      execFile(fileURLToPath(new URL('../native/build/Release/shell-capabilities', import.meta.url)), [],
        { timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 1_024, env: {}, encoding: 'utf8' }, (error, stdout) => {
          if (error) { reject(error); return; }
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error('SHELL_PROBE_INVALID')); }
        });
    });
  },
};

/** A slow PATH filesystem must not stall shell admission. One outstanding read can finish later, but no further paths are read. */
async function boundedProbe<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => read(controller.signal)), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('SHELL_PROBE_TIMEOUT')); }, 2_500);
    })]);
  } finally { clearTimeout(timer); }
}

/** No successful syscall is promoted into a usable sandbox. Missing/broken helpers stay unknown. */
export async function probeShellCapabilities(env: ShellProbeEnvironment = environment): Promise<ShellCapabilities> {
  if (env.platform !== 'linux') return Object.freeze({ platform: env.platform, bubblewrap: 'unsupported', userNamespace: 'unsupported',
    landlock: Object.freeze({ status: 'unsupported', abi: null }) });
  const [binary, kernel] = await Promise.allSettled([boundedProbe(signal => env.findBubblewrap(signal)), boundedProbe(() => env.kernel())]);
  const raw = kernel.status === 'fulfilled' ? kernel.value as Record<string, unknown> | null : null;
  const valid = raw && typeof raw['userNamespace'] === 'boolean' && Number.isSafeInteger(raw['landlockAbi'])
    && Number.isSafeInteger(raw['landlockErrno']) && Number(raw['landlockErrno']) >= 0;
  const abi = valid && Number(raw['landlockAbi']) > 0 ? Number(raw['landlockAbi']) : null;
  const status: ShellCapabilityStatus = abi !== null ? 'available'
    : valid && [38, 95].includes(Number(raw['landlockErrno'])) ? 'unavailable' : 'unknown'; // Linux ENOSYS / EOPNOTSUPP.
  return Object.freeze({ platform: env.platform,
    bubblewrap: binary.status === 'fulfilled' ? binary.value ? 'available' : 'unavailable' : 'unknown',
    userNamespace: valid ? raw['userNamespace'] ? 'available' : 'unavailable' : 'unknown', landlock: Object.freeze({ status, abi }) });
}
let measured: Promise<ShellCapabilities> | undefined;
/** Service startup starts this bounded probe; turns share the same process observation. Restart to refresh it. */
export function shellSandboxCapabilities(): Promise<ShellCapabilities> { return measured ??= probeShellCapabilities(); }
