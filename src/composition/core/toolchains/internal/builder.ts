import limits from './limits.json' with { type: 'json' };
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigFieldDefault, loadConfig, normalizeGlobalScopePlatform, prepareProductDirectory, resolveGlobalScopePaths, resolveProductLayout, type ConfigLoadOptions, ErrorRegistry } from '#platform/index.js';
import { affectedToolchainProfiles, workerImageBudget, matchingWorkerConsent, workerConsentBinding, type WorkerConsentBinding } from '#engine/index.js';
import { FileInstallationIdentityStore, readNewestWorkerReceipt, readWorkerHistory, withWorkerBuilder, readWorkerImageHeldVersion, readWorkerImageSources, runNodeProcess, type WorkerImageBuildRunner, type WorkerReservation } from '#adapters/index.js';
import { writeArtifact } from './update.js';
const counter = (value: string) => Number(/^r([0-9]+)/u.exec(value)?.[1] ?? 0);
/** Refresh and acquisition enter this same daemon-only owner before counter reservation or any build context. */
export async function configuredWorkerBuilder<T>(projectRoot: string, options: ConfigLoadOptions, input: { packageRoot: string; home: string;
  binding: WorkerConsentBinding; imageId?: string; refreshExisting?: boolean; plannedAt?: string; instanceId?: string; runner?: WorkerImageBuildRunner; signal?: AbortSignal },
  run: (reservation: WorkerReservation, signal: AbortSignal, retain: (receipt: unknown) => Promise<void>) => Promise<T>): Promise<T> {
  const config = await loadConfig(projectRoot, { ...options, force: true, heal: false });
  const authorize = async (current: typeof config, binding: WorkerConsentBinding) => {
    // Existing installs may refresh only packaged sources and the exact providers their installed image receipts attest.
    if (input.refreshExisting && current.execution?.docker
      && JSON.stringify(current.toolchains.image.sources) === JSON.stringify(getConfigFieldDefault('toolchains').image.sources)
      && current.toolchains.currency.registryEndpoint === getConfigFieldDefault('toolchains').currency.registryEndpoint) {
      const profiles = affectedToolchainProfiles(current).filter(profile => binding.providers.includes(profile.provider));
      const providers = new Set<string>();
      for (const profile of profiles) {
        const installed = profile.imageId ? (await readNewestWorkerReceipt(input.home, profile.imageId))?.images?.filter(image => image.imageId === profile.imageId).flatMap(image => image.providers) : null;
        if (!installed?.includes(profile.provider)) { matchingWorkerConsent(current.toolchains.image.consents, binding, input.imageId); return; }
        installed.forEach(provider => providers.add(provider));
      }
      if (providers.size === binding.providers.length && binding.providers.every(provider => providers.has(provider))) return;
    }
    matchingWorkerConsent(current.toolchains.image.consents, binding, input.imageId);
  };
  await authorize(config, input.binding);
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'
    && ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(entry[0])));
  const runner = input.runner ?? runNodeProcess;
  const evidence = await runner({ schemaVersion: 1, requestId: randomUUID(), executable: process.execPath,
    args: [join(input.packageRoot, 'assets/worker-image/build.mjs'), '--daemon-identity'], cwd: input.packageRoot, env,
    timeoutMs: config.toolchains.currency.timeoutMs, outputBytes: config.toolchains.update.outputBytes }, input.signal);
  if (evidence.reason !== 'exit' || evidence.exitCode !== 0) throw ErrorRegistry.createError('WORKER_IMAGE_DOCKER_WAITING');
  const identity = JSON.parse(Buffer.from(evidence.stdoutBase64, 'base64').toString('utf8')) as { daemonId: string; endpoint: string };
  if (typeof identity.daemonId !== 'string' || !identity.daemonId || typeof identity.endpoint !== 'string') throw ErrorRegistry.createError('WORKER_DAEMON_CHANGED');
  const global = resolveGlobalScopePaths(normalizeGlobalScopePlatform(options.platform ?? process.platform, options.env ?? process.env), options.env ?? process.env, { ignoreProjectOverride: true });
  const layout = resolveProductLayout({ projectRoot: global.stateDir, root: global.stateDir, platform: options.platform === 'win32' ? 'win32' : 'posix' });
  const root = await prepareProductDirectory(layout, 'workerImageBuilders');
  const instanceId = input.instanceId ?? randomUUID(), budgetMs = workerImageBudget(config.toolchains.update.buildTimeoutMs, input.binding.providers.length);
  const lessee = await new FileInstallationIdentityStore(config.productLayout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
  return withWorkerBuilder({ root, packageRoot: input.packageRoot, daemonId: identity.daemonId, instanceId, budgetMs, ...(input.signal ? { signal: input.signal } : {}), ...(lessee.status === 'available' ? { lessee: lessee.value.installationId } : {}),
    audit: event => writeArtifact(join(input.home, 'builder-audits'), `${randomUUID()}${limits.artifactSuffix}`, event).then(() => undefined) }, async custody => {
    // Re-read after waiting for custody: changing a source or withdrawing access never inherits an earlier consent observation.
    const fresh = await loadConfig(projectRoot, { ...options, force: true, heal: false });
    const sources = await readWorkerImageSources(input.packageRoot);
    const binding = workerConsentBinding({ recipe: sources.recipe, providers: input.binding.providers, npmRegistry: fresh.toolchains.currency.registryEndpoint, sources: fresh.toolchains.image.sources });
    if (JSON.stringify(binding) !== JSON.stringify(input.binding)) throw ErrorRegistry.createError('WORKER_IMAGE_CONSENT_MISSING');
    await authorize(fresh, binding);
    const held = await readWorkerImageHeldVersion({ packageRoot: input.packageRoot, timeoutMs: fresh.toolchains.currency.timeoutMs, outputBytes: fresh.toolchains.update.outputBytes, env, ...(input.signal ? { signal: input.signal } : {}) }, runner);
    const history = await readWorkerHistory({ packageRoot: input.packageRoot, home: input.home, daemonId: identity.daemonId });
    const reservation = await custody.reserve(Math.max(counter(held ?? ''), ...history.map(counter), counter((sources.recipe as { imageVersion: string }).imageVersion)), input.plannedAt ?? new Date().toISOString());
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Date.parse(reservation.expiresAt) - Date.now())), ...(input.signal ? [input.signal] : [])]);
    return run(reservation, signal, custody.retain);
  });
}
