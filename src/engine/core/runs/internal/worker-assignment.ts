import { createHash } from 'node:crypto';
import { canonicalModelMaker, catalogDefaultEffort, catalogPinModelEvidence, eligibleRoleModels, isCandidateSelector, MODEL_TIERS, resolveTaskWorkClass, resolveWorkClassCandidates, roleModelKey, WORK_CLASS_LIMITS,
  WORK_CLASS_WORKER_ROLE, WorkerEffortError, type CandidateSelector, type CatalogModel, type CatalogPinModelEvidence, type ExecutionProfileDefinition, type ModelRolePolicy, type ReasoningEffort,
  type WorkClassRegistry, type WorkInput, type WorkerAssignment, type WorkerAssignmentSkip } from '#domain/index.js';
import { admitWorkerModels, WorkerModelAdmissionError, type ModelCatalogReader } from '#engine/core/model-activation/index.js';
/** The admission facts a system assignment reads: the Run's scope (activation is per scope), admission time, the image-refresh caveat and
 * (M3) the composed tier/role registry (Core seed + the installation's `model_roles` overlays) that candidate roles and selectors read. */
export interface WorkerAssignmentContext { readonly scopeId: string; readonly nowMs: number; readonly imageRefreshInProgress?: boolean; readonly roles: ModelRolePolicy }
/** A chosen candidate before effort selection; `seal` lacks only the effort level, which the one effort owner (selectWorkerEffort) decides. */
export type PendingWorkerAssignment = Readonly<{ input: WorkInput; model: CatalogModel; target: ReasoningEffort | null;
  seal: DistributiveOmit<WorkerAssignment, 'effort'> & Readonly<{ effortSource: WorkerAssignment['effort']['source'] }> }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** M3 skip reason: an exact candidate whose (channel, model) does not hold the worker role in the tier/role registry (fail-closed). */
const ROLE_REFUSED = 'WORKER_MODEL_ROLE_REFUSED';
type Tried = Readonly<{ index: number; channelId: string; modelId: string; effort: ReasoningEffort | undefined;
  selector?: Readonly<{ roleRevision: string; expanded: number; position: number; expansionDigest: string }> }>;
const tierRank = (tier: typeof MODEL_TIERS[number]) => MODEL_TIERS.indexOf(tier);
const skippedText = (skipped: readonly WorkerAssignmentSkip[]) => skipped.map(row => `${row.channelId}/${row.modelId}: ${row.reason}`).join('; ');
/**
 * ATAMA-1 (owner ASS1, A5): the system — never the Brain — picks the worker of a task whose work input leaves the model open. The task's
 * WorkClass names one ordered candidate list; each candidate is tried in order through the SAME admission check a pinned model gets (catalog
 * row, lifecycle, alias, scope activation of channel and model, channel/CLI match, CLI floor, session-start evidence), compiled onto the
 * task's template so the CLI identity comes from the template, not from this code. The first admissible candidate is chosen; every earlier
 * one is kept with its typed refusal. No admissible candidate is one typed refusal naming them all: nothing outside the list is ever chosen,
 * and nothing is retried later. Reads only; the caller freezes the result into the Run.
 * M3 (model independence): every candidate must hold the worker role in the tier/role registry, an exact one included (a list can no longer
 * name a model the registry has not admitted as a worker). A selector entry is expanded when it is reached, in registry order, to the worker
 * models holding its role that pass its tier/maker/channel filters, are in the scope's catalog and active there; models already tried are
 * not tried twice, and a list whose expansions exceed the registry bound is a typed refusal, never a truncation.
 */
