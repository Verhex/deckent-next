import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';
import { validateCurrentRunRecords } from './migration-v5.js';

/** Registry-selected execution definitions and fingerprints are immutable Run evidence. */
export function requireLedgerV8ExecutionRegistry(db: DatabaseSync): void {
  try { validateCurrentRunRecords(db); }
  catch { throw new AttemptStoreError('LEDGER_RESET_REQUIRED'); }
}
