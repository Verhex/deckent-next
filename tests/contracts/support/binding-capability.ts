import { localInstallationBindingSource } from '#adapters/index.js';
import { resolveProductLayout } from '#platform/index.js';

/** The binding this host reaches by the product's own capture (no machine-id parsing is copied into tests). */
export async function hostBindingStrength(): Promise<'machine' | 'weak' | 'unsupported' | 'probe-failed'> {
  if (process.platform === 'win32') return 'unsupported';
  try {
    const binding = await localInstallationBindingSource({ ...resolveProductLayout({ projectRoot: process.cwd() }), root: process.cwd() }).capture();
    return 'status' in binding ? 'unsupported' : binding.strength;
  } catch { return 'probe-failed'; }
}

/**
 * Typed not-run reason when this host cannot bind an installation identity at all (win32, or a posix root without a usable inode),
 * else null. Binding v2 reaches at least a weak root/device/inode binding on posix, so move, copy and restore detection runs on hosts
 * without a machine identity too (containers, the verify image).
 */
export async function installationBindingNotRunReason(): Promise<string | null> {
  const binding = await hostBindingStrength();
  if (binding === 'unsupported') return `INSTALLATION_BINDING_UNSUPPORTED: no installation binding on ${process.platform}`;
  return binding === 'probe-failed' ? 'INSTALLATION_BINDING_UNSUPPORTED: installation binding could not be probed' : null;
}

/**
 * Typed not-run reason when this host has no machine-strength binding (no valid platform machine identity), else null. Only tests that
 * assert machine-digest behavior use it; the weak path has its own active tests on every posix host.
 */
export async function machineBindingNotRunReason(): Promise<string | null> {
  const binding = await hostBindingStrength();
  if (binding === 'machine') return null;
  return binding === 'weak' ? 'INSTALLATION_MACHINE_BINDING_UNAVAILABLE: no machine identity on this host (Linux: valid /etc/machine-id); the weak binding path runs instead'
    : installationBindingNotRunReason();
}
