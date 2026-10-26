import { z } from 'zod';
import { workerEffortSchema, workerModelPinEvidenceShape, catalogPinModelEvidence, eligibleRoleModels, roleModelKey, type ModelCatalogModelRecord, type ModelRolePolicy } from '#domain/index.js';
import { compareToolchainVersions, extractToolchainVersion } from '#engine/core/toolchain-currency/index.js';
import type { ModelCatalogReader } from './catalog.js';

/**
 * New-Run worker model admission (WORKER-CURRENCY-1, owner 2026-09-30): a native coding task is admitted only when its profile pins an
 * exact model of an active catalog channel matching the profile's CLI, the model (and each declared auxiliary model) is registered,
 * current (lifecycle active, not past its retirement day), active in the Run's scope, and the profile's pinned CLI version — the one the
 * container preflight enforces against the image before any work — meets the model's minimum. No alias is resolved, no model substituted.
 * Profiles without `nativeSubscription` are not worker-model profiles and pass untouched. Replays of admitted Runs never reach this check.
 */
export type WorkerModelAdmissionCode = 'WORKER_MODEL_UNPINNED' | 'WORKER_MODEL_ALIAS_REFUSED' | 'WORKER_CHANNEL_NOT_ACTIVE'
  | 'WORKER_CHANNEL_MISMATCH' | 'WORKER_MODEL_UNKNOWN' | 'WORKER_MODEL_RETIRED' | 'WORKER_MODEL_NOT_CURRENT' | 'WORKER_MODEL_NOT_ACTIVE'
  | 'WORKER_MODEL_CLI_TOO_OLD' | 'WORKER_MODEL_BINDING_MISMATCH' | 'WORKER_EFFORT_UNSUPPORTED' | 'WORK_CLASS_NOT_REGISTERED'
  | 'WORKER_ASSIGNMENT_NO_CANDIDATES' | 'WORKER_ASSIGNMENT_NONE' | 'WORKER_ASSIGNMENT_EXPANSION_LIMIT';
export interface WorkerModelAdmissionDetail {
  readonly taskId: string; readonly channelId: string | null; readonly modelId: string | null;
  readonly exactModelId?: string; readonly minCliVersion?: string; readonly cliVersion?: string | null;
  /** ATAMA-1 refusals: the WorkClass whose candidate list was read and each skipped candidate with its typed reason (bounded by the list). */
  readonly workClass?: string; readonly skipped?: string; readonly skippedMore?: number;
}
/** Admission that passes with a visible caveat (WORKER-AUTO-REFRESH, owner K2): the pinned worker CLI is older than the model's minimum while
 * a worker image refresh is in flight, so the Run is admitted on the newest image it can use today. Never raised when no refresh runs. */
export interface WorkerImageRefreshingWarning {
  readonly code: 'WORKER_IMAGE_REFRESHING'; readonly taskId: string; readonly modelId: string; readonly minCliVersion: string; readonly cliVersion: string | null;
}
/** DECKENT-MD-WORKERS: the project's selected worker instruction file was left out of the compiled prompts, with its reason. */
export interface WorkerInstructionsWithheldWarning {
  readonly code: 'WORKER_INSTRUCTIONS_WITHHELD'; readonly source: string; readonly reason: 'absent' | 'untrusted' | 'unsafe' | 'unreadable'; readonly digest: string | null;
}
/** S4B-5 (§7.3): memory left out of one task's worker prompt, the Run admitted without it. `policy`: the admitting principal may not inspect the
 * scope's memory; `sources`: `count` eligible entries come from work it may not read (a count only); `budget`: the prompt had no room for the part;
 * `contests`: more contests are open than one bounded read shows. */
export interface MemoryContextWithheldWarning {
  readonly code: 'MEMORY_CONTEXT_WITHHELD'; readonly taskId: string | null; readonly reason: 'policy' | 'sources' | 'budget' | 'contests'; readonly count: number;
}
export type WorkerAdmissionWarning = WorkerImageRefreshingWarning | WorkerInstructionsWithheldWarning | MemoryContextWithheldWarning;
export type WorkerAdmissionOptions = Readonly<{ imageRefreshInProgress?: boolean }>;
export class WorkerModelAdmissionError extends Error {
  constructor(readonly code: WorkerModelAdmissionCode, readonly detail: WorkerModelAdmissionDetail) { super(code); this.name = 'WorkerModelAdmissionError'; }
}
const pinned = z.object({ channelId: z.string(), modelId: z.string(), auxiliaryModelIds: z.array(z.string()).readonly(), ...workerModelPinEvidenceShape }).strict();
const subscriptionSchema = z.object({ schemaVersion: z.number(), provider: z.enum(['claude', 'codex', 'cursor']),
  reasoningEffort: workerEffortSchema.optional(), effortMode: z.enum(['arguments', 'model-id']).nullable().optional(),
  preflight: z.object({ cliVersion: z.string() }).passthrough().optional(), model: pinned.optional() }).passthrough();
