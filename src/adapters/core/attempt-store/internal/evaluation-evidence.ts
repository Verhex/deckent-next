import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sameAttemptIdentity, TaskEvaluationError, operationEvidenceBindingReason, operationEvidenceBindingSchema, attemptIdentitySchema,
  type AttemptIdentity, type TaskEvaluation, type RunSnapshot } from '#domain/index.js';
import { workerEventLogSchema, criterionEvidenceDigest, bindUsedOperationEvidence } from '#engine/index.js';
import { readRunBoundDispatch, readRunBoundTask } from './run-dispatch-lookup.js';
import { SqliteEffectJournal } from './effect.js';
/** The immutable admission row owns Run authority; dispatch grant owns execution authority and start time. */
export function readRunEvaluationPrincipal(db: DatabaseSync, identity: AttemptIdentity) {
  attemptIdentitySchema.parse(identity);
  const row = db.prepare('SELECT actor_id,issuer,subject FROM run_execution_intents WHERE scope_id=? AND run_id=?').get(identity.scopeId, identity.runId);
  return row ? operationEvidenceBindingSchema.parse({ startedAt: 0, principals: [{ id: row.actor_id, issuer: row.issuer, subject: row.subject }] }).principals[0]! : null;
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
  const hash = (record: unknown) => createHash('sha256').update(JSON.stringify(record)).digest('hex');
  const principal = readRunEvaluationPrincipal(db, evaluation.identity);
  for (const row of evaluation.criteria) {
    const reference = row.effectEvidence;
    const definition = run.graph.criterionDefinitions.find(value => value.id === row.criterionId);
    const selected = run.execution.criteria.find(value => value.criterionId === row.criterionId);
    if (!reference && selected?.evaluator.implementation.id === 'operation-evidence' && row.verdict === 'pass') throw new TaskEvaluationError('TASK_EVALUATION_STALE');
    if (!reference) continue;
    if (selected?.evaluator.implementation.id !== 'operation-evidence' || selected.evaluator.implementation.version !== 1
      || definition?.parameters.commandId !== reference.commandId) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
    const record = effects.read(evaluation.identity.scopeId, reference.commandId);
    const compensation = record?.state === 'settled' && record.intent.descriptor.compensation
      ? effects.readCompensation(evaluation.identity.scopeId, reference.commandId) : null;
    if (row.verdict === 'pass' && (!record || record.state !== 'settled' || compensation
      || !row.evidenceTypes?.includes('operation-settlement') || !row.evidenceReferences?.some(value => value.id === reference.commandId && value.digest === reference.digest)
      || operationEvidenceBindingReason(dispatch?.grant ? { startedAt: dispatch.grant.grantedAt,
        principals: [dispatch.grant.principal, ...(principal ? [principal] : [])] } : undefined, record.intent.actor, record.evidence?.observedAt))) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
    if (JSON.stringify(reference) !== JSON.stringify({ commandId: reference.commandId, digest: record ? hash(record) : null,
      compensation: compensation ? { commandId: compensation.intent.command.commandId, digest: hash(compensation) } : null })) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  }
  const criterion = criterionEvidenceDigest(evaluation.criteria);
  if (evaluation.evidenceDigests && JSON.stringify(evaluation.evidenceDigests) !== JSON.stringify([current.output, current.seal, current.patch, criterion].filter(Boolean))) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  if (evaluation.workspaceChange && evaluation.workspaceChange.patchDigest !== current.patch) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  const evidence = evaluation.returnEvidence;
  if (evidence && (evidence.digest !== (evidence.kind === 'criterion-evidence' ? criterion : current[evidence.kind === 'output' ? 'output' : evidence.kind === 'workspace-patch' ? 'patch' : 'seal'])
    || (evidence.kind === 'model-seal' && (evaluation.model?.verdict !== 'verified' || evaluation.model.evidence !== 'sealed')))) throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
}
