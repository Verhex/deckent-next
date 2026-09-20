import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { encodeModelBindingDefinition } from '#domain/index.js';
import * as adapters from '#adapters/index.js';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteModelInvocationStore,
  openSqliteProviderSpendIntegrityReader, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId, verifyProviderSpendIntegrity } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const execute = promisify(execFile), roots: string[] = [], servers: Server[] = [];
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
  server.closeAllConnections(); server.close(() => resolve());
}))); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(withBudget = true, allow = true, completePricing = true) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-openrouter-composition-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(data), mkdir(home)]);
  const keyPath = join(root, 'key.pem'), certPath = join(root, 'cert.pem');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  const [key, caPem] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);
  let metadataGets = 0, posts = 0;
  const server = createServer({ key, cert: caPem }, (request, response) => {
    if (request.url === '/api/v1/models/vendor/model/endpoints') {
      metadataGets++; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: { id: 'vendor/model', endpoints: [{
        model_id: 'vendor/model', tag: 'provider/region', provider_name: 'Fixture', context_length: 4096, max_prompt_tokens: 1000,
        max_completion_tokens: 32, status: 0, supported_parameters: ['max_completion_tokens'],
        pricing: { prompt: '0.000001', completion: '0.000002', ...(completePricing ? { request: '0' } : {}),
          input_cache_read: '0', input_cache_write: '0', internal_reasoning: '0' },
      }] } })); return;
    }
    if (request.url === '/chat' && request.method === 'POST') {
      posts++; request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({
        id: 'response', object: 'chat.completion', created: 1, model: 'vendor/model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      })); return;
    }
    response.writeHead(404); response.end();
  });
  servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE');
  const origin = `https://127.0.0.1:${address.port}`, reference = { providerId: 'openrouter', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const model = { id: 'model', version: 1, nativeId: 'vendor/model', protocols: [{ family: 'openrouter-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ id: 'openrouter', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'openrouter', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
    digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openrouter-chat-completions', version: 'v1' }, adapter: { id: 'openrouter-chat-http', version: 1,
      definition: { endpoint: `${origin}/chat`, authentication: { type: 'none' }, tls: { caPem }, maxOutputTokens: 32,
        metadataEndpoint: `${origin}/api/v1/models/vendor/model/endpoints`, endpointTag: 'provider/region',
        metadataLimits: { maxAgeMs: 60_000, maxResponseBytes: 64_000, timeoutMs: 1000 } } },
    allocation: { id: 'allocation', maxCalls: 3, maxInFlight: 2 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 8192, timeoutMs: 2000 } };
  const config: Record<string, unknown> = { layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog,
    provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] } };
  if (withBudget) config['provider_spending'] = { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 }] };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify(config), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { ...readLocalOsIdentity(), scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding });
  const policyPath = join(data, 'policy.json');
  const policy = (enabled: boolean) => ({ schemaVersion: 1, revision: enabled ? 'allow' : 'deny', restrictions: [], grants: enabled ? [{
    id: 'invoke', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }],
    resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] },
  }] : [] });
  const writePolicy = (enabled: boolean) => writeFile(policyPath, JSON.stringify(policy(enabled)), { mode: 0o600 });
  await writePolicy(allow);
  const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'vendor/model', messages: [{ role: 'user' as const, content: 'private prompt' }], max_completion_tokens: 8 } };
  return { project, ledger, config, configPath: join(project, '.deckent/config.json'), policyPath, policy, writePolicy,
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' }, command,
    get metadataGets() { return metadataGets; }, get posts() { return posts; } };
}

