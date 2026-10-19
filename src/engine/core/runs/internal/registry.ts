import { createHash } from 'node:crypto';
import { freezeTaskAcceptance, assertAcceptanceCriteria, readWorkerModelPin, resolveTaskWorkClass, type TaskStallPolicy, type FrozenWorkClassProfile, executionProfileDefinitionSchema, executionRegistrySchema, runExecutionSnapshotSchema, encodeCriterionDefinition, validateTaskGraph, type ExecutionProfileDefinition, type EvaluatorDefinition, type CriterionDefinition, type RunExecutionSnapshot, type TaskGraph, type WorkInput } from '#domain/index.js';
export interface ExecutionRegistryValidation {
  /** Installed adapter/evaluator selection; data cannot introduce executable code or grant policy. */
  profile(profile: ExecutionProfileDefinition): undefined;
  criterion(evaluator: EvaluatorDefinition, criterion: CriterionDefinition): undefined;
  /** K3: installed template adapters. A template never runs as is; it is compiled with the task's typed work input (pure, no I/O). */
  prepareProfile?(profile: ExecutionProfileDefinition, kind: string, taskId: string): ExecutionProfileDefinition;
  isTemplate?(profile: ExecutionProfileDefinition): boolean;
  compile?(template: ExecutionProfileDefinition, workInput: WorkInput, kind: string, taskId: string): ExecutionProfileDefinition;
  /** R3 (owner D4a): the installation silence policy and the deadline a profile's policy must stop before (null: no host liveness channel). */
  silence?: Readonly<{ policy: TaskStallPolicy; deadline(profile: ExecutionProfileDefinition): number | null }>;
}
export class ExecutionRegistryError extends Error {
  constructor(readonly code: 'TASK_KIND_NOT_REGISTERED' | 'TASK_EVALUATOR_NOT_REGISTERED' | 'EXECUTION_REGISTRY_VALIDATOR_INVALID' | 'RUN_EXECUTION_INTEGRITY'
    | 'WORK_INPUT_REQUIRED' | 'WORK_INPUT_TEMPLATE_REQUIRED' | 'WORKER_INACTIVITY_POLICY_INVALID') { super(code); this.name = 'ExecutionRegistryError'; }
}

