import { fileURLToPath } from 'node:url';
import { workerConsentBinding } from '#engine/index.js';
import { readWorkerImageSources, WORKER_IMAGE_ESTIMATED_GB } from '#adapters/index.js';
import { sha256, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { snapshotConfiguredConfig } from '#composition/core/config/index.js';
/** The same recipe/source binding the consent owner will seal. It contains no credentials and applies nothing. */
export async function previewOnboardingConsent(root: string, provider: string, options: ConfigLoadOptions) {
  const config = await loadConfig(root, { ...options, heal: false, force: true }), snapshot = await snapshotConfiguredConfig(root, options);
  const sources = await readWorkerImageSources(fileURLToPath(new URL('../../../../../', import.meta.url)));
  const binding = workerConsentBinding({ recipe: sources.recipe, providers: [provider], npmRegistry: config.toolchains.currency.registryEndpoint, sources: config.toolchains.image.sources });
  const content = { ...binding, configDigest: snapshot.digest, sizeGigabytes: WORKER_IMAGE_ESTIMATED_GB, buildTimeoutMs: config.toolchains.update.buildTimeoutMs };
  return { ...content, digest: sha256(JSON.stringify(content)) };
}
