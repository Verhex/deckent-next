import { catalogDefaultEffort, resolveTaskWorkClass, resolveWorkClassCandidates, WorkerEffortError, type CatalogModel, type ExecutionProfileDefinition, type ReasoningEffort,
  type WorkClassRegistry, type WorkInput, type WorkerAssignment, type WorkerAssignmentSkip } from '#domain/index.js';
import { admitWorkerModels, WorkerModelAdmissionError, type ModelCatalogReader } from '#engine/core/model-activation/index.js';
/** The admission facts a system assignment reads: the Run's scope (activation is per scope), admission time and the image-refresh caveat. */
export interface WorkerAssignmentContext { readonly scopeId: string; readonly nowMs: number; readonly imageRefreshInProgress?: boolean }
/** A chosen candidate before effort selection; `seal` lacks only the effort level, which the one effort owner (selectWorkerEffort) decides. */
export type PendingWorkerAssignment = Readonly<{ input: WorkInput; model: CatalogModel; target: ReasoningEffort | null;
  seal: Omit<WorkerAssignment, 'effort'> & Readonly<{ effortSource: WorkerAssignment['effort']['source'] }> }>;
const skippedText = (skipped: readonly WorkerAssignmentSkip[]) => skipped.map(row => `${row.channelId}/${row.modelId}: ${row.reason}`).join('; ');
/**
 * ATAMA-1 (owner ASS1, A5): the system — never the Brain — picks the worker of a task whose work input leaves the model open. The task's
 * WorkClass names one ordered candidate list; each candidate is tried in order through the SAME admission check a pinned model gets (catalog
 * row, lifecycle, alias, scope activation of channel and model, channel/CLI match, CLI floor, session-start evidence), compiled onto the
 * task's template so the CLI identity comes from the template, not from this code. The first admissible candidate is chosen; every earlier
 * one is kept with its typed refusal. No admissible candidate is one typed refusal naming them all: nothing outside the list is ever chosen,
 * and nothing is retried later. Reads only; the caller freezes the result into the Run.
 */
export async function assignTaskWorker(task: Readonly<{ id: string; kind: string; workClass?: string | undefined }>, input: WorkInput,
  template: ExecutionProfileDefinition, registry: WorkClassRegistry | undefined, reader: ModelCatalogReader,
  compile: (template: ExecutionProfileDefinition, input: WorkInput) => ExecutionProfileDefinition, context: WorkerAssignmentContext): Promise<PendingWorkerAssignment> {
  const refuse = (code: 'WORKER_ASSIGNMENT_NO_CANDIDATES' | 'WORKER_ASSIGNMENT_NONE', workClass: string | null, skipped: readonly WorkerAssignmentSkip[] = []): never => {
    throw new WorkerModelAdmissionError(code, Object.freeze({ taskId: task.id, channelId: null, modelId: null, workClass: workClass ?? '-', skipped: skippedText(skipped) || '-' }));
  };
  let resolved;
  try { resolved = resolveTaskWorkClass(task.kind, task.workClass ?? input.workClass, registry); }
  catch (error) { if (error instanceof WorkerEffortError) throw new WorkerModelAdmissionError(error.code, { taskId: task.id, channelId: null, modelId: null }); throw error; }
  const { policy, workClass } = resolved;
  if (!workClass) return refuse('WORKER_ASSIGNMENT_NO_CANDIDATES', null);
  const list = resolveWorkClassCandidates(policy, workClass);
  if (!list) return refuse('WORKER_ASSIGNMENT_NO_CANDIDATES', workClass.id);
  const skipped: WorkerAssignmentSkip[] = [];
  for (const [index, candidate] of list.candidates.entries()) {
    const chosen: WorkInput = { ...input, model: { channelId: candidate.channelId, modelId: candidate.modelId, auxiliaryModelIds: [] } };
    const profile = compile(template, chosen);
    try { await admitWorkerModels([{ taskId: task.id, profile }], context.scopeId, reader, context.nowMs, [], { imageRefreshInProgress: context.imageRefreshInProgress === true }); }
    catch (error) {
      if (!(error instanceof WorkerModelAdmissionError)) throw error;
      skipped.push(Object.freeze({ index, channelId: candidate.channelId, modelId: candidate.modelId, reason: error.code })); continue;
    }
    const entry = (await reader.models(candidate.channelId)).find(row => row.modelId === candidate.modelId);
    const activation = await reader.activation(context.scopeId, candidate.channelId, candidate.modelId);
    // The admission check above read the same rows; a row gone in between is an unknown state, never a silent next candidate.
    if (!entry || activation?.state !== 'active') throw new WorkerModelAdmissionError('WORKER_MODEL_NOT_ACTIVE', { taskId: task.id, channelId: candidate.channelId, modelId: candidate.modelId });
    const vendor = catalogDefaultEffort(entry.model), target = candidate.effort ?? vendor;
    return Object.freeze({ input: chosen, model: entry.model, target, seal: Object.freeze({ schemaVersion: 1 as const, workClass: workClass.id, workClassRevision: policy.revision,
      candidatePolicy: Object.freeze({ id: list.id, version: list.version }), candidateIndex: index, channelId: candidate.channelId, modelId: candidate.modelId,
      catalogRevision: entry.catalogRevision, modelRevision: entry.revision, activationRevision: activation.revision,
      effortSource: candidate.effort !== undefined ? 'candidate' as const : vendor !== null ? 'catalog' as const : 'cli-default' as const, skipped: Object.freeze(skipped) }) });
  }
  return refuse('WORKER_ASSIGNMENT_NONE', workClass.id, skipped);
}
