import { sha256, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { affectedToolchainProfiles, type SetupIntentFact } from '#engine/index.js';
import { workerImagePresence } from '#adapters/index.js';
import { inspectConfiguredWorkerImage } from '#composition/core/toolchains/index.js';
import { inspectConfiguredPoolCapacity } from '#composition/core/runs/index.js';
/** Readiness is observed through the existing image and pool owners; configuration presence alone never settles setup. */
export async function configuredWorkerSetupFact(root: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<SetupIntentFact | null> {
  const config = await loadConfig(root, { ...options, heal: false, force: true });
  const consents = config.toolchains.image.consents, state = await inspectConfiguredWorkerImage(root, options), pins = affectedToolchainProfiles(config);
  // Prepared registries without an acquisition contract retain their existing admission/readiness owner.
  if (!consents.length && !state) return null;
  const settings = config.execution?.docker;
  const present = settings ? await Promise.all(pins.map(pin => pin.imageId ? workerImagePresence({ executable: settings.executable, imageId: pin.imageId,
    timeoutMs: settings.controlTimeoutMs, outputBytes: settings.outputBytes }) : Promise.resolve('unknown' as const))) : [];
  const pool = config.admission ? await inspectConfiguredPoolCapacity(root, { schemaVersion: 1, scopeId }, options).catch((error: unknown) => { if ((error as { code?: unknown })?.code === 'RUN_POOL_REQUIRED') return null; throw error; }) : null;
  // Another provider's acquisition does not block an already admitted, ready profile.
  const ready = pins.length > 0 && present.every(value => value === 'present') && pool !== null;
  const phase = ready ? 'ready' : state?.phase === 'ready' ? 'awaiting-confirmation' : state?.phase ?? 'waiting-docker';
  const reason = !ready && state?.phase === 'declined' ? 'WORKER_IMAGE_DECLINED' : !ready && state?.phase === 'failed'
    ? state.code === 'WORKER_IMAGE_BUILD_INTERRUPTED' ? 'WORKER_IMAGE_BUILD_INTERRUPTED' : 'WORKER_IMAGE_BUILD_FAILED' : 'WORKER_SETUP_PENDING';
  const basis = sha256(JSON.stringify({ registry: config.admission ?? null, execution: config.execution ?? null, consent: consents.at(-1) ?? null, state, present, pool }));
  return { id: basis, revision: state?.revision ?? 0, basis, ready, reason,
    params: { phase, step: state?.step ?? '', since: state?.startedAt ?? '' } };
}
