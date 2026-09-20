import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { AttemptStoreError, verifyModelInvocationReceipt } from '#engine/index.js';

type Row = Readonly<Record<string, unknown>>;
function invalid(): never { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  return input as Record<string, unknown>;
}
function decoded(input: unknown): Record<string, unknown> {
  if (typeof input !== 'string') return invalid();
  try { return object(JSON.parse(input)); } catch { return invalid(); }
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid();
}
const allocationSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, allocationId: identitySchema,
  maxCalls: z.number().int().positive().safe(), maxInFlight: z.number().int().positive().safe(),
  lifetimeCalls: z.number().int().nonnegative().safe(), inFlight: z.number().int().nonnegative().safe() }).strict()
  .superRefine((value, context) => {
    if (value.inFlight > value.lifetimeCalls || value.lifetimeCalls > value.maxCalls || value.inFlight > value.maxInFlight) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_ALLOCATION_INVALID' });
    }
  });
type Allocation = z.infer<typeof allocationSchema>;
type Counts = { lifetimeCalls: number; inFlight: number };

/** Convert only genuine v14 receipts. Runtime readers accept only the current receipt version. */
function receiptV2(input: unknown) {
  const receipt = decoded(input);
  exact(receipt, ['schemaVersion', 'request', 'actor', 'authorization', 'definition', 'activationRevision',
    'profile', 'profileDigest', 'claim', 'claimedAtMs', 'outcome']);
  if (receipt.schemaVersion !== 1) invalid();
  let outcome: unknown = null;
  if (receipt.outcome !== null) {
    const old = object(receipt.outcome);
    if (old.schemaVersion !== 1) invalid();
    if (old.state === 'responded') {
      exact(old, ['schemaVersion', 'state', 'response', 'observedAtMs']);
      outcome = { ...old, schemaVersion: 2 };
    } else if (old.state === 'unknown') {
      exact(old, ['schemaVersion', 'state', 'reason', 'observedAtMs']);
      if (old.reason !== 'transport-error') invalid();
      outcome = { ...old, schemaVersion: 2, evidence: null };
    } else invalid();
  }
  try { return verifyModelInvocationReceipt({ ...receipt, schemaVersion: 2, outcome }); }
  catch { return invalid(); }
}

/** Caller owns the transaction spanning this rebuild and the user_version update. */
export function migrateModelInvocationEvidence(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT scope_id,command_id,invocation_id,allocation_id,state,record
    FROM model_invocations ORDER BY scope_id,invocation_id`).all() as Row[];
  const converted = rows.map(row => {
    const receipt = receiptV2(row.record), state = receipt.outcome?.state ?? 'claimed';
    if (row.scope_id !== receipt.request.scopeId || row.command_id !== receipt.request.commandId
      || row.invocation_id !== receipt.claim.invocationId || row.allocation_id !== receipt.profile.allocation.id
      || row.state !== state || (state !== 'claimed' && state !== 'responded' && state !== 'unknown')) invalid();
    return { row, receipt, state };
  });
  const allocations = new Map<string, Map<string, Allocation>>(), counts = new Map<string, Map<string, Counts>>();
  for (const allocation of db.prepare(`SELECT scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record
    FROM model_invocation_allocations`).all() as Row[]) {
    const record = decoded(allocation.record);
    exact(record, ['schemaVersion', 'scopeId', 'allocationId', 'maxCalls', 'maxInFlight', 'lifetimeCalls', 'inFlight']);
    const parsed = allocationSchema.safeParse(record);
    if (!parsed.success || allocation.scope_id !== parsed.data.scopeId || allocation.allocation_id !== parsed.data.allocationId
      || allocation.max_calls !== parsed.data.maxCalls || allocation.max_in_flight !== parsed.data.maxInFlight
      || allocation.lifetime_calls !== parsed.data.lifetimeCalls || allocation.in_flight !== parsed.data.inFlight) invalid();
    let scope = allocations.get(parsed.data.scopeId);
    if (!scope) { scope = new Map(); allocations.set(parsed.data.scopeId, scope); }
    if (scope.has(parsed.data.allocationId)) invalid();
    scope.set(parsed.data.allocationId, parsed.data);
  }
  for (const value of converted) {
    const allocation = allocations.get(value.receipt.request.scopeId)?.get(value.receipt.profile.allocation.id);
    if (!allocation || allocation.maxCalls !== value.receipt.profile.allocation.maxCalls
      || allocation.maxInFlight !== value.receipt.profile.allocation.maxInFlight) invalid();
    let scope = counts.get(allocation.scopeId);
    if (!scope) { scope = new Map(); counts.set(allocation.scopeId, scope); }
    const count = scope.get(allocation.allocationId) ?? { lifetimeCalls: 0, inFlight: 0 };
    count.lifetimeCalls++;
    if (value.state !== 'responded') count.inFlight++;
    scope.set(allocation.allocationId, count);
  }
  for (const [scopeId, scope] of allocations) for (const [allocationId, allocation] of scope) {
    const count = counts.get(scopeId)?.get(allocationId) ?? { lifetimeCalls: 0, inFlight: 0 };
    if (count.lifetimeCalls !== allocation.lifetimeCalls || count.inFlight !== allocation.inFlight) invalid();
  }
  db.exec(`CREATE TABLE model_invocations_v15(scope_id TEXT NOT NULL,command_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
    allocation_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('claimed','responded','unknown','rejected')),record TEXT NOT NULL,
    PRIMARY KEY(scope_id,invocation_id),UNIQUE(scope_id,command_id));`);
  const insert = db.prepare(`INSERT INTO model_invocations_v15(scope_id,command_id,invocation_id,allocation_id,state,record)
    VALUES(?,?,?,?,?,?)`);
  for (const value of converted) insert.run(String(value.row.scope_id), String(value.row.command_id), String(value.row.invocation_id),
    String(value.row.allocation_id), value.state, JSON.stringify(value.receipt));
  db.exec(`DROP INDEX model_invocations_allocation_state; DROP TABLE model_invocations;
    ALTER TABLE model_invocations_v15 RENAME TO model_invocations;
    CREATE INDEX model_invocations_allocation_state ON model_invocations(scope_id,allocation_id,state);`);
}
