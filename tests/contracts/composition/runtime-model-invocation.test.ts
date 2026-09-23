import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { createConnection } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { encodeServiceFrame, openSqliteModelActivationStore, requestLocalRuntime } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, ModelInvocationControllers, modelInvocationRequestDigest, modelInvocationTargetId } from '#engine/index.js';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createPricedProviderTls, fixtureBudget, pricedProviderDefinition, replyPricedProviderMetadata } from '../../fixtures/priced-provider.js';

const roots: string[] = [], httpServers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [],
  heldReleases: (() => void)[] = [];
const execute = promisify(execFile);
const cli = resolve('dist/composition/core/cli/internal/entry.js'), mcp = resolve('dist/composition/core/mcp/internal/entry.js');
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
async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), 2_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function fixture(nativeTimeoutMs = 2_000) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-runtime-model-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  let metadataRequests = 0, requests = 0, releaseHeld: (() => void) | undefined, observeHeld: (() => void) | undefined,
    observeHeldClose: (() => void) | undefined, hold = false, heldPartial = false;
  heldReleases.push(() => releaseHeld?.());
  const heldObserved = () => new Promise<void>(resolve => { observeHeld = resolve; });
  const tls = await createPricedProviderTls(root);
  const native = createServer({ key: tls.key, cert: tls.caPem }, (request, reply) => {
    if (request.method === 'GET' && request.url === '/api/v1/models/vendor/model/endpoints') {
      metadataRequests++;
      if (metadataRequests === 2) { setTimeout(() => replyPricedProviderMetadata(request, reply), 10); return; }
      replyPricedProviderMetadata(request, reply); return;
    }
    if (request.url !== '/chat' || request.method !== 'POST') { reply.writeHead(404); reply.end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', async () => {
      requests++; if (hold) {
        if (heldPartial) {
          reply.once('close', () => observeHeldClose?.());
          reply.writeHead(200, { 'content-type': 'application/json' }); reply.write('{"id":"partial"');
        }
        observeHeld?.(); await new Promise<void>(resolve => { releaseHeld = resolve; }); hold = false;
        if (heldPartial) { heldPartial = false; reply.destroy(); return; }
      }
      reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify({ id: `response-${requests}`,
        object: 'chat.completion', created: 1, model: 'vendor/model', choices: [{ index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: 'done', refusal: null } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }); });
  httpServers.push(native); await new Promise<void>((resolve, reject) => { native.once('error', reject); native.listen(0, '127.0.0.1', resolve); });
  const address = native.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const origin = `https://127.0.0.1:${address.port}`;
  const reference = { providerId: 'openrouter', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const model = { id: 'model', version: 1, nativeId: 'vendor/model', protocols: [{ family: 'openrouter-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ id: 'openrouter', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'openrouter', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
    digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1 as const, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openrouter-chat-completions', version: 'v1' }, adapter: { id: 'openrouter-chat-http', version: 1,
      definition: pricedProviderDefinition(origin, tls.caPem) }, allocation: { id: 'allocation', maxCalls: 8, maxInFlight: 2 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 2048, timeoutMs: nativeTimeoutMs } };
  const config = { layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog,
    provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_spending: fixtureBudget(),
    mcp: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConcurrentCalls: 8 },
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
  const setMcpResponseMaxBytes = async (responseMaxBytes: number) => {
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ ...config,
      mcp: { ...config.mcp, responseMaxBytes } }), { mode: 0o600 });
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
    grants: allow ? [{ id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'],
      principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'model-invocation', ids: [target] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }],
      resource: { kind: 'scope', ids: ['scope'] } }] : [] }), { mode: 0o600 });
  await policy(true);
  const command = (commandId: string) => ({ schemaVersion: 1 as const, commandId, scopeId: 'scope', reference,
    catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'vendor/model', messages: [{ role: 'user', content: `prompt-${commandId}` }], max_completion_tokens: 4 } });
  const count = (commandId: string) => { const db = new DatabaseSync(ledger, { readOnly: true });
    try { return Number(db.prepare('SELECT count(*) AS count FROM model_invocations WHERE command_id=?').get(commandId)?.count); } finally { db.close(); } };
  const totalCount = () => { const db = new DatabaseSync(ledger, { readOnly: true });
    try { return Number(db.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count); } finally { db.close(); } };
  return { project, data, env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' }, ledger, reference, command, count, policy,
    setServiceResponseMaxBytes, setMcpResponseMaxBytes,
    totalCount, serviceOptions: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 8,
      headerTimeoutMs: 1000, responseTimeoutMs: 1000, acceptRetryDelayMs: 10, acceptRetryLimit: 2 },
    get metadataRequests() { return metadataRequests; }, get requests() { return requests; }, holdResponse() { hold = true; return heldObserved(); },
    heldResponseClosed() { return new Promise<void>(resolve => { observeHeldClose = resolve; }); },
    holdPartialResponse() { hold = true; heldPartial = true; return heldObserved(); },
    releaseResponse() { releaseHeld?.(); } };
}

