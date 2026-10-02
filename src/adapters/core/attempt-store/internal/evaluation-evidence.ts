import type { DatabaseSync } from 'node:sqlite';
import { sameAttemptIdentity, TaskEvaluationError, type AttemptIdentity, type TaskEvaluation } from '#domain/index.js';
import { workerEventLogSchema } from '#engine/index.js';
import { readRunBoundDispatch } from './run-dispatch-lookup.js';
/** Ledger snapshot at park/commit: immutable output and host seal bound to this exact Attempt. */
export function readEvaluationDigests(db: DatabaseSync, identity: AttemptIdentity) {
  const { dispatch } = readRunBoundDispatch(db, identity);
  const row = db.prepare('SELECT record FROM worker_event_logs WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  const log = row ? workerEventLogSchema.parse(JSON.parse(String(row.record))) : null;
  if (log && !sameAttemptIdentity(log.identity, identity)) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  return { output: dispatch?.output?.digest, seal: log?.events.digest };
}
export function assertEvaluationDigests(db: DatabaseSync, evaluation: TaskEvaluation) {
  const current = readEvaluationDigests(db, evaluation.identity);
  if (evaluation.evidenceDigests && JSON.stringify(evaluation.evidenceDigests) !== JSON.stringify([current.output, current.seal].filter(Boolean))) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  const evidence = evaluation.returnEvidence;
  if (evidence && (evidence.digest !== current[evidence.kind === 'output' ? 'output' : 'seal']
    || (evidence.kind === 'model-seal' && (evaluation.model?.verdict !== 'verified' || evaluation.model.evidence !== 'sealed')))) throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
}
