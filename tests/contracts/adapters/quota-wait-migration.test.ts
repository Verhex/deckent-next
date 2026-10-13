import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrateLedger, CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { DOWNGRADE_TO_V53_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

it('v53 quota custody is backfilled without rewriting snapshots; indexed projections follow every committed update and rollback', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow'); db.exec(DOWNGRADE_TO_V53_LEDGER_SQL);
    const wait = { identity: { attemptId: 'attempt' }, channelId: 'channel', since: 1000, deadline: 6000,
      quota: { source: 'claude-rate-limit', resetsAtMs: 6000 } };
    const snapshot = JSON.stringify({ quotaWaits: [wait] });
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('s', 'r', 1, snapshot, '{}');
    expect(() => migrateLedger(db, 'forbid')).toThrow('ATTEMPT_STORE_VERSION');
    db.exec('BEGIN IMMEDIATE'); migrateLedger(db, 'allow'); db.exec('COMMIT');
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(db.prepare('SELECT snapshot FROM runs').get()!.snapshot).toBe(snapshot);
    expect(db.prepare('SELECT channel_held,released_at_ms FROM run_quota_waits').get()).toEqual({ channel_held: 1, released_at_ms: null });
    const released = JSON.stringify({ quotaWaits: [{ ...wait, releasedAtMs: 2000 }] });
    db.exec('BEGIN IMMEDIATE'); db.prepare('UPDATE runs SET snapshot=?').run(released);
    expect(db.prepare('SELECT released_at_ms FROM run_quota_waits').get()!.released_at_ms).toBe(2000);
    db.exec('ROLLBACK'); expect(db.prepare('SELECT released_at_ms FROM run_quota_waits').get()!.released_at_ms).toBeNull();
    db.prepare('UPDATE runs SET snapshot=?').run(released); expect(db.prepare('SELECT released_at_ms FROM run_quota_waits').get()!.released_at_ms).toBe(2000);
    db.exec('DELETE FROM runs'); expect(db.prepare('SELECT count(*) n FROM run_quota_waits').get()!.n).toBe(0);
  } finally { db.close(); }
});
it.each(['codex-text', 'exit-text', 'unknown-reset', 'over-bound'] as const)('migration and insert triggers never promote %s into a channel hold', variant => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow');
    const wait = { identity: { attemptId: 'attempt' }, channelId: 'channel', since: 1000, deadline: 6000,
      quota: { source: variant === 'codex-text' || variant === 'exit-text' ? variant : 'claude-rate-limit', resetsAtMs: variant === 'unknown-reset' ? null : 6000 },
      ...(variant === 'over-bound' ? { resetBoundExceeded: true } : {}) };
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('s', 'r', 1, JSON.stringify({ quotaWaits: [wait] }), '{}');
    expect(db.prepare('SELECT channel_held FROM run_quota_waits').get()!.channel_held).toBe(0);
    db.exec(DOWNGRADE_TO_V53_LEDGER_SQL); migrateLedger(db, 'allow');
    expect(db.prepare('SELECT channel_held FROM run_quota_waits').get()!.channel_held).toBe(0);
  } finally { db.close(); }
});
it('conflicting v54 schema rolls back the additive migration and leaves v53 untouched', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow'); db.exec(DOWNGRADE_TO_V53_LEDGER_SQL);
    db.exec('CREATE TABLE quota_release_receipts(foreign_record TEXT); BEGIN IMMEDIATE');
    expect(() => migrateLedger(db, 'allow')).toThrow('already exists'); db.exec('ROLLBACK');
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(53);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='run_quota_waits'").get()).toBeUndefined();
    expect(db.prepare('PRAGMA table_info(quota_release_receipts)').all()[0]!.name).toBe('foreign_record');
  } finally { db.close(); }
});

it.each(['migration', 'insert', 'update'] as const)('%s skips malformed snapshot projection without rewriting it or disturbing other channel holds', path => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateLedger(db, 'allow');
    if (path === 'migration') db.exec(DOWNGRADE_TO_V53_LEDGER_SQL);
    const snapshot = JSON.stringify({ quotaWaits: [{ identity: { attemptId: 'attempt' }, channelId: 'channel', since: 1000, deadline: 6000,
      quota: { source: 'claude-rate-limit', resetsAtMs: 6000 } }] });
    const insert = db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)');
    insert.run('s', 'valid', 1, snapshot, '{}');
    if (path === 'update') insert.run('s', 'corrupt', 1, snapshot, '{}');
    else insert.run('s', 'corrupt', 1, 'not-json', '{}');
    if (path === 'migration') { db.exec('BEGIN IMMEDIATE'); migrateLedger(db, 'allow'); db.exec('COMMIT'); }
    if (path === 'update') {
      db.exec('BEGIN IMMEDIATE'); db.prepare("UPDATE runs SET snapshot='not-json' WHERE run_id='corrupt'").run();
      expect(db.prepare("SELECT count(*) n FROM run_quota_waits WHERE run_id='corrupt'").get()!.n).toBe(0);
      db.exec('ROLLBACK');
      expect(db.prepare("SELECT channel_held FROM run_quota_waits WHERE run_id='corrupt'").get()!.channel_held).toBe(1);
      db.prepare("UPDATE runs SET snapshot='not-json' WHERE run_id='corrupt'").run();
    }
    expect(db.prepare("SELECT snapshot FROM runs WHERE run_id='corrupt'").get()!.snapshot).toBe('not-json');
    expect(db.prepare("SELECT count(*) n FROM run_quota_waits WHERE run_id='corrupt'").get()!.n).toBe(0);
    expect(db.prepare("SELECT channel_held FROM run_quota_waits WHERE run_id='valid'").get()!.channel_held).toBe(1);
  } finally { db.close(); }
});