it.skipIf(process.platform !== 'linux')('owns bounded invocation through current wire10 across disconnect, replay, restart and policy change', async () => {
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
  expect(f.metadataRequests).toBe(2); expect(f.requests).toBe(1); expect(f.count('shared')).toBe(1);
  const sharedQuery = { schemaVersion: 2 as const, scopeId: 'scope', invocationId: first.receipt.claim.invocationId, reference: f.reference };
  const sharedInspection = await firstClient.inspectModelInvocation(sharedQuery, { maxResultBytes: 60_000 });
  expect(sharedInspection.invocation).toEqual(fresh.receipt); expect(sharedInspection.spending).not.toBeNull();

  const held = f.command('disconnect'), observed = f.holdResponse();
  const raw = createConnection(service.endpoint); raw.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => { raw.once('connect', resolve); raw.once('error', reject); });
  raw.end(encodeServiceFrame({ schemaVersion: 11, requestId: randomUUID(), operation: 'invokeModel', input: held,
    delivery: { maxResultBytes: 60_000 } }, 65536));
  await within(observed, 'DISCONNECT_HTTP_NOT_OBSERVED'); raw.destroy();
  let drained = false; const stopping = service.stop().then(value => { drained = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
  f.releaseResponse(); expect(await stopping).toMatchObject({ state: 'clean' }); await service.done;
  await waitFor(() => f.count('disconnect') === 1, 'DISCONNECTED_CLAIM_MISSING');

  services.splice(services.indexOf(service), 1); service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const restarted = createConfiguredRuntimeClient(f.project, { env: f.env });
  const db = new DatabaseSync(f.ledger, { readOnly: true }); const row = db.prepare('SELECT invocation_id FROM model_invocations WHERE command_id=?').get('disconnect') as { invocation_id: string }; db.close();
  const disconnectedQuery = { schemaVersion: 2 as const, scopeId: 'scope', invocationId: row.invocation_id, reference: f.reference };
  expect((await restarted.inspectModelInvocation(disconnectedQuery, { maxResultBytes: 60_000 })).invocation?.outcome).toMatchObject({ state: 'responded' });
  expect(f.requests).toBe(2);

  expect(await service.stop()).toMatchObject({ state: 'clean' }); await service.done;
  services.splice(services.indexOf(service), 1); await f.setServiceResponseMaxBytes(1024);
  service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const forged = f.command('forged-cap');
  const forgedResponse = await requestLocalRuntime({ endpoint: service.endpoint, ...f.serviceOptions }, {
    schemaVersion: 11, requestId: randomUUID(), operation: 'invokeModel', input: forged,
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
  expirySocket.end(encodeServiceFrame({ schemaVersion: 11, requestId: randomUUID(), operation: 'invokeModel', input: expiring,
    delivery: { maxResultBytes: 60_000 } }, 65536));
  await within(expiryObserved, 'GRACE_EXPIRY_HTTP_NOT_OBSERVED'); expirySocket.destroy();
  expect(await service.stop()).toMatchObject({ state: 'incomplete', remainingRequests: 1 });
  expect(f.count('grace-expiry')).toBe(1); f.releaseResponse(); await service.done;
  services.splice(services.indexOf(service), 1); service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const expiryDb = new DatabaseSync(f.ledger, { readOnly: true });
  const expiryRow = expiryDb.prepare('SELECT invocation_id FROM model_invocations WHERE command_id=?').get('grace-expiry') as { invocation_id: string };
  expiryDb.close();
  const afterExpiry = createConfiguredRuntimeClient(f.project, { env: f.env });
  expect((await afterExpiry.inspectModelInvocation({ schemaVersion: 2, scopeId: 'scope', invocationId: expiryRow.invocation_id,
    reference: f.reference }, { maxResultBytes: 60_000 })).invocation?.outcome).toMatchObject({ state: 'responded' });
  expect(f.requests).toBe(3);

  await expect(afterExpiry.invokeModel(f.command('tiny'), { maxResultBytes: 64 })).rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
  expect(f.count('tiny')).toBe(0); expect(f.requests).toBe(3);
  expect((await afterExpiry.inspectModelInvocation(sharedQuery, { maxResultBytes: 60_000 })).spending).toEqual(sharedInspection.spending);
  await f.policy(false);
  await expect(afterExpiry.invokeModel(f.command('denied'), { maxResultBytes: 60_000 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.count('denied')).toBe(0); expect(f.requests).toBe(3);
    // This non-echo fixture checks request-body omission, not confidentiality of arbitrary provider responses.
  expect((await readFile(f.ledger)).includes(Buffer.from('prompt-shared'))).toBe(false);
}, 15_000);

it.skipIf(process.platform !== 'linux')('records live SDK cancellation while a partial native response remains ambiguous and capacity stays held', async () => {
  const f = await fixture(10_000), observer = { async onPage() {}, async onError() {} };
  const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const client = createConfiguredRuntimeClient(f.project, { env: f.env }), command = f.command('cancel-held-partial');
  const observed = f.holdPartialResponse(), closed = f.heldResponseClosed();
  const invocation = client.invokeModel(command, { maxResultBytes: 60_000 });
  await observed;
  const cancellation = { schemaVersion: 1 as const, commandId: 'cancel-held-partial-command', scopeId: 'scope',
    targetCommandId: command.commandId, reference: f.reference, expectedRequestDigest: modelInvocationRequestDigest(command) };
  try {
    const cancelled = await client.cancelModelInvocation(cancellation, { maxResultBytes: 60_000 });
    expect(cancelled).toMatchObject({ replayed: false, receipt: { command: cancellation, disposition: 'requested' } });
    expect(await client.cancelModelInvocation(cancellation, { maxResultBytes: 60_000 })).toEqual({ replayed: true, receipt: cancelled.receipt });
    const descriptor = await client.describeService(), audit = new DatabaseSync(f.ledger, { readOnly: true });
    try {
      expect(JSON.parse(String(audit.prepare('SELECT record FROM model_invocation_cancellations WHERE command_id=?')
        .get(cancellation.commandId)?.record))).toMatchObject({ command: cancellation, disposition: 'requested' });
      expect(JSON.parse(String(audit.prepare('SELECT record FROM model_invocation_controls').get()?.record)))
        .toMatchObject({ send: { state: 'permitted', ownerId: descriptor.instanceId } });
    } finally { audit.close(); }
    await within(closed, 'MODEL_INVOCATION_ABORT_NOT_OBSERVED');
    const settled = await within(invocation, 'MODEL_INVOCATION_ABORT_NOT_SETTLED');
    expect(settled.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error', evidence: { body: { complete: false } } });
    const inspection = await client.inspectModelInvocation({ schemaVersion: 2, scopeId: 'scope', invocationId: settled.receipt.claim.invocationId,
      reference: f.reference, includeResponseContent: true }, { maxResultBytes: 60_000 });
    expect(Buffer.from((inspection.responseContent as { data: string }).data, 'base64').toString('utf8')).toBe('{"id":"partial"');
    const allocation = new DatabaseSync(f.ledger, { readOnly: true });
    try { expect(allocation.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get())
      .toEqual({ lifetime_calls: 1, in_flight: 1 }); } finally { allocation.close(); }
    expect(f.requests).toBe(1);
  } finally { f.releaseResponse(); }
}, 15_000);

it.skipIf(process.platform !== 'linux')('recovers a durable requested cancellation after its live delivery fails', async () => {
  const f = await fixture(10_000);
  const modelPages: { readonly command: unknown; readonly result: { readonly outcomes: readonly { readonly status: string }[] } }[] = [];
  let releaseInitialPage!: () => void, observeInitialPage!: () => void, firstPage = true;
  const initialPage = new Promise<void>(resolve => { observeInitialPage = resolve; });
  const initialPageBarrier = new Promise<void>(resolve => { releaseInitialPage = resolve; });
  let initialPageReleased = false;
  const unblockInitialPage = () => { if (!initialPageReleased) { initialPageReleased = true; releaseInitialPage(); } };
  const observer = {
    async onPage() {}, async onError() {},
    async onModelCancellationPage(command: unknown, result: { readonly outcomes: readonly { readonly status: string }[] }) {
      modelPages.push({ command, result });
      if (firstPage) { firstPage = false; observeInitialPage(); await initialPageBarrier; }
    },
    async onModelCancellationError() { throw new Error('UNEXPECTED_MODEL_CANCELLATION_RECOVERY_ERROR'); },
  };
  let service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  await within(initialPage, 'MODEL_CANCELLATION_INITIAL_PAGE_MISSING').catch(error => { unblockInitialPage(); throw error; });
  const client = createConfiguredRuntimeClient(f.project, { env: f.env }), command = f.command('recover-cancel-held-partial');
  const observed = f.holdPartialResponse(), closed = f.heldResponseClosed();
  const invocation = client.invokeModel(command, { maxResultBytes: 60_000 });
  await observed;
  const cancellation = { schemaVersion: 1 as const, commandId: 'recover-cancel-held-partial-command', scopeId: 'scope',
    targetCommandId: command.commandId, reference: f.reference, expectedRequestDigest: modelInvocationRequestDigest(command) };
  const originalRequestAbort = ModelInvocationControllers.prototype.requestAbort;
  let injected = false;
  ModelInvocationControllers.prototype.requestAbort = function(control) {
    if (!injected) { injected = true; throw new Error('FIXTURE_ABORT_DELIVERY_FAILURE'); }
    return originalRequestAbort.call(this, control);
  };
  try {
    await expect(client.cancelModelInvocation(cancellation, { maxResultBytes: 60_000 })).rejects.toThrow();
    expect(injected).toBe(true);
    const audit = new DatabaseSync(f.ledger, { readOnly: true });
    try {
      expect(JSON.parse(String(audit.prepare('SELECT record FROM model_invocation_cancellations WHERE command_id=?')
        .get(cancellation.commandId)?.record))).toMatchObject({ command: cancellation, disposition: 'requested' });
    } finally { audit.close(); }
  } finally {
    ModelInvocationControllers.prototype.requestAbort = originalRequestAbort;
    unblockInitialPage();
  }
  try {
    await within(closed, 'MODEL_INVOCATION_RECOVERY_ABORT_NOT_OBSERVED');
    await waitFor(() => modelPages.some(page => page.result.outcomes.some(outcome => outcome.status === 'abort-requested')),
      'MODEL_INVOCATION_RECOVERY_ABORT_PAGE_MISSING');
    const settled = await within(invocation, 'MODEL_INVOCATION_RECOVERY_ABORT_NOT_SETTLED');
    expect(settled.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error', evidence: { body: { complete: false } } });
    const inspection = await client.inspectModelInvocation({ schemaVersion: 2, scopeId: 'scope', invocationId: settled.receipt.claim.invocationId,
      reference: f.reference, includeResponseContent: true }, { maxResultBytes: 60_000 });
    expect(Buffer.from((inspection.responseContent as { data: string }).data, 'base64').toString('utf8')).toBe('{"id":"partial"');
    expect(f.requests).toBe(1);
    const allocation = new DatabaseSync(f.ledger, { readOnly: true });
    try { expect(allocation.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get())
      .toEqual({ lifetime_calls: 1, in_flight: 1 }); } finally { allocation.close(); }

    expect(await service.stop()).toMatchObject({ state: 'clean' }); await service.done;
    services.splice(services.indexOf(service), 1);
    const restartPages: { readonly outcomes: readonly { readonly status: string }[] }[] = [];
    service = await startConfiguredRuntimeService(f.project, {
      async onPage() {}, async onError() {},
      async onModelCancellationPage(_command, result) { restartPages.push(result); },
      async onModelCancellationError() { throw new Error('UNEXPECTED_RESTART_MODEL_CANCELLATION_ERROR'); },
    }, { env: f.env });
    services.push(service);
    await waitFor(() => restartPages.some(page => page.outcomes.some(outcome => outcome.status === 'not-live')),
      'MODEL_INVOCATION_RESTART_NOT_LIVE_PAGE_MISSING');
    expect(f.requests).toBe(1);
    const restartedAllocation = new DatabaseSync(f.ledger, { readOnly: true });
    try { expect(restartedAllocation.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get())
      .toEqual({ lifetime_calls: 1, in_flight: 1 }); } finally { restartedAllocation.close(); }
  } finally { f.releaseResponse(); }
}, 20_000);

it.skipIf(process.platform !== 'linux')('records and replays a held model cancellation through the compiled CLI', async () => {
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); });
  const f = await fixture(10_000), observer = { async onPage() {}, async onError() {} };
  const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const client = createConfiguredRuntimeClient(f.project, { env: f.env }), command = f.command('cli-cancel-held-partial');
  const observed = f.holdPartialResponse(), closed = f.heldResponseClosed();
  const invocation = client.invokeModel(command, { maxResultBytes: 60_000 }); await observed;
  const cancellation = { schemaVersion: 1 as const, commandId: 'cli-cancel-held-partial-command', scopeId: 'scope',
    targetCommandId: command.commandId, reference: f.reference, expectedRequestDigest: modelInvocationRequestDigest(command) };
  const input = 'cli-cancel-held-partial.json'; await writeFile(join(f.project, input), JSON.stringify(cancellation), { mode: 0o600 });
  const cancel = async () => JSON.parse((await within(execute(process.execPath, [cli, 'models', 'cancel', '--input', input, '--json'], {
    cwd: f.project, env: f.env, timeout: 10_000, maxBuffer: 1_048_576,
  }), 'CLI_MODEL_CANCELLATION_TIMEOUT')).stdout) as unknown;
  try {
    const recorded = await cancel();
    expect(recorded).toMatchObject({ replayed: false, receipt: { command: cancellation, disposition: 'requested',
      claim: { scopeId: 'scope', commandId: command.commandId, requestDigest: cancellation.expectedRequestDigest } } });
    expect(await cancel()).toEqual({ ...(recorded as object), replayed: true });
    await within(closed, 'CLI_MODEL_CANCELLATION_ABORT_NOT_OBSERVED');
    const settled = await within(invocation, 'CLI_MODEL_CANCELLATION_ABORT_NOT_SETTLED');
    expect(recorded).toMatchObject({ receipt: { claim: { invocationId: settled.receipt.claim.invocationId } } });
    expect(settled.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error', evidence: { body: { complete: false } } });
    const allocation = new DatabaseSync(f.ledger, { readOnly: true });
    try { expect(allocation.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get())
      .toEqual({ lifetime_calls: 1, in_flight: 1 }); } finally { allocation.close(); }
    expect(f.requests).toBe(1);
  } finally { f.releaseResponse(); }
}, 20_000);

it.skipIf(process.platform !== 'linux')('records and replays a held model cancellation through real stdio MCP', async () => {
  await access(mcp).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); });
  const f = await fixture(10_000), observer = { async onPage() {}, async onError() {} };
  const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const client = createConfiguredRuntimeClient(f.project, { env: f.env }), command = f.command('mcp-cancel-held-partial');
  const observed = f.holdPartialResponse(), closed = f.heldResponseClosed();
  const invocation = client.invokeModel(command, { maxResultBytes: 60_000 }); await observed;
  const cancellation = { schemaVersion: 1 as const, commandId: 'mcp-cancel-held-partial-command', scopeId: 'scope',
    targetCommandId: command.commandId, reference: f.reference, expectedRequestDigest: modelInvocationRequestDigest(command) };
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', f.project], env: f.env, stderr: 'pipe' });
  const mcpClient = new Client({ name: 'runtime-model-invocation-cancellation-proof', version: '1' });
  try {
    await within(mcpClient.connect(transport), 'MCP_MODEL_CANCELLATION_CONNECT_TIMEOUT');
    const tool = (await within(mcpClient.listTools(), 'MCP_MODEL_CANCELLATION_LIST_TIMEOUT')).tools.find(value => value.name === 'cancel_model_invocation');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    const recorded = await within(mcpClient.callTool({ name: 'cancel_model_invocation', arguments: cancellation }), 'MCP_MODEL_CANCELLATION_TIMEOUT');
    expect(recorded.isError).not.toBe(true);
    expect(recorded.structuredContent).toMatchObject({ replayed: false, receipt: { command: cancellation, disposition: 'requested',
      claim: { scopeId: 'scope', commandId: command.commandId, requestDigest: cancellation.expectedRequestDigest } } });
    const replay = await within(mcpClient.callTool({ name: 'cancel_model_invocation', arguments: cancellation }), 'MCP_MODEL_CANCELLATION_REPLAY_TIMEOUT');
    expect(replay.isError).not.toBe(true); expect(replay.structuredContent).toEqual({ ...(recorded.structuredContent as object), replayed: true });
    await within(closed, 'MCP_MODEL_CANCELLATION_ABORT_NOT_OBSERVED');
    const settled = await within(invocation, 'MCP_MODEL_CANCELLATION_ABORT_NOT_SETTLED');
    expect(recorded.structuredContent).toMatchObject({ receipt: { claim: { invocationId: settled.receipt.claim.invocationId } } });
    expect(settled.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error', evidence: { body: { complete: false } } });
    const allocation = new DatabaseSync(f.ledger, { readOnly: true });
    try { expect(allocation.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get())
      .toEqual({ lifetime_calls: 1, in_flight: 1 }); } finally { allocation.close(); }
    expect(f.requests).toBe(1);
  } finally {
    f.releaseResponse();
    await mcpClient.close().catch(() => undefined); await transport.close().catch(() => undefined);
  }
}, 20_000);

it.skipIf(process.platform !== 'linux')('rejects an MCP cancellation before effect when its full response cannot fit', async () => {
  await access(mcp).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); });
  const f = await fixture(10_000), observer = { async onPage() {}, async onError() {} };
  const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const client = createConfiguredRuntimeClient(f.project, { env: f.env }), command = f.command('mcp-bounded-cancel-held-partial');
  const observed = f.holdPartialResponse(), closed = f.heldResponseClosed();
  let invocationSettled = false;
  const invocation = client.invokeModel(command, { maxResultBytes: 60_000 });
  void invocation.then(() => { invocationSettled = true; }, () => { invocationSettled = true; });
  await observed;
  const cancellation = { schemaVersion: 1 as const, commandId: 'mcp-bounded-cancel-command', scopeId: 'scope',
    targetCommandId: command.commandId, reference: f.reference, expectedRequestDigest: modelInvocationRequestDigest(command) };
  await f.setMcpResponseMaxBytes(1_024);
  const boundedTransport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', f.project], env: f.env, stderr: 'pipe' });
  const boundedClient = new Client({ name: 'runtime-model-invocation-bounded-cancellation-proof', version: '1' });
  try {
    await within(boundedClient.connect(boundedTransport), 'MCP_BOUNDED_CANCELLATION_CONNECT_TIMEOUT');
    const rejected = await within(boundedClient.callTool({ name: 'cancel_model_invocation', arguments: cancellation }),
      'MCP_BOUNDED_CANCELLATION_TIMEOUT');
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text',
      text: expect.stringContaining('MODEL_INVOCATION_RESULT_LIMIT') })]));
    const audit = new DatabaseSync(f.ledger, { readOnly: true });
    try {
      const row = audit.prepare(`SELECT control.record AS control_record,
        (SELECT count(*) FROM model_invocation_cancellations cancellation
          WHERE cancellation.scope_id=invocation.scope_id AND cancellation.invocation_id=invocation.invocation_id) AS cancellation_count
        FROM model_invocations invocation JOIN model_invocation_controls control
          ON control.scope_id=invocation.scope_id AND control.invocation_id=invocation.invocation_id
        WHERE invocation.command_id=?`).get(command.commandId) as { control_record: string; cancellation_count: number } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.control_record)).toMatchObject({ send: { state: 'permitted' }, cancellation: null });
      expect(row!.cancellation_count).toBe(0);
    } finally { audit.close(); }
    expect(invocationSettled).toBe(false);
  } finally {
    await boundedClient.close().catch(() => undefined); await boundedTransport.close().catch(() => undefined);
  }

  await f.setMcpResponseMaxBytes(65_536);
  const normalTransport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', f.project], env: f.env, stderr: 'pipe' });
  const normalClient = new Client({ name: 'runtime-model-invocation-normal-cancellation-proof', version: '1' });
  try {
    await within(normalClient.connect(normalTransport), 'MCP_NORMAL_CANCELLATION_CONNECT_TIMEOUT');
    const recorded = await within(normalClient.callTool({ name: 'cancel_model_invocation', arguments: cancellation }),
      'MCP_NORMAL_CANCELLATION_TIMEOUT');
    expect(recorded.isError).not.toBe(true);
    expect(recorded.structuredContent).toMatchObject({ replayed: false,
      receipt: { command: cancellation, disposition: 'requested' } });
    await within(closed, 'MCP_NORMAL_CANCELLATION_ABORT_NOT_OBSERVED');
    const settled = await within(invocation, 'MCP_NORMAL_CANCELLATION_ABORT_NOT_SETTLED');
    expect(settled.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error', evidence: { body: { complete: false } } });
  } finally {
    f.releaseResponse();
    await normalClient.close().catch(() => undefined); await normalTransport.close().catch(() => undefined);
  }
}, 20_000);

