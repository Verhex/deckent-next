import type { SqliteAttemptOptions } from './internal/options.js';
export type { SqliteAttemptStore } from './internal/sqlite.js';
/** Load the native driver only when this storage adapter is selected by composition. */
export async function openSqliteAttemptStore(path: string, options: SqliteAttemptOptions) {
  const { SqliteAttemptStore } = await import('./internal/sqlite.js');
  return new SqliteAttemptStore(path, options);
}
export type { SqliteAttemptOptions } from './internal/options.js';
