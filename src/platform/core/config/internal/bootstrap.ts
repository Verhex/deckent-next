import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { observeBootstrapState, assertBootstrapUsable, assertBootstrapUnchanged,
  BootstrapStateError, type BootstrapObservation, type BootstrapPendingAdmission } from '#platform/core/bootstrap-state/index.js';
import { DECKENT_DIR } from '#platform/core/common/index.js';
import { DeckentError, ErrorRegistry } from '#platform/core/errors/index.js';

/** Astra 2471 R1: a backup restore publishes several resources; this fixed anchor exists from before its first publication until its last.
 * While present (any entry, fail closed) no configured work is admitted; only a rerun restore (`restoreHold: 'admit'`) proceeds. */
export const restoreHoldPath = (projectRoot: string) => join(resolve(projectRoot), DECKENT_DIR, 'restore-hold.json');
export type RestoreHoldAdmission = 'refuse' | 'admit';
async function assertNoRestoreHold(root: string, hold: RestoreHoldAdmission) {
  if (hold === 'admit') return;
  const path = restoreHoldPath(root);
  if (await lstat(path).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }))
    throw ErrorRegistry.createError('BACKUP_RESTORE_HOLD', { params: { path } });
}
/** Installation admission is observed from the fixed project anchor, never from config
 * being installed. Both cache and fresh reads use the same generation fence. */
export async function inspectInstallationBootstrap(root: string, admission: BootstrapPendingAdmission = 'none', hold: RestoreHoldAdmission = 'refuse'): Promise<BootstrapObservation> {
  try {
    await assertNoRestoreHold(root, hold);
    const observed = await observeBootstrapState(root);
    assertBootstrapUsable(observed, admission, root); return observed;
  } catch (error) {
    if (error instanceof DeckentError) throw error;
    throw ErrorRegistry.createError(error instanceof BootstrapStateError ? error.code : 'CONFIG_READ_IO_HOLD');
  }
}
export async function assertInstallationBootstrap(root: string, expected: BootstrapObservation, admission: BootstrapPendingAdmission = 'none', hold: RestoreHoldAdmission = 'refuse'): Promise<void> {
  try {
    await assertNoRestoreHold(root, hold);
    const current = await observeBootstrapState(root);
    assertBootstrapUsable(current, admission, root); assertBootstrapUnchanged(expected, current);
  } catch (error) {
    if (error instanceof DeckentError) throw error;
    throw ErrorRegistry.createError(error instanceof BootstrapStateError ? error.code : 'CONFIG_READ_IO_HOLD');
  }
}
