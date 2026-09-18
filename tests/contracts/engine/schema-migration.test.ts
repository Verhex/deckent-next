import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore } from '#adapters/index.js';
it('rolls all earlier migration steps back when a later DDL step fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-schema-')); const path = join(root, 'ledger.db');
  try {
    const setup = new DatabaseSync(path);
    setup.exec('CREATE TABLE execution_pools(marker TEXT); INSERT INTO execution_pools VALUES (\'preserve\');'); setup.close();
    await expect(openSqliteAttemptStore(path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' })).rejects.toThrow();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(0);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name)).toEqual(['execution_pools']);
      expect(db.prepare('SELECT marker FROM execution_pools').get()!.marker).toBe('preserve');
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
