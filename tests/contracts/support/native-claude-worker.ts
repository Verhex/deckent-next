import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';
import { encodeModelBindingDefinition, mcpPrincipalRef, type ExecutionProfileDefinition } from '#domain/index.js';
import { compileNativeCodingDockerProfile, createNativeCliWorkerProfile, createNativeCodingTemplate, nativeCliWorkerStoredBase, openSqliteModelActivationStore, readLocalOsIdentity,
  type NativeCliWorkerBinding } from '#adapters/index.js';
import { bindCapacityResource, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { headlessCapacityBinding } from '#adapters/core/sqlite-model-invocation/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationProfileDigest, modelInvocationTargetId } from '#engine/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { clearConfigCache, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { seedCatalog, SEED_CHANNEL } from './model-catalog.js';

/**
 * Owner 2026-11-08: Claude workers run tokenless on the person's own login (`deckent coding template --connection <profile>`), never in Docker.
 * One login connected for each recommended Claude model of the seed, set up the way witnessed `models connect` leaves it: a v2 headless profile per
 * model (same owner, login dir and executable: one capacity resource), its provider binding, scope activation, source binding, the ledger
 * capacity row, delegated use for the AI workload and the model-use grants (admission pins as the MCP actor). Admission never spawns the CLI,
 * so the login paths are synthetic. The ledger worker catalog (`applyModelCatalog`) stays with the caller, which decides what is active.
 * Call after the project config, ledger and policy file exist.
 */
export async function nativeClaudeWorkers(project: string, scopeId: string, options: ConfigLoadOptions, cliVersion = '2.1.293') {
  const configPath = join(project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  const owner = readLocalOsIdentity(), person = { issuer: owner.issuer, subject: owner.subject }, seed = await seedCatalog(), channel = seed.providers[0];
  const family: string = channel.channel.protocolFamily, modelIds: string[] = seed.recommendedActivations[0].modelIds;
  const definition = { schemaVersion: 1, executable: process.execPath, configDir: '/synthetic/claude-login', stateDir: '/synthetic/claude-state',
    ownerUid: process.getuid!(), minCliVersion: cliVersion, delegatedUse: { consentedBy: person, atMs: 1, classes: ['ai'] } };
  const models = modelIds.map(nativeId => ({ id: nativeId, version: 1, nativeId, protocols: [{ family, version: 'v1', capabilities: [] }] }));
  const provider = { id: SEED_CHANNEL, version: 1 }, catalog = { schemaVersion: 1 as const, revision: config.provider_catalog?.revision ?? 'native-claude-workers',
    providers: [...(config.provider_catalog?.providers ?? []), { ...provider, models }] };
  const profiles = models.map(model => {
    const digest = createHash('sha256').update(encodeModelBindingDefinition({ encodingVersion: 1, provider, model })).digest('hex');
    return { schemaVersion: 2, id: `claude-worker-${model.nativeId}`, version: 1, scopeId, billingAxis: 'subscription',
      reference: { providerId: SEED_CHANNEL, providerVersion: 1, modelId: model.id, modelVersion: 1 }, bindingDigest: digest, protocol: { family, version: 'v1' },
      adapter: { id: 'native-cli-headless', version: 1, definition: { ...definition } as Record<string, unknown> },
      allocation: { id: `claude-worker-${model.nativeId}`, maxCalls: 8, maxInFlight: 2 }, limits: { requestMaxBytes: 128_000, responseMaxBytes: 65_536, timeoutMs: 10_000 } };
  });
  const write = async () => { await writeFile(configPath, JSON.stringify({ ...config, provider_catalog: catalog,
    provider_invocation_profiles: { schemaVersion: 1, profiles: [...(config.provider_invocation_profiles?.profiles ?? []), ...profiles] } })); clearConfigCache(); };
  await write();
  // Trusted fixture setup mirrors the source identities sealed by witnessed models connect; no production authority is bypassed.
  const scoped = await vi.importActual<typeof import('#composition/core/scoped-request/index.js')>('#composition/core/scoped-request/index.js');
  const context = await scoped.loadConfiguredScopeContext(project, scopeId, options, 'write');
  if (!context.installationId) throw new Error('FIXTURE_INSTALLATION_MISSING');
  for (const profile of profiles) profile.adapter.definition['sourceBinding'] = { schemaVersion: 1, installationId: context.installationId, companyId: context.config.company.id, scopeId, principal: person };
  await write();
  const { store, path, layout } = await openConfiguredAttemptStore(project, options); store.close();
  // Direct fixture setup bypasses models connect, which persists the shared subscription resource.
  const db = openSqliteLedger(path, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' }, 'forbid');
  let resourceKey: string;
  try { resourceKey = bindCapacityResource(db, headlessCapacityBinding(profiles[0]!.adapter.definition), { executionSlots: 2, inFlightSlots: 2 }).resourceKey; } finally { db.close(); }
  const principal = { ...owner, scopeIds: [scopeId] };
  const activation = new ModelActivationApplication({ verify: async () => principal }, { authorize: async () => ({ revision: 'seed', ruleId: 'seed' }) },
    new ModelBindingApplication({ read: async () => catalog }), () => openSqliteModelActivationStore(path, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' }), () => 1);
  for (const profile of profiles) await activation.admit({ schemaVersion: 1, action: 'activate', commandId: `activate-${profile.id}`, scopeId, reference: profile.reference,
    expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: profile.bindingDigest } });
  const policyPath = productResourcePath(layout, 'policy'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  await writeFile(policyPath, JSON.stringify({ ...policy, grants: [...policy.grants, { id: 'claude-worker-use', effect: 'allow', actions: ['invoke'], scopes: [scopeId],
    principals: [person, mcpPrincipalRef(person)], resource: { kind: 'model-invocation', ids: profiles.map(profile => modelInvocationTargetId(profile.reference)) } }] }), { mode: 0o600 });
  clearConfigCache();
  const connected = profiles[0]!;
  const binding: NativeCliWorkerBinding = { schemaVersion: 1, connectionId: resourceKey, resourceKey, protocolFamily: family,
    profileDigest: modelInvocationProfileDigest(connected as never), definition: connected.adapter.definition as NativeCliWorkerBinding['definition'] };
  const invocation = { provider: 'claude', cliVersion: `${cliVersion} (Claude Code)`, discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' };
  /** The v2 template `coding template --connection` writes for this login (discovery disabled); `extra` adds template fields (turn limit, parts). */
  const template = (id: string, limits?: unknown, extra: object = {}) => ({ ...createNativeCodingTemplate(limits, { ...invocation, ...extra }, binding), id });
  /** A prepared worker profile on this login: the Docker task base compiled with the exact pin, then bound to the connection; keeps `base`'s id. */
  const prepared = (base: ExecutionProfileDefinition, fields: object, effort?: Parameters<typeof compileNativeCodingDockerProfile>[2]) => ({ ...createNativeCliWorkerProfile(
    nativeCliWorkerStoredBase(compileNativeCodingDockerProfile(base, { schemaVersion: 4, ...invocation, ...fields }, effort)), binding), id: base.id, version: base.version });
  return { binding, invocation, template, prepared, profiles };
}
