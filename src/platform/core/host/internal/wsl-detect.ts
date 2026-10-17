import { closeSync, openSync, readSync } from 'node:fs';
import { HOST_LIMITS_REGISTRY } from '#platform/core/common/index.js';
import { envValue, type Environment } from './env.js';

/** Kernel identity text (`/proc/sys/kernel/osrelease`, else `/proc/version`); null when neither can be read. */
export type KernelIdentityReader = () => string | null;
const KERNEL_FILES = Object.freeze(['/proc/sys/kernel/osrelease', '/proc/version']);
const KERNEL_READ_BYTES = HOST_LIMITS_REGISTRY.kernelIdentityReadBytes;
const WSL_KERNEL = /microsoft|wsl/i;

function readBounded(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(KERNEL_READ_BYTES);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, KERNEL_READ_BYTES, 0));
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing left to release */ } }
}
let hostKernel: { readonly text: string | null } | undefined;
/** The running host's kernel identity, read at most once per process and bounded; failure reads as unknown (null). */
export const hostKernelIdentity: KernelIdentityReader = () => {
  hostKernel ??= { text: KERNEL_FILES.map(readBounded).find(text => !!text?.trim()) ?? null };
  return hostKernel.text;
};
/** Environment variables first (a WSL login shell sets them); a systemd user service has neither, so the kernel identity decides. The
 * kernel only describes the real host, so without an injected reader it is consulted for the process's own environment alone. */
export function detectWslLinux(env: Environment, kernel?: KernelIdentityReader): boolean {
  if (envValue(env, 'WSL_DISTRO_NAME') || envValue(env, 'WSL_INTEROP')) return true;
  const reader = kernel ?? (env === process.env ? hostKernelIdentity : undefined);
  if (!reader) return false;
  try { const text = reader(); return !!text && WSL_KERNEL.test(text.slice(0, KERNEL_READ_BYTES)); } catch { return false; }
}
