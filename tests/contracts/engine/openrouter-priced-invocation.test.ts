import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOpenRouterPricedNative } from '#adapters/core/provider-openrouter-chat/index.js';
import { fetchOpenRouterTariff } from '#adapters/core/provider-openrouter-pricing/index.js';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, resolveModelBindingDefinition } from '#domain/index.js';
import { ModelInvocationApplication, parseProviderSpendReservation } from '#engine/index.js';

const execute = promisify(execFile), sqlite = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
let directory = '', certificate = '', privateKey = '', server: Server | undefined;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'deckent-openrouter-priced-'));
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', key, '-out', cert,
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  [privateKey, certificate] = await Promise.all([readFile(key, 'utf8'), readFile(cert, 'utf8')]);
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await rm(directory, { recursive: true, force: true });
});
const reference = { providerId: 'openrouter', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'openrouter', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'vendor/model',
    protocols: [{ family: 'openrouter-chat-completions', version: 'v1', capabilities: [] }] }] }] }, reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const principal = { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user' as const, scopeIds: ['scope'] };
const prices = (prompt = '0.000001') => ({ prompt, completion: '0.000002', request: '0', input_cache_read: '0', input_cache_write: '0', internal_reasoning: '0' });
const metadata = (pricing: Record<string, unknown>) => ({ data: { id: 'vendor/model', endpoints: [{ model_id: 'vendor/model', tag: 'provider/region',
  provider_name: 'Synthetic Provider', context_length: 4096, max_prompt_tokens: 1000, max_completion_tokens: 32, status: 0,
  supported_parameters: ['max_completion_tokens'], pricing }] } });

async function fixture(pricing: Record<string, unknown> = prices()) {
  let metadataDocument = metadata(pricing), posts = 0, metadataGets = 0, serviceOpen = true;
  server = createServer({ key: privateKey, cert: certificate }, (request, response) => {
    if (request.url === '/api/v1/models/vendor/model/endpoints') {
      metadataGets++; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(metadataDocument)); return;
    }
    if (request.url === '/chat' && request.method === 'POST') {
      posts++; request.resume(); response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'response', object: 'chat.completion', created: 1, model: 'vendor/model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] })); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE');
  const root = await mkdtemp(join(tmpdir(), 'deckent-openrouter-priced-ledger-')), path = join(root, 'ledger.db');
  const origin = `https://127.0.0.1:${address.port}`, metadataEndpoint = `${origin}/api/v1/models/vendor/model/endpoints`;
  const fetchObservation = () => fetchOpenRouterTariff({ endpoint: metadataEndpoint, modelId: 'vendor/model', endpointTag: 'provider/region',
    maxAgeMs: 60_000, maxResponseBytes: 64_000, timeoutMs: 1000, caPem: certificate }, Date.now);
  let observation = await fetchObservation();
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openrouter-chat-completions', version: 'v1' }, adapter: { id: 'openrouter-chat-http', version: 1,
      definition: { endpoint: `${origin}/chat`, authentication: { type: 'none' }, tls: { caPem: certificate }, maxOutputTokens: 32,
        metadataEndpoint, endpointTag: 'provider/region', metadataLimits: { maxAgeMs: 60_000, maxResponseBytes: 64_000, timeoutMs: 1000 } } }, allocation: { id: 'calls', maxCalls: 4, maxInFlight: 4 },
    limits: { requestMaxBytes: 8192, responseMaxBytes: 8192, timeoutMs: 1000 } };
  const activations = await openSqliteModelActivationStore(path, sqlite);
  const activation = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor: {
      id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance,
    },
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition }); activations.close();
  const budget = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 };
  let sequence = 0;
  const priced = createOpenRouterPricedNative({ currentObservation: () => observation, now: Date.now });
  const application = (authorize = async (input: Parameters<typeof priced.quote>[0]) => ({ budget, quote: priced.quote(input) })) =>
    new ModelInvocationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'policy', ruleId: 'invoke' }; } },
      { async inspect() { return { schemaVersion: 1, reference, status: 'declared' as const, catalogRevision: 'catalog', definition, binding, availability: 'not-observed' as const }; } },
      async () => ({ async loadRecord() { return activation.receipt.record; }, close() {} }), { async resolve() { return profile; } },
      { resolve() { return priced.native; } }, async () => openSqliteModelInvocationStore(path, sqlite, 'forbid'),
      { invocationId: () => `invocation-${++sequence}`, ownerId: () => 'runtime', now: Date.now }, { authorize });
  const command = (commandId: string) => ({ schemaVersion: 1 as const, commandId, scopeId: 'scope', reference,
    catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'vendor/model', messages: [{ role: 'user' as const, content: 'private prompt' }], max_completion_tokens: 8 } });
  const counts = () => { const db = new DatabaseSync(path, { readOnly: true }); try { return {
    invocations: db.prepare('SELECT count(*) AS count FROM model_invocations').get()!.count,
    reservations: db.prepare('SELECT count(*) AS count FROM model_invocation_spend_reservations').get()!.count,
  }; } finally { db.close(); } };
  const stopService = async () => {
    if (!serviceOpen) return;
    serviceOpen = false; server!.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
  };
  return { application, command, counts, path, priced, fetchObservation, stopService,
    setMetadata(value: ReturnType<typeof metadata>) { metadataDocument = value; },
    setObservation(value: typeof observation) { observation = value; }, get observation() { return observation; }, get posts() { return posts; }, get metadataGets() { return metadataGets; },
    async close() { await stopService(); await rm(root, { recursive: true, force: true }); } };
}

