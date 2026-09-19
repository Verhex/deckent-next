import { observeBootstrapState, assertBootstrapUsable, assertBootstrapUnchanged,
  BootstrapStateError, type BootstrapObservation } from '#platform/core/bootstrap-state/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';

/** Installation admission is observed from the fixed project anchor, never from config
 * being installed. Both cache and fresh reads use the same generation fence. */
export async function inspectInstallationBootstrap(root: string): Promise<BootstrapObservation> {
  try {
    const observed = await observeBootstrapState(root);
    assertBootstrapUsable(observed); return observed;
  } catch (error) {
    throw ErrorRegistry.createError(error instanceof BootstrapStateError ? error.code : 'CONFIG_READ_IO_HOLD');
  }
}
export async function assertInstallationBootstrap(root: string, expected: BootstrapObservation): Promise<void> {
  try {
    const current = await observeBootstrapState(root);
    assertBootstrapUsable(current); assertBootstrapUnchanged(expected, current);
  } catch (error) {
    throw ErrorRegistry.createError(error instanceof BootstrapStateError ? error.code : 'CONFIG_READ_IO_HOLD');
  }
}
