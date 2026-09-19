import type { DatabaseSync } from 'node:sqlite';
import { requireMigrationReceipt } from './migration-v12-receipts.js';
import { createRun, runSnapshotSchema, type RunSnapshot } from '#domain/index.js';
import { AttemptStoreError, assertRunExecution, runCreateSchema, runExecutionPolicySchema, type RunCreate } from '#engine/index.js';

function invalid(): never { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
function evidence<T>(read: () => T): T { try { return read(); } catch { return invalid(); } }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  return input as Record<string, unknown>;
}
function decoded(input: unknown): Record<string, unknown> {
  if (typeof input !== 'string') return invalid();
  return object(evidence(() => JSON.parse(input)));
}
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** The old scalar meant immediate only when a strict creation receipt proves its origin.
 * Legacy shape handling stays inside this forward migration; runtime accepts only snapshot 3.
 */
function convert(source: unknown, creation: RunCreate): RunSnapshot {
  const old = decoded(source);
  if (old.schemaVersion !== 2 || !Array.isArray(old.progress)) return invalid();
  const progress = old.progress.map(input => {
    const value = object(input);
    if (!Object.hasOwn(value, 'eligibleAt') || value.eligibleAt !== creation.now || Object.hasOwn(value, 'eligibility')) return invalid();
    const rest = { ...value }; delete rest.eligibleAt;
    return { ...rest, eligibility: { kind: 'immediate' } };
  });
  const current = evidence(() => runSnapshotSchema.parse({ ...old, schemaVersion: 3, progress }));
  evidence(() => assertRunExecution(current.graph, current.execution));
  if (!same(current.identity, creation.identity) || !same(current.graph, creation.graph) || !same(current.execution, creation.execution)) return invalid();
  return current;
}

/** Caller owns one BEGIN IMMEDIATE covering this conversion and all subsequent version steps.
 * Validate orphan receipts first; retain original command bytes and convert one Run at a time.
 */
export function migrateImmediateEligibility(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT scope_id,command_id,command,snapshot FROM run_receipts').iterate()) {
      const snapshot = decoded(row.snapshot), identity = object(snapshot.identity), command = decoded(row.command);
      if (identity.scopeId !== row.scope_id || command.commandId !== row.command_id || typeof identity.runId !== 'string') invalid();
      if (!db.prepare('SELECT 1 FROM runs WHERE scope_id=? AND run_id=?').get(String(row.scope_id), identity.runId)) invalid();
      if (command.action === 'create-run' && !same(object(command.identity), identity)) invalid();
    }
    for (const row of db.prepare('SELECT scope_id,run_id,revision,snapshot,policy FROM runs').iterate()) {
      let receipt: Record<string, unknown> | undefined;
      for (const found of db.prepare(`SELECT command_id,command,snapshot FROM run_receipts
        WHERE scope_id=? AND json_extract(command,'$.action')='create-run'
        AND json_extract(command,'$.identity.runId')=?`).iterate(String(row.scope_id), String(row.run_id))) {
        if (receipt) invalid();
        receipt = found;
      }
      if (!receipt) invalid();
      const { action, ...command } = decoded(receipt.command);
      if (action !== 'create-run') invalid();
      const creation = evidence(() => runCreateSchema.parse(command));
      if (creation.commandId !== receipt.command_id || creation.identity.scopeId !== row.scope_id || creation.identity.runId !== row.run_id) invalid();
      const expected = createRun(creation.identity, creation.graph, creation.now, creation.execution);
      if (!same(convert(receipt.snapshot, creation), expected)) invalid();
      const policy = evidence(() => runExecutionPolicySchema.parse(decoded(row.policy)));
      if (!same(policy, creation.policy)) invalid();
      const current = convert(row.snapshot, creation);
      if (current.revision !== row.revision) invalid();
      // Only keys are retained. Snapshot payloads are validated and rewritten individually.
      const keys = db.prepare(`SELECT command_id FROM run_receipts
        WHERE scope_id=? AND json_extract(snapshot,'$.identity.runId')=?`).all(String(row.scope_id), String(row.run_id));
      for (const key of keys) {
        const historical = db.prepare('SELECT command,snapshot FROM run_receipts WHERE scope_id=? AND command_id=?')
          .get(String(row.scope_id), String(key.command_id));
        if (!historical) invalid();
        const converted = convert(historical.snapshot, creation);
        if (converted.revision > current.revision) invalid();
        requireMigrationReceipt(historical.command, key.command_id, converted);
        db.prepare('UPDATE run_receipts SET snapshot=? WHERE scope_id=? AND command_id=?')
          .run(JSON.stringify(converted), String(row.scope_id), String(key.command_id));
      }
      db.prepare('UPDATE runs SET snapshot=? WHERE scope_id=? AND run_id=?')
        .run(JSON.stringify(current), String(row.scope_id), String(row.run_id));
    }
}
