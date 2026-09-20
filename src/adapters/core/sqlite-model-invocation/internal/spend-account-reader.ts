import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { ProviderSpendError, type ProviderSpendAccountReader } from '#engine/index.js';
import { PROVIDER_SPEND_LEDGER_VERSION, requireLedgerVersion } from '#adapters/core/sqlite-ledger/index.js';
import { readSpendCheckpoint } from './spend-checkpoint.js';

const optionsSchema = z.object({ busyTimeoutMs: z.number().int().nonnegative().max(2_147_483_647) }).strict();

class SqliteProviderSpendAccountReader implements ProviderSpendAccountReader {
  constructor(private readonly db: DatabaseSync) {}

  async loadSnapshot(scopeId: string) {
    if (!identitySchema.safeParse(scopeId).success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    this.db.exec('BEGIN');
    try {
      const checkpoint = readSpendCheckpoint(this.db, scopeId);
      this.db.exec('COMMIT');
      return checkpoint;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      if (error instanceof ProviderSpendError) throw error;
      throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    }
  }

  close() { this.db.close(); }
}

export function openSqliteProviderSpendAccountReader(path: string,
  options: { readonly busyTimeoutMs: number }): ProviderSpendAccountReader {
  const parsed = optionsSchema.safeParse(options);
  if (typeof path !== 'string' || !path || !parsed.success) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { readOnly: true, timeout: parsed.data.busyTimeoutMs });
    requireLedgerVersion(db, PROVIDER_SPEND_LEDGER_VERSION);
    return new SqliteProviderSpendAccountReader(db);
  } catch (error) {
    try { db?.close(); } catch { /* The read-only reader never wrote state. */ }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ATTEMPT_STORE_VERSION') throw error;
    throw new ProviderSpendError('PROVIDER_SPEND_UNAVAILABLE');
  }
}
