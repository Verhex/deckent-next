import limits from './limits.json' with { type: 'json' };
import { readWorkerImageState, writeWorkerImageState, recoverWorkerImageContext } from './state.js';
import { randomUUID } from 'node:crypto';
import { watch, readFile, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorRegistry, loadConfig, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { interruptedWorkerImage, matchingWorkerConsent, workerConsentBinding, workerImageBudget, insertHistoryLine, type WorkerImageState } from '#engine/index.js';
import { buildWorkerImageInHome, readWorkerImageSources, type WorkerImageBuildRunner } from '#adapters/index.js';
import type { NpmLatestVersionFetcher } from './currency.js';
import { configuredWorkerBuilder } from './builder.js';
import { writeArtifact } from './update.js';
const packageRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const failure = (error: unknown) => (error as { code?: string }).code ?? 'WORKER_IMAGE_BUILD_FAILED';
export type WorkerAcquisitionDependencies = Readonly<{ packageRoot?: string; runner?: WorkerImageBuildRunner; fetcher?: NpmLatestVersionFetcher; instanceId: string; signal?: AbortSignal }>;
const inflight = new Map<string, Promise<WorkerImageState | null>>();
/** S3 emits image facts only: no proposal, initial execution settings, registry or pool writer is held here. */
export function acquireConfiguredWorkerImage(projectRoot: string, options: ConfigLoadOptions, dependencies: WorkerAcquisitionDependencies): Promise<WorkerImageState | null> {
  const key = resolve(projectRoot), existing = inflight.get(key); if (existing) return existing;
  const started = acquire(projectRoot, options, dependencies).finally(() => { inflight.delete(key); }); inflight.set(key, started); return started;
}
async function acquire(projectRoot: string, options: ConfigLoadOptions, dependencies: WorkerAcquisitionDependencies): Promise<WorkerImageState | null> {
  const config = await loadConfig(projectRoot, { ...options, force: true, heal: false }), root = dependencies.packageRoot ?? packageRoot;
  const home = join(productResourcePath(config.productLayout, 'workspaces'), 'toolchains'), previous = await readWorkerImageState(home);
  const now = () => new Date().toISOString();
  if (previous) {
    const recovered = interruptedWorkerImage(previous, dependencies.instanceId, now());
    if (recovered !== previous) {
      await writeWorkerImageState(home, recovered);
      await recoverWorkerImageContext(home, previous, root, dependencies.runner, options.env as Record<string, string> | undefined);
      await writeArtifact(join(home, 'acquisitions'), `${randomUUID()}${limits.artifactSuffix}`, recovered);
      return recovered;
    }
  }
  const record = config.toolchains.image.consents.at(-1);
  // Marker-only writes do not authorize even a daemon probe. A failed/interrupted consent is consumed and never automatically retried.
  if (!record) { if (previous) throw ErrorRegistry.createError('WORKER_IMAGE_CONSENT_MISSING'); return null; }
  if (previous?.consentId === record.id) return previous;
  const sources = await readWorkerImageSources(root);
  const binding = workerConsentBinding({ recipe: sources.recipe, providers: record.providers, npmRegistry: config.toolchains.currency.registryEndpoint, sources: config.toolchains.image.sources });
  matchingWorkerConsent([record], binding);
  const startedAt = now(), budget = workerImageBudget(config.toolchains.update.buildTimeoutMs, record.providers.length);
  let state: WorkerImageState = { schemaVersion: 1, revision: (previous?.revision ?? 0) + 1, instanceId: dependencies.instanceId, consentId: record.id,
    phase: 'requested', step: null, startedAt, lastProgressAt: startedAt, expiresAt: new Date(Date.parse(startedAt) + budget).toISOString(),
    daemonId: null, code: null, images: previous?.images ?? [], context: null };
  const publish = async (change: Partial<WorkerImageState>) => {
    state = { ...state, ...change, revision: state.revision + 1, lastProgressAt: now() }; await writeWorkerImageState(home, state);
  };
  await writeWorkerImageState(home, state);
  try {
    await configuredWorkerBuilder(projectRoot, options, { packageRoot: root, home, binding, plannedAt: startedAt, ...dependencies }, async (reservation, signal, retain) => {
      const version = reservation.version, recipe = sources.recipe as { imageVersion: string; base: { image: string } };
      const history = insertHistoryLine(sources.dockerfile, `# version ${version} | ${startedAt.slice(0, 10)} | base ${binding.baseRef} | supersedes ${recipe.imageVersion} | witnessed worker image acquisition`);
      await publish({ phase: 'acquiring', step: 'base', daemonId: reservation.daemonId,
        startedAt: now(), expiresAt: reservation.expiresAt });
      const progressStop = new AbortController(); let progressDone = Promise.resolve();
      const built = await buildWorkerImageInHome({ packageRoot: root, home, imageVersion: version, recipe: sources.recipe, dockerfile: history, reservation,
        timeoutMs: config.toolchains.update.buildTimeoutMs, outputBytes: config.toolchains.update.outputBytes, failedContextsKept: config.toolchains.update.failedContextsKept,
        resolution: { selected: record.providers, npmRegistry: config.toolchains.currency.registryEndpoint, sources: config.toolchains.image.sources,
          refreshMs: config.toolchains.image.baseRefreshMs, plannedAt: startedAt, previousVersion: recipe.imageVersion, ...(dependencies.fetcher ? { lookup: dependencies.fetcher } : {}) },
        ...(options.env ? { env: options.env as Record<string, string> } : {}), signal, onContext: async context => { await publish({ context }); progressDone = observeProgress(context, record.providers, progressStop.signal, step => publish({ step })); },
      }, dependencies.runner).finally(async () => { progressStop.abort(); await progressDone; });
      const receipt = built.receipt as { imageVersion: string; daemonId: string; recipeSha256: string; images: { providers: string[]; imageId: string; tag: string }[] };
      if (receipt.daemonId !== reservation.daemonId || receipt.recipeSha256 !== binding.recipeDigest
        || record.providers.some(provider => !receipt.images.some(image => image.providers.includes(provider)))) throw ErrorRegistry.createError('WORKER_RECEIPT_INVALID');
      await retain(built.receipt);
      const images = receipt.images.flatMap(image => image.providers.map(provider => ({ consentId: record.id, daemonId: reservation.daemonId, recipeDigest: binding.recipeDigest, provider, imageId: image.imageId, imageVersion: receipt.imageVersion,
        tagVersion: image.tag.split(':').at(-1)!, receiptPath: built.receiptPath })));
      await publish({ phase: 'ready', step: null, images: [...state.images.filter(image => !record.providers.includes(image.provider)), ...images] });
    });
  } catch (error) {
    const code = signalInterrupted(dependencies.signal) ? 'WORKER_IMAGE_BUILD_INTERRUPTED' : failure(error);
    await publish({ phase: code === 'WORKER_IMAGE_DOCKER_WAITING' ? 'waiting-docker' : 'failed', code, step: null });
  }
  await writeArtifact(join(home, 'acquisitions'), `${randomUUID()}${limits.artifactSuffix}`, state);
  return state;
}
const signalInterrupted = (signal?: AbortSignal) => signal?.aborted === true;
/** One listener job per service, triggered by config publication; startup recovery is awaited before any new acquisition. */
export function startWorkerImageAcquisition(projectRoot: string, options: ConfigLoadOptions, signal: AbortSignal,
  dependencies: Omit<WorkerAcquisitionDependencies, 'signal'> = { instanceId: randomUUID() }) {
  const done = (async () => {
    const config = await loadConfig(projectRoot, { ...options, heal: false });
    const changes = watch(dirname(config.productLayout.bootstrapConfigPath), { signal });
    // Start watching before initial observation so a consent publication cannot be lost during a build.
    const run = () => acquireConfiguredWorkerImage(projectRoot, options, { ...dependencies, signal }).catch(() => null);
    try { if (!signal.aborted) await run(); for await (const event of changes) { if (event.filename === basename(config.productLayout.bootstrapConfigPath) && !signal.aborted) await run(); } }
    catch (error) { if (!signal.aborted) throw error; }
    finally { await changes.return?.(); }
  })();
  void done.catch(() => undefined); return { done };
}
/** Read-only facts for U4-1p and the ready-card owner. */
export async function inspectConfiguredWorkerImage(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  return readWorkerImageState(join(productResourcePath(config.productLayout, 'workspaces'), 'toolchains'));
}

async function observeProgress(context: string, providers: readonly string[], signal: AbortSignal, publish: (step: string) => Promise<void>) {
  try {
    for await (const event of watch(context, { signal })) {
      if (event.filename !== 'progress.json') continue;
      const path = join(context, 'progress.json'), info = await lstat(path);
      if (!info.isFile() || info.size > 4096) continue;
      const value = JSON.parse(await readFile(path, 'utf8')) as { step?: unknown };
      if (typeof value.step === 'string' && ['base', 'probe', ...providers.map(id => `layer:${id}`)].includes(value.step)) await publish(value.step);
    }
  } catch { /* Progress is observational; the builder receipt alone settles the job. */ }
}
