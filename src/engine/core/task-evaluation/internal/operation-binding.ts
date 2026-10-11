import { MAX_WALL_SKEW_MS } from '#platform/index.js';
import { bindTaskAcceptance, taskEvaluationSchema, type OperationEvidenceBinding, type RunSnapshot, type TaskEvaluation } from '#domain/index.js';

/** The ledger checks use by another Run under its acceptance transaction; this pure normalization owns no I/O or transition. */
export function bindUsedOperationEvidence(run: RunSnapshot, evaluation: TaskEvaluation, isUsed: (commandId: string) => boolean): TaskEvaluation {
  const criteria = evaluation.criteria.map(row => row.verdict === 'pass' && row.effectEvidence && isUsed(row.effectEvidence.commandId)
    ? { ...row, verdict: 'fail' as const, reason: 'OPERATION_EVIDENCE_OTHER_RUN' as const, evidenceTypes: [], evidenceReferences: [] } : row);
  return criteria.every((row, index) => row === evaluation.criteria[index]) ? evaluation : taskEvaluationSchema.parse(bindTaskAcceptance(run, { ...evaluation, criteria }));
}
type Actor = OperationEvidenceBinding['principals'][number];
/** The one constructor of a granted Attempt's operation-evidence binding, used by evaluation and the acceptance transaction alike.
 * The grant and an effect settlement are stamped by different processes; local wall clocks step independently (I40), so a
 * settlement earlier than the grant by at most MAX_WALL_SKEW_MS is not provably earlier. Beyond that bound it is OPERATION_EVIDENCE_EARLIER. */
export function operationEvidenceBinding(grant: Readonly<{ grantedAt: number; principal: Actor }> | undefined, runPrincipal: Actor | null | undefined): OperationEvidenceBinding | undefined {
  return grant ? { notBefore: Math.max(0, grant.grantedAt - MAX_WALL_SKEW_MS), principals: [grant.principal, ...(runPrincipal ? [runPrincipal] : [])] } : undefined;
}
