import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type ShellCapabilityStatus = 'available' | 'unavailable' | 'unknown' | 'unsupported';
/** v2 (BWRAP-SELECT, owner S7 2026-09-29): `bubblewrap` is the selected launcher and its own sandbox run, no longer a PATH scan (v1). */
export const SHELL_CAPABILITIES_VERSION = 2;
/** The bubblewrap launcher the probe selected (the adapter's rules: `shell-sandbox-bwrap` launcher selection). `path` is what runs: a
 * system file's canonical path, or the bundled build's verified copy under the product state root. `identity` is the file's
 * `dev:ino:size:mtimeNs:ctimeNs` at the measurement, re-checked on every use. `overlay`: the version has `--overlay-src` (≥ 0.11.0). */
export interface BubblewrapLauncher {
  readonly source: 'system' | 'bundled';
  readonly path: string;
  readonly version: string;
  readonly sha256: string | null;
  readonly overlay: boolean;
  readonly identity: string;
}
/** A user-namespace restriction the launcher's own run met (typed, S3): `apparmor` when the kernel's AppArmor restriction is on. */
export interface BubblewrapRestriction { readonly kind: 'apparmor' | 'user-namespace'; readonly hint: string }
/**
 * The bubblewrap observation: `available` only when a launcher passed selection and its own sandbox run (user, mount, network, PID
 * namespaces and a fresh /proc) succeeded; `restricted` when that run met a user-namespace restriction. Every candidate the rules
 * rejected is named in `rejected` (never a silent fallback); `detail` says in one line why the status is not `available`.
 */
export interface BubblewrapCapability {
  readonly status: ShellCapabilityStatus | 'restricted';
  readonly launcher: BubblewrapLauncher | null;
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
  readonly restriction: BubblewrapRestriction | null;
  readonly detail: string | null;
}
export interface ShellCapabilities {
  readonly schemaVersion: typeof SHELL_CAPABILITIES_VERSION;
  readonly platform: string;
  readonly bubblewrap: BubblewrapCapability;
  /** The native helper's `unshare(CLONE_NEWUSER)` observation (Landlock host facts); bubblewrap is gated by its own run, not by this. */
  readonly userNamespace: ShellCapabilityStatus;
  readonly landlock: { readonly status: ShellCapabilityStatus; readonly abi: number | null };
}
/** An observation without a launcher (not probed, failed, timed out, unsupported). */
export const bubblewrapObservation = (status: BubblewrapCapability['status'], detail: string | null = null,
  rejected: BubblewrapCapability['rejected'] = []): BubblewrapCapability => Object.freeze({ status, launcher: null, rejected, restriction: null, detail });
/** Probe seam: inputs are observations, not assertions that a sandbox runner is implemented. `bubblewrap` selects and runs the launcher
 * (the bubblewrap adapter composes it: this unit cannot know its rules); `kernel` is the native helper. */
export interface ShellProbeEnvironment {
  readonly platform: string;
  bubblewrap(signal: AbortSignal): Promise<BubblewrapCapability>;
  kernel(): Promise<unknown>;
}
/** The native kernel helper (user namespace, Landlock ABI), shared by every composed probe. */
export function nativeShellKernelProbe(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(fileURLToPath(new URL('../native/build/Release/shell-capabilities', import.meta.url)), [],
      { timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 1_024, env: {}, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(error); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('SHELL_PROBE_INVALID')); }
      });
  });
}

/** A slow observation must not stall shell admission: the signal aborts the bubblewrap selection's children when the bound is reached. */
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
export async function probeShellCapabilities(env: ShellProbeEnvironment): Promise<ShellCapabilities> {
  if (env.platform !== 'linux') return Object.freeze({ schemaVersion: SHELL_CAPABILITIES_VERSION, platform: env.platform, bubblewrap: bubblewrapObservation('unsupported'),
    userNamespace: 'unsupported', landlock: Object.freeze({ status: 'unsupported', abi: null }) });
  const [launcher, kernel] = await Promise.allSettled([boundedProbe(signal => env.bubblewrap(signal)), boundedProbe(() => env.kernel())]);
  const raw = kernel.status === 'fulfilled' ? kernel.value as Record<string, unknown> | null : null;
  const valid = raw && typeof raw['userNamespace'] === 'boolean' && Number.isSafeInteger(raw['landlockAbi'])
    && Number.isSafeInteger(raw['landlockErrno']) && Number(raw['landlockErrno']) >= 0;
  const abi = valid && Number(raw['landlockAbi']) > 0 ? Number(raw['landlockAbi']) : null;
  const status: ShellCapabilityStatus = abi !== null ? 'available'
    : valid && [38, 95].includes(Number(raw['landlockErrno'])) ? 'unavailable' : 'unknown'; // Linux ENOSYS / EOPNOTSUPP.
  const bubblewrap = launcher.status === 'fulfilled' ? launcher.value
    : bubblewrapObservation('unknown', `launcher probe ${launcher.reason instanceof Error ? launcher.reason.message : 'failed'}`);
  return Object.freeze({ schemaVersion: SHELL_CAPABILITIES_VERSION, platform: env.platform, bubblewrap,
    userNamespace: valid ? raw['userNamespace'] ? 'available' : 'unavailable' : 'unknown', landlock: Object.freeze({ status, abi }) });
}
