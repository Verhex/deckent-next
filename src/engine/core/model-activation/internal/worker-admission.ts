import { z } from 'zod';
import type { ModelCatalogModelRecord } from '#domain/index.js';
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
  | 'WORKER_MODEL_CLI_TOO_OLD';
export interface WorkerModelAdmissionDetail {
  readonly taskId: string; readonly channelId: string | null; readonly modelId: string | null;
  readonly exactModelId?: string; readonly minCliVersion?: string; readonly cliVersion?: string | null;
}
export class WorkerModelAdmissionError extends Error {
  constructor(readonly code: WorkerModelAdmissionCode, readonly detail: WorkerModelAdmissionDetail) { super(code); this.name = 'WorkerModelAdmissionError'; }
}
const pinned = z.object({ channelId: z.string(), modelId: z.string(), auxiliaryModelIds: z.array(z.string()).readonly() }).strict();
const subscriptionSchema = z.object({ schemaVersion: z.number(), provider: z.enum(['claude', 'codex', 'cursor']),
  preflight: z.object({ cliVersion: z.string() }).passthrough().optional(), model: pinned.optional() }).passthrough();
const taskSchema = z.object({ taskId: z.string(), profile: z.object({ parameters: z.object({ nativeSubscription: z.unknown().optional() }).passthrough() }).passthrough() }).passthrough();
const today = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);

async function checkModel(reader: ModelCatalogReader, scopeId: string, taskId: string, provider: string, cliVersion: string | null,
  channelId: string, modelId: string, nowMs: number): Promise<void> {
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
  if (lifecycle.state === 'retired' || (lifecycle.retiredOn !== null && lifecycle.retiredOn <= today(nowMs))) refuse('WORKER_MODEL_RETIRED');
  if (lifecycle.state !== 'active') refuse('WORKER_MODEL_NOT_CURRENT');
  if ((await reader.activation(scopeId, channelId, null))?.state !== 'active') refuse('WORKER_CHANNEL_NOT_ACTIVE');
  if ((await reader.activation(scopeId, channelId, modelId))?.state !== 'active') refuse('WORKER_MODEL_NOT_ACTIVE');
  if (entry.model.minCliVersion !== null) {
    const observed = cliVersion === null ? null : extractToolchainVersion(provider, cliVersion);
    if (observed === null || compareToolchainVersions(observed, entry.model.minCliVersion) < 0) {
      refuse('WORKER_MODEL_CLI_TOO_OLD', { minCliVersion: entry.model.minCliVersion, cliVersion: observed });
    }
  }
}

/** Throws the first typed refusal in task order; resolves when every worker task may be admitted. Reads only, writes nothing. */
export async function admitWorkerModels(tasksInput: readonly unknown[], scopeId: string, reader: ModelCatalogReader, nowMs: number): Promise<void> {
  for (const input of tasksInput) {
    const task = taskSchema.parse(input);
    const raw = task.profile.parameters.nativeSubscription;
    if (raw === undefined) continue;
    const subscription = subscriptionSchema.safeParse(raw);
    if (!subscription.success || !subscription.data.model) {
      throw new WorkerModelAdmissionError('WORKER_MODEL_UNPINNED', Object.freeze({ taskId: task.taskId, channelId: null, modelId: null }));
    }
    const { provider, preflight, model } = subscription.data;
    for (const modelId of [model.modelId, ...model.auxiliaryModelIds]) {
      await checkModel(reader, scopeId, task.taskId, provider, preflight?.cliVersion ?? null, model.channelId, modelId, nowMs);
    }
  }
}