it('reserves from the actual native-produced quote, holds missing usage, and replays without another POST or reservation', async () => {
  const f = await fixture();
  try {
    const first = await f.application().invoke(f.command('one'));
    expect(first.receipt.outcome?.state).toBe('responded'); expect(f.posts).toBe(1); expect(f.counts()).toEqual({ invocations: 1, reservations: 1 });
    const db = new DatabaseSync(f.path, { readOnly: true });
    let persisted: ReturnType<typeof parseProviderSpendReservation>;
    try {
      persisted = parseProviderSpendReservation(JSON.parse(String(
        db.prepare('SELECT record FROM model_invocation_spend_reservations').get()!.record)));
      expect(persisted).toMatchObject({ descriptor: { quote: {
        pricing: { id: 'openrouter-endpoint-tariff', definition: { modelId: 'vendor/model', endpointTag: 'provider/region', pricing: prices() } },
        meter: { id: 'openrouter-text-reservation', evidence: { schemaVersion: 1, sourceBodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          calculation: { currency: 'USD', rounding: 'ceil-per-dimension', minorUnitsPerCurrencyUnit: 100 },
          pricedDimensions: ['completion', 'input_cache_read', 'input_cache_write', 'internal_reasoning', 'prompt', 'request'],
          unpricedDimensions: [],
          bodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/), reservation: { maxPromptTokens: 1000, maxCompletionTokens: 8,
            maxChargeMinorUnits: 2, currency: 'USD' } } },
      } }, disposition: { state: 'held', reason: 'missing-usage' } });
      expect(persisted.descriptor.quote.meter.evidence.tariffDigest).toBe(persisted.descriptor.quote.pricing.digest);
      const serializedQuote = JSON.stringify(persisted.descriptor.quote);
      expect(serializedQuote).not.toContain('private prompt');
      expect(serializedQuote).not.toContain('synthetic credential');
    } finally { db.close(); }
    expect(await f.application().invoke(f.command('one'))).toEqual({ ...first, replayed: true });
    expect(f.posts).toBe(1); expect(f.counts()).toEqual({ invocations: 1, reservations: 1 });

    f.setMetadata(metadata(prices('0.000009')));
    const changed = await f.fetchObservation();
    expect(changed.tariff.tariffDigest).not.toBe(persisted.descriptor.quote.pricing.digest);
    await f.stopService();
    const reopened = await openSqliteModelInvocationReader(f.path, { busyTimeoutMs: 2000 });
    try {
      const inspection = await reopened.loadInspection('scope', first.receipt.claim.invocationId);
      expect(inspection?.spending).toEqual(persisted);
      expect(inspection?.spending?.descriptor.quote.pricing.definition.pricing).toEqual(prices());
      expect(inspection?.spending?.descriptor.quote.meter.evidence.reservation).toEqual(
        persisted.descriptor.quote.meter.evidence.reservation);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

it('rejects tampered nested tariff data even when its outer quote and row checksums are recomputed', async () => {
  const f = await fixture();
  try {
    const result = await f.application().invoke(f.command('tamper'));
    await f.stopService();
    const db = new DatabaseSync(f.path);
    try {
      const row = db.prepare('SELECT record FROM model_invocation_spend_reservations WHERE scope_id=? AND invocation_id=?')
        .get('scope', result.receipt.claim.invocationId)!;
      const record = JSON.parse(String(row.record));
      record.descriptor.quote.pricing.definition.pricing.prompt = '0.999999';
      record.descriptor.quoteDigest = createHash('sha256').update(
        `deckent.provider-spend-quote.v1\n${JSON.stringify(record.descriptor.quote)}`).digest('hex');
      const serialized = JSON.stringify(record);
      const rowDigest = createHash('sha256').update(`deckent.provider-spend-reservation.v1\n${serialized}`).digest('hex');
      db.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE scope_id=? AND invocation_id=?')
        .run(serialized, rowDigest, 'scope', result.receipt.claim.invocationId);
    } finally { db.close(); }
    const reopened = await openSqliteModelInvocationReader(f.path, { busyTimeoutMs: 2000 });
    try { await expect(reopened.loadInspection('scope', result.receipt.claim.invocationId)).rejects.toThrow(); }
    finally { reopened.close(); }
  } finally { await f.close(); }
});

it.each(['missing-price', 'missing-request-price', 'fake-observation', 'currency'] as const)('rejects %s before claim, reservation, or POST', async kind => {
  const pricing: Record<string, unknown> = kind === 'missing-price' ? { prompt: '0.000001', completion: '0.000002' } : prices();
  if (kind === 'missing-request-price') delete pricing.request;
  const f = await fixture(pricing);
  try {
    if (kind === 'fake-observation') f.setObservation({ ...f.observation, receivedBytes: f.observation.receivedBytes + 1 });
    const app = kind === 'currency' ? f.application(async input => ({ budget: { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget',
      revision: 1, currency: 'EUR', limitMinorUnits: 1000 }, quote: f.priced.quote(input) })) : f.application();
    await expect(app.invoke(f.command(kind))).rejects.toThrow();
    expect(f.posts).toBe(0); expect(f.counts()).toEqual({ invocations: 0, reservations: 0 });
  } finally { await f.close(); }
});

it('rejects an observation change between the two quote checks before durable effects', async () => {
  const f = await fixture();
  try {
    f.setMetadata(metadata(prices('0.000003'))); const changed = await f.fetchObservation(); let calls = 0;
    const app = f.application(async input => {
      const quote = f.priced.quote(input);
      if (++calls === 1) f.setObservation(changed);
      return { budget: { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 }, quote };
    });
    await expect(app.invoke(f.command('changed'))).rejects.toThrow(); expect(calls).toBe(1);
    expect(f.posts).toBe(0); expect(f.counts()).toEqual({ invocations: 0, reservations: 0 });
  } finally { await f.close(); }
});