it.skipIf(process.platform !== 'linux')('completes compiled terminal line-mode turns as governed runtime invocations and stops at policy', async () => {
  await access(cli).catch(() => { throw new Error('BUILD_REQUIRED: run npm run build before this process proof'); });
  const f = await fixture(), observer = { async onPage() {}, async onError() {} };
  const configPath = join(f.project, '.deckent/config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  await writeFile(configPath, JSON.stringify({ ...config, terminal: { chat: { schemaVersion: 1, reference: f.reference, maxCompletionTokens: 4 } } }), { mode: 0o600 });
  clearConfigCache();
  const service = await startConfiguredRuntimeService(f.project, observer, { env: f.env }); services.push(service);
  const session = (input: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, 'terminal', 'session', '--scope', 'scope', '--lang', 'en'], { cwd: f.project, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); }); child.stdin.end(input);
  });
  const answered = await session('first question\nsecond question\n');
  expect(answered.code, answered.stderr).toBe(0);
  expect(answered.stdout.split('\n').filter(line => line === 'done')).toHaveLength(2);
  expect(f.requests).toBe(2); expect(f.totalCount()).toBe(2);
  await f.policy(false);
  const denied = await session('third question\n');
  expect(denied.code).toBe(0); expect(`${denied.stdout}${denied.stderr}`).toMatch(/\[[A-Z_]+\]/);
  expect(denied.stdout).not.toContain('done'); expect(f.requests).toBe(2);
}, 30_000);
