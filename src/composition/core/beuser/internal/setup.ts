import { isDeepStrictEqual } from 'node:util';
import { executionRegistrySchema } from '#domain/index.js';
import { readInstallationProfileFile, readBeuserCandidate, openSqliteModelActivationReader, canonicalRealmPath } from '#adapters/index.js';
import { inspectRoleModelsInScope, roleModelInvocationReference, BEUSER_LIMITS_REGISTRY } from '#engine/index.js';
import { CONFIG_FIELDS, ErrorRegistry, sha256, type ConfigLoadOptions } from '#platform/index.js';
import { configPersonWitness, createConfiguredConfigApplication, snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { installConfiguredExecutionPool } from '#composition/core/installation/index.js';
import { beuserJourneyProfileSchema } from '#composition/core/supervisors/index.js';

export interface BeuserSetupInput { readonly scopeId: string; readonly profile: string; readonly apply: boolean; readonly expect?: string }
/** Person-selected, bounded execution data. ConfigApplication remains the only config writer; no model or policy grants are created here. */
export async function setupConfiguredBeuser(root: string, input: BeuserSetupInput, options: ConfigLoadOptions = {}) {
  await configPersonWitness()('beuser setup');
  const read = await snapshotConfiguredConfig(root, { ...options, heal: false });
  const c = await loadConfiguredScopeContext(root, input.scopeId, { ...options, heal: false }, 'write');
  const raw = await readInstallationProfileFile(input.profile, c.config.inspection.policyMaxBytes);
  const admission = CONFIG_FIELDS.admission.schema.safeParse(raw);
  const invalid = () => ErrorRegistry.createError('BEUSER_INPUT_INVALID');
  if (!admission.success || !admission.data) throw invalid();
  const parsed = executionRegistrySchema.safeParse(admission.data.registry);
  if (!parsed.success || !parsed.data.profiles.length) throw invalid();
  const registry = parsed.data;
  const modelReader = await openSqliteModelActivationReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
  try {
    const sources = { modelRoles: c.config['model_roles'], providerCatalog: c.config['provider_catalog'],
      activation: (scopeId: string, reference: Parameters<typeof modelReader.loadRecord>[1]) => modelReader.loadRecord(scopeId, reference) };
    for (const profile of registry.profiles) {
      if (profile.adapter.id !== 'beuser' || profile.adapter.version !== 1) throw invalid();
      const data = beuserJourneyProfileSchema.safeParse(profile.parameters);
      if (!data.success) throw invalid();
      const p = data.data;
      if (!BEUSER_LIMITS_REGISTRY.profiles.some(limit => limit.revision === p.limitsRevision)) throw ErrorRegistry.createError('BEUSER_LIMITS_UNAVAILABLE');
      if (await canonicalRealmPath(p.candidateRoot, 'directory') !== p.candidateRoot) throw invalid();
      await readBeuserCandidate(p.candidateRoot, p.candidateManifest, c.config.installation.packageMeasurement,
        p.packageDigest, p.binding.candidate.stateDigest);
      for (const role of ['beuser-walker', 'beuser-evaluator'] as const) {
        const target = p.choices[role], held = await inspectRoleModelsInScope(sources, role, input.scopeId, Date.now());
        if (!held.models.some(row => row.channelId === target.channelId && row.modelId === target.modelId && row.active)
          || !roleModelInvocationReference(sources, c.config['provider_invocation_profiles'], input.scopeId, target)) throw ErrorRegistry.createError('BEUSER_MODEL_UNAVAILABLE');
      }
    }
  } finally { modelReader.close(); }
  const existing = read.effective.admission;
  // This installer never replaces an unrelated registry or widens an existing pool implicitly.
  // The config loader uses null-prototype JSON objects; prototypes do not change the selected data.
  if (existing && !isDeepStrictEqual(existing, admission.data, { skipPrototype: true })) throw ErrorRegistry.createError('BEUSER_SETUP_CONFLICT');
  const digest = sha256(JSON.stringify({ project: read.digest, global: read.global, admission: admission.data }));
  const result = { schemaVersion: 1 as const, status: existing ? 'current' : 'preview', digest, admission: admission.data };
  if (!input.apply) return result;
  if (input.expect !== digest) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
  let status = 'current';
  if (!existing) {
    const app = createConfiguredConfigApplication(root, options, current => {
      if (!isDeepStrictEqual(current.global, read.global)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    });
    const written = await app.submit('set', { keyPath: 'admission', value: admission.data, layer: 'project', expect: read.digest,
      scopeId: input.scopeId, principal: c.principal, commandId: `beuser-setup-${digest}` });
    if (written.status !== 'applied') return { ...result, status: 'approval-pending', approval: written };
    status = 'applied';
  }
  const pool = await installConfiguredExecutionPool(root, input.scopeId, true, options);
  return { ...result, status: pool.status === 'created' || pool.status === 'current' ? status : 'pool-unavailable', pool };
}
