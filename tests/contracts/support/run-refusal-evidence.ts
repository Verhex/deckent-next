import { DatabaseSync } from 'node:sqlite';
import { hostname, userInfo } from 'node:os';
import { expect } from 'vitest';
import { auditRecordSchema, authorityDecisionSubjectSchema } from '#domain/index.js';
import { sha256 } from '#platform/index.js';

/** Snapshot every durable business table, plus the exact pre-existing audit rows.
 * A refused admission can seal its evaluated policy; it cannot write a Run effect. */
export function runRefusalEvidence(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all();
    const tables = schema.filter(row => row.type === 'table' && row.name !== 'audit_events');
    return {
      version: db.prepare('PRAGMA user_version').get(), schema,
      tables: Object.fromEntries(tables.map(row => {
        const name = String(row.name).replaceAll('"', '""');
        // FTS5 shadow tables (ledger v61 memory search) are WITHOUT ROWID: they are ordered by their key column instead.
        return [row.name, db.prepare(`SELECT * FROM "${name}" ORDER BY ${/WITHOUT ROWID/i.test(String(row.sql)) ? '1' : 'rowid'}`).all()];
      })),
      audit: db.prepare('SELECT * FROM audit_events ORDER BY scope_id,sequence').all(),
    };
  } finally { db.close(); }
}

export function expectOnlyUnappliedRunDecisions(path: string, before: ReturnType<typeof runRefusalEvidence>,
  expected: readonly { scopeId: string; commandId: string; runId: string }[]) {
  const after = runRefusalEvidence(path);
  expect(after.version).toEqual(before.version);
  expect(after.schema).toEqual(before.schema);
  expect(after.tables).toEqual(before.tables);
  for (const row of before.audit) expect(after.audit.find(value => value.event_id === row.event_id && value.scope_id === row.scope_id)).toEqual(row);
  const previous = new Set(before.audit.map(row => `${row.scope_id}:${row.event_id}`));
  const added = after.audit.filter(value => !previous.has(`${value.scope_id}:${value.event_id}`));
  expect(added).toHaveLength(expected.length);
  const observed = [];
  for (const row of added) {
    expect(row.kind).toBe('authority-decision');
    const record = auditRecordSchema.parse(JSON.parse(String(row.record)));
    const subject = authorityDecisionSubjectSchema.parse(record.event.subject);
    expect(subject).toMatchObject({ action: 'create', resource: { kind: 'run' }, basisDigest: null, verdict: { decision: 'allow' } });
    expect(subject.envelope.scopeId).toBe(row.scope_id);
    expect(subject.envelope.idempotencyKeyHash).toBe(sha256(subject.envelope.commandId));
    expect(subject.envelope.principalRef).toMatchObject({ issuer: hostname(), subject: String(userInfo().uid) });
    expect(record.event.principal).toEqual({ issuer: subject.envelope.principalRef.issuer, subject: subject.envelope.principalRef.subject });
    expect(record.event.policyRevision).toBe(subject.verdict.revision);
    expect(row).toMatchObject({ event_id: record.event.eventId, scope_id: record.event.scopeId, sequence: record.sequence, key_id: record.keyId, mac: record.mac });
    observed.push({ scopeId: subject.envelope.scopeId, commandId: subject.envelope.commandId, runId: subject.resource.id });
  }
  const identities = (values: readonly { scopeId: string; commandId: string; runId: string }[]) => values.map(value => JSON.stringify({
    scopeId: value.scopeId, commandId: value.commandId, runId: value.runId })).sort();
  expect(identities(observed)).toEqual(identities(expected));
}
