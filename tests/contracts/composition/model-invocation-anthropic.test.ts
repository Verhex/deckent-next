import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, afterEach, expect, it } from 'vitest';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { anthropicPublishedTariff, openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteProviderSpendIntegrityReader, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId, verifyProviderSpendIntegrity } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createLocalTls } from '../../fixtures/local-tls.js';

// The governed invocation path (policy, activation, allocation, budget reservation, receipt) over a real https Anthropic-shaped
// server: no real API is ever called. The key comes only from the injected secret resolver, by reference.
const roots: string[] = [], servers: Server[] = [];
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
const SECRET = 'sk-ant-api03-composition_secret-42', MODEL = 'claude-sonnet-5-5';
afterEach(async () => {
  clearConfigCache();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

type Reply = (response: ServerResponse) => void;
async function fixture(limitMinorUnits = 1000, allow = true, reply?: Reply) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-anthropic-composition-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(data), mkdir(home)]);
  const { key, caPem } = await createLocalTls(root);
  const seen: { headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer({ key, cert: caPem }, (request, response) => {
    const chunks: Buffer[] = []; request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      seen.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (reply) { reply(response); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } }));
    });
  });
  servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE');
  const endpoint = `https://127.0.0.1:${address.port}/v1/messages`, reference = { providerId: 'anthropic', providerVersion: 1, modelId: 'sonnet', modelVersion: 1 };
  const model = { id: 'sonnet', version: 1, nativeId: MODEL, protocols: [{ family: 'anthropic-messages', version: '2023-06-01', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ id: 'anthropic', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'anthropic', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'anthropic-messages', version: '2023-06-01' }, adapter: { id: 'anthropic-messages-http', version: 2,
      definition: { endpoint, maxOutputTokens: 64, authentication: { type: 'header', name: 'x-api-key', credentialRef: 'ANTHROPIC_API_KEY' }, tls: { caPem },
        tariff: anthropicPublishedTariff(MODEL) } },
    allocation: { id: 'allocation', maxCalls: 3, maxInFlight: 2 }, limits: { requestMaxBytes: 8192, responseMaxBytes: 8192, timeoutMs: 2000 } };
  const config = { layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    provider_spending: { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits }] } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify(config), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { ...readLocalOsIdentity(), scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: allow ? 'allow' : 'deny', restrictions: [], grants: allow ? [{
    id: 'invoke', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }],
    resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } }] : [] }), { mode: 0o600 });
  const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: MODEL, messages: [{ role: 'user' as const, content: 'private prompt' }], max_completion_tokens: 8 } };
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const streamed = { ...command, commandId: 'streamed', nativeRequest: { ...command.nativeRequest, stream: true, stream_options: { include_usage: true as const } } };
  return { project, ledger, command, streamed, env, seen, secretResolver: async (reference: string) => reference === 'ANTHROPIC_API_KEY' ? SECRET : undefined };
}