const taskSchema = z.object({ taskId: z.string(), profile: z.object({ parameters: z.object({ nativeSubscription: z.unknown().optional() }).passthrough() }).passthrough() }).passthrough();
const today = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);
/** Retired by the catalog's lifecycle data: its state, or its recorded retirement day has come (worker admission and the activation cascade share it). */
export const catalogModelRetired = (lifecycle: Pick<ModelCatalogModelRecord['model']['lifecycle'], 'state' | 'retiredOn'>, nowMs: number) =>
  lifecycle.state === 'retired' || (lifecycle.retiredOn !== null && lifecycle.retiredOn <= today(nowMs));

async function checkModel(reader: ModelCatalogReader, scopeId: string, taskId: string, provider: string, cliVersion: string | null,
  channelId: string, modelId: string, nowMs: number, warnings?: WorkerAdmissionWarning[]): Promise<ModelCatalogModelRecord> {
  const refuse = (code: WorkerModelAdmissionCode, extra: Partial<WorkerModelAdmissionDetail> = {}): never => {
    throw new WorkerModelAdmissionError(code, Object.freeze({ taskId, channelId, modelId, ...extra }));
  };
  const channel = await reader.channel(channelId), models = channel ? await reader.models(channelId) : [];
  const aliased = models.find(entry => entry.model.aliases.includes(modelId));
  if (channel?.channel.aliases.includes(modelId) || aliased) refuse('WORKER_MODEL_ALIAS_REFUSED', aliased ? { exactModelId: aliased.modelId } : {});
  if (!channel) return refuse('WORKER_CHANNEL_NOT_ACTIVE');
  if (channel.channel.kind !== 'native-cli' || channel.channel.cli !== provider) refuse('WORKER_CHANNEL_MISMATCH');
  const entry: ModelCatalogModelRecord | undefined = models.find(candidate => candidate.modelId === modelId);
  if (!entry) return refuse('WORKER_MODEL_UNKNOWN');
  const { lifecycle } = entry.model;
  if (catalogModelRetired(lifecycle, nowMs)) refuse('WORKER_MODEL_RETIRED');
  if (lifecycle.state !== 'active') refuse('WORKER_MODEL_NOT_CURRENT');
  if ((await reader.activation(scopeId, channelId, null))?.state !== 'active') refuse('WORKER_CHANNEL_NOT_ACTIVE');
  if ((await reader.activation(scopeId, channelId, modelId))?.state !== 'active') refuse('WORKER_MODEL_NOT_ACTIVE');
  if (entry.model.minCliVersion !== null) {
    const observed = cliVersion === null ? null : extractToolchainVersion(provider, cliVersion);
    if (observed === null || compareToolchainVersions(observed, entry.model.minCliVersion) < 0) {
      if (!warnings) refuse('WORKER_MODEL_CLI_TOO_OLD', { minCliVersion: entry.model.minCliVersion, cliVersion: observed });
      else warnings.push({ code: 'WORKER_IMAGE_REFRESHING', taskId, modelId, minCliVersion: entry.model.minCliVersion, cliVersion: observed });
    }
  }
  return entry;
}
/** K3 work input as recorded in the Run graph: the requested pin and optional effort of a task compiled from a template. */
export type WorkerTaskRequest = Readonly<{ id: string; workInput?: Readonly<{ model?: Readonly<{ channelId: string; modelId: string; auxiliaryModelIds: readonly string[] }> | undefined; effort?: string | undefined }> | undefined }>;

/** The (channel, model) keys that hold the worker `role` (the WorkClass worker role id, registry data) in a scope today (tier/role registry; a dated exception counts only while its measured row is active).
 * The one gate for system assignment and for the Brain's worker-model list, so the two cannot disagree. */
export async function workerRoleKeys(roles: ModelRolePolicy, role: string, scopeId: string, reader: ModelCatalogReader, nowMs: number): Promise<ReadonlySet<string>> {
  const measured = new Set<string>();
  for (const row of roles.models) if (row.measured !== undefined && row.roles.includes(role) && (await reader.activation(scopeId, row.channelId, row.modelId))?.state === 'active') measured.add(roleModelKey(row));
  return new Set(eligibleRoleModels(roles, role, { today: today(nowMs), active: measured }).map(roleModelKey));
}
export interface WorkerPlanningTemplate { readonly profile: { id: string; version: number }; readonly provider: string; readonly cliVersion: string }
/** Read-only planner choices share the admission check, including scope activation, lifecycle, alias and CLI floor, and the assignment's
 * `worker` role gate (`roles` is required: a model without the role is skipped, fail closed). */
