import { lstat } from 'node:fs/promises';
import { settleRemovedAttachment } from '#engine/index.js';
import { productResourcePath, type ResolvedConfig } from '#platform/index.js';
import { FileProjectAttachmentStore } from './store.js';
/** Called by the existing uninstall completion owner, after the reference's governed removal and before the hold is released. */
export async function settleAttachmentRemoval(config: ResolvedConfig, installationId: string, env: Readonly<Record<string, string | undefined>>) {
  if (!config.installation.sharedRegistrationId || await lstat(productResourcePath(config.productLayout, 'projectAttachment')).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) return;
  const store = new FileProjectAttachmentStore(config.productLayout, { env }, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
  return settleRemovedAttachment(store, config.installation.sharedRegistrationId, installationId, config.projectRoot);
}
