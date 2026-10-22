import { inspectProductDirectory, prepareProductDirectory, ManagedFileError, type ProductLayout } from '#platform/index.js';
import { FileAutonomyShadowStore } from '#adapters/index.js';
/** OTONOM-TESLIM shadow store (state/autonomy-shadow): only the queue service writes it; outside the audit chain, never an authority input. */
export const autonomyShadowWriter = (layout: ProductLayout) => new FileAutonomyShadowStore(() => prepareProductDirectory(layout, 'autonomyShadow'));
/** Latest shadow record of one ticket for a card the caller already may inspect (list/inspect, monitor; never the y/N consent prompt). Creates nothing. */
export function readAutonomyShadow(layout: ProductLayout, scopeId: string, commandId: string) {
  return new FileAutonomyShadowStore(async () => {
    try { return await inspectProductDirectory(layout, 'autonomyShadow'); }
    catch (error) { if (error instanceof ManagedFileError && error.code === 'MANAGED_FILE_MISSING') return null; throw error; }
  }).latest(scopeId, commandId);
}
