import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { deckentMetricsSchema, encodeDeckentJson, type JsonValue, type RunSnapshot, type OperationEvidenceBinding } from '#domain/index.js';
import { deriveAcceptanceMetric, selectRunAcceptanceEvaluations, RunStoreError } from '#engine/index.js';

/** Caller owns the producer transaction; there is no independent metrics commit or public submission path. */
export function recordAcceptanceMetric(db: DatabaseSync, producerCommandId: string, snapshot: RunSnapshot): void {
  const receipt = db.prepare('SELECT command,snapshot FROM run_receipts WHERE scope_id=? AND command_id=?').get(snapshot.identity.scopeId, producerCommandId);
  if (!receipt || receipt.snapshot !== JSON.stringify(snapshot)) throw new RunStoreError('RUN_STORE_CONFLICT');
  const metric = deriveAcceptanceMetric(String(receipt.command), snapshot); if (!metric) return;
  const bytes = encodeDeckentJson(metric as unknown as JsonValue), id = metric.identity;
  const record = encodeDeckentJson({ schemaVersion: 1, metric: metric as unknown as JsonValue, digest: createHash('sha256').update(bytes, 'utf8').digest('hex') });
  const previous = db.prepare('SELECT record FROM acceptance_metrics WHERE scope_id=? AND producer_command_id=?').get(id.scopeId, producerCommandId);
  if (previous) { if (previous.record !== record) throw new RunStoreError('RUN_COMMAND_CONFLICT'); return; }
  db.prepare('INSERT INTO acceptance_metrics(scope_id,producer_command_id,run_id,task_id,attempt_id,outcome_kind,record) VALUES(?,?,?,?,?,?,?)')
    .run(id.scopeId, producerCommandId, id.runId, id.taskId, id.attemptId, metric.outcome.kind, record);
}

type EvaluationRow = { readonly commandId: string; readonly command: string };
/** Every evaluation receipt in one scan, keyed `scope/run`: a monitor snapshot reads every Run, and one scan per Run cost O(Runs × receipts). */
export function readAcceptanceEvaluationRows(db: DatabaseSync): ReadonlyMap<string, readonly EvaluationRow[]> {
  const rows = new Map<string, EvaluationRow[]>();
  for (const row of db.prepare(`SELECT scope_id,command_id,command,json_extract(command,'$.evaluation.identity.runId') AS run_id FROM run_receipts WHERE CASE WHEN json_valid(command)
    THEN json_extract(command,'$.action')='apply-task-evaluation' ELSE 0 END`).all()) if (typeof row.run_id === 'string') {
    const key = `${row.scope_id}/${row.run_id}`, list = rows.get(key) ?? []; list.push({ commandId: String(row.command_id), command: String(row.command) }); rows.set(key, list); }
  return rows;
}
/** Read-only receipt metadata, pinned to an already authorized Run snapshot; `rows` is that Run's slice of `readAcceptanceEvaluationRows`. */
export function readRunAcceptanceEvaluations(db: DatabaseSync, snapshot: RunSnapshot, rows?: readonly EvaluationRow[]) {
  return selectRunAcceptanceEvaluations(snapshot, rows ?? db.prepare(`SELECT command_id,command FROM run_receipts WHERE scope_id=? AND CASE WHEN json_valid(command) THEN
    json_extract(command,'$.action')='apply-task-evaluation' AND json_extract(command,'$.evaluation.identity.runId')=? ELSE 0 END`).all(snapshot.identity.scopeId, snapshot.identity.runId)
    .map(row => ({ commandId: String(row.command_id), command: String(row.command) })));
}
/** Scoped, digest-checked retained metrics; the consumer still owns per-Attempt output admission. */
export function readRunAcceptanceMetrics(db: DatabaseSync, snapshot: RunSnapshot) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acceptance_metrics'").get();
  if (!table) return [];
  return snapshot.bindings.flatMap(binding => {
    const records = db.prepare(`SELECT m.record FROM acceptance_metrics m JOIN run_receipts r ON r.scope_id=m.scope_id AND r.command_id=m.producer_command_id
      WHERE m.scope_id=? AND m.run_id=? AND m.attempt_id=? AND m.outcome_kind=? AND json_valid(r.snapshot)
      AND json_type(r.snapshot,'$.revision')='integer' AND json_extract(r.snapshot,'$.revision')<=? ORDER BY m.rowid DESC LIMIT 1`)
      .all(snapshot.identity.scopeId, snapshot.identity.runId, binding.identity.attemptId, 'task', snapshot.revision);
    return records.flatMap(row => { try {
      const record = JSON.parse(String(row.record)) as { metric: unknown; digest: string };
      const metric = deckentMetricsSchema.parse(record.metric);
      if (metric.identity.scopeId !== binding.identity.scopeId || metric.identity.runId !== binding.identity.runId || metric.identity.taskId !== binding.identity.taskId
        || metric.identity.attemptId !== binding.identity.attemptId || createHash('sha256').update(encodeDeckentJson(metric as unknown as JsonValue)).digest('hex') !== record.digest) throw new Error();
      return [metric];
    } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); } });
  });
}

/** Same-Run sharing requires a currently accepted Task and its exact immutable settlement digest, never mere prior use. */
export function readAcceptedOperationSettlements(db: DatabaseSync, run: RunSnapshot): NonNullable<OperationEvidenceBinding['acceptedSettlements']> {
  return Object.freeze(readRunAcceptanceEvaluations(db, run).flatMap(evaluation => {
    if (run.progress.find(task => task.taskId === evaluation.identity.taskId)?.phase !== 'accepted') return [];
    return evaluation.criteria.flatMap(row => {
      const criterion = run.graph.criterionDefinitions.find(value => value.id === row.criterionId);
      if (row.verdict !== 'pass' || !row.evidenceTypes?.includes('operation-settlement')
        || run.execution.criteria.find(value => value.criterionId === row.criterionId)?.evaluator.implementation.id !== 'operation-evidence') return [];
      return (row.evidenceReferences ?? []).filter(reference => reference.id === criterion?.parameters.commandId)
        .map(reference => Object.freeze({ commandId: reference.id, digest: reference.digest }));
    });
  }));
}
