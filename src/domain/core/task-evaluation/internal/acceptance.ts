import { evaluationAcceptanceSchema, runSnapshotSchema, type RunSnapshot } from '#domain/core/run/index.js';
import { workerReportRefusal } from '#domain/core/worker-event/index.js';
import { TaskEvaluationError, type TaskEvaluation } from './evaluation.js';

export { evaluationAcceptanceSchema };
/** Recomputable metadata on the canonical evaluation; never a second acceptance writer. */
export function bindTaskAcceptance(run: RunSnapshot, evaluation: TaskEvaluation): TaskEvaluation {
  const reference = run.execution.tasks.find(row => row.taskId === evaluation.identity.taskId)?.acceptance;
  if (!reference) {
    if (evaluation.acceptance) throw new TaskEvaluationError('TASK_EVALUATION_PROFILE_MISMATCH');
    return evaluation;
  }
  const frozen = run.execution.workClassProfiles?.find(row => row.workClass === reference.workClass
    && row.policyRevision === reference.policyRevision && row.profileVersion === reference.profileVersion);
  if (!frozen) throw new TaskEvaluationError('TASK_EVALUATION_PROFILE_MISMATCH');
  const profile = frozen.profile;
  const coreType = (type: string) => type.startsWith('ext:') ? frozen.evidenceExtensions.find(row => row.id === type)?.mapsTo : type;
  let missing = false, missingApproval = false;
  const criteria = evaluation.criteria.map(row => {
    const definition = reference.criteria.find(value => value.criterionId === row.criterionId);
    if (!definition) throw new TaskEvaluationError('TASK_EVALUATION_PROFILE_MISMATCH');
    const actual = row.evidenceTypes ?? [];
    const invalidType = actual.some(type => !coreType(type) || !definition.evidenceTypes.includes(type));
    const absent = definition.evidenceTypes.some(type => !actual.includes(type)) || row.evidenceIds.length === 0;
    if (absent || invalidType) missing = true;
    if (definition.evidenceTypes.some(type => coreType(type) === 'approval-receipt' && !actual.includes(type))) missingApproval = true;
    return absent || invalidType ? { ...row, verdict: row.verdict === 'fail' ? 'fail' as const : 'unknown' as const } : row;
  });
  // R5 (owner D5a): a missing or invalid worker report is missing evidence, expressed through the profile's ceiling rule.
  if (evaluation.report && ['report-missing', 'report-invalid'].includes(workerReportRefusal(evaluation.report) ?? '')) missing = true;
  const weights = profile.rubric.reduce((sum, row) => sum + row.weight, 0);
  let score = profile.rubric.reduce((sum, rubric) => {
    const matched = criteria.filter(row => reference.criteria.find(value => value.criterionId === row.criterionId)?.criterionType === rubric.criterionType);
    return sum + (matched.length > 0 && matched.every(row => row.verdict === 'pass') ? rubric.weight : 0);
  }, 0) / weights;
  const ceilingReasons: ('missing-evidence' | 'unsettled-effect' | 'missing-approval')[] = [];
  const progress = run.progress.find(row => row.taskId === evaluation.identity.taskId);
  for (const rule of profile.ceilingRules) {
    if ((rule.when === 'missing-evidence' && missing) || (rule.when === 'unsettled-effect' && progress?.unresolvedEffects)
      || (rule.when === 'missing-approval' && missingApproval)) { score = Math.min(score, rule.maxScore); ceilingReasons.push(rule.when); }
  }
  const acceptance = evaluationAcceptanceSchema.parse({ ...reference, score, ceilingReasons });
  return { ...evaluation, criteria, acceptance };
}
export function inspectAcceptanceConclusion(runInput: unknown, evaluation: TaskEvaluation): 'pass' | 'fail' | 'unknown' | null {
  const run = runSnapshotSchema.parse(runInput);
  const rebound = bindTaskAcceptance(run, evaluation);
  if (!rebound.acceptance) return null;
  if (JSON.stringify(rebound.acceptance) !== JSON.stringify(evaluation.acceptance)
    || JSON.stringify(rebound.criteria) !== JSON.stringify(evaluation.criteria)) throw new TaskEvaluationError('TASK_EVALUATION_PROFILE_MISMATCH');
  const frozen = run.execution.workClassProfiles!.find(row => row.workClass === rebound.acceptance!.workClass
    && row.policyRevision === rebound.acceptance!.policyRevision && row.profileVersion === rebound.acceptance!.profileVersion)!;
  if (rebound.criteria.some(row => row.verdict === 'unknown')) return 'unknown';
  if (rebound.acceptance.score < frozen.profile.decisionThresholds.rejectBelow) return 'fail';
  return rebound.acceptance.score >= frozen.profile.decisionThresholds.acceptAt ? 'pass' : 'unknown';
}
