import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { identitySchema, parseModelInvocationControlRecord } from '#domain/index.js';
import { AttemptStoreError, verifyModelInvocationRecord } from '#engine/index.js';

type Row = Readonly<Record<string, unknown>>;
const counter = z.number().int().nonnegative().safe();
const allocationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, allocationId: identitySchema,
  maxCalls: counter.positive(), maxInFlight: counter.positive(), lifetimeCalls: counter, inFlight: counter }).strict()
  .superRefine((value, context) => {
    if (value.inFlight > value.lifetimeCalls || value.lifetimeCalls > value.maxCalls || value.inFlight > value.maxInFlight) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_ALLOCATION_INVALID' });
    }
  });
function invalid(): never { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
function decode(input: unknown): Record<string, unknown> {
  if (typeof input !== 'string') return invalid();
  try {
    const value = JSON.parse(input) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
  } catch { return invalid(); }
}
function receipt4(input: unknown): Record<string, unknown> {
  const old = decode(input), outcome = old.outcome;
  if (old.schemaVersion !== 3) return invalid();
  const convertedOutcome = outcome === null ? null : (() => {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
      || (outcome as Record<string, unknown>).schemaVersion !== 3) return invalid();
    if (!['responded', 'unknown', 'rejected'].includes(String((outcome as Record<string, unknown>).state))) return invalid();
    return { ...(outcome as Record<string, unknown>), schemaVersion: 4 };
  })();
  return { ...old, schemaVersion: 4, outcome: convertedOutcome };
}