/** Stored selections must remain an exact, verifiable record of the Run graph at admission. */
export function assertRunExecution(graphInput: unknown, executionInput: unknown): RunExecutionSnapshot {
  const graph: TaskGraph = validateTaskGraph(graphInput); const execution = runExecutionSnapshotSchema.parse(executionInput);
  const invalid = () => { throw new ExecutionRegistryError('RUN_EXECUTION_INTEGRITY'); };
  if (execution.tasks.length !== graph.tasks.length || execution.criteria.length !== graph.criterionDefinitions.length) invalid();
  const selectedTasks = new Set(execution.tasks.map(entry => entry.taskId));
  const selectedCriteria = new Set(execution.criteria.map(entry => entry.criterionId));
  if (selectedTasks.size !== execution.tasks.length || selectedCriteria.size !== execution.criteria.length) invalid();
  const profiles = execution.workClassProfiles ?? [];
  if (new Set(profiles.map(row => JSON.stringify([row.workClass, row.policyRevision, row.profileVersion]))).size !== profiles.length) invalid();
  for (const task of graph.tasks) {
    if (!selectedTasks.has(task.id)) invalid();
    const entry = execution.tasks.find(row => row.taskId === task.id)!;
    if (!entry.acceptance) continue;
    const frozen = profiles.find(row => row.workClass === entry.acceptance!.workClass && row.policyRevision === entry.acceptance!.policyRevision && row.profileVersion === entry.acceptance!.profileVersion);
    if (!frozen) invalid();
    try { assertAcceptanceCriteria(entry.acceptance, frozen!, task, graph.criterionDefinitions); } catch { invalid(); }
    const effort = readWorkerModelPin(entry.profile.parameters)?.reasoningEffort;
    if (effort?.workClass && (effort.workClass !== entry.acceptance.workClass || effort.policyRevision !== entry.acceptance.policyRevision)) invalid();
  }
  if (profiles.some(row => !execution.tasks.some(task => task.acceptance?.workClass === row.workClass && task.acceptance.policyRevision === row.policyRevision && task.acceptance.profileVersion === row.profileVersion))) invalid();
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
  const workClassProfiles: FrozenWorkClassProfile[] = [];
  const tasks = graph.tasks.map(task => {
    const kind = registry.kinds.find(entry => entry.kind === task.kind);
    if (!kind) throw new ExecutionRegistryError('TASK_KIND_NOT_REGISTERED');
    const selected = registry.profiles.find(entry => entry.id === kind.profile.id && entry.version === kind.profile.version)!;
    // K3 pairing (decided here, before any validator): a template kind needs a work input and a work input needs a template kind.
    const template = validation.isTemplate?.(selected) === true;
    if (template !== (task.workInput !== undefined)) throw new ExecutionRegistryError(template ? 'WORK_INPUT_REQUIRED' : 'WORK_INPUT_TEMPLATE_REQUIRED');
    const profile = template ? executionProfileDefinitionSchema.parse(validation.compile!(selected, task.workInput!, task.kind, task.id)) : validation.prepareProfile?.(selected, task.kind, task.id) ?? selected;
    // The compiled profile keeps its template's registry identity (provenance) and must itself pass every installed profile check.
    if (profile.id !== selected.id || profile.version !== selected.version || (template && validation.isTemplate!(profile))
      || validation.profile(profile) !== undefined) throw new ExecutionRegistryError('EXECUTION_REGISTRY_VALIDATOR_INVALID');
    // EXEC-RELEASE C2 (owner B): the kind's explicit no-workspace-delivery declaration is frozen with the Run, only when present.
    const acceptance = freezeTaskAcceptance(task, graph.criterionDefinitions, registry.workClasses);
    if (acceptance && !workClassProfiles.some(row => row.workClass === acceptance.frozen.workClass && row.policyRevision === acceptance.frozen.policyRevision && row.profileVersion === acceptance.frozen.profileVersion)) workClassProfiles.push(acceptance.frozen);
    const stall = freezeSilencePolicy(task, profile, registry.workClasses, validation.silence);
    return Object.freeze({ taskId: task.id, profile, ...(acceptance ? { acceptance: acceptance.reference } : {}), ...(kind.workspaceDelivery ? { workspaceDelivery: kind.workspaceDelivery } : {}), ...(stall ? { stall } : {}) });
  });
  const criteria = graph.criterionDefinitions.map(criterion => {
    const evaluator = registry.evaluators.find(entry => entry.id === criterion.evaluator.id && entry.version === criterion.evaluator.version);
    if (!evaluator) throw new ExecutionRegistryError('TASK_EVALUATOR_NOT_REGISTERED');
    if (validation.criterion(evaluator, criterion) !== undefined) throw new ExecutionRegistryError('EXECUTION_REGISTRY_VALIDATOR_INVALID');
    return Object.freeze({ criterionId: criterion.id, evaluator, fingerprint: createHash('sha256').update(encodeCriterionDefinition(criterion), 'utf8').digest('hex') });
  });
  return assertRunExecution(graph, { schemaVersion: 1 as const, registryRevision: registry.revision,
    ...(workClassProfiles.length ? { workClassProfiles } : {}), tasks: Object.freeze(tasks), criteria: Object.freeze(criteria) });
}
/** R3: a watchable task freezes its work class's silence policy (an explicit class policy that cannot stop before the deadline is refused) or
 * the installation default, which simply does not apply to a profile whose deadline comes first: that task keeps the deadline bound alone. */
function freezeSilencePolicy(task: TaskGraph['tasks'][number], profile: ExecutionProfileDefinition, classes: Parameters<typeof resolveTaskWorkClass>[2], silence: ExecutionRegistryValidation['silence']) {
  const deadline = silence?.deadline(profile) ?? null;
  if (!silence || deadline === null) return undefined;
  const workClass = resolveTaskWorkClass(task.kind, task.workClass ?? task.workInput?.workClass, classes).workClass;
  const override = workClass && 'inactivity' in workClass ? workClass.inactivity : undefined;
  const policy = { ...silence.policy, ...override };
  if (policy.stopAfterMs < deadline) return policy;
  if (override) throw new ExecutionRegistryError('WORKER_INACTIVITY_POLICY_INVALID');
  return undefined;
}
