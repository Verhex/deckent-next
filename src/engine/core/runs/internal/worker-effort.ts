import { executionRegistrySchema, readWorkerModelPin, selectWorkerEffort, validateTaskGraph, WorkerEffortError,
  type CatalogModel, type ExecutionProfileDefinition, type WorkInput, type WorkerEffort } from '#domain/index.js';
import { WorkerModelAdmissionError, type ModelCatalogReader } from '#engine/core/model-activation/index.js';
import { resolveExecutionRegistry, type ExecutionRegistryValidation } from './registry.js';
export interface WorkerEffortCompiler {
  capability(profile: ExecutionProfileDefinition): Readonly<{ mode: 'arguments' | 'model-id'; levels: readonly string[] }> | null;
  compile(template: ExecutionProfileDefinition, input: WorkInput, effort?: WorkerEffort): ExecutionProfileDefinition;
  bind(profile: ExecutionProfileDefinition, effort: WorkerEffort): ExecutionProfileDefinition;
}
/** Read-only preparation inside new-Run admission. The application chooses once; adapters own transport, the Run owns its frozen profile.
 * Replay exits before this path. Unknown pins remain for ordinary model admission to refuse; no alias/model is substituted. */
export async function prepareWorkerEffortAdmission(graphInput: unknown, registryInput: unknown, reader: Pick<ModelCatalogReader, 'models'>,
  compiler: WorkerEffortCompiler): Promise<Pick<ExecutionRegistryValidation, 'compile' | 'prepareProfile'>> {
  const graph = validateTaskGraph(graphInput), registry = executionRegistrySchema.parse(registryInput);
  const models = new Map<string, CatalogModel>();
  const key = (pin: { channelId: string; modelId: string }) => JSON.stringify([pin.channelId, pin.modelId]);
  const definition = (kind: string) => { const reference = registry.kinds.find(row => row.kind === kind)?.profile;
    return registry.profiles.find(row => row.id === reference?.id && row.version === reference.version); };
  for (const task of graph.tasks) {
    const pin = task.workInput?.model ?? readWorkerModelPin(definition(task.kind)?.parameters)?.pin;
    if (!pin || models.has(key(pin))) continue;
    const entry = (await reader.models(pin.channelId)).find(row => row.modelId === pin.modelId);
    if (entry) models.set(key(pin), entry.model);
  }
  const select = (profile: ExecutionProfileDefinition, kind: string, taskId: string, pin: { channelId: string; modelId: string }, input?: WorkInput): WorkerEffort | undefined => {
    const model = models.get(key(pin)); if (!model) return undefined;
    const prepared = input ? undefined : readWorkerModelPin(profile.parameters)?.reasoningEffort;
    try { return selectWorkerEffort({ model, capability: compiler.capability(profile), kind, workClass: input?.workClass,
      explicit: input?.effort ?? (prepared?.source === 'explicit' ? prepared.level ?? undefined : undefined), policy: registry.workClasses }); }
    catch (error) {
      if (!(error instanceof WorkerEffortError)) throw error;
      throw new WorkerModelAdmissionError(error.code, { taskId,
        channelId: pin.channelId, modelId: pin.modelId });
    }
  };
  return {
    compile(template, input, kind, taskId) { return compiler.compile(template, input, select(template, kind, taskId, input.model, input)); },
    prepareProfile(profile, kind, taskId) { const pinned = readWorkerModelPin(profile.parameters); if (!pinned) return profile;
      const effort = select(profile, kind, taskId, pinned.pin); return effort ? compiler.bind(profile, effort) : profile; },
  };
}

/** Resolve compiler + policy through the same application-owned registry admission; no new execution flow. */
export async function resolveWorkerEffortExecution(graph: unknown, registry: unknown, reader: Pick<ModelCatalogReader, 'models'>,
  validation: ExecutionRegistryValidation, compiler: WorkerEffortCompiler) {
  return resolveExecutionRegistry(graph, registry, { ...validation, ...await prepareWorkerEffortAdmission(graph, registry, reader, compiler) });
}
