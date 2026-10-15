import { localInstallationBindingSource } from '#adapters/index.js';
import { resolveProductLayout } from '#platform/index.js';
import { hostLayoutPlatform } from './host-platform.js';

/** The binding this host reaches by the product's own capture (no machine-id parsing is copied into tests). This is what the doctor reports;
 * on native Windows the capture reaches the weak location binding although no installation identity can be stored there. */
export async function hostBindingStrength(): Promise<'machine' | 'weak' | 'unsupported' | 'probe-failed'> {
  try {
    const binding = await localInstallationBindingSource({ ...resolveProductLayout({ projectRoot: process.cwd(), platform: hostLayoutPlatform() }), root: process.cwd() }).capture();
    return 'status' in binding ? 'unsupported' : binding.strength;
  } catch { return 'probe-failed'; }
}

/**
 * Typed not-run reason when this host cannot bind an installation identity at all (win32, or a posix root without a usable inode),
 * else null. Binding v2 reaches at least a weak root/device/inode binding on posix, so move, copy and restore detection runs on hosts
 * without a machine identity too (containers, the verify image).
 */
export async function installationBindingNotRunReason(): Promise<string | null> {
  // Native Windows: the identity file a binding protects needs managed private files, which the product does not support there.
  if (process.platform === 'win32') return `INSTALLATION_BINDING_UNSUPPORTED: no installation binding on ${process.platform}`;
  const binding = await hostBindingStrength();
  if (binding === 'unsupported') return `INSTALLATION_BINDING_UNSUPPORTED: no installation binding on ${process.platform}`;
  return binding === 'probe-failed' ? 'INSTALLATION_BINDING_UNSUPPORTED: installation binding could not be probed' : null;
}

/**
 * Typed not-run reason when this host has no machine-strength binding (no valid platform machine identity), else null. Only tests that
 * assert machine-digest behavior use it; the weak path has its own active tests on every posix host.
 */
export async function machineBindingNotRunReason(): Promise<string | null> {
  const notRun = await installationBindingNotRunReason();
  if (notRun !== null) return notRun;
  return await hostBindingStrength() === 'machine' ? null
    : 'INSTALLATION_MACHINE_BINDING_UNAVAILABLE: no machine identity on this host (Linux: valid /etc/machine-id); the weak binding path runs instead';
}
