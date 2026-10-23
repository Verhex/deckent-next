import type { CatalogTariffLookup } from '#domain/index.js';
import type { ModelCatalogReader } from '#engine/index.js';

/**
 * Security review M4: the spend authority's re-read of a sealed catalog tariff. It returns the registered row's own `connect.tariff` term only
 * when the ledger catalog holds exactly that (channel, exact model id) at exactly the sealed revision; the adapter then compares it with the
 * profile's tariff. Catalog rows are installation-wide facts (ledger v43); the invocation itself is admitted for its scope (chat activation,
 * policy) before any price is quoted.
 */
export function createCatalogTariffLookup(open: () => Promise<ModelCatalogReader>): CatalogTariffLookup {
  return async (seal, modelId) => {
    const reader = await open();
    try {
      const row = (await reader.models(seal.channelId)).find(entry => entry.modelId === modelId);
      return row && row.revision === seal.modelRevision && 'connect' in row.model ? row.model.connect?.tariff ?? null : null;
    } finally { reader.close(); }
  };
}
