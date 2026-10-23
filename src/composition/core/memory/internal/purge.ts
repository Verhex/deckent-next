import { MemoryJournalError } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteMemoryJournalStore } from '#adapters/index.js';
import { productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { memoryJournalFor, memoryPurgeJournalOf } from './journal.js';

/**
 * S4B-4 §6.6 restore safety, at service start before any work is admitted (and not gated by any memory mode): every scope the journal names is
 * re-applied in full. An unreadable journal or any failure holds the start with `MEMORY_PURGE_REPLAY_HELD`, never a silent un-purge.
 */
export async function replayConfiguredMemoryPurges(projectRoot: string, options: ConfigLoadOptions = {}) {
  try {
    const config = await loadComposedConfig(projectRoot, { ...options, heal: false }), layout = config.productLayout;
    let records;
    try { records = await memoryPurgeJournalOf(layout, () => openLocalIntegrityAuthority(layout, config.approvals.keyFile, false)).list(); }
    catch (error) { throw Object.assign(new MemoryJournalError('MEMORY_PURGE_REPLAY_HELD'), { cause: error }); }
    const out = { scopes: 0, records: 0, applied: 0, invocationsPurged: 0 };
    for (const scopeId of [...new Set(records.map(record => record.scopeId))]) {
      const journal = await memoryJournalFor(await loadConfiguredScopeContext(projectRoot, scopeId, { ...options, heal: false }, 'write'), 'write');
      const result = await journal.replayPurges(scopeId);
      out.scopes++; out.records += result.records; out.applied += result.applied; out.invocationsPurged += result.invocationsPurged;
    }
    return out;
  } catch (error) { throw queryFailure(error); }
}
/** The restore card's line (`backup.restore.memoryPurges`): how many journal purges the restored ledger lacks (re-applied at the next service start). */
export async function countConfiguredMemoryPurgesPending(projectRoot: string, options: ConfigLoadOptions = {}): Promise<number> {
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false }), layout = config.productLayout;
  const integrity = () => openLocalIntegrityAuthority(layout, config.approvals.keyFile, false), records = await memoryPurgeJournalOf(layout, integrity).list();
  if (!records.length) return 0;
  const store = openSqliteMemoryJournalStore(productResourcePath(layout, 'ledger'), config.storage.sqlite, await integrity(), 'read');
  try {
    let pending = 0;
    for (const record of records) if (!await store.purgeRecord!(record.scopeId, record.purgeId)) pending++;
    return pending;
  } finally { store.close(); }
}
