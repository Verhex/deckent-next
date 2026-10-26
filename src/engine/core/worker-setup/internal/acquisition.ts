import { z } from 'zod';
import { ErrorRegistry, sha256, workerImageConsentSchema, type WorkerImageConsent } from '#platform/index.js';
import { layeredWorkerRecipeSchema, workerSourceUrl, type WorkerImageSources } from '#engine/core/toolchain-currency/index.js';
/** The budget is one base build plus each selected image, with the existing cleanup/marker grace. */
export const WORKER_IMAGE_GRACE_MS = 60_000;
export function workerImageBudget(buildTimeoutMs: number, images: number): number {
  const total = buildTimeoutMs * (images + 1) + WORKER_IMAGE_GRACE_MS;
  if (!Number.isSafeInteger(total) || total > 2_147_483_647 || images < 1) throw ErrorRegistry.createError('WORKER_PLAN_INVALID');
  return total;
}
export type WorkerConsentBinding = Pick<WorkerImageConsent, 'providers' | 'sources' | 'proxy' | 'recipeDigest' | 'baseRef'>;
export function workerConsentBinding(input: { recipe: unknown; providers: readonly string[]; npmRegistry: string; sources: WorkerImageSources }): WorkerConsentBinding {
  const recipe = layeredWorkerRecipeSchema.parse(input.recipe), providers = [...input.providers];
  if (!providers.length || new Set(providers).size !== providers.length || providers.some(id => !recipe.providers.some(row => row.id === id))) throw ErrorRegistry.createError('WORKER_PLAN_INVALID');
  const sources = providers.map(id => {
    const installer = recipe.providers.find(row => row.id === id)!.installer;
    return installer.kind === 'npm' ? input.npmRegistry : input.sources.installerUrls?.[id] ?? installer.url;
  });
  return { providers, sources: [...new Set(sources.map(url => workerSourceUrl(url)))].sort(), proxy: input.sources.proxy ? workerSourceUrl(input.sources.proxy, true) : null,
    recipeDigest: sha256(JSON.stringify(input.recipe, null, 2) + '\n'), baseRef: input.sources.baseImage ?? recipe.base.image };
}
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
export function matchingWorkerConsent(records: readonly unknown[], binding: WorkerConsentBinding, imageId?: string): WorkerImageConsent {
  const eligible = records.map(raw => workerImageConsentSchema.safeParse(raw)).flatMap(record => record.success
    && record.data.imageId === imageId && record.data.recipeDigest === binding.recipeDigest && record.data.baseRef === binding.baseRef && record.data.proxy === binding.proxy
    && record.data.providers.every(provider => binding.providers.includes(provider)) && record.data.sources.every(source => binding.sources.includes(source)) ? [record.data] : []);
  if (eligible.length && same([...new Set(eligible.flatMap(record => record.providers))], binding.providers)
    && same([...new Set(eligible.flatMap(record => record.sources))], binding.sources)) return eligible.at(-1)!;
  throw ErrorRegistry.createError('WORKER_IMAGE_CONSENT_MISSING');
}
const pin = z.object({ consentId: z.string().min(1), daemonId: z.string().min(1), recipeDigest: z.string().regex(/^[a-f0-9]{64}$/u), provider: z.string().min(1), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u), imageVersion: z.string(), tagVersion: z.string(), receiptPath: z.string() }).strict();
export const workerImageStateSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().positive().safe(), instanceId: z.string().min(1),
  consentId: z.string().min(1), phase: z.enum(['requested', 'waiting-docker', 'acquiring', 'ready', 'failed', 'declined']),
  step: z.string().nullable(), startedAt: z.string().datetime(), lastProgressAt: z.string().datetime(), expiresAt: z.string().datetime(),
  daemonId: z.string().nullable(), code: z.string().nullable(), images: z.array(pin).max(64), context: z.string().nullable(),
}).strict();
export type WorkerImageState = z.infer<typeof workerImageStateSchema>;
/** A marker describes work; it never admits it. Restart does not retry an uncertain build. */
export function interruptedWorkerImage(state: WorkerImageState, instanceId: string, now: string): WorkerImageState {
  return ['acquiring', 'requested'].includes(state.phase) && (state.instanceId !== instanceId || Date.parse(state.expiresAt) <= Date.parse(now))
    ? { ...state, revision: state.revision + 1, phase: 'failed', code: 'WORKER_IMAGE_BUILD_INTERRUPTED', lastProgressAt: now } : state;
}
export const consentProviders = (records: readonly WorkerImageConsent[]) => [...new Set(records.flatMap(record => record.providers))];
