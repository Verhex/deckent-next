import { restoreLeftovers } from '#adapters/index.js';
import { productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';

/** Doctor's recovery-file view (S1 D4): files an interrupted restore left behind (stage, pending hold, decrypted key not yet in place). */
export interface RecoveryFilesView { readonly leftovers: readonly string[] }
/** Read-only; the configuration is read without resolving any secret reference. */
export async function inspectConfiguredRecoveryFiles(projectRoot: string, options: ConfigLoadOptions = {}): Promise<RecoveryFilesView> {
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false, secretResolver: async () => undefined, onWarning() {} });
  return { leftovers: await restoreLeftovers(config.projectRoot, productResourcePath(config.productLayout, 'approvals'), config.approvals.keyFile) };
}
