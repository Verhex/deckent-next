import { restoreLeftovers } from '#adapters/index.js';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { productResourcePath, restoreHoldPath, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';

/** Doctor's recovery-file view: files an interrupted restore left behind (S1 D4: stage, pending hold, decrypted key not yet in place) and
 * the project's installation directory mode (S1 D2: a mode open to group/other is shown, never changed). */
export interface RecoveryFilesView { readonly leftovers: readonly string[]; readonly installationDirectory: { readonly path: string; readonly mode: string } | null }
/** Read-only; the configuration is read without resolving any secret reference. */
export async function inspectConfiguredRecoveryFiles(projectRoot: string, options: ConfigLoadOptions = {}): Promise<RecoveryFilesView> {
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false, secretResolver: async () => undefined, onWarning() {} });
  const path = dirname(restoreHoldPath(config.projectRoot)), info = await lstat(path).catch(() => null);
  return { leftovers: await restoreLeftovers(config.projectRoot, productResourcePath(config.productLayout, 'approvals'), config.approvals.keyFile),
    installationDirectory: info?.isDirectory() ? { path, mode: (info.mode & 0o777).toString(8).padStart(4, '0') } : null };
}
