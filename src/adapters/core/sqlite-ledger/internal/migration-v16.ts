import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { AttemptStoreError } from '#engine/index.js';
import { migrateInvocationReceiptContent } from './migration-invocation-content.js';

type Row = Readonly<Record<string, unknown>>;
const counter = z.number().int().nonnegative().safe();
const allocationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, allocationId: identitySchema,
  maxCalls: counter.positive(), maxInFlight: counter.positive(), lifetimeCalls: counter, inFlight: counter }).strict();
function invalid(): never { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
function decode(input: unknown): unknown {
  if (typeof input !== 'string') return invalid();
  try { return JSON.parse(input) as unknown; } catch { return invalid(); }
}
/** The ledger writer owns the transaction for all content extraction and version updates. */
export function migrateModelInvocationContents(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT scope_id,command_id,invocation_id,allocation_id,state,record FROM model_invocations`).all() as Row[];
  const converted = rows.map(row => {
    const record = migrateInvocationReceiptContent(decode(row.record)), receipt = record.receipt;
    if (row.scope_id !== receipt.request.scopeId || row.command_id !== receipt.request.commandId
      || row.invocation_id !== receipt.claim.invocationId || row.allocation_id !== receipt.profile.allocation.id
      || row.state !== (receipt.outcome?.state ?? 'claimed')) invalid();
    return record;
  });
  const allocations = new Map<string, z.infer<typeof allocationSchema>>();
  const counts = new Map<string, { lifetimeCalls: number; inFlight: number }>();
  const key = (scope: string, allocation: string) => JSON.stringify([scope, allocation]);
  for (const row of db.prepare(`SELECT scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record FROM model_invocation_allocations`).all() as Row[]) {
    const parsed = allocationSchema.safeParse(decode(row.record));
    if (!parsed.success) return invalid();
    const a = parsed.data;
    if (row.scope_id !== a.scopeId || row.allocation_id !== a.allocationId || row.max_calls !== a.maxCalls
      || row.max_in_flight !== a.maxInFlight || row.lifetime_calls !== a.lifetimeCalls || row.in_flight !== a.inFlight
      || a.inFlight > a.lifetimeCalls || a.lifetimeCalls > a.maxCalls || a.inFlight > a.maxInFlight) invalid();
    const id = key(a.scopeId, a.allocationId);
    if (allocations.has(id)) invalid();
    allocations.set(id, a);
  }
  for (const { receipt } of converted) {
    const id = key(receipt.request.scopeId, receipt.profile.allocation.id), a = allocations.get(id);
    if (!a || a.maxCalls !== receipt.profile.allocation.maxCalls || a.maxInFlight !== receipt.profile.allocation.maxInFlight) invalid();
    const count = counts.get(id) ?? { lifetimeCalls: 0, inFlight: 0 };
    count.lifetimeCalls++;
    if (!receipt.outcome || receipt.outcome.state === 'unknown') count.inFlight++;
    counts.set(id, count);
  }
  for (const [id, a] of allocations) {
    const count = counts.get(id) ?? { lifetimeCalls: 0, inFlight: 0 };
    if (a.lifetimeCalls !== count.lifetimeCalls || a.inFlight !== count.inFlight) invalid();
  }
  db.exec(`CREATE TABLE model_invocation_contents(scope_id TEXT NOT NULL,invocation_id TEXT NOT NULL,record TEXT NOT NULL,
    PRIMARY KEY(scope_id,invocation_id),FOREIGN KEY(scope_id,invocation_id) REFERENCES model_invocations(scope_id,invocation_id));`);
  const contentInsert = db.prepare(`INSERT INTO model_invocation_contents(scope_id,invocation_id,record) VALUES(?,?,?)`);
  const receiptUpdate = db.prepare(`UPDATE model_invocations SET record=? WHERE scope_id=? AND invocation_id=?`);
  for (const { receipt, content } of converted) {
    if (content) contentInsert.run(receipt.claim.scopeId, receipt.claim.invocationId, JSON.stringify(content));
    const result = receiptUpdate.run(JSON.stringify(receipt), receipt.claim.scopeId, receipt.claim.invocationId);
    if (result.changes !== 1) invalid();
  }
}
