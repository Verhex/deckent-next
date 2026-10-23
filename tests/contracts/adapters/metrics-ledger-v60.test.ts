import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION, METRICS_V2_LEDGER_VERSION, migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { DOWNGRADE_TO_V59_LEDGER_SQL } from '../../fixtures/ledger-previous.js';

// ATAMA-0: v60 keeps every v59 metric row byte for byte and adds the (Task, Attempt, outcome kind) current-row invariant.
// The fixture is the shape a v59 ledger holds after a retained-evidence return: two producers for one Attempt, one for another.
const v1 = (attemptId: string, status: string) => JSON.stringify({ schemaVersion: 1, metric: { schemaVersion: 1, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId },
  outcome: { kind: 'task', status } }, digest: 'f'.repeat(64) });
function v59() {
  const db = new DatabaseSync(':memory:');
  migrateLedger(db, 'allow'); db.exec(DOWNGRADE_TO_V59_LEDGER_SQL);
  const insert = db.prepare('INSERT INTO acceptance_metrics(scope_id,producer_command_id,run_id,task_id,attempt_id,outcome_kind,record) VALUES(?,?,?,?,?,?,?)');
  insert.run('s', 'evaluation', 'r', 't', 'a1', 'task', v1('a1', 'awaiting-decision'));
  insert.run('s', 'other', 'r', 't2', 'a2', 'task', v1('a2', 'accepted'));
  insert.run('s', 'new-evidence', 'r', 't', 'a1', 'task', v1('a1', 'accepted'));
  return db;
}
const rows = (db: DatabaseSync) => db.prepare('SELECT rowid,producer_command_id,record,superseded_by FROM acceptance_metrics ORDER BY rowid').all();

it('v59 upgrades to v60: rows and their order are kept, the older row of an Attempt is superseded by its successor', () => {
  expect(METRICS_V2_LEDGER_VERSION).toBe(60); expect(CURRENT_LEDGER_VERSION).toBe(63);
  const db = v59();
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(59);
    const before = db.prepare('SELECT rowid,producer_command_id,record FROM acceptance_metrics ORDER BY rowid').all();
    migrateLedger(db, 'allow');
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(rows(db)).toEqual(before.map(row => ({ ...row, superseded_by: row.producer_command_id === 'evaluation' ? 'new-evidence' : null })));
    // One current row per (Task, Attempt, outcome kind) is a storage invariant, not a reader convention.
    expect(() => db.prepare("UPDATE acceptance_metrics SET superseded_by=NULL WHERE producer_command_id='evaluation'").run()).toThrow(/UNIQUE/);
    // The same producer may write a different outcome kind (a human decision that also closes the Run).
    db.prepare('INSERT INTO acceptance_metrics(scope_id,producer_command_id,run_id,task_id,attempt_id,outcome_kind,record) VALUES(?,?,?,?,?,?,?)')
      .run('s', 'new-evidence', 'r', 't', 'a1', 'run', '{}');
    migrateLedger(db, 'forbid');
  } finally { db.close(); }
});
it('the v60 → v59 fixture is exact for single-kind producers and the upgrade replays to the same rows', () => {
  const db = v59();
  try {
    migrateLedger(db, 'allow'); const upgraded = rows(db);
    db.exec(DOWNGRADE_TO_V59_LEDGER_SQL);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(59);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('acceptance_metrics') WHERE name='superseded_by'").get()?.n).toBe(0);
    migrateLedger(db, 'allow');
    expect(rows(db)).toEqual(upgraded);
  } finally { db.close(); }
});
