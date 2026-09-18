import type { DatabaseSync } from 'node:sqlite';
import { runSnapshotSchema, validateTaskGraph } from '#domain/index.js';
import { assertRunExecution, dispatchRecordSchema, runCreateSchema, AttemptStoreError } from '#engine/index.js';

/** Schema 5 is a custody boundary: legacy records cannot be assigned missing evidence. */
export function requireLedgerV5Custody(db: DatabaseSync): void {
  try {
    for (const row of db.prepare('SELECT scope_id,attempt_id,record FROM dispatches').iterate()) {
      const record = requireDispatchRecord(row.record);
      if (record.request.identity.scopeId !== row.scope_id || record.request.identity.attemptId !== row.attempt_id) throw new Error('DISPATCH_ROW_MISMATCH');
    }
    validateCurrentRunRecords(db);
  } catch { throw new AttemptStoreError('LEDGER_RESET_REQUIRED'); }
}

function requireDispatchRecord(value: unknown) {
  const record = JSON.parse(String(value));
  if (!record || typeof record !== 'object' || (record as { schemaVersion?: unknown }).schemaVersion !== 2 ||
    !Object.hasOwn(record, 'profile') || !['pending', 'granted', 'prevented-before-launch'].includes((record as { launch?: unknown }).launch as string)) {
    throw new Error('DISPATCH_CUSTODY_MISSING');
  }
  return dispatchRecordSchema.parse(record);
}

function requireRunSnapshot(value: unknown) {
  const snapshot = runSnapshotSchema.parse(JSON.parse(String(value)));
  assertRunExecution(snapshot.graph, snapshot.execution);
  return snapshot;
}

function requireRunReceiptCommand(value: unknown) {
  const command = JSON.parse(String(value));
  if (!command || typeof command !== 'object' || (command as { action?: unknown }).action !== 'create-run') return;
  const input: Record<string, unknown> = { ...command };
  delete input.action;
  const create = runCreateSchema.parse(input);
  validateTaskGraph(create.graph);
  assertRunExecution(create.graph, create.execution);
  return create;
}

/** Shared forward-only boundary: every persisted Run row must satisfy the one current contract. */
export function validateCurrentRunRecords(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT scope_id,run_id,revision,snapshot FROM runs').iterate()) {
    const snapshot = requireRunSnapshot(row.snapshot);
    if (snapshot.identity.scopeId !== row.scope_id || snapshot.identity.runId !== row.run_id || snapshot.revision !== row.revision) throw new Error('RUN_ROW_MISMATCH');
  }
  for (const row of db.prepare('SELECT scope_id,snapshot,command FROM run_receipts').iterate()) {
    const snapshot = requireRunSnapshot(row.snapshot);
    if (snapshot.identity.scopeId !== row.scope_id) throw new Error('RUN_RECEIPT_SCOPE_MISMATCH');
    const create = requireRunReceiptCommand(row.command);
    if (create && (JSON.stringify(create.identity) !== JSON.stringify(snapshot.identity) ||
      JSON.stringify(create.graph) !== JSON.stringify(snapshot.graph) ||
      JSON.stringify(create.execution) !== JSON.stringify(snapshot.execution))) throw new Error('RUN_RECEIPT_ADMISSION_MISMATCH');
  }
}
