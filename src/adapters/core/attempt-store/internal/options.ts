import { z } from 'zod';
import { AttemptStoreError } from '#engine/index.js';

export const sqliteAttemptOptionsSchema = z.object({
  // Native SQLite busy timeout is a signed 32-bit millisecond budget.
  busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647),
  journalMode: z.enum(['wal', 'delete']),
  durability: z.enum(['full', 'extra']),
}).strict().readonly();
export type SqliteAttemptOptions = z.infer<typeof sqliteAttemptOptionsSchema>;
export function sqliteFailure(error: unknown): unknown {
  const code = error && typeof error === 'object' && 'errcode' in error ? error.errcode : null;
  if (typeof code === 'number' && [5, 6].includes(code & 255)) return new AttemptStoreError('ATTEMPT_STORE_BUSY');
  return error;
}
