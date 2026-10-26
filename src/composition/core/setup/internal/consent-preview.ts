import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerConsentBinding } from '#engine/index.js';
import { readWorkerImageSources, workerImageEstimate, inspectWorkerImageChoices, detectExecutionFacts, readNewestWorkerReceipt } from '#adapters/index.js';
import { sha256, loadConfig, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { snapshotConfiguredConfig } from '#composition/core/config/index.js';
/** The same recipe/source binding the consent owner will seal. It contains no credentials and applies nothing. */
export async function previewOnboardingConsent(root: string, provider: string, options: ConfigLoadOptions, choices = true) {
  const config = await loadConfig(root, { ...options, heal: false, force: true }), snapshot = await snapshotConfiguredConfig(root, options);
  const sources = await readWorkerImageSources(fileURLToPath(new URL('../../../../../', import.meta.url)));
  const binding = workerConsentBinding({ recipe: sources.recipe, providers: [provider], npmRegistry: config.toolchains.currency.registryEndpoint, sources: config.toolchains.image.sources });
  const home = join(productResourcePath(config.productLayout, 'workspaces'), 'toolchains'), previousMs = (await readNewestWorkerReceipt(home))?.durationMs ?? null;
  const content = { previousMs, ...binding, configDigest: snapshot.digest, ...workerImageEstimate([provider]), buildTimeoutMs: config.toolchains.update.buildTimeoutMs };
  const execution = choices ? await detectExecutionFacts({ env: options.env ?? process.env }) : null;
  const images = choices ? await inspectWorkerImageChoices({ packageRoot: fileURLToPath(new URL('../../../../../', import.meta.url)), home,
    executable: execution?.runtimes.find(row => row.support === 'supported' && row.daemon === 'reachable')?.path ?? null, provider, env: options.env ?? process.env }) : [];
  return { ...content, images, digest: sha256(JSON.stringify(content)) };
}
