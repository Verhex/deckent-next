import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configCommand } from '../../../src/surfaces/core/config/index.js';
import { modelsCommand } from '../../../src/surfaces/core/cli-models/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '../../../src/composition/core/config/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { admitConfiguredModelActivation, inspectConfiguredModelActivation } from '#composition/core/model-activation/index.js';
import { inspectConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteModelInvocationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelInvocationPolicyAuthorization, modelInvocationProfileDigest, modelInvocationRequestDigest,
  type ModelBindingInspection, type ModelActivationInspection, type ModelActivationResult, type ModelInvocationInspection, type ConfigApplication } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { clearConfigCache, getConfigFieldDefault, loadConfig, prepareProductFile, productResourcePath, resolveProductLayout } from '#platform/index.js';
import type { ModelInvocationProfile, ModelReference } from '#domain/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const scopeId = 'installation', servedId = 'Qwen3.8-27B-INT4-W4A16';
// Historical 2026-09-30 allowed proof snapshot, selected provider/profile data only. This is fixture metadata, never a current-serving claim.
const protocols = [{ family: 'openai-chat-completions', version: 'v1', capabilities:
  ['text', 'tool-calls', 'token-count', 'chat-template-enable-thinking'].map(id => ({ id, version: 1, state: 'supported' })) }];
const oldProvider = { id: 'local-llama', version: 1, models: [1, 2, 3, 4, 5].map(version => ({ id: 'qwen38', version,
  nativeId: version === 1 ? 'Qwen3.8-27B-Q4_K_M' : servedId,
  protocols: protocols.map(protocol => ({ ...protocol, capabilities: protocol.capabilities.slice(0, version <= 2 ? 1 : version - 1) })) })) };
const oldReference = (modelVersion: number): ModelReference => ({ providerId: 'local-llama', providerVersion: 1, modelId: 'qwen38', modelVersion });
const newReference: ModelReference = { providerId: 'local-vllm', providerVersion: 1, modelId: servedId, modelVersion: 1 };
const newProvider = { id: 'local-vllm', version: 1, models: [{ id: servedId, version: 1, nativeId: servedId, protocols }] };

