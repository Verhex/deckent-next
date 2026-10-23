import { executionRegistrySchema, readWorkerModelPin, selectWorkerEffort, validateTaskGraph, WorkerEffortError, catalogPinModelEvidence, workerAssignmentSchema,
  type CatalogModel, type CatalogPinModelEvidence, type ExecutionProfileDefinition, type WorkInput, type WorkerAssignment, type WorkerEffort } from '#domain/index.js';
import { WorkerModelAdmissionError, type ModelCatalogReader } from '#engine/core/model-activation/index.js';
import { resolveExecutionRegistry, type ExecutionRegistryValidation } from './registry.js';
import { assignTaskWorker, type PendingWorkerAssignment, type WorkerAssignmentContext } from './worker-assignment.js';
export interface WorkerEffortCompiler {
  capability(profile: ExecutionProfileDefinition): Readonly<{ mode: 'arguments' | 'model-id'; levels: readonly string[] }> | null;
  /** `evidence`: the catalog's session-start names / provider-choice flag for the pinned model, frozen into the profile pin (owner K1/K2). */
  compile(template: ExecutionProfileDefinition, input: WorkInput, effort?: WorkerEffort, evidence?: CatalogPinModelEvidence): ExecutionProfileDefinition;
  bind(profile: ExecutionProfileDefinition, effort: WorkerEffort, evidence?: CatalogPinModelEvidence): ExecutionProfileDefinition;
}
/** Read-only preparation inside new-Run admission. The application chooses once; adapters own transport, the Run owns its frozen profile.
 * Replay exits before this path. Unknown pins remain for ordinary model admission to refuse; no alias/model is substituted.
 * ATAMA-1: a template task whose work input leaves the model open gets its worker from the WorkClass candidate list (assignTaskWorker);
 * without an assignment context such a task is a typed refusal, never a default model. */
export async function prepareWorkerEffortAdmission(graphInput: unknown, registryInput: unknown, reader: ModelCatalogReader,
  compiler: WorkerEffortCompiler, context?: WorkerAssignmentContext): Promise<Pick<ExecutionRegistryValidation, 'compile' | 'prepareProfile' | 'assignment'>> {
  const graph = validateTaskGraph(graphInput), registry = executionRegistrySchema.parse(registryInput);
  const models = new Map<string, CatalogModel>(), evidence = new Map<string, CatalogPinModelEvidence>();
  const key = (pin: { channelId: string; modelId: string }) => JSON.stringify([pin.channelId, pin.modelId]);
  const definition = (kind: string) => { const reference = registry.kinds.find(row => row.kind === kind)?.profile;
    return registry.profiles.find(row => row.id === reference?.id && row.version === reference.version); };
  const assigned = new Map<string, PendingWorkerAssignment>(), sealed = new Map<string, WorkerAssignment>();
  for (const task of graph.tasks) {
    const template = definition(task.kind);
    if (task.workInput && !task.workInput.model && template) {
      if (!context) throw new WorkerModelAdmissionError('WORKER_ASSIGNMENT_NO_CANDIDATES', { taskId: task.id, channelId: null, modelId: null });
      assigned.set(task.id, await assignTaskWorker(task, task.workInput, template, registry.workClasses, reader, (value, input) => compiler.compile(value, input), context));
    }
    const pin = assigned.get(task.id)?.input.model ?? task.workInput?.model ?? readWorkerModelPin(template?.parameters)?.pin;
    if (!pin || models.has(key(pin))) continue;
    const rows = await reader.models(pin.channelId), entry = rows.find(row => row.modelId === pin.modelId);
    if (entry) { models.set(key(pin), entry.model); evidence.set(key(pin), catalogPinModelEvidence(rows.map(row => row.model), pin.modelId)); }
  }
  const select = (profile: ExecutionProfileDefinition, kind: string, taskId: string, pin: { channelId: string; modelId: string }, input?: WorkInput): WorkerEffort | undefined => {
    const model = models.get(key(pin)); if (!model) return undefined;
    const prepared = input ? undefined : readWorkerModelPin(profile.parameters)?.reasoningEffort, pending = assigned.get(taskId);
    try { return selectWorkerEffort({ model, capability: compiler.capability(profile), kind, workClass: graph.tasks.find(task => task.id === taskId)?.workClass ?? input?.workClass,
      explicit: input?.effort ?? (prepared?.source === 'explicit' ? prepared.level ?? undefined : undefined), policy: registry.workClasses,
      ...(pending ? { assigned: { target: pending.target } } : {}) }); }
    catch (error) {
      if (!(error instanceof WorkerEffortError)) throw error;
      throw new WorkerModelAdmissionError(error.code, { taskId,
        channelId: pin.channelId, modelId: pin.modelId });
    }
  };
  return {
    compile(template, input, kind, taskId) {
      const pending = assigned.get(taskId), chosen = pending?.input ?? input;
      if (!chosen.model) throw new WorkerModelAdmissionError('WORKER_ASSIGNMENT_NO_CANDIDATES', { taskId, channelId: null, modelId: null });
      const effort = select(template, kind, taskId, chosen.model, chosen), profile = compiler.compile(template, chosen, effort, evidence.get(key(chosen.model)));
      if (pending) { const { effortSource, ...seal } = pending.seal;
        sealed.set(taskId, workerAssignmentSchema.parse({ ...seal, effort: { level: readWorkerModelPin(profile.parameters)?.reasoningEffort?.level ?? null, source: effortSource } })); }
      return profile;
    },
    prepareProfile(profile, kind, taskId) { const pinned = readWorkerModelPin(profile.parameters); if (!pinned) return profile;
      const effort = select(profile, kind, taskId, pinned.pin); return effort ? compiler.bind(profile, effort, evidence.get(key(pinned.pin))) : profile; },
    assignment(taskId) { return sealed.get(taskId); },
  };
}

/** Resolve compiler + policy through the same application-owned registry admission; no new execution flow. */
export async function resolveWorkerEffortExecution(graph: unknown, registry: unknown, reader: ModelCatalogReader,
  validation: ExecutionRegistryValidation, compiler: WorkerEffortCompiler, context?: WorkerAssignmentContext) {
  return resolveExecutionRegistry(graph, registry, { ...validation, ...await prepareWorkerEffortAdmission(graph, registry, reader, compiler, context) });
}
