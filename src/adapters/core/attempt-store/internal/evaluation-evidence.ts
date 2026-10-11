import type { DatabaseSync } from 'node:sqlite';
import { sameAttemptIdentity, TaskEvaluationError, operationEvidenceBindingSchema, attemptIdentitySchema,
  type AttemptIdentity, type TaskEvaluation, type RunSnapshot } from '#domain/index.js';
import { workerEventLogSchema, bindUsedOperationEvidence, selectEvaluationEffectEvidence, assertEvaluationEffectEvidence, assertEvaluationDigestEvidence } from '#engine/index.js';
import { readRunBoundDispatch, readRunBoundTask } from './run-dispatch-lookup.js';
import { SqliteEffectJournal } from './effect.js';
/** The immutable admission row owns Run authority; dispatch grant owns execution authority and start time. */
export function readRunEvaluationPrincipal(db: DatabaseSync, identity: AttemptIdentity) {
  attemptIdentitySchema.parse(identity);
  const row = db.prepare('SELECT actor_id,issuer,subject FROM run_execution_intents WHERE scope_id=? AND run_id=?').get(identity.scopeId, identity.runId);
  return row ? operationEvidenceBindingSchema.parse({ notBefore: 0, principals: [{ id: row.actor_id, issuer: row.issuer, subject: row.subject }] }).principals[0]! : null;
}
/** Accepted receipts reserve evidence to one Run across restart; its Tasks may share it. Acceptance write transaction only. */
export function bindOperationEvidenceUse(db: DatabaseSync, run: RunSnapshot, evaluation: TaskEvaluation): TaskEvaluation {
  const { scopeId, runId } = evaluation.identity;
  return bindUsedOperationEvidence(run, evaluation, commandId => !!db.prepare(`SELECT 1 FROM run_receipts r, json_each(r.command,'$.evaluation.criteria') c
      WHERE r.scope_id=? AND json_extract(r.command,'$.action')='apply-task-evaluation' AND json_extract(r.command,'$.evaluation.identity.runId')!=?
      AND COALESCE(json_extract(c.value,'$.effectEvidence.commandId'),CASE WHEN EXISTS(SELECT 1 FROM json_each(c.value,'$.evidenceTypes') t WHERE t.value='operation-settlement') THEN json_extract(c.value,'$.evidenceReferences[0].id') END)=? AND json_extract(c.value,'$.verdict')='pass'
      AND EXISTS (SELECT 1 FROM run_receipts a, json_each(a.snapshot,'$.progress') p, json_each(a.snapshot,'$.bindings') b WHERE a.scope_id=r.scope_id AND json_extract(a.snapshot,'$.identity.runId')=json_extract(r.command,'$.evaluation.identity.runId')
        AND json_extract(p.value,'$.taskId')=json_extract(r.command,'$.evaluation.identity.taskId') AND json_extract(p.value,'$.phase')='accepted'
        AND json_extract(b.value,'$.identity.attemptId')=json_extract(r.command,'$.evaluation.identity.attemptId')) LIMIT 1`).get(scopeId, runId, commandId));
}
/** Ledger snapshot at park/commit: immutable output and host seal bound to this exact Attempt. */
export function readEvaluationDigests(db: DatabaseSync, identity: AttemptIdentity) {
  const { dispatch } = readRunBoundDispatch(db, identity);
  const row = db.prepare('SELECT record FROM worker_event_logs WHERE scope_id=? AND attempt_id=?').get(identity.scopeId, identity.attemptId);
  const log = row ? workerEventLogSchema.parse(JSON.parse(String(row.record))) : null;
  if (log && !sameAttemptIdentity(log.identity, identity)) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  return { output: dispatch?.output?.digest, seal: log?.events.digest, patch: readRunBoundTask(db, identity).workInput ? dispatch?.patch?.digest : undefined };
}
export function assertEvaluationDigests(db: DatabaseSync, evaluation: TaskEvaluation) {
  const current = readEvaluationDigests(db, evaluation.identity), effects = new SqliteEffectJournal(db), { run, dispatch } = readRunBoundDispatch(db, evaluation.identity);
  const principal = readRunEvaluationPrincipal(db, evaluation.identity);
  for (const row of evaluation.criteria) {
    const reference = selectEvaluationEffectEvidence(run, row);
    if (!reference) continue;
    const record = effects.read(evaluation.identity.scopeId, reference.commandId);
    const compensation = record?.state === 'settled' && record.intent.descriptor.compensation
      ? effects.readCompensation(evaluation.identity.scopeId, reference.commandId) : null;
    assertEvaluationEffectEvidence(row, reference, dispatch, principal, record, compensation);
  }
  assertEvaluationDigestEvidence(evaluation, current);
}