export async function assignTaskWorker(task: Readonly<{ id: string; kind: string; workClass?: string | undefined }>, input: WorkInput,
  template: ExecutionProfileDefinition, registry: WorkClassRegistry | undefined, reader: ModelCatalogReader,
  compile: (template: ExecutionProfileDefinition, input: WorkInput, evidence?: CatalogPinModelEvidence) => ExecutionProfileDefinition,
  context: WorkerAssignmentContext): Promise<PendingWorkerAssignment> {
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
  const skipped: WorkerAssignmentSkip[] = [], tried = new Set<string>(), today = new Date(context.nowMs).toISOString().slice(0, 10);
  // Permission for the tier/role registry is the scope's registered-catalog activation (the one worker admission enforces), never the
  // declared invocation catalog. Only measured rows can drop a dated exception, so only they are read before a row list is taken.
  const active = async (channelId: string, modelId: string) => (await reader.activation(context.scopeId, channelId, modelId))?.state === 'active';
  // Reads stay bounded by channels and roles, not rows: one catalog read per channel and one measured-row pass per role per assignment.
  const channelRows = new Map<string, Awaited<ReturnType<ModelCatalogReader['models']>>>(), roleFacts = new Map<string, { today: string; active: ReadonlySet<string> }>();
  const rowsOf = async (channelId: string) => { let rows = channelRows.get(channelId); if (!rows) channelRows.set(channelId, rows = await reader.models(channelId)); return rows; };
  const facts = async (roleId: string) => { if (roleFacts.has(roleId)) return roleFacts.get(roleId)!; const measured = new Set<string>();
    for (const row of context.roles.models) if (row.measured !== undefined && row.roles.includes(roleId) && await active(row.channelId, row.modelId)) measured.add(roleModelKey(row));
    roleFacts.set(roleId, { today, active: measured }); return roleFacts.get(roleId)!; };
  let workers: ReadonlySet<string> | undefined, expandedTotal = 0, sawSelector = false;
  const workerKeys = async () => workers ??= new Set(eligibleRoleModels(context.roles, WORK_CLASS_WORKER_ROLE, await facts(WORK_CLASS_WORKER_ROLE)).map(roleModelKey));
  const expand = async (index: number, selector: CandidateSelector): Promise<readonly Tried[]> => {
    // An unregistered role is the registry's typed refusal (MODEL_ROLE_NOT_REGISTERED), never an empty silent list.
    const rows = eligibleRoleModels(context.roles, selector.role, await facts(selector.role)), allowed = await workerKeys(), found: { channelId: string; modelId: string }[] = [];
    for (const row of rows) {
      const key = roleModelKey(row);
      if (tried.has(key) || !allowed.has(key) || (selector.channelIn !== undefined && !selector.channelIn.includes(row.channelId))) continue;
      if ((selector.minTier !== undefined || selector.maxTier !== undefined) && (row.tier === null
        || (selector.minTier !== undefined && tierRank(row.tier) < tierRank(selector.minTier)) || (selector.maxTier !== undefined && tierRank(row.tier) > tierRank(selector.maxTier)))) continue;
      const entry = (await rowsOf(row.channelId)).find(model => model.modelId === row.modelId), maker = entry ? canonicalModelMaker(entry.model) : null;
      if (!entry) continue;
      if (selector.makerIn !== undefined && (maker === null || !selector.makerIn.includes(maker))) continue;
      if (selector.makerNotIn !== undefined && (maker === null || selector.makerNotIn.includes(maker))) continue;
      if (!await active(row.channelId, row.modelId)) continue;
      found.push({ channelId: row.channelId, modelId: row.modelId });
    }
    expandedTotal += found.length;
    if (expandedTotal > WORK_CLASS_LIMITS.expandedCandidatesPerPolicy) throw new WorkerModelAdmissionError('WORKER_ASSIGNMENT_EXPANSION_LIMIT', { taskId: task.id, channelId: null, modelId: null, workClass: workClass.id });
    const expansionDigest = createHash('sha256').update(JSON.stringify([selector, context.roles.revision, found.map(row => [row.channelId, row.modelId])]), 'utf8').digest('hex');
    return found.map((row, position) => ({ index, ...row, effort: selector.effort, selector: { roleRevision: context.roles.revision, expanded: found.length, position, expansionDigest } }));
  };
  for (const [index, declared] of list.candidates.entries()) {
    if (isCandidateSelector(declared)) sawSelector = true;
    const targets: readonly Tried[] = isCandidateSelector(declared) ? await expand(index, declared)
      : tried.has(roleModelKey(declared)) ? [] : [{ index, channelId: declared.channelId, modelId: declared.modelId, effort: declared.effort }];
    for (const candidate of targets) {
      tried.add(roleModelKey(candidate));
      if (!candidate.selector && !(await workerKeys()).has(roleModelKey(candidate))) {
        skipped.push(Object.freeze({ index, channelId: candidate.channelId, modelId: candidate.modelId, reason: ROLE_REFUSED })); continue;
      }
      const chosen: WorkInput = { ...input, model: { channelId: candidate.channelId, modelId: candidate.modelId, auxiliaryModelIds: [] } };
      // The candidate's pin carries the catalog's session-start names exactly as a pinned model's does (owner K1/K2), or admission refuses it.
      const profile = compile(template, chosen, catalogPinModelEvidence((await rowsOf(candidate.channelId)).map(row => row.model), candidate.modelId));
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
      const common = { workClass: workClass.id, workClassRevision: policy.revision,
        candidatePolicy: Object.freeze({ id: list.id, version: list.version }), candidateIndex: index, channelId: candidate.channelId, modelId: candidate.modelId,
        catalogRevision: entry.catalogRevision, modelRevision: entry.revision, activationRevision: activation.revision,
        effortSource: candidate.effort !== undefined ? 'candidate' as const : vendor !== null ? 'catalog' as const : 'cli-default' as const, skipped: Object.freeze(skipped) };
      // A choice that never met a selector keeps the v1 seal (alpha.54 reads it); one reached through or after a selector is v2 with its expansion.
      const seal = !sawSelector ? { schemaVersion: 1 as const, ...common }
        : { schemaVersion: 2 as const, ...common, ...(candidate.selector ? { selector: Object.freeze({ ...candidate.selector }) } : {}) };
      return Object.freeze({ input: chosen, model: entry.model, target, seal: Object.freeze(seal) });
    }
  }
  return refuse('WORKER_ASSIGNMENT_NONE', workClass.id, skipped);
}
