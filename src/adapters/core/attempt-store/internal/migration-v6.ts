import type { DatabaseSync } from 'node:sqlite';
import { dispatchRecordSchema, AttemptStoreError, type SupervisorProfileValidator } from '#engine/index.js';

/** Profile compatibility belongs to the selected adapter; this migration knows only the generic envelope. */
export function requireLedgerV6ProfileCompatibility(db: DatabaseSync, profiles?: SupervisorProfileValidator): void {
  try {
    for (const row of db.prepare('SELECT record FROM dispatches').iterate()) {
      const record = dispatchRecordSchema.parse(JSON.parse(String(row.record)));
      if (!profiles) throw new Error('PROFILE_VALIDATOR_REQUIRED');
      const result = profiles.validate(record.profile);
      if (result !== undefined) throw new Error('PROFILE_VALIDATOR_INVALID_RETURN');
    }
  } catch { throw new AttemptStoreError('LEDGER_RESET_REQUIRED'); }
}
