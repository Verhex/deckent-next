import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { encodeServiceFrame, openSqliteModelActivationStore, requestLocalRuntime } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const roots: string[] = [], httpServers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [],
  heldReleases: (() => void)[] = [];
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
afterEach(async () => {
  for (const release of heldReleases.splice(0)) release();
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  await Promise.all(httpServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function waitFor(check: () => boolean, label: string) {
  const until = Date.now() + 5_000;
  while (!check()) { if (Date.now() >= until) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 5)); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-runtime-model-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  let requests = 0, releaseHeld: (() => void) | undefined, observeHeld: (() => void) | undefined, hold = false;
  heldReleases.push(() => releaseHeld?.());
  const heldObserved = () => new Promise<void>(resolve => { observeHeld = resolve; });
  const native = createServer((request, reply) => { const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', async () => {
      requests++; if (hold) { observeHeld?.(); await new Promise<void>(resolve => { releaseHeld = resolve; }); hold = false; }
      reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify({ id: `response-${requests}`,
        object: 'chat.completion', created: 1, model: 'native-model', choices: [{ index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: 'done', refusal: null } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }); });
  httpServers.push(native); await new Promise<void>((resolve, reject) => { native.once('error', reject); native.listen(0, '127.0.0.1', resolve); });
  const address = native.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const model = { id: 'model', version: 1, nativeId: 'native-model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ id: 'provider', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'provider', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
    digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1 as const, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 1,
      definition: { origin: `http://127.0.0.1:${address.port}`, maxOutputTokens: 8 } }, allocation: { id: 'allocation', maxCalls: 8, maxInFlight: 2 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 2048, timeoutMs: 2_000 } };
  const config = { layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog,
    provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 50 } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify(config), { mode: 0o600 });
  const setServiceResponseMaxBytes = async (responseMaxBytes: number) => {
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ ...config,
      service: { ...config.service, responseMaxBytes } }), { mode: 0o600 });
    clearConfigCache();
  };
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { id: `os:${userInfo().uid}`, issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding });
  const policyPath = join(data, 'policy.json'), target = modelInvocationTargetId(reference);
  const policy = async (allow: boolean) => writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: allow ? 'allow' : 'deny', restrictions: [],
    grants: allow ? [{ id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect'], scopes: ['scope'],
      principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'model-invocation', ids: [target] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }],
      resource: { kind: 'scope', ids: ['scope'] } }] : [] }), { mode: 0o600 });
  await policy(true);
  const command = (commandId: string) => ({ schemaVersion: 1 as const, commandId, scopeId: 'scope', reference,
    catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'native-model', messages: [{ role: 'user', content: `prompt-${commandId}` }], max_completion_tokens: 4 } });
  const count = (commandId: string) => { const db = new DatabaseSync(ledger, { readOnly: true });
    try { return Number(db.prepare('SELECT count(*) AS count FROM model_invocations WHERE command_id=?').get(commandId)?.count); } finally { db.close(); } };
  const totalCount = () => { const db = new DatabaseSync(ledger, { readOnly: true });
    try { return Number(db.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count); } finally { db.close(); } };
  return { project, data, env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' }, ledger, reference, command, count, policy,
    setServiceResponseMaxBytes,
    totalCount, serviceOptions: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 8,
      headerTimeoutMs: 1000, responseTimeoutMs: 1000, acceptRetryDelayMs: 10, acceptRetryLimit: 2 },
    get requests() { return requests; }, holdResponse() { hold = true; return heldObserved(); }, releaseResponse() { releaseHeld?.(); } };
}

