import { loadConfig, type ConfigLoadOptions, type DeckentConfig } from '#platform/index.js';
import { executionRegistrySchema, NATIVE_CODING_TEMPLATE_ADAPTER_ID } from '#domain/index.js';
import { affectedToolchainProfiles, type WorkerKindAvailability } from '#engine/index.js';
import { isNativeCliWorkerProfile, isNativeCodingTemplate, nativeCliWorkerBindingSchema, workerImagePresence } from '#adapters/index.js';

/** Observe only the image prerequisite; connection custody and execution policy keep their existing owners. */
export async function configuredWorkerKinds(config: DeckentConfig): Promise<readonly WorkerKindAvailability[]> {
  const registry = executionRegistrySchema.safeParse(config.admission?.registry);
  if (!registry.success) return [];
  const key = (profile: Readonly<{ id: string; version: number }>) => JSON.stringify([profile.id, profile.version]);
  const pins = affectedToolchainProfiles(config), settings = config.execution?.docker;
  const presence = new Map<string, Promise<'present' | 'missing' | 'unknown'>>();
  return Promise.all(registry.data.kinds.map(async kind => {
    const profile = registry.data.profiles.find(row => key(row) === key(kind.profile));
    const connected = profile && (isNativeCliWorkerProfile(profile) || isNativeCodingTemplate(profile) && nativeCliWorkerBindingSchema.safeParse(profile.parameters['worker']).success);
    const pin = pins.find(row => key(row.profile) === key(kind.profile));
    // Other execution adapters retain their own admission owner; only a pinned worker image is observed here.
    if (connected || !pin) return { kind: kind.kind, reason: null, rebind: false };
    const imageId = pin.imageId;
    if (settings && imageId && !presence.has(imageId)) presence.set(imageId, workerImagePresence({ executable: settings.executable, imageId,
      timeoutMs: settings.controlTimeoutMs, outputBytes: settings.outputBytes }));
    const found = imageId ? await presence.get(imageId) ?? 'unknown' : 'unknown';
    return { kind: kind.kind, reason: found === 'present' ? null : found === 'missing' ? 'image-missing' : 'image-unverified',
      rebind: profile?.adapter.id === NATIVE_CODING_TEMPLATE_ADAPTER_ID };
  }));
}
export async function inspectConfiguredWorkerKinds(root: string, options: ConfigLoadOptions = {}) {
  return configuredWorkerKinds(await loadConfig(root, { ...options, heal: false, force: true }));
}
