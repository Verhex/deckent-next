import { parseModelCatalogModelRecord, parseModelCatalogChannelRecord } from '#domain/index.js';
import type { MonitorMap } from './contract.js';
/** Catalog metadata only; invocation readiness remains an independently authorized observation. */
export function projectMonitorCatalog(models: readonly Record<string, unknown>[]): MonitorMap {
  return Object.freeze({ config: [], registry: { profiles: [], kinds: [] }, policy: null, memory: { available: false },
    models: Object.freeze(models.map(row => {
      const { model } = parseModelCatalogModelRecord(JSON.parse(String(row.record)));
      const { channel } = parseModelCatalogChannelRecord(JSON.parse(String(row.channel_record)));
      return Object.freeze({ channelId: String(row.channel_id), modelId: String(row.model_id), active: false,
        vendorId: 'vendorId' in model ? model.vendorId : null, billing: 'billing' in channel ? channel.billing : null });
    })) });
}