it.skipIf(process.platform !== 'linux')('owns bounded invocation through wire3 across disconnect, replay, restart and policy change', async () => {
  const f = await fixture(), observer = { async onPage() {}, async onError() {} };
  let service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const incomplete = createConnection(service.endpoint); incomplete.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => { incomplete.once('connect', resolve); incomplete.once('error', reject); });
  incomplete.end(Buffer.from([0, 0, 0, 100, 123])); await new Promise<void>(resolve => incomplete.once('close', () => resolve()));
  expect(f.totalCount()).toBe(0); expect(f.requests).toBe(0);

  const firstClient = createConfiguredRuntimeClient(f.project, { env: f.env }), secondClient = createConfiguredRuntimeClient(f.project, { env: f.env });
  const shared = f.command('shared'), [first, second] = await Promise.all([
    firstClient.invokeModel(shared, { maxResultBytes: 60_000 }), secondClient.invokeModel(shared, { maxResultBytes: 60_000 }),
  ]);
  expect([first.replayed, second.replayed].sort()).toEqual([false, true]); expect(first.receipt.claim).toEqual(second.receipt.claim);
  const fresh = first.replayed ? second : first;
  expect(f.requests).toBe(1); expect(f.count('shared')).toBe(1);
  const sharedQuery = { schemaVersion: 1 as const, scopeId: 'scope', invocationId: first.receipt.claim.invocationId, reference: f.reference };
  expect((await firstClient.inspectModelInvocation(sharedQuery, { maxResultBytes: 60_000 })).invocation).toEqual(fresh.receipt);

  const held = f.command('disconnect'), observed = f.holdResponse();
  const raw = createConnection(service.endpoint); raw.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => { raw.once('connect', resolve); raw.once('error', reject); });
  raw.end(encodeServiceFrame({ schemaVersion: 3, requestId: randomUUID(), operation: 'invokeModel', input: held,
    delivery: { maxResultBytes: 60_000 } }, 65536));
  await observed; raw.destroy();
  let drained = false; const stopping = service.stop().then(value => { drained = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
  f.releaseResponse(); expect(await stopping).toMatchObject({ state: 'clean' }); await service.done;
  await waitFor(() => f.count('disconnect') === 1, 'DISCONNECTED_CLAIM_MISSING');

  services.splice(services.indexOf(service), 1); service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const restarted = createConfiguredRuntimeClient(f.project, { env: f.env });
  const db = new DatabaseSync(f.ledger, { readOnly: true }); const row = db.prepare('SELECT invocation_id FROM model_invocations WHERE command_id=?').get('disconnect') as { invocation_id: string }; db.close();
  const disconnectedQuery = { schemaVersion: 1 as const, scopeId: 'scope', invocationId: row.invocation_id, reference: f.reference };
  expect((await restarted.inspectModelInvocation(disconnectedQuery, { maxResultBytes: 60_000 })).invocation?.outcome).toMatchObject({ state: 'responded' });
  expect(f.requests).toBe(2);

  expect(await service.stop()).toMatchObject({ state: 'clean' }); await service.done;
  services.splice(services.indexOf(service), 1); await f.setServiceResponseMaxBytes(1024);
  service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const forged = f.command('forged-cap');
  const forgedResponse = await requestLocalRuntime({ endpoint: service.endpoint, ...f.serviceOptions }, {
    schemaVersion: 3, requestId: randomUUID(), operation: 'invokeModel', input: forged,
    delivery: { maxResultBytes: Number.MAX_SAFE_INTEGER },
  });
  expect(forgedResponse).toMatchObject({ ok: false, error: { code: 'MODEL_INVOCATION_RESULT_LIMIT' } });
  expect(f.count('forged-cap')).toBe(0); expect(f.requests).toBe(2);
  expect(await service.stop()).toMatchObject({ state: 'clean' }); await service.done;
  services.splice(services.indexOf(service), 1); await f.setServiceResponseMaxBytes(65536);
  service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);

  const expiring = f.command('grace-expiry'), expiryObserved = f.holdResponse();
  const expirySocket = createConnection(service.endpoint); expirySocket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => { expirySocket.once('connect', resolve); expirySocket.once('error', reject); });
  expirySocket.end(encodeServiceFrame({ schemaVersion: 3, requestId: randomUUID(), operation: 'invokeModel', input: expiring,
    delivery: { maxResultBytes: 60_000 } }, 65536));
  await expiryObserved; expirySocket.destroy();
  expect(await service.stop()).toMatchObject({ state: 'incomplete', remainingRequests: 1 });
  expect(f.count('grace-expiry')).toBe(1); f.releaseResponse(); await service.done;
  services.splice(services.indexOf(service), 1); service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const expiryDb = new DatabaseSync(f.ledger, { readOnly: true });
  const expiryRow = expiryDb.prepare('SELECT invocation_id FROM model_invocations WHERE command_id=?').get('grace-expiry') as { invocation_id: string };
  expiryDb.close();
  const afterExpiry = createConfiguredRuntimeClient(f.project, { env: f.env });
  expect((await afterExpiry.inspectModelInvocation({ schemaVersion: 1, scopeId: 'scope', invocationId: expiryRow.invocation_id,
    reference: f.reference }, { maxResultBytes: 60_000 })).invocation?.outcome).toMatchObject({ state: 'responded' });
  expect(f.requests).toBe(3);

  await expect(afterExpiry.invokeModel(f.command('tiny'), { maxResultBytes: 64 })).rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
  expect(f.count('tiny')).toBe(0); expect(f.requests).toBe(3);
  await f.policy(false);
  await expect(afterExpiry.invokeModel(f.command('denied'), { maxResultBytes: 60_000 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.count('denied')).toBe(0); expect(f.requests).toBe(3);
  expect((await readFile(f.ledger)).includes(Buffer.from('prompt-shared'))).toBe(false);
}, 15_000);
