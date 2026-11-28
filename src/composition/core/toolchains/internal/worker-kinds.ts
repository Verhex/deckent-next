import { loadConfig, type ConfigLoadOptions, type DeckentConfig } from '#platform/index.js';
import { executionRegistrySchema, NATIVE_CODING_TEMPLATE_ADAPTER_ID } from '#domain/index.js';
import { affectedToolchainProfiles, type WorkerKindAvailability } from '#engine/index.js';
import { isNativeCliWorkerProfile, isNativeCodingTemplate, nativeCliWorkerBindingSchema, nativeSubscriptionSchema, workerImagePresence } from '#adapters/index.js';
import { dockerLoginClosed } from './currency.js';

/** Observe only the image prerequisite; connection custody and execution policy keep their existing owners. `loginClosed` (doctor and `deckent coding`
 * only, owner 114) marks a Docker kind its Run start refuses; the planner and setup facts never pass it, so their view and every refusal stay as they are. */
export async function configuredWorkerKinds(config: DeckentConfig, loginClosed?: (provider: string) => boolean): Promise<readonly WorkerKindAvailability[]> {
  const registry = executionRegistrySchema.safeParse(config.admission?.registry);
  if (!registry.success) return [];
  const key = (profile: Readonly<{ id: string; version: number }>) => JSON.stringify([profile.id, profile.version]);
  const pins = affectedToolchainProfiles(config), settings = config.execution?.docker;
  const presence = new Map<string, Promise<'present' | 'missing' | 'unknown'>>();
  return Promise.all(registry.data.kinds.map(async kind => {
    const profile = registry.data.profiles.find(row => key(row) === key(kind.profile));
    const connected = profile && (isNativeCliWorkerProfile(profile) || isNativeCodingTemplate(profile) && nativeCliWorkerBindingSchema.safeParse(profile.parameters['worker']).success);
    const pin = pins.find(row => key(row.profile) === key(kind.profile));
    // Other execution adapters retain their own admission owner; only a pinned worker image is observed here. Owner 114: an older Docker profile without
    // a version pin names its CLI in its subscription; the doctor view marks it as Run start refuses it (its image is still not observed).
    const subscription = connected || pin ? undefined : nativeSubscriptionSchema.safeParse(profile?.parameters['nativeSubscription']).data;
    if (connected || !pin) return { kind: kind.kind, reason: null, rebind: false, ...(subscription && loginClosed?.(subscription.provider) ? { notRunnable: 'NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE' as const } : {}) };
    const imageId = pin.imageId;
    if (settings && imageId && !presence.has(imageId)) presence.set(imageId, workerImagePresence({ executable: settings.executable, imageId,
      timeoutMs: settings.controlTimeoutMs, outputBytes: settings.outputBytes }));
    const found = imageId ? await presence.get(imageId) ?? 'unknown' : 'unknown';
    return { kind: kind.kind, reason: found === 'present' ? null : found === 'missing' ? 'image-missing' : 'image-unverified',
      rebind: profile?.adapter.id === NATIVE_CODING_TEMPLATE_ADAPTER_ID, ...(loginClosed?.(pin.provider) ? { notRunnable: 'NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE' as const } : {}) };
  }));
}
export async function inspectConfiguredWorkerKinds(root: string, options: ConfigLoadOptions = {}) {
  return configuredWorkerKinds(await loadConfig(root, { ...options, heal: false, force: true }), dockerLoginClosed);
}
