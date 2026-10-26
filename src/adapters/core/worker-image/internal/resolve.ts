import { createHash } from 'node:crypto';
import { ErrorRegistry, CONFIG_FIELDS } from '#platform/index.js';
import { planWorkerImage, workerSourceUrl, type WorkerBuildPlan, type WorkerImageSources, type WorkerInstallInput, type LayeredWorkerRecipe } from '#engine/index.js';
import { fetchNpmLatestVersion, type NpmLatestVersionInput, type NpmLatestVersion } from '#adapters/core/npm-registry/index.js';

export type WorkerResolution = Readonly<{ selected?: readonly string[]; npmRegistry?: string; sources?: WorkerImageSources; refreshMs?: number;
  plannedAt?: string; previousVersion?: string | null; previousRefreshKey?: string; resolved?: Readonly<Record<string, WorkerInstallInput>>;
  lookup?: (input: NpmLatestVersionInput) => Promise<NpmLatestVersion>; timeoutMs?: number; responseMaxBytes?: number; signal?: AbortSignal }>;
/** The vendor installer is downloaded as bounded data, never run on the host. Redirects require an explicitly configured final URL. */
async function installerHash(url: string, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const response = await fetch(workerSourceUrl(url), { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
  if (!response.ok || !response.body) throw ErrorRegistry.createError('WORKER_IMAGE_VERSIONS_UNRESOLVABLE');
  const hash = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw ErrorRegistry.createError('WORKER_IMAGE_VERSIONS_UNRESOLVABLE');
      hash.update(chunk);
    }
  } finally { await response.body.cancel().catch(() => undefined); }
  return hash.digest('hex');
}
/** Resolve all and only the selected CLI inputs before any context or Docker effect. Unknown/offline never falls back to latest. */
export async function resolveWorkerBuildPlan(recipe: LayeredWorkerRecipe, imageVersion: string, buildTimeoutMs: number, input: WorkerResolution = {}): Promise<WorkerBuildPlan> {
  const selected = input.selected ?? recipe.providers.map(provider => provider.id);
  const npmRegistry = workerSourceUrl(input.npmRegistry ?? recipe.npmRegistry);
  if (input.sources?.proxy) workerSourceUrl(input.sources.proxy, true);
  const defaults = CONFIG_FIELDS.toolchains.schema.parse({});
  const timeoutMs = input.timeoutMs ?? defaults.currency.timeoutMs, maxBytes = input.responseMaxBytes ?? defaults.currency.responseMaxBytes;
  const providers: Record<string, WorkerInstallInput> = {};
  for (const id of selected) {
    const provider = recipe.providers.find(entry => entry.id === id);
    if (!provider) throw ErrorRegistry.createError('WORKER_PLAN_INVALID');
    const target = provider.installer.kind === 'vendor-script' ? workerSourceUrl(input.sources?.installerUrls?.[id] ?? provider.installer.url) : null;
    if (input.resolved?.[id]) { providers[id] = input.resolved[id]; continue; }
    try {
      input.signal?.throwIfAborted();
      const installer = provider.installer;
      if (installer.kind === 'npm') {
        const value = await (input.lookup ?? fetchNpmLatestVersion)({ endpoint: npmRegistry, package: installer.package, timeoutMs, responseMaxBytes: maxBytes });
        providers[id] = { kind: 'npm', package: installer.package, version: value.version };
      } else {
        const url = target!;
        providers[id] = { kind: 'vendor-script', url, sha256: await installerHash(url, timeoutMs, maxBytes, input.signal) };
      }
    } catch { throw ErrorRegistry.createError('WORKER_IMAGE_VERSIONS_UNRESOLVABLE'); }
  }
  const at = Date.parse(input.plannedAt ?? new Date().toISOString()), cadence = input.refreshMs ?? defaults.image.baseRefreshMs;
  return planWorkerImage({ recipe, imageVersion, previousVersion: input.previousVersion === undefined ? recipe.previousVersion : input.previousVersion,
    selected, resolved: providers, npmRegistry, ...(input.sources ? { sources: input.sources } : {}), buildTimeoutMs,
    refreshKey: String(Math.floor(at / cadence)), pull: input.previousRefreshKey !== String(Math.floor(at / cadence)) });
}
