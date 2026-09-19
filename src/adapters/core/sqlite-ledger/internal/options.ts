import { SQLITE_STORAGE_OPTIONS } from '#platform/index.js';
import { z } from 'zod';
import { AttemptStoreError } from '#engine/index.js';

export const sqliteLedgerOptionsSchema = SQLITE_STORAGE_OPTIONS;
export type SqliteLedgerOptions = z.infer<typeof sqliteLedgerOptionsSchema>;
export function sqliteFailure(error: unknown): unknown {
  const code = error && typeof error === 'object' && 'errcode' in error ? error.errcode : null;
  if (typeof code === 'number' && [5, 6].includes(code & 255)) return new AttemptStoreError('ATTEMPT_STORE_BUSY');
  return error;
}
