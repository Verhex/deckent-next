import { localInstallationBindingSource } from '#adapters/index.js';
import { resolveProductLayout } from '#platform/index.js';

/**
 * Typed not-run reason when this host cannot bind an installation identity to the machine (container without a valid /etc/machine-id,
 * unsupported platform), else null. Asks the product's own binding source; no machine-id parsing is copied into tests. The product's
 * behavior without the capability (unbound v1 identity, relocation comparison skipped, typed INSTALLATION_IDENTITY_UNSUPPORTED) has its
 * own active tests that inject an unsupported source, so nothing in the unsupported path goes unasserted.
 */
export async function machineBindingNotRunReason(): Promise<string | null> {
  if (process.platform === 'win32') return 'INSTALLATION_BINDING_UNSUPPORTED: win32 has no machine binding';
  try {
    const binding = await localInstallationBindingSource(resolveProductLayout({ projectRoot: process.cwd() })).capture();
    return 'status' in binding ? 'INSTALLATION_BINDING_UNSUPPORTED: no usable machine identity on this host (Linux: valid /etc/machine-id); relocation and copy detection is off and has separate typed tests' : null;
  } catch { return 'INSTALLATION_BINDING_UNSUPPORTED: machine binding could not be probed'; }
}
