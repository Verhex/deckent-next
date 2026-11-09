import type { DatabaseSync } from 'node:sqlite';
import { sameAttemptIdentity, taskEvaluationSchema, type AttemptIdentity } from '#domain/index.js';
import { AttemptStoreError } from '#engine/index.js';
/** Evaluation evidence stays in existing Run receipts. Query pins the complete accepted Attempt, never artifact existence. */
export function readTaskHandoffEvaluation(db: DatabaseSync, identity: AttemptIdentity) {
  const row = db.prepare(`SELECT command FROM run_receipts WHERE scope_id=? AND json_extract(command,'$.action')='apply-task-evaluation'
    AND json_extract(command,'$.evaluation.identity.runId')=? AND json_extract(command,'$.evaluation.identity.attemptId')=?
    ORDER BY json_extract(snapshot,'$.revision') DESC LIMIT 1`).get(identity.scopeId, identity.runId, identity.attemptId);
  if (!row) return null;
  try {
    const evaluation = taskEvaluationSchema.parse(JSON.parse(String(row.command)).evaluation);
    if (!sameAttemptIdentity(evaluation.identity, identity)) throw new Error();
    return evaluation;
  } catch { throw new AttemptStoreError('ATTEMPT_STORE_CORRUPT'); }
}
