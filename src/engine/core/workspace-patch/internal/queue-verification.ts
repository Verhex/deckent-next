import { ErrorRegistry } from '#platform/index.js';
import { createHash } from 'node:crypto';
import { encodeCriterionDefinition, executionRegistrySchema, taskGraphSchema, sameAttemptIdentity, CandidateBindingError,
  type CandidateBinding, type TargetQueueRecord, type RunSnapshot, type CriterionDefinition } from '#domain/index.js';
import { executionProfileFingerprint, adoptionCriteriaMeet, type AdoptionVerificationRequirement, type CriterionWithin } from './verification.js';
import { WorkspaceAdoptionError } from './adoption-error.js';
/** Preserve the original Task's evaluator definitions and pinned implementations, adding the current installation bar conjunctively. */
export function queueVerificationGraph(record: TargetQueueRecord, original: RunSnapshot, registryInput: unknown, bar: AdoptionVerificationRequirement | null) {
  const task = original.graph.tasks.find(task => task.id === record.request.identity.taskId);
  const binding = original.bindings.find(binding => sameAttemptIdentity(binding.identity, record.request.identity));
  if (!task || !binding || original.progress.find(row => row.taskId === task.id)?.phase !== 'accepted') throw new WorkspaceAdoptionError('ADOPTION_NOT_ACCEPTED');
  const registry = executionRegistrySchema.parse(registryInput);
  const criteria = task.acceptanceCriteria.map(id => {
    const definition = original.graph.criterionDefinitions.find(row => row.id === id), pinned = original.execution.criteria.find(row => row.criterionId === id);
    const current = definition && registry.evaluators.find(row => row.id === definition.evaluator.id && row.version === definition.evaluator.version);
    if (!definition || !pinned || JSON.stringify(pinned.evaluator) !== JSON.stringify(current)) throw new WorkspaceAdoptionError('ADOPTION_VERIFICATION_MISMATCH');
    return definition;
  });
  for (const [index, required] of (bar?.criteria ?? []).entries()) {
    let id = `queue-bar-${index}`;
    while (criteria.some(row => row.id === id)) id += '-bar';
    criteria.push({ id, version: 1, description: id, evaluator: required.evaluator, parameters: required.parameters } as CriterionDefinition);
  }
  const kind = bar?.kind ?? task.kind, entry = registry.kinds.find(row => row.kind === kind);
  const profile = entry && registry.profiles.find(row => row.id === entry.profile.id && row.version === entry.profile.version);
  if (!profile) throw ErrorRegistry.createError('ADOPTION_VERIFICATION_NOT_CONFIGURED');
  const graph = taskGraphSchema.parse({ schemaVersion: 4, revision: 1, tasks: [{ id: task.id, kind, ...(task.workClass ? { workClass: task.workClass } : {}), dependencies: [], acceptanceCriteria: criteria.map(row => row.id) }], criterionDefinitions: criteria });
  return { graph, profileFingerprint: executionProfileFingerprint(profile), criteria: criteria.map(row => createHash('sha256').update(encodeCriterionDefinition(row)).digest('hex')) };
}
/** Verify exact graph, source, revision, profile and all original plus current criteria before interpreting phase. */
export function assertQueueVerification(candidate: CandidateBinding, expected: ReturnType<typeof queueVerificationGraph>, run: RunSnapshot,
  custody: { baseRevision: string; source: { sourceFingerprint: string } } | null, bar: AdoptionVerificationRequirement | null, within: CriterionWithin) {
  const task = run.graph.tasks[0], profile = run.execution.tasks[0]?.profile;
  if (!custody || custody.baseRevision !== candidate.candidateVersion || custody.source.sourceFingerprint !== candidate.sourceBinding
    || JSON.stringify(run.graph) !== JSON.stringify(expected.graph) || !task || !profile || executionProfileFingerprint(profile) !== candidate.profileFingerprint
    || JSON.stringify(run.execution.criteria.map(row => row.fingerprint)) !== JSON.stringify(candidate.criteria)) throw new CandidateBindingError('CANDIDATE_MISMATCH');
  if (bar && !adoptionCriteriaMeet(bar, run, task.id, within)) throw new WorkspaceAdoptionError('ADOPTION_VERIFICATION_CRITERIA_WEAKER');
  return run.progress.find(row => row.taskId === task.id)?.phase;
}