describe.skipIf(process.platform === 'win32')('requires POSIX local principal; AUTHENTICATION_REQUIRED on Windows UID -1', () => {
it('runs the governed invocation with the key resolved by reference only, reserves the tariff bound and keeps the secret out of durable records', async () => {
  const f = await fixture();
  const first = await invokeConfiguredModel(f.project, f.command, { env: f.env, secretResolver: f.secretResolver });
  expect(first.receipt.outcome?.state).toBe('responded');
  expect(f.seen).toHaveLength(1);
  expect(f.seen[0]!.headers['x-api-key']).toBe(SECRET); expect(f.seen[0]!.headers['authorization']).toBeUndefined();
  expect(f.seen[0]!.headers['anthropic-version']).toBe('2023-06-01');
  expect(JSON.parse(f.seen[0]!.body)).toEqual({ model: MODEL, max_tokens: 8, stream: false, messages: [{ role: 'user', content: 'private prompt' }] });
  const reader = await openSqliteModelInvocationReader(f.ledger, { busyTimeoutMs: 1000 });
  let persisted;
  try { persisted = await reader.loadInspection('scope', first.receipt.claim.invocationId); } finally { reader.close(); }
  expect(persisted?.spending).toMatchObject({ descriptor: { budgetId: 'budget', currency: 'USD', quote: { maxChargeMinorUnits: expect.any(Number),
    pricing: { id: 'anthropic-published-tariff', version: 1, definition: { modelId: MODEL, kind: 'anthropic-published' } },
    meter: { id: 'anthropic-messages-reservation', version: 1 } } },
  // Checkpoint A: the exact reported usage is priced against this pinned published tariff.
  disposition: { state: 'settled-measured-tariff' }, measurement: { basis: 'measured-tariff' } });
  expect(persisted?.spending?.descriptor.quote.maxChargeMinorUnits).toBeGreaterThan(0);
  expect(JSON.stringify(persisted)).not.toContain(SECRET);
  const spend = await openSqliteProviderSpendIntegrityReader(f.ledger, { busyTimeoutMs: 1000 });
  try { await expect(verifyProviderSpendIntegrity(spend, 'scope', 10)).resolves.toMatchObject({ reservationCount: 1, settledMinorUnits: 1 }); } finally { spend.close(); }
  expect((await invokeConfiguredModel(f.project, f.command, { env: f.env, secretResolver: f.secretResolver })).replayed).toBe(true);
  expect(f.seen).toHaveLength(1);
});

it('refuses before any request when the budget cannot hold the bound, the policy denies, or no key resolves', async () => {
  const tiny = await fixture(0);
  await expect(invokeConfiguredModel(tiny.project, tiny.command, { env: tiny.env, secretResolver: tiny.secretResolver })).rejects.toMatchObject({ code: 'PROVIDER_SPEND_EXHAUSTED' });
  expect(tiny.seen).toHaveLength(0);
  const denied = await fixture(1000, false);
  await expect(invokeConfiguredModel(denied.project, denied.command, { env: denied.env, secretResolver: denied.secretResolver })).rejects.toThrow();
  expect(denied.seen).toHaveLength(0);
  const keyless = await fixture();
  // A missing key is an effect-free failure (never a response, never a request on the wire). SPEND-HOLDS: it is recorded as a certified
  // empty not-sent rejection, so its reservation is released without charge instead of staying held as an uncertain outcome.
  const unresolved = await invokeConfiguredModel(keyless.project, keyless.command, { env: keyless.env, secretResolver: async () => undefined });
  expect(unresolved.receipt.outcome).toMatchObject({ state: 'rejected', evidence: { reason: 'not-sent', httpStatus: null, body: { complete: true, byteLength: 0 } } });
  expect(keyless.seen).toHaveLength(0);
  // The environment is not a fallback for a resolver that answered: the reference names one exact secret source.
  const viaEnv = await fixture();
  const result = await invokeConfiguredModel(viaEnv.project, viaEnv.command, { env: { ...viaEnv.env, ANTHROPIC_API_KEY: SECRET } });
  expect(result.receipt.outcome?.state).toBe('responded');
});


// Astra 2459 R1: Anthropic `message_start` carries a non-final usage (output_tokens=1); only the cumulative final `message_delta`
// usage may settle money. A stream cut before it (EOF, abort, provider error) is an unknown outcome whose reservation stays held.
const sse = (type: string, payload: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const opening = sse('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })
  + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  + ['par', 'tial ', 'answer'].map(text => sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })).join('');
const finalUsage = sse('content_block_stop', { index: 0 }) + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
const sseHead = (response: ServerResponse) => response.writeHead(200, { 'content-type': 'text/event-stream' });

async function spendOf(f: Awaited<ReturnType<typeof fixture>>, invocationId: string) {
  const reader = await openSqliteModelInvocationReader(f.ledger, { busyTimeoutMs: 1000 });
  let inspection;
  try { inspection = await reader.loadInspection('scope', invocationId); } finally { reader.close(); }
  const spend = await openSqliteProviderSpendIntegrityReader(f.ledger, { busyTimeoutMs: 1000 });
  try { return { inspection, integrity: await verifyProviderSpendIntegrity(spend, 'scope', 10) }; } finally { spend.close(); }
}

it.each([
  ['EOF', (response: ServerResponse) => { sseHead(response); response.end(opening); }],
  ['provider error', (response: ServerResponse) => { sseHead(response); response.end(opening + sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })); }],
])('keeps the whole reservation held when the stream ends by %s before the final message_delta usage', async (_name, reply) => {
  const f = await fixture(1000, true, reply);
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env, secretResolver: f.secretResolver });
  expect(result.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error' });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  const maximum = inspection!.spending!.descriptor.quote.maxChargeMinorUnits;
  expect(maximum).toBeGreaterThan(0);
  expect(inspection?.spending).toMatchObject({ disposition: { state: 'held', reason: 'unknown', observedMinorUnits: null }, measurement: null });
  expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: maximum, settledMinorUnits: 0,
    checkpoint: { account: { reservedMinorUnits: maximum, settledMinorUnits: 0, settledExactMinorUnits: '0', frozen: false } } });
});

