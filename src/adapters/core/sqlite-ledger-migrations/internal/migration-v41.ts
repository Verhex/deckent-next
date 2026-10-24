import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError } from '#engine/index.js';

// General Core audit port, first slice (owner 2026-09-27 q4/q5): sealed audit events, append-only in the database itself — the
// triggers abort any UPDATE or DELETE, so a row can only be added; the sealed record carries its scope-local sequence, so a gap
// or renumbering is visible on read. Counters are mutable summaries of decisions that were silent already (q5), not evidence.
// IF NOT EXISTS follows v39: a real ledger below v41 never has these objects; a same-name object of another shape fails the
// check below and rolls the single migration transaction back (the ledger stays at its version, typed ATTEMPT_STORE_VERSION).
const AUDIT_SQL = `CREATE TABLE IF NOT EXISTS audit_events(scope_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),event_id TEXT NOT NULL,
    kind TEXT NOT NULL,at_ms INTEGER NOT NULL CHECK(at_ms>=0),key_id TEXT NOT NULL,mac TEXT NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,sequence),UNIQUE(scope_id,event_id));
  CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'AUDIT_APPEND_ONLY'); END;
  CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'AUDIT_APPEND_ONLY'); END;
  CREATE TABLE IF NOT EXISTS audit_counters(scope_id TEXT NOT NULL,counter TEXT NOT NULL,count INTEGER NOT NULL CHECK(count>=0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0),PRIMARY KEY(scope_id,counter));`;
const SHAPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  audit_events: ['scope_id', 'sequence', 'event_id', 'kind', 'at_ms', 'key_id', 'mac', 'record'],
  audit_counters: ['scope_id', 'counter', 'count', 'updated_at_ms'],
});

/** Creates the v41 audit objects and proves their shape: exact column lists and both append-only triggers present. */
export function migrateAuditEvents(db: DatabaseSync): void {
  db.exec(AUDIT_SQL);
  for (const [table, columns] of Object.entries(SHAPES)) {
    const found = db.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).all(table).map(row => String(row.name));
    if (found.join(',') !== columns.join(',')) throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
  }
  const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='audit_events' ORDER BY name").all().map(row => String(row.name));
  if (triggers.join(',') !== 'audit_events_no_delete,audit_events_no_update') throw new AttemptStoreError('ATTEMPT_STORE_VERSION');
}
