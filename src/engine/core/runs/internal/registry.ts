import { createHash } from 'node:crypto';
import { executionRegistrySchema, runExecutionSnapshotSchema, encodeCriterionDefinition, validateTaskGraph, type ExecutionProfileDefinition, type EvaluatorDefinition, type CriterionDefinition, type RunExecutionSnapshot, type TaskGraph } from '#domain/index.js';
export interface ExecutionRegistryValidation {
  /** Installed adapter/evaluator selection; data cannot introduce executable code or grant policy. */
  profile(profile: ExecutionProfileDefinition): undefined;
  criterion(evaluator: EvaluatorDefinition, criterion: CriterionDefinition): undefined;
}
export class ExecutionRegistryError extends Error {
  constructor(readonly code: 'TASK_KIND_NOT_REGISTERED' | 'TASK_EVALUATOR_NOT_REGISTERED' | 'EXECUTION_REGISTRY_VALIDATOR_INVALID' | 'RUN_EXECUTION_INTEGRITY') { super(code); this.name = 'ExecutionRegistryError'; }
}

/** Stored selections must remain an exact, verifiable record of the Run graph at admission. */
export function assertRunExecution(graphInput: unknown, executionInput: unknown): RunExecutionSnapshot {
  const graph: TaskGraph = validateTaskGraph(graphInput); const execution = runExecutionSnapshotSchema.parse(executionInput);
  const invalid = () => { throw new ExecutionRegistryError('RUN_EXECUTION_INTEGRITY'); };
  if (execution.tasks.length !== graph.tasks.length || execution.criteria.length !== graph.criterionDefinitions.length) invalid();
  const selectedTasks = new Set(execution.tasks.map(entry => entry.taskId));
  const selectedCriteria = new Set(execution.criteria.map(entry => entry.criterionId));
  if (selectedTasks.size !== execution.tasks.length || selectedCriteria.size !== execution.criteria.length) invalid();
  for (const task of graph.tasks) if (!selectedTasks.has(task.id)) invalid();
  for (const criterion of graph.criterionDefinitions) {
    const selected = execution.criteria.find(entry => entry.criterionId === criterion.id);
    const fingerprint = createHash('sha256').update(encodeCriterionDefinition(criterion), 'utf8').digest('hex');
    if (!selected || selected.evaluator.id !== criterion.evaluator.id || selected.evaluator.version !== criterion.evaluator.version || selected.fingerprint !== fingerprint) invalid();
  }
  return execution;
}
/** Resolve once at admission. Return copied immutable selected definitions, never live registry references. */
export function resolveExecutionRegistry(graphInput: unknown, registryInput: unknown, validation: ExecutionRegistryValidation) {
  const graph = validateTaskGraph(graphInput); const registry = executionRegistrySchema.parse(registryInput);
  const tasks = graph.tasks.map(task => {
    const kind = registry.kinds.find(entry => entry.kind === task.kind);
    if (!kind) throw new ExecutionRegistryError('TASK_KIND_NOT_REGISTERED');
    const profile = registry.profiles.find(entry => entry.id === kind.profile.id && entry.version === kind.profile.version)!;
    if (validation.profile(profile) !== undefined) throw new ExecutionRegistryError('EXECUTION_REGISTRY_VALIDATOR_INVALID');
    return Object.freeze({ taskId: task.id, profile });
  });
  const criteria = graph.criterionDefinitions.map(criterion => {
    const evaluator = registry.evaluators.find(entry => entry.id === criterion.evaluator.id && entry.version === criterion.evaluator.version);
    if (!evaluator) throw new ExecutionRegistryError('TASK_EVALUATOR_NOT_REGISTERED');
    if (validation.criterion(evaluator, criterion) !== undefined) throw new ExecutionRegistryError('EXECUTION_REGISTRY_VALIDATOR_INVALID');
    return Object.freeze({ criterionId: criterion.id, evaluator, fingerprint: createHash('sha256').update(encodeCriterionDefinition(criterion), 'utf8').digest('hex') });
  });
  return assertRunExecution(graph, { schemaVersion: 1 as const, registryRevision: registry.revision,
    tasks: Object.freeze(tasks), criteria: Object.freeze(criteria) });
}
