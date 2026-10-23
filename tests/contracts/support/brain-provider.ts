import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import * as httpTransport from '#adapters/core/provider-http-json/index.js';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { readLocalOsIdentity, openSqliteModelActivationStore, compileNativeCodingDockerProfile } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId, createModelInvocationResponseEvidence } from '#engine/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { clearConfigCache, resolveGlobalConfigReadPath } from '#platform/index.js';
import { applyModelCatalog } from '../../../src/index.js';
import { seedCatalog, SEED_CHANNEL } from './model-catalog.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';
import { fixtureDockerRegistry } from './execution-registry.js';
import { proposalFixture } from './run-proposal.js';
/** Real configured application, SQLite and pricing; only the external HTTP effect is a bounded in-memory fake. */
export async function brainProviderFixture(options: { standing?: boolean; budget?: number | null; model?: 'missing' | 'inactive'; response?: string; hold?: boolean;
  finishReason?: 'stop' | 'length'; maxOutputTokens?: number; responseMaxBytes?: number;
  thinking?: 'supported' | 'unsupported' | 'unknown' | 'wrong-version' | 'wrong-protocol';
  noCharge?: boolean; subscription?: boolean; template?: boolean; contextWindow?: number; tokenCount?: { count: number; max_model_len?: number } | null; rejectStatus?: number;
  /** S2 tier/role registry overlay for the fixture Brain (installation layer): a frontier Brain row by default; `null` writes none. */
  modelRoles?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-brain-provider-'));
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await mkdir(join(project, '.deckent'), { recursive: true });
  const bodies: string[] = [];
  const counterBodies: string[] = [];
  const draft = proposalFixture('business');
  const { graph, budgetCeiling, requiredPermissions } = draft;
  let output: string | ((body: string) => string) = options.response ?? JSON.stringify({ graph, budgetCeiling, requiredPermissions });
  let posts = 0;
  const transport = vi.spyOn(httpTransport, 'sendNativeJsonHttp').mockImplementation(async (request, sendOptions, signal) => {
    if (request.definition.endpoint === 'https://127.0.0.1:1234/tokenize' && sendOptions.parseResponse) {
      counterBodies.push(request.body);
      const parsed = sendOptions.parseResponse(Buffer.from(JSON.stringify(options.tokenCount)));
      if (!('response' in parsed)) return { kind: 'rejected', evidence: createModelInvocationResponseEvidence(request.adapter, 'invalid-response', 200, Buffer.from('null'), true) };
      return parsed.response;
    }
    if (request.definition.endpoint !== 'https://127.0.0.1:1234/chat' || !sendOptions.parseResponse) throw new Error('UNROUTED_FIXTURE_EFFECT');
    posts++; bodies.push(request.body);
    if (options.rejectStatus) return { kind: 'rejected', evidence: createModelInvocationResponseEvidence(request.adapter,
      'http-status', options.rejectStatus, Buffer.from('context window exceeded api_key=sk-provider-private'), true) };
    if (options.hold) await new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) reject(new Error('FIXTURE_ABORTED'));
      else signal?.addEventListener('abort', () => reject(new Error('FIXTURE_ABORTED')), { once: true });
    });
    const parsed = sendOptions.parseResponse(Buffer.from(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'vendor/model',
      choices: [{ index: 0, finish_reason: options.finishReason ?? 'stop', message: { role: 'assistant', content: typeof output === 'function' ? output(request.body) : output } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })));
    if (!('response' in parsed)) throw new Error('FIXTURE_RESPONSE_INVALID');
    return parsed.response;
  });
  const reference = { providerId: 'test-operator', providerVersion: 1, modelId: 'fixture-model', modelVersion: 1 };
  const model = { id: reference.modelId, version: 1, nativeId: 'vendor/model', protocols: [{ family: 'openai-chat-completions', version: 'v1',
    capabilities: [...(options.tokenCount === undefined ? [] : [{ id: 'token-count', version: 1, state: 'supported' }]),
      ...(options.thinking && options.thinking !== 'wrong-protocol' ? [{ id: 'chat-template-enable-thinking',
        version: options.thinking === 'wrong-version' ? 2 : 1, state: options.thinking === 'wrong-version' ? 'supported' : options.thinking }] : [])] },
      ...(options.thinking === 'wrong-protocol' ? [{ family: 'other-protocol', version: 'v1',
        capabilities: [{ id: 'chat-template-enable-thinking', version: 1, state: 'supported' }] }] : [])] };
  const catalog = { schemaVersion: 1 as const, revision: 'fixture-catalog', providers: [{ id: reference.providerId, version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: reference.providerId, version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1, id: 'fixture', version: 1, scopeId: 's', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: 'https://127.0.0.1:1234/chat', authentication: { type: 'none' }, maxOutputTokens: options.maxOutputTokens ?? 8,
        ...(options.tokenCount === undefined ? {} : { tokenizeEndpoint: 'https://127.0.0.1:1234/tokenize' }),
        tariff: { kind: 'operator-static', version: 2, currency: 'USD', inputMinorUnitsPerMillionTokens: options.noCharge ? 0 : 200,
          cachedInputMinorUnitsPerMillionTokens: options.noCharge ? 0 : 50, outputMinorUnitsPerMillionTokens: options.noCharge ? 0 : 1000 } } }, allocation: { id: 'fixture', maxCalls: 8, maxInFlight: 2 },
    limits: { requestMaxBytes: 128_000, responseMaxBytes: options.responseMaxBytes ?? 16_384, timeoutMs: 2_000 },
    ...(options.contextWindow ? { contextWindowTokens: options.contextWindow } : {}) };
  const workClasses = { schemaVersion: 2, revision: 'business-v1', classes: [{ id: 'business', parentClassId: 'small', defaultEffort: 'high',
    proposalAdmission: { risk: 'low', standingAdmission: options.standing ?? false }, acceptanceProfile: { schemaVersion: 1, version: 1,
      criterionTypes: ['completion'], evidenceTypes: ['verification-result'], rubric: [{ criterionType: 'completion', evidenceTypes: ['verification-result'], weight: 1 }],
      ceilingRules: [], decisionThresholds: { rejectBelow: 0.2, acceptAt: 1 } } }], bindings: [{ kind: 'purchase', classId: 'business' }] };
  const workerRegistry = fixtureDockerRegistry(['purchase']);
  const seed = options.subscription ? await seedCatalog() : null;
  const workerModel = seed?.providers[0].models.find((row: { lifecycle: { state: string }; nativeId: string }) => row.lifecycle.state === 'active' && row.nativeId === 'claude-sonnet-5-5');
  if (options.subscription) workerRegistry.profiles[0] = compileNativeCodingDockerProfile(workerRegistry.profiles[0], { schemaVersion: 4,
    provider: 'claude', cliVersion: '2.1.285 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
    model: { channelId: SEED_CHANNEL, modelId: workerModel.nativeId, auxiliaryModelIds: [] }, prompt: 'Prepare a purchase and business readback.' }) as typeof workerRegistry.profiles[0];
  if (options.template) {
    const base = fixtureDockerRegistry(['purchase']).profiles[0]!;
    const docker = Object.fromEntries(Object.entries(base.parameters).filter(([key]) => key !== 'argv'));
    workerRegistry.profiles[0] = { ...base, adapter: { id: 'native-coding-template', version: 1 }, parameters: { schemaVersion: 1, docker,
      invocation: { provider: 'claude', cliVersion: '2.1.285 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' } } } as unknown as typeof base;
  }
  const config = { layout: { root: data }, provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    terminal: { scopeId: 's', chat: { schemaVersion: 1, ...(options.model === 'missing' ? {} : { reference }), maxCompletionTokens: 8 } },
    ...(options.budget === null ? {} : { provider_spending: { ...fixtureBudget('s'), budgets: [{ ...fixtureBudget('s').budgets[0]!, limitMinorUnits: options.budget ?? 1000 }] } }),
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 2, ordering: 'input-order', registry: { ...workerRegistry, workClasses } } };
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '' }, loadOptions = { env };
  const modelRoles = options.modelRoles !== undefined ? options.modelRoles : { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'fixture-roles', roles: [],
    models: [{ channelId: reference.providerId, modelId: model.nativeId, version: 1, tier: 'frontier', roles: ['brain'] }], exceptions: [] }] };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify(config));
  const globalPath = await resolveGlobalConfigReadPath(env);
  await mkdir(dirname(globalPath), { recursive: true }); await writeFile(globalPath, JSON.stringify(modelRoles === null ? {} : { model_roles: modelRoles }));
  await loadComposedConfig(project, loadOptions);
  const { store, path } = await openConfiguredAttemptStore(project, loadOptions);
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } }); store.close();
  const principal = { ...readLocalOsIdentity(), scopeIds: ['s'] };
  const activation = new ModelActivationApplication({ verify: async () => principal }, { authorize: async () => ({ revision: 'seed', ruleId: 'seed' }) },
    new ModelBindingApplication({ read: async () => catalog }), () => openSqliteModelActivationStore(path, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' }), () => 1);
  if (options.model !== 'inactive') await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 's', reference,
    expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: binding });
  const grants = [
    { id: 'run', actions: ['create', 'inspect'], resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', actions: ['use'], resource: { kind: 'pool', ids: ['p'] } },
    { id: 'account', actions: ['inspect'], resource: { kind: 'provider-spend-account', ids: 'all' } },
    { id: 'invocation', actions: ['invoke', 'inspect', 'inspect-content', 'cancel'], resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } },
    ...(options.subscription ? [{ id: 'catalog', actions: ['activate'], resource: { kind: 'model-activation', ids: 'all' } }] : []),
    { id: 'approval', actions: ['inspect', 'decide'], resource: { kind: 'approval', ids: 'all' } },
  ].map(grant => ({ ...grant, effect: 'allow', scopes: grant.id === 'catalog' ? 'all' : ['s'], principals: [{ issuer: principal.issuer, subject: principal.subject }] }));
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'fixture-policy', restrictions: [], grants }), { mode: 0o600 });
  if (seed) {
    await applyModelCatalog(project, { schemaVersion: 1, commandId: 'worker-seed', scopeId: 's', action: 'register', catalog: seed }, loadOptions);
    for (const modelId of [null, workerModel.nativeId]) await applyModelCatalog(project, { schemaVersion: 1, commandId: 'worker-activate-' + modelId,
      scopeId: 's', action: 'activate', channelId: SEED_CHANNEL, modelId, expectedRevision: 0 }, loadOptions);
  }
  return { project, data, path, options: loadOptions, reference, config, bodies, counterBodies, get posts() { return posts; }, setOutput(value: string | ((body: string) => string)) { output = value; },
    async close() { clearConfigCache(); transport.mockRestore(); await rm(root, { recursive: true, force: true }); } };
}