it.skipIf(process.platform === 'win32')('cleans provider history through real config/models commands in a temp project without a model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'config-catalog-cleanup-')); roots.push(root);
  const env = { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') }, options = { env };
  await applyPolicyTemplateInstallation(root, scopeId);
  const layout = resolveProductLayout({ projectRoot: root }), ledger = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  const sqlite = getConfigFieldDefault('storage').sqlite; openSqliteLedger(ledger, sqlite).close();
  const policyPath = productResourcePath(layout, 'policy'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
  const identity = readLocalOsIdentity(), principals = [{ issuer: identity.issuer, subject: identity.subject }];
  // Keep the actual first-run config grant. Add only fixture model management/history authority as policy data.
  policy.grants.push({ id: 'cleanup-models', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: [scopeId], principals,
    resource: { kind: 'model-activation', ids: 'all' } }, { id: 'cleanup-history', effect: 'allow', actions: ['invoke', 'inspect'], scopes: [scopeId], principals,
    resource: { kind: 'model-invocation', ids: 'all' } });
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  let serial = 0;
  async function config<T>(args: string[]): Promise<T> {
    const output: string[] = [];
    await configCommand(['config', ...args, '--json'], { root, env, stdout: { write: (value: string) => { output.push(value); } },
      configApplication: createConfiguredConfigApplication, resolveConfigPrincipal: resolveConfiguredConfigPrincipal });
    return JSON.parse(output.join('')) as T;
  }
  async function models<T>(args: string[]): Promise<T> {
    const output: string[] = [];
    await modelsCommand(['models', ...args, '--json'], { root, env, stdout: { write: (value: string) => { output.push(value); } },
      inspectModelBinding, admitModelActivation: admitConfiguredModelActivation, inspectModelActivation: inspectConfiguredModelActivation,
      inspectModelInvocation: inspectConfiguredModelInvocation });
    return JSON.parse(output.join('')) as T;
  }
  async function set(key: string, value: unknown) {
    const inspected = await config<Awaited<ReturnType<ConfigApplication['inspect']>>>([]);
    return config(['set', key, JSON.stringify(value), '--scope', scopeId, '--command-id', `set-${++serial}`,
      ...(inspected.digest ? ['--expect', inspected.digest] : [])]);
  }
  const flags = (reference: ModelReference) => ['--provider', reference.providerId, '--provider-version', String(reference.providerVersion),
    '--model', reference.modelId, '--model-version', String(reference.modelVersion)];
  async function binding(reference: ModelReference) {
    const result = await models<ModelBindingInspection>(['binding', ...flags(reference)]);
    if (result.status !== 'declared') throw new Error('FIXTURE_BINDING_UNDECLARED');
    return result;
  }
  async function activate(reference: ModelReference) {
    const result = await binding(reference);
    return models<ModelActivationResult>(['activate', '--scope', scopeId, ...flags(reference), '--command-id', `activate-${++serial}`,
      '--expected-revision', '0', '--binding-digest', result.binding.digest, '--catalog-revision', result.catalogRevision]);
  }
  await set('provider_catalog', { schemaVersion: 1, revision: 'cleanup-fixture', providers: [oldProvider] });
  const oldBinding = await binding(oldReference(5));
  const oldProfile: ModelInvocationProfile = { schemaVersion: 1, id: 'local-qwen', version: 6, scopeId, reference: oldReference(5),
    bindingDigest: oldBinding.binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'openai-chat-http', version: 4, definition: { endpoint: 'http://127.0.0.1:18080/v1/chat/completions', maxOutputTokens: 8192,
      authentication: { type: 'none' }, tariff: { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 },
      tokenizeEndpoint: 'http://127.0.0.1:18080/tokenize' } }, allocation: { id: 'local-qwen-terminal', maxCalls: null, maxInFlight: 2 },
    limits: { requestMaxBytes: 1048576, responseMaxBytes: 1048576, timeoutMs: 300000 }, contextWindowTokens: 196608 };
  await set('provider_invocation_profiles', { schemaVersion: 1, profiles: [oldProfile] });
  await set('terminal.scopeId', scopeId); await set('terminal.chat', { schemaVersion: 1, reference: oldReference(5), maxCompletionTokens: 8192 });
  // The fixture's 1 MiB native response needs space for its worst-case delivery envelope, as real activation enforces.
  await set('service.responseMaxBytes', 16_777_216); await set('mcp.responseMaxBytes', 16_777_216);
  const activated = await Promise.all([1, 2, 3, 4, 5].map(version => activate(oldReference(version))));
  // Seed one no-network fixture claim via the durable adapter after actual policy authorization and real activation.
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'write');
  const authorization = await new ModelInvocationPolicyAuthorization({ async load() { return context.document; } }).authorize('invoke', { scopeId, reference: oldReference(5) }, context.principal);
  const command = { schemaVersion: 1 as const, commandId: 'historical-command', scopeId, reference: oldReference(5), catalogRevision: oldBinding.catalogRevision,
    expectedBinding: oldBinding.binding, nativeRequest: { model: servedId, messages: [] } };
  const store = await openSqliteModelInvocationStore(ledger, sqlite, 'forbid');
  try {
    const claimed = await store.claim({ command, requestDigest: modelInvocationRequestDigest(command), actor: identity, authorization, definition: oldBinding.definition,
      activation: activated[4]!.receipt.record, profile: oldProfile, profileDigest: modelInvocationProfileDigest(oldProfile), invocationId: 'historical-invocation', claimedAtMs: 10 });
    await store.permitSend(claimed.record.receipt.claim, 'fixture-owner', 11);
    await store.recordUnknown(claimed.record.receipt.claim, 'transport-error', 12);
  } finally { store.close(); }
  const historyFile = join(root, 'history-query.json');
  await writeFile(historyFile, JSON.stringify({ schemaVersion: 2, scopeId, invocationId: 'historical-invocation', reference: oldReference(5) }));
  const before = await models<ModelInvocationInspection>(['invocation', '--input', historyFile]);
  expect(before.invocation?.profile.version).toBe(6);

  // The exact owner cleanup path starts here. Product config get must preserve numeric token controls for safe roundtrip.
  const currentProfile = await config<ModelInvocationProfile>(['get', 'provider_invocation_profiles.profiles.0']);
  expect(currentProfile.contextWindowTokens).toBe(196608); expect(currentProfile.adapter.definition['maxOutputTokens']).toBe(8192);
  await set('provider_catalog.providers.1', newProvider);
  const fresh = await binding(newReference); expect(fresh.definition.model.protocols).toEqual(oldBinding.definition.model.protocols);
  await activate(newReference);
  await set('provider_invocation_profiles.profiles.0', { ...currentProfile, version: 7, reference: newReference, bindingDigest: fresh.binding.digest });
  await set('terminal.chat.reference', newReference);
  for (const version of [1, 2, 3, 4, 5]) {
    const bound = await binding(oldReference(version));
    const current = await models<ModelActivationInspection>(['activation', '--scope', scopeId, ...flags(oldReference(version))]);
    const result = await models<ModelActivationResult>(['deactivate', '--scope', scopeId, ...flags(oldReference(version)), '--command-id', `off-${version}`,
      '--expected-revision', String(current.activation?.revision ?? 0), '--binding-digest', bound.binding.digest]);
    expect(result.receipt.record.state).toBe('inactive');
  }
  const inspected = await config<Awaited<ReturnType<ConfigApplication['inspect']>>>([]);
  expect(inspected.digest).not.toBeNull();
  await config(['unset', 'provider_catalog.providers.0', '--scope', scopeId, '--command-id', 'remove-old-provider', '--expect', inspected.digest!]);
  const effective = await loadConfig(root, options);
  expect(effective['provider_catalog']).toMatchObject({ providers: [{ id: 'local-vllm', models: [{ id: servedId, version: 1 }] }] });
  expect((effective['provider_catalog'] as { providers: unknown[] }).providers).toHaveLength(1);
  expect(effective['terminal']).toMatchObject({ chat: { reference: newReference } });
  const after = await models<ModelInvocationInspection>(['invocation', '--input', historyFile]);
  expect(after).toEqual(before); expect(after.invocation?.request.reference).toEqual(oldReference(5));
  expect(after).toMatchObject({ historyIntegrity: 'not-recorded', contentStatus: 'not-captured' });
});
