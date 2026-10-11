import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { encodeDeckentJson, type JsonValue, type RunSnapshot } from '#domain/index.js';
import { deriveAcceptanceMetric, RunStoreError } from '#engine/index.js';

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
