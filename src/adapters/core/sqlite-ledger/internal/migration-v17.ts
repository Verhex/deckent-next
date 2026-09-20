import type { DatabaseSync } from 'node:sqlite';
import { AttemptStoreError, verifyModelInvocationRecord } from '#engine/index.js';

/** Add a single audit owner and retain-or-purged relationship without changing immutable receipts. */
export function migrateModelInvocationPurge(db: DatabaseSync): void {
  try {
    const rows = db.prepare(`SELECT i.scope_id,i.invocation_id,i.command_id,i.allocation_id,i.state,i.record,
      c.record AS content_record FROM model_invocations i LEFT JOIN model_invocation_contents c
      ON c.scope_id=i.scope_id AND c.invocation_id=i.invocation_id`).all();
    let contents = 0;
    for (const row of rows) {
      if (typeof row.record !== 'string' || (row.content_record !== null && typeof row.content_record !== 'string')) throw new Error();
      const record = verifyModelInvocationRecord({ receipt: JSON.parse(row.record),
        content: row.content_record === null ? null : JSON.parse(row.content_record as string), purge: null });
      const receipt = record.receipt;
      if (receipt.claim.scopeId !== row.scope_id || receipt.claim.invocationId !== row.invocation_id
        || receipt.request.commandId !== row.command_id || receipt.profile.allocation.id !== row.allocation_id
        || (receipt.outcome?.state ?? 'claimed') !== row.state) throw new Error();
      if (record.content !== null) contents++;
    }
    if (db.prepare('SELECT count(*) AS count FROM model_invocation_contents').get()?.count !== contents) throw new Error();
  } catch { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
  db.exec(`CREATE TABLE model_invocation_content_purges(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id),UNIQUE(scope_id,invocation_id),
    FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations(scope_id,invocation_id));
    CREATE TABLE model_invocation_contents_v17(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
      record TEXT,purge_command_id TEXT,PRIMARY KEY(scope_id,invocation_id),
      CHECK((record IS NOT NULL AND purge_command_id IS NULL) OR (record IS NULL AND purge_command_id IS NOT NULL)),
      FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations(scope_id,invocation_id),
      FOREIGN KEY(scope_id,purge_command_id) REFERENCES model_invocation_content_purges(scope_id,command_id));
    INSERT INTO model_invocation_contents_v17(scope_id,invocation_id,record) SELECT scope_id,invocation_id,record FROM model_invocation_contents;
    DROP TABLE model_invocation_contents;
    ALTER TABLE model_invocation_contents_v17 RENAME TO model_invocation_contents;`);
}
