// Exact reader from 9d92287fdf3db0207882aaf67339977d3858035b; retained to test rollback compatibility.
import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';
export const CURRENT_LEDGER_VERSION = 70;
export function requireLedgerVersion(db: DatabaseSync, minimum: number) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < minimum || version > CURRENT_LEDGER_VERSION) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  return version;
}