/** Ledger17 predates send custody. Preserve that uncertainty explicitly; never infer prevention. */
export function migrateModelInvocationControl(db: DatabaseSync): void {
  try {
    const rows = db.prepare(`SELECT i.scope_id,i.command_id,i.invocation_id,i.allocation_id,i.state,i.record,
      c.invocation_id AS content_invocation_id,c.record AS content_record,c.purge_command_id AS content_purge_command_id,
      p.scope_id AS purge_scope_id,p.command_id AS purge_command_id,p.invocation_id AS purge_invocation_id,p.record AS purge_record
      FROM model_invocations i LEFT JOIN model_invocation_contents c
        ON c.scope_id=i.scope_id AND c.invocation_id=i.invocation_id
      LEFT JOIN model_invocation_content_purges p
        ON p.scope_id=c.scope_id AND p.command_id=c.purge_command_id
      ORDER BY i.scope_id,i.invocation_id`).all() as Row[];
    const converted = rows.map(row => {
      const receipt = receipt4(row.record);
      const record = verifyModelInvocationRecord({ receipt,
        content: row.content_record === null ? null : decode(row.content_record),
        purge: row.purge_record === null ? null : decode(row.purge_record) });
      const claim = record.receipt.claim;
      if (claim.scopeId !== row.scope_id || claim.invocationId !== row.invocation_id
        || record.receipt.request.commandId !== row.command_id
        || record.receipt.profile.allocation.id !== row.allocation_id
        || (record.receipt.outcome?.state ?? 'claimed') !== row.state) invalid();
      const hasContentRow = row.content_invocation_id !== null;
      if (hasContentRow !== (record.content !== null || record.purge !== null)
        || (hasContentRow && row.content_invocation_id !== row.invocation_id)) invalid();
      if (record.purge === null) {
        if (row.content_purge_command_id !== null || row.purge_command_id !== null || row.purge_scope_id !== null
          || row.purge_invocation_id !== null || row.purge_record !== null) invalid();
      } else if (row.purge_scope_id !== row.scope_id || row.purge_invocation_id !== row.invocation_id
        || row.content_purge_command_id !== record.purge.command.commandId
        || row.purge_command_id !== record.purge.command.commandId) invalid();
      const control = parseModelInvocationControlRecord({ schemaVersion: 1, claim,
        reference: record.receipt.request.reference, send: { state: 'unobserved' }, cancellation: null });
      return { row, record, control };
    });
    if (db.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count !== converted.length) invalid();
    const contentCount = converted.filter(value => value.row.content_invocation_id !== null).length;
    const purgeCount = converted.filter(value => value.row.purge_record !== null).length;
    if (db.prepare('SELECT count(*) AS count FROM model_invocation_contents').get()?.count !== contentCount
      || db.prepare('SELECT count(*) AS count FROM model_invocation_content_purges').get()?.count !== purgeCount) invalid();

    const allocations = db.prepare(`SELECT scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record
      FROM model_invocation_allocations`).all() as Row[];
    const counts = new Map<string, { lifetime: number; inFlight: number }>();
    for (const value of converted) {
      const key = JSON.stringify([value.record.receipt.claim.scopeId, value.record.receipt.profile.allocation.id]);
      const count = counts.get(key) ?? { lifetime: 0, inFlight: 0 };
      count.lifetime++;
      if (value.record.receipt.outcome?.state !== 'responded' && value.record.receipt.outcome?.state !== 'rejected') count.inFlight++;
      counts.set(key, count);
    }
    for (const row of allocations) {
      const parsed = allocationSchema.safeParse(decode(row.record));
      if (!parsed.success) invalid();
      const allocation = parsed.data, key = JSON.stringify([row.scope_id, row.allocation_id]);
      if (allocation.scopeId !== row.scope_id || allocation.allocationId !== row.allocation_id
        || allocation.maxCalls !== row.max_calls || allocation.maxInFlight !== row.max_in_flight
        || allocation.lifetimeCalls !== row.lifetime_calls || allocation.inFlight !== row.in_flight) invalid();
      const count = counts.get(key) ?? { lifetime: 0, inFlight: 0 };
      if (count.lifetime !== row.lifetime_calls || count.inFlight !== row.in_flight) invalid();
      counts.delete(key);
    }
    if (counts.size !== 0) invalid();

    db.exec(`PRAGMA defer_foreign_keys=ON;
      CREATE TABLE model_invocations_v18(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
        allocation_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('claimed','responded','unknown','rejected','not-sent')),
        record TEXT NOT NULL,PRIMARY KEY(scope_id,invocation_id),UNIQUE(scope_id,command_id));
      CREATE TABLE model_invocation_controls(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
        send_state TEXT NOT NULL CHECK(send_state IN ('pending','permitted','prevented','unobserved')),record TEXT NOT NULL,
        PRIMARY KEY(scope_id,invocation_id),FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations_v18(scope_id,invocation_id));
      CREATE TABLE model_invocation_cancellations(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
        record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id),UNIQUE(scope_id,invocation_id),
        FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations_v18(scope_id,invocation_id));
      CREATE TABLE model_invocation_content_purges_v18(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,command_id),UNIQUE(scope_id,invocation_id),
        FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations_v18(scope_id,invocation_id));
      CREATE TABLE model_invocation_contents_v18(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
        record TEXT,purge_command_id TEXT,PRIMARY KEY(scope_id,invocation_id),
        CHECK((record IS NOT NULL AND purge_command_id IS NULL) OR (record IS NULL AND purge_command_id IS NOT NULL)),
        FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations_v18(scope_id,invocation_id),
        FOREIGN KEY(scope_id,purge_command_id) REFERENCES model_invocation_content_purges_v18(scope_id,command_id));
      INSERT INTO model_invocation_content_purges_v18 SELECT * FROM model_invocation_content_purges;
      INSERT INTO model_invocation_contents_v18 SELECT * FROM model_invocation_contents;`);
    const invocationInsert = db.prepare(`INSERT INTO model_invocations_v18
      (scope_id,command_id,invocation_id,allocation_id,state,record) VALUES(?,?,?,?,?,?)`);
    const controlInsert = db.prepare(`INSERT INTO model_invocation_controls(scope_id,invocation_id,send_state,record)
      VALUES(?,?,?,?)`);
    for (const value of converted) {
      invocationInsert.run(String(value.row.scope_id), String(value.row.command_id), String(value.row.invocation_id),
        String(value.row.allocation_id), String(value.row.state), JSON.stringify(value.record.receipt));
      controlInsert.run(String(value.row.scope_id), String(value.row.invocation_id), 'unobserved', JSON.stringify(value.control));
    }
    db.exec(`DROP TABLE model_invocation_contents; DROP TABLE model_invocation_content_purges;
      DROP INDEX model_invocations_allocation_state; DROP TABLE model_invocations;
      ALTER TABLE model_invocations_v18 RENAME TO model_invocations;
      ALTER TABLE model_invocation_content_purges_v18 RENAME TO model_invocation_content_purges;
      ALTER TABLE model_invocation_contents_v18 RENAME TO model_invocation_contents;
      CREATE INDEX model_invocations_allocation_state ON model_invocations(scope_id,allocation_id,state);`);
    if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) invalid();
  } catch (error) {
    if (error instanceof AttemptStoreError && error.code === 'LEDGER_MIGRATION_EVIDENCE_REQUIRED') throw error;
    invalid();
  }
}