// Astra 2462 R1: the final message_delta must carry its own output_tokens. Without it, message_start's output_tokens=1 is never inherited
// as the final count: a cut stream is unknown and a completed one an invalid response, both with the whole reservation held.
const ownless = (usage: Record<string, unknown>) => sse('content_block_stop', { index: 0 }) + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage });
it.each([
  ['empty usage, then EOF', opening + ownless({}), 'unknown'],
  ['usage without output_tokens, then EOF', opening + ownless({ input_tokens: 9 }), 'unknown'],
  ['empty usage, then message_stop', opening + ownless({}) + sse('message_stop'), 'rejected'],
] as const)('keeps the whole reservation held when the final message_delta carries %s', async (_name, wire, state) => {
  const f = await fixture(1000, true, response => { sseHead(response); response.end(wire); });
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env, secretResolver: f.secretResolver });
  expect(result.receipt.outcome).toMatchObject(state === 'unknown' ? { state, reason: 'transport-error' } : { state, evidence: { reason: 'invalid-response' } });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  const maximum = inspection!.spending!.descriptor.quote.maxChargeMinorUnits;
  expect(maximum).toBeGreaterThan(0);
  expect(inspection?.spending).toMatchObject({ disposition: { state: 'held', reason: 'unknown', observedMinorUnits: null }, measurement: null });
  expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: maximum, settledMinorUnits: 0,
    checkpoint: { account: { reservedMinorUnits: maximum, settledMinorUnits: 0, settledExactMinorUnits: '0', frozen: false } } });
});

it('keeps the whole reservation held when the caller aborts the stream before the final message_delta usage', async () => {
  let written!: () => void;
  const sent = new Promise<void>(resolve => { written = resolve; });
  const f = await fixture(1000, true, response => { sseHead(response); response.write(opening, () => written()); });
  const controller = new AbortController();
  const pending = invokeConfiguredModel(f.project, f.streamed, { env: f.env, secretResolver: f.secretResolver }, controller.signal);
  await sent; await new Promise(resolve => setTimeout(resolve, 150)); controller.abort();
  const result = await pending;
  expect(result.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error' });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  const maximum = inspection!.spending!.descriptor.quote.maxChargeMinorUnits;
  expect(inspection?.spending).toMatchObject({ disposition: { state: 'held', reason: 'unknown', observedMinorUnits: null }, measurement: null });
  expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: maximum, settledMinorUnits: 0,
    checkpoint: { account: { reservedMinorUnits: maximum, settledMinorUnits: 0, settledExactMinorUnits: '0', frozen: false } } });
});

it('settles a complete stream from its final usage exactly like the non-streamed call, and a stream cut after that final usage the same', async () => {
  const exact = async (f: Awaited<ReturnType<typeof fixture>>, command: typeof f.command, state: string) => {
    const result = await invokeConfiguredModel(f.project, command, { env: f.env, secretResolver: f.secretResolver });
    expect(result.receipt.outcome?.state).toBe(state);
    const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
    expect(inspection?.spending).toMatchObject({ disposition: { state: 'settled-measured-tariff' }, measurement: { basis: 'measured-tariff' } });
    expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: 0 });
    return { exact: inspection!.spending!.measurement!.exactMinorUnits, account: integrity.checkpoint.account.settledExactMinorUnits };
  };
  const json = await fixture();
  const reference = await exact(json, json.command, 'responded');
  const complete = await fixture(1000, true, response => { sseHead(response); response.end(opening + finalUsage + sse('message_stop')); });
  const cut = await fixture(1000, true, response => { sseHead(response); response.end(opening + finalUsage); });
  // Usage 9 input / 2 output on the same pinned tariff: the same exact bigint charge as the non-streamed response.
  expect(await exact(complete, complete.streamed, 'responded')).toEqual(reference);
  expect(await exact(cut, cut.streamed, 'unknown')).toEqual(reference);
  expect(reference.exact).not.toBe('0');
});

});
