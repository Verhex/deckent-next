import { ErrorRegistry, loadConfig, type ConfigLoadOptions, type WorkerImageConsent } from '#platform/index.js';
import { workerConsentBinding, type AuthorityWitness } from '#engine/index.js';
import { readWorkerImageSources } from '#adapters/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, snapshotConfiguredConfig, configPersonWitness } from '#composition/core/config/index.js';
import { fileURLToPath } from 'node:url';
/** S4/U4 call this after the card: no marker or build is written by consent itself. */
export async function consentConfiguredWorkerImage(projectRoot: string, input: { providers: readonly string[]; scopeId: string; commandId: string },
  options: ConfigLoadOptions = {}, witness?: AuthorityWitness) {
  await configPersonWitness(witness)('workerImage');
  const principal = await resolveConfiguredConfigPrincipal(projectRoot, input.scopeId, options);
  const config = await loadConfig(projectRoot, { ...options, force: true, heal: false });
  const snapshot = await snapshotConfiguredConfig(projectRoot, options), records = config.toolchains.image.consents;
  const sources = await readWorkerImageSources(fileURLToPath(new URL('../../../../../', import.meta.url)));
  const binding = workerConsentBinding({ recipe: sources.recipe, providers: input.providers, npmRegistry: config.toolchains.currency.registryEndpoint, sources: config.toolchains.image.sources });
  const existing = records.find(record => record.id === input.commandId);
  const record: WorkerImageConsent = { operation: 'worker-image.consent@1', id: input.commandId, person: { id: principal.id, issuer: principal.issuer, subject: principal.subject },
    scopeId: input.scopeId, ...binding, createdAt: existing?.createdAt ?? new Date().toISOString() };
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw ErrorRegistry.createError('WORKER_IMAGE_CONSENT_INVALID');
  const own = (snapshot.document as { toolchains?: { image?: { consents?: WorkerImageConsent[] } } }).toolchains?.image?.consents ?? [];
  return createConfiguredConfigApplication(projectRoot, options, undefined, witness).submit('set', {
    keyPath: 'toolchains.image.consents', value: existing ? own : [...own, record], layer: 'project', expect: snapshot.digest, principal, scopeId: input.scopeId, commandId: input.commandId,
  });
}
