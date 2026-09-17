import type { SqliteAttemptOptions } from './internal/options.js';
export type { SqliteAttemptStore } from './internal/sqlite.js';
/** Load the native driver only when this storage adapter is selected by composition. */
export async function openSqliteAttemptStore(path: string, options: SqliteAttemptOptions) {
  const { SqliteAttemptStore } = await import('./internal/sqlite.js');
  return new SqliteAttemptStore(path, options);
}
export type { SqliteAttemptOptions } from './internal/options.js';
export type { SqliteInventoryReader, SqliteInventoryOptions } from './internal/inventory-reader.js';
export async function openSqliteInventoryReader(path: string, options: import('./internal/inventory-reader.js').SqliteInventoryOptions) {
  const { SqliteInventoryReader } = await import('./internal/inventory-reader.js');
  return new SqliteInventoryReader(path, options);
}