it('acquires one native tariff, persists one reservation, and replays without refetch or repost', async () => {
  const f = await fixture(); const first = await invokeConfiguredModel(f.project, f.command, { env: f.env });
  expect(first.receipt.outcome?.state).toBe('responded'); expect([f.metadataGets, f.posts]).toEqual([1, 1]);
  const invocationReader = await openSqliteModelInvocationReader(f.ledger, { busyTimeoutMs: 1000 });
  let persisted;
  try { persisted = await invocationReader.loadInspection('scope', first.receipt.claim.invocationId); }
  finally { invocationReader.close(); }
  expect(persisted?.spending).toMatchObject({ schemaVersion: 1, descriptor: { scopeId: 'scope', invocationId: first.receipt.claim.invocationId,
    budgetId: 'budget', budgetRevision: 1, currency: 'USD', quote: { maxChargeMinorUnits: 2,
      pricing: { id: 'openrouter-endpoint-tariff', version: 1, definition: expect.objectContaining({ modelId: 'vendor/model', endpointTag: 'provider/region' }) },
      meter: { id: 'openrouter-text-reservation', version: 1, evidence: expect.objectContaining({ tariffDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }) } } },
    disposition: { state: 'held', reason: 'missing-usage', observedMinorUnits: null, evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  const spendReader = await openSqliteProviderSpendIntegrityReader(f.ledger, { busyTimeoutMs: 1000 });
  let beforeReplay;
  try { beforeReplay = await verifyProviderSpendIntegrity(spendReader, 'scope', 10); }
  finally { spendReader.close(); }
  expect(beforeReplay).toMatchObject({ reservationCount: 1, reservedMinorUnits: 2, settledMinorUnits: 0,
    checkpoint: { account: { reservedMinorUnits: 2, settledMinorUnits: 0, frozen: false } } });
  expect((await invokeConfiguredModel(f.project, f.command, { env: f.env })).replayed).toBe(true);
  expect([f.metadataGets, f.posts]).toEqual([1, 1]);
  const replayReader = await openSqliteProviderSpendIntegrityReader(f.ledger, { busyTimeoutMs: 1000 });
  try { await expect(verifyProviderSpendIntegrity(replayReader, 'scope', 10)).resolves.toEqual(beforeReplay); }
  finally { replayReader.close(); }
});

it.each([[false, true], [true, false]] as const)('denies missing budget or policy before metadata acquisition', async (budget, policy) => {
  const f = await fixture(budget, policy);
  await expect(invokeConfiguredModel(f.project, f.command, { env: f.env })).rejects.toThrow();
  expect([f.metadataGets, f.posts]).toEqual([0, 0]);
});

it('rejects incomplete tariff pricing before a claim or native POST', async () => {
  const f = await fixture(true, true, false);
  await expect(invokeConfiguredModel(f.project, f.command, { env: f.env })).rejects.toThrow();
  expect([f.metadataGets, f.posts]).toEqual([1, 0]);
  const store = await openSqliteModelInvocationStore(f.ledger, sqlite, 'forbid');
  try { await expect(store.loadReceipt('scope', f.command.commandId)).resolves.toBeNull(); }
  finally { store.close(); }
});

async function expectNoAcquisitionEffects(f: Awaited<ReturnType<typeof fixture>>) {
  expect([f.metadataGets, f.posts]).toEqual([0, 0]);
  const reader = await openSqliteProviderSpendIntegrityReader(f.ledger, { busyTimeoutMs: 1000 });
  try { await expect(verifyProviderSpendIntegrity(reader, 'scope', 10)).resolves.toBeNull(); }
  finally { reader.close(); }
}

it('rechecks revoked invoke policy before selected native metadata acquisition', async () => {
  const f = await fixture(), original = adapters.createOpenRouterPricedNative;
  vi.spyOn(adapters, 'createOpenRouterPricedNative').mockImplementation(options => {
    writeFileSync(f.policyPath, JSON.stringify(f.policy(false)), { mode: 0o600 }); clearConfigCache(); return original(options);
  });
  await expect(invokeConfiguredModel(f.project, f.command, { env: f.env })).rejects.toThrow();
  await expectNoAcquisitionEffects(f);
});

it('rechecks the configured profile before selected native metadata acquisition', async () => {
  const f = await fixture(), original = adapters.createOpenRouterPricedNative;
  vi.spyOn(adapters, 'createOpenRouterPricedNative').mockImplementation(options => {
    writeFileSync(f.configPath, JSON.stringify({ ...f.config,
      provider_invocation_profiles: { schemaVersion: 1, profiles: [] } }), { mode: 0o600 }); clearConfigCache(); return original(options);
  });
  await expect(invokeConfiguredModel(f.project, f.command, { env: f.env })).rejects.toThrow();
  await expectNoAcquisitionEffects(f);
});
