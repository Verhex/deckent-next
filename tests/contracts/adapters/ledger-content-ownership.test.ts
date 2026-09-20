import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';

it('enforces response content ownership in the actual shared SQLite writer connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-content-ownership-'));
  const db = openSqliteLedger(join(root, 'ledger.db'), { busyTimeoutMs: 20, journalMode: 'delete', durability: 'full' });
  try {
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(() => db.prepare('INSERT INTO model_invocation_contents(scope_id,invocation_id,record) VALUES(?,?,?)')
      .run('scope', 'missing-invocation', '{}')).toThrow();
    expect(db.prepare('SELECT count(*) AS count FROM model_invocation_contents').get()?.count).toBe(0);
    // Minimal SQL rows deliberately exercise the database's relationship, not receipt validation.
    db.prepare('INSERT INTO model_invocations(scope_id,command_id,invocation_id,allocation_id,state,record) VALUES(?,?,?,?,?,?)')
      .run('scope', 'command', 'invocation', 'allocation', 'responded', '{}');
    db.prepare('INSERT INTO model_invocation_contents(scope_id,invocation_id,record) VALUES(?,?,?)')
      .run('scope', 'invocation', '{}');
    expect(() => db.prepare('DELETE FROM model_invocations WHERE scope_id=? AND invocation_id=?')
      .run('scope', 'invocation')).toThrow();
    expect(db.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count).toBe(1);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
