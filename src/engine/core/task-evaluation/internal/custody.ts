import { createHash } from 'node:crypto';
import { TaskEvaluationError, operationEvidenceBindingReason, type EffectRecord, type RunSnapshot, type TaskEvaluation } from '#domain/index.js';
import type { DispatchRecord } from '#engine/core/dispatch/index.js';
import type { TaskEvaluationCommit } from './commit.js';
import { criterionEvidenceDigest } from './recovery.js';
import { operationEvidenceBinding } from './operation-binding.js';

/** Check the admitted evaluator before the ledger reads the cited effect. */
export function selectEvaluationEffectEvidence(run: RunSnapshot, row: TaskEvaluation['criteria'][number]) {
  const reference = row.effectEvidence;
  const definition = run.graph.criterionDefinitions.find(value => value.id === row.criterionId);
  const selected = run.execution.criteria.find(value => value.criterionId === row.criterionId);
  if (!reference && selected?.evaluator.implementation.id === 'operation-evidence' && row.verdict === 'pass') throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  if (!reference) return undefined;
  if (selected?.evaluator.implementation.id !== 'operation-evidence' || selected.evaluator.implementation.version !== 1
    || definition?.parameters.commandId !== reference.commandId) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  return reference;
}

/** Pure decision over effect snapshots read under the acceptance transaction. */
export function assertEvaluationEffectEvidence(row: TaskEvaluation['criteria'][number], reference: NonNullable<typeof row.effectEvidence>,
  dispatch: DispatchRecord | null, principal: TaskEvaluationCommit['actor'] | null, record: EffectRecord | null, compensation: EffectRecord | null) {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if (row.verdict === 'pass' && (!record || record.state !== 'settled' || compensation
    || !row.evidenceTypes?.includes('operation-settlement') || !row.evidenceReferences?.some(value => value.id === reference.commandId && value.digest === reference.digest)
    || operationEvidenceBindingReason(operationEvidenceBinding(dispatch?.grant, principal), record.intent.actor, record.evidence?.observedAt))) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  if (JSON.stringify(reference) !== JSON.stringify({ commandId: reference.commandId, digest: record ? hash(record) : null,
    compensation: compensation ? { commandId: compensation.intent.command.commandId, digest: hash(compensation) } : null })) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
}

/** Preserve ordered custody bytes and the existing typed return-evidence rejections. */
export function assertEvaluationDigestEvidence(evaluation: TaskEvaluation, current: { output: string | undefined; seal: string | undefined; patch: string | undefined }) {
  const criterion = criterionEvidenceDigest(evaluation.criteria);
  if (evaluation.evidenceDigests && JSON.stringify(evaluation.evidenceDigests) !== JSON.stringify([current.output, current.seal, current.patch, criterion].filter(Boolean))) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  if (evaluation.workspaceChange && evaluation.workspaceChange.patchDigest !== current.patch) throw new TaskEvaluationError('TASK_EVALUATION_STALE');
  const evidence = evaluation.returnEvidence;
  if (evidence && (evidence.digest !== (evidence.kind === 'criterion-evidence' ? criterion : current[evidence.kind === 'output' ? 'output' : evidence.kind === 'workspace-patch' ? 'patch' : 'seal'])
    || (evidence.kind === 'model-seal' && (evaluation.model?.verdict !== 'verified' || evaluation.model.evidence !== 'sealed')))) throw new TaskEvaluationError('TASK_EVALUATION_NOT_READY');
}