export async function inspectAdmissibleWorkerModels(templates: readonly WorkerPlanningTemplate[], scopeId: string, reader: ModelCatalogReader,
  nowMs: number, options: WorkerAdmissionOptions & Readonly<{ roles: ModelRolePolicy; workerRole: string }>) {
  const choices = [], workers = await workerRoleKeys(options.roles, options.workerRole, scopeId, reader, nowMs);
  const channels = await reader.channels();
  for (const template of templates) {
    for (const channel of channels.filter(row => row.channel.kind === 'native-cli' && row.channel.cli === template.provider)) {
      const admitted: Readonly<{ record: ModelCatalogModelRecord; warnings: readonly WorkerAdmissionWarning[] }>[] = [];
      for (const row of await reader.models(channel.channelId)) {
        if (!workers.has(roleModelKey({ channelId: channel.channelId, modelId: row.modelId }))) continue;
        const warnings: WorkerAdmissionWarning[] = [];
        try {
          const record = await checkModel(reader, scopeId, template.profile.id, template.provider, template.cliVersion,
            channel.channelId, row.modelId, nowMs, options.imageRefreshInProgress ? warnings : undefined);
          admitted.push({ record, warnings });
        } catch (error) { if (!(error instanceof WorkerModelAdmissionError)) throw error; }
      }
      const ids = admitted.map(row => row.record.modelId).sort();
      for (const { record: row, warnings } of admitted) choices.push({ profile: template.profile, channelId: channel.channelId, modelId: row.modelId,
        auxiliaryModelIds: [] as readonly string[], availableAuxiliaryModelIds: ids,
        billing: 'billing' in channel.channel ? channel.channel.billing : null, efforts: row.model.efforts,
        ...(warnings.length ? { warnings } : {}) });
    }
  }
  return choices;
}

/** Throws the first typed refusal in task order; resolves (with any caveats) when every worker task may be admitted. Reads only, writes nothing.
 * `requests` (the Run graph tasks) add the K3 checks: a compiled pin must equal the requested one exactly, and a requested effort must be
 * one the catalog declares for the main model. The effort is recorded in the Run graph; the chosen CLI setting is frozen in the execution profile. */
export async function admitWorkerModels(tasksInput: readonly unknown[], scopeId: string, reader: ModelCatalogReader, nowMs: number,
  requests: readonly WorkerTaskRequest[] = [], options: WorkerAdmissionOptions = {}): Promise<readonly WorkerAdmissionWarning[]> {
  const warnings: WorkerAdmissionWarning[] = [];
  const requested = new Map(requests.map(task => [task.id, task.workInput]));
  for (const input of tasksInput) {
    const task = taskSchema.parse(input);
    const raw = task.profile.parameters.nativeSubscription;
    if (raw === undefined) continue;
    const subscription = subscriptionSchema.safeParse(raw);
    if (!subscription.success || !subscription.data.model) {
      throw new WorkerModelAdmissionError('WORKER_MODEL_UNPINNED', Object.freeze({ taskId: task.taskId, channelId: null, modelId: null }));
    }
    const { provider, preflight, model, reasoningEffort, effortMode } = subscription.data; const request = requested.get(task.taskId);
    const detail = Object.freeze({ taskId: task.taskId, channelId: model.channelId, modelId: model.modelId });
    // A work input without a model (v2) was assigned by the system; the frozen assignment seal is checked against the pin by the Run's integrity check.
    if (request?.model && JSON.stringify([request.model.channelId, request.model.modelId, request.model.auxiliaryModelIds])
      !== JSON.stringify([model.channelId, model.modelId, model.auxiliaryModelIds])) throw new WorkerModelAdmissionError('WORKER_MODEL_BINDING_MISMATCH', detail);
    for (const modelId of [model.modelId, ...model.auxiliaryModelIds]) {
      const entry = await checkModel(reader, scopeId, task.taskId, provider, preflight?.cliVersion ?? null, model.channelId, modelId, nowMs, options.imageRefreshInProgress ? warnings : undefined);
      if (modelId === model.modelId && ((request?.effort !== undefined && (!entry.model.efforts.includes(request.effort as never)
        || reasoningEffort?.source !== 'explicit' || reasoningEffort.level !== request.effort))
        || (reasoningEffort?.level != null && (!entry.model.efforts.includes(reasoningEffort.level)
          || (effortMode === 'model-id' && entry.model.effortBinding?.level !== reasoningEffort.level))))) {
        throw new WorkerModelAdmissionError('WORKER_EFFORT_UNSUPPORTED', detail);
      }
    }
    // Owner K1/K2 2026-10-22: the frozen pin's session-start names and provider-choice flag are exactly what the catalog records now; a
    // profile can neither invent a name match nor drop the provider-choice label. Pins of models without such catalog data carry none.
    const evidence = catalogPinModelEvidence((await reader.models(model.channelId)).map(row => row.model), model.modelId);
    if (JSON.stringify([model.reportedNames, model.otherReportedNames, model.providerChosen])
      !== JSON.stringify([evidence.reportedNames, evidence.otherReportedNames, evidence.providerChosen])) throw new WorkerModelAdmissionError('WORKER_MODEL_BINDING_MISMATCH', detail);
  }
  return warnings;
}
