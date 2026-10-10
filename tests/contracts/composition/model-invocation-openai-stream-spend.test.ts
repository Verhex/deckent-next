import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, afterEach, expect, it, vi } from 'vitest';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore, openSqliteModelInvocationReader, openSqliteProviderSpendIntegrityReader, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId, verifyProviderSpendIntegrity, modelInvocationRequestDigest,
  modelInvocationProfileDigest, providerSpendEvidenceDigest } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createLocalTls } from '../../fixtures/local-tls.js';
import { registerProviderSpendNoChargeCertification } from '../../../src/extensions.js';

// Astra 2462 R1 through the governed invocation path (policy, activation, budget reservation, receipt, SQLite spend ledger) over a real
// https OpenAI-compatible server with a non-zero operator-static v2 tariff: only the final event's own usage settles money. An interim usage
// chunk before the finish reason is never promoted to the final count by a later finish marker; the reservation stays held. Astra 2467:
// a contradiction after the final usage withdraws it, so a bounded (retention-capped) refusal also holds instead of settling.
// CORE-BUDGET-HOLD certified release (lead 2026-10-10, E2 1b): a request to the exact certified vendor URL is routed, in this test process only,
// to the local TLS server (certificate names the vendor host, SNI kept); every other host passes through untouched, so no network call is made.
const route = vi.hoisted(() => ({ hosts: ['api.openai.com', 'llm.acme.example'], port: 0 }));
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  const request = ((url: URL, options: import('node:https').RequestOptions, callback: (response: import('node:http').IncomingMessage) => void) => {
    if (!(url instanceof URL) || !route.hosts.includes(url.hostname)) return actual.request(url, options, callback);
    if (!route.port) throw new Error('vendor host is not routed in this test');
    return actual.request({ ...options, protocol: 'https:', hostname: '127.0.0.1', port: route.port, path: `${url.pathname}${url.search}`,
      servername: url.hostname, headers: { ...options.headers, host: url.hostname } }, callback);
  }) as typeof actual.request;
  return { ...actual, request, default: { ...actual, request } };
});
// Law 10: a separately distributed package certifies its own vendor endpoint through `deckent/extensions` before the composition root seals.
registerProviderSpendNoChargeCertification({ vendor: 'acme.llm', endpoints: ['https://llm.acme.example/v1/chat/completions'], statuses: [400, 422],
  source: 'https://acme.example/docs/errors' });
const roots: string[] = [], servers: Server[] = [];
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
const MODEL = 'operator-chat';
afterEach(async () => {
  clearConfigCache(); route.port = 0;
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

type Reply = (response: ServerResponse) => void;
const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
const jsonReply: Reply = response => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'partial answer' } }], usage }));
};
async function fixture(reply: Reply, listen = true, vendorEndpoint?: string) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-openai-stream-spend-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(data), mkdir(home)]);
  const { key, caPem } = await createLocalTls(root, vendorEndpoint ? { dnsNames: route.hosts } : {});
  const server = createServer({ key, cert: caPem }, (request, response) => { request.resume(); request.on('end', () => reply(response)); });
  if (listen) { servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  const address = server.address(); if (listen && (!address || typeof address === 'string')) throw new Error('FIXTURE');
  if (vendorEndpoint && address && typeof address !== 'string') route.port = address.port;
  const reference = { providerId: 'operator', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
  const model = { id: 'chat', version: 1, nativeId: MODEL, protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ id: 'operator', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'operator', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: vendorEndpoint ?? `https://127.0.0.1:${address && typeof address !== 'string' ? address.port : 1234}/chat`, maxOutputTokens: 64, authentication: { type: 'none' }, tls: { caPem },
        tariff: { kind: 'operator-static', version: 2, currency: 'USD', inputMinorUnitsPerMillionTokens: 200, cachedInputMinorUnitsPerMillionTokens: 50,
          outputMinorUnitsPerMillionTokens: 1000 } } },
    allocation: { id: 'allocation', maxCalls: 3, maxInFlight: 2 }, limits: { requestMaxBytes: 8192, responseMaxBytes: 8192, timeoutMs: 2000 } };
  const config = { layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    provider_spending: { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 }] } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify(config), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { ...readLocalOsIdentity(), scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  const activated = await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [{
    id: 'invoke', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }],
    resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } }] }), { mode: 0o600 });
  const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: MODEL, messages: [{ role: 'user' as const, content: 'private prompt' }], max_completion_tokens: 16 } };
  const streamed = { ...command, commandId: 'streamed', nativeRequest: { ...command.nativeRequest, stream: true, stream_options: { include_usage: true as const } } };
  return { project, ledger, command, streamed, profile, definition, principal, activation: activated.receipt.record, data,
    env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}

const chunk = (choice: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ id: 'chatcmpl-1',
  object: 'chat.completion.chunk', created: 1, model: MODEL, choices: choice ? [{ index: 0, finish_reason: null, ...choice }] : [], ...extra })}\n\n`;
const sseReply = (wire: string): Reply => response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(wire); };
// Interim usage (100/10) on the first content chunk, more content without usage, then a finish chunk whose own usage is null.
const interimThenFinish = chunk({ delta: { role: 'assistant', content: 'par' } }, { usage }) + chunk({ delta: { content: 'tial ' } })
  + chunk({ delta: { content: 'answer' } }) + chunk({ delta: {}, finish_reason: 'stop' }, { usage: null });
const content = chunk({ delta: { role: 'assistant', content: 'partial ' } }) + chunk({ delta: { content: 'answer' } });

async function spendOf(f: Awaited<ReturnType<typeof fixture>>, invocationId: string) {
  const reader = await openSqliteModelInvocationReader(f.ledger, { busyTimeoutMs: 1000 });
  let inspection;
  try { inspection = await reader.loadInspection('scope', invocationId); } finally { reader.close(); }
  const spend = await openSqliteProviderSpendIntegrityReader(f.ledger, { busyTimeoutMs: 1000 });
  try { return { inspection, integrity: await verifyProviderSpendIntegrity(spend, 'scope', 10) }; } finally { spend.close(); }
}

describe.skipIf(process.platform === 'win32')('requires POSIX local principal; AUTHENTICATION_REQUIRED on Windows UID -1', () => {
it('exhaustion totals require a fresh account-inspect grant, independently of invocation authority', async () => {
  let requests = 0; const f = await fixture(response => { requests++; jsonReply(response); }, false);
  const requestDigest = modelInvocationRequestDigest(f.command), profileDigest = modelInvocationProfileDigest(f.profile);
  const evidence = { schemaVersion: 1, kind: 'synthetic-test-bound' }, digest = providerSpendEvidenceDigest(evidence);
  const store = await openSqliteModelInvocationStore(f.ledger, sqlite, 'forbid');
  const claim = await store.claim({ command: f.command, requestDigest, profileDigest, profile: f.profile, definition: f.definition, activation: f.activation,
    actor: { id: f.principal.id, issuer: f.principal.issuer, subject: f.principal.subject, assurance: f.principal.assurance },
    authorization: { revision: 'seed', ruleId: 'seed' }, invocationId: 'synthetic-held', claimedAtMs: 2,
    spending: { budget: { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 },
      quote: { schemaVersion: 1, scopeId: 'scope', requestDigest, profileDigest, currency: 'USD', maxChargeMinorUnits: 1000,
        pricing: { id: 'fixture', version: 1, definition: evidence, digest }, meter: { id: 'fixture', version: 1, evidence, evidenceDigest: digest } } } });
  await store.permitSend(claim.record.receipt.claim, 'synthetic-owner', 3); await store.recordUnknown(claim.record.receipt.claim, 'transport-error', 4); store.close();
  const command = { ...f.command, commandId: 'exhausted' }, options = { env: f.env };
  const denied = await invokeConfiguredModel(f.project, command, options).catch(error => error);
  expect(denied).toMatchObject({ code: 'PROVIDER_SPEND_EXHAUSTED' }); expect(denied.params).not.toHaveProperty('held'); expect(denied.params).not.toHaveProperty('settled');
  const path = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(path, 'utf8'));
  policy.grants.push({ id: 'account-inspect', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [{ issuer: f.principal.issuer, subject: f.principal.subject }], resource: { kind: 'provider-spend-account', ids: ['budget'] } });
  await writeFile(path, JSON.stringify(policy));
  const allowed = await invokeConfiguredModel(f.project, command, options).catch(error => error);
  expect(allowed).toMatchObject({ code: 'PROVIDER_SPEND_EXHAUSTED', params: { settled: '0', held: 1000, limit: 1000, currency: 'USD' } });
  policy.grants.pop(); await writeFile(path, JSON.stringify(policy));
  const revoked = await invokeConfiguredModel(f.project, command, options).catch(error => error);
  expect(revoked.params).not.toHaveProperty('held'); expect(requests).toBe(0);
  const { integrity } = await spendOf(f, 'synthetic-held'); expect(integrity.reservationCount).toBe(1); expect(integrity.reservedMinorUnits).toBe(1000);
});
it.each([
  ['cut after the usage-null finish chunk (EOF before the usage-only chunk and [DONE])', interimThenFinish, 'unknown'],
  ['completed with [DONE] but no final usage', interimThenFinish + 'data: [DONE]\n\n', 'rejected'],
] as const)('an interim usage is never promoted to final by a later finish marker: %s', async (_name, wire, state) => {
  const f = await fixture(sseReply(wire));
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env });
  expect(result.receipt.outcome).toMatchObject(state === 'unknown' ? { state, reason: 'transport-error' } : { state, evidence: { reason: 'invalid-response' } });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  const maximum = inspection!.spending!.descriptor.quote.maxChargeMinorUnits;
  expect(maximum).toBeGreaterThan(0);
  expect(inspection?.spending).toMatchObject({ descriptor: { quote: { pricing: { definition: { kind: 'operator-static', version: 2 } } } },
    disposition: { state: 'held', reason: 'unknown', observedMinorUnits: null }, measurement: null });
  expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: maximum, settledMinorUnits: 0,
    checkpoint: { account: { reservedMinorUnits: maximum, settledMinorUnits: 0, settledExactMinorUnits: '0', frozen: false } } });
});

});

// CORE-BUDGET-HOLD certified release cases (own block: same POSIX-principal precondition).
describe.skipIf(process.platform === 'win32')('requires POSIX local principal; certified no-charge release', () => {
it.each([400, 422, 429, 500, 503])('HTTP %s from an uncertified (local) endpoint stays held through the real TLS producer', async status => {
  // CORE-BUDGET-HOLD (owner, Jev 3f877ac4): money is released only with an exact vendor endpoint/status certificate (no-charge-policy.json).
  const f = await fixture(response => { response.writeHead(status, { 'content-type': 'application/json' }); response.end('{"error":{"message":"invalid_request_error"}}'); });
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  expect(result.receipt.outcome).toMatchObject({ state: 'rejected', evidence: { reason: 'http-status', httpStatus: status } });
  expect(inspection!.spending!.disposition).toMatchObject({ state: 'held', reason: 'unknown' });
  expect(integrity.reservedMinorUnits).toBe(inspection!.spending!.descriptor.quote.maxChargeMinorUnits);
  expect(integrity.reservedMinorUnits).toBeGreaterThan(0);
  expect(integrity.settledMinorUnits).toBe(0);
});

it.each([400, 422, 429])('HTTP %s from the certified vendor endpoint releases no-charge through the real TLS producer', async status => {
  let requests = 0;
  const f = await fixture(response => { requests++; response.writeHead(status, { 'content-type': 'application/json' }); response.end('{"error":{"message":"invalid_request_error"}}'); },
    true, 'https://api.openai.com/v1/chat/completions');
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  expect(requests).toBe(1);
  expect(result.receipt.outcome).toMatchObject({ state: 'rejected', evidence: { reason: 'http-status', httpStatus: status } });
  expect(inspection!.spending!.disposition.state).toBe('released-no-charge');
  expect(integrity.reservedMinorUnits).toBe(0); expect(integrity.settledMinorUnits).toBe(0);
});

it.each([[400, 'released-no-charge'], [422, 'released-no-charge'], [429, 'held']] as const)('an extension-certified endpoint answers HTTP %s -> %s (only its own statuses)', async (status, state) => {
  const f = await fixture(response => { response.writeHead(status, { 'content-type': 'application/json' }); response.end('{"error":{"message":"invalid_request_error"}}'); },
    true, 'https://llm.acme.example/v1/chat/completions');
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  expect(result.receipt.outcome).toMatchObject({ state: 'rejected', evidence: { reason: 'http-status', httpStatus: status } });
  expect(inspection!.spending!.disposition.state).toBe(state);
  expect(integrity.reservedMinorUnits).toBe(state === 'held' ? inspection!.spending!.descriptor.quote.maxChargeMinorUnits : 0);
});

it.each([500, 503])('HTTP %s from the certified vendor endpoint is not certified by status and stays held', async status => {
  const f = await fixture(response => { response.writeHead(status, { 'content-type': 'application/json' }); response.end('{"error":{"message":"server"}}'); },
    true, 'https://api.openai.com/v1/chat/completions');
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  expect(inspection!.spending!.disposition.state).toBe('held');
  expect(integrity.reservedMinorUnits).toBe(inspection!.spending!.descriptor.quote.maxChargeMinorUnits);
});

it('a credential/policy refusal before POST releases its claim without contacting the TLS producer', async () => {
  let requests = 0;
  const f = await fixture(response => { requests++; jsonReply(response); });
  const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
  config.provider_invocation_profiles.profiles[0].adapter.definition.authentication = { type: 'bearer', credentialRef: 'MISSING_KEY' };
  await writeFile(path, JSON.stringify(config)); clearConfigCache();
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  expect(result.receipt.outcome).toMatchObject({ state: 'rejected', evidence: { reason: 'not-sent', httpStatus: null } });
  expect(inspection!.spending!.disposition.state).toBe('released-no-charge');
  expect(integrity.reservedMinorUnits).toBe(0); expect(requests).toBe(0);
});

it.each(['timeout', 'cancel'] as const)('%s after POST keeps the hold after closing the local request', async mode => {
  const cancel = new AbortController(); let contacted = false;
  const f = await fixture(response => { contacted = true; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
    response.write(content); if (mode === 'cancel') cancel.abort(); });
  if (mode === 'timeout') {
    const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
    config.provider_invocation_profiles.profiles[0].limits.timeoutMs = 100;
    await writeFile(path, JSON.stringify(config)); clearConfigCache();
  }
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env }, cancel.signal);
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  expect(contacted).toBe(true); expect(result.receipt.outcome?.state).toBe('unknown');
  expect(inspection!.spending!.disposition.state).toBe('held');
  expect(integrity.reservedMinorUnits).toBe(inspection!.spending!.descriptor.quote.maxChargeMinorUnits);
});

// Astra 2467: SSE comment padding pushes the observed wire past the 8192-byte retention cap (the evidence is then bounded, not complete,
// so a refusal is recorded as unknown/response-limit with the partial measurement), while the assembled answer stays small.
const padding = `: ${'x'.repeat(1000)}\n`.repeat(10);
const tier = (value: string) => ({ service_tier: value });
const finalDefault = padding + chunk({ delta: { role: 'assistant', content: 'partial ' } }, tier('default')) + chunk({ delta: { content: 'answer' } }, tier('default'))
  + chunk({ delta: {}, finish_reason: 'stop' }, { usage: null, ...tier('default') }) + chunk(null, { usage, ...tier('default') });
it.each([
  ['a later chunk names a conflicting service tier', finalDefault + chunk(null, tier('priority')) + 'data: [DONE]\n\n'],
  ['the completed stream is invalid after [DONE]', finalDefault + 'data: [DONE]\n\ndata: {'],
] as const)('a contradiction after the final usage keeps the reservation held past the retention cap: %s', async (_name, wire) => {
  const f = await fixture(sseReply(wire));
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env });
  expect(result.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error' });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  expect(inspection?.record.receipt.outcome).toMatchObject({ state: 'unknown', evidence: { reason: 'response-limit', body: { complete: false } } });
  const maximum = inspection!.spending!.descriptor.quote.maxChargeMinorUnits;
  expect(maximum).toBeGreaterThan(0);
  expect(inspection?.spending).toMatchObject({ disposition: { state: 'held', reason: 'unknown', observedMinorUnits: null }, measurement: null });
  expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: maximum, settledMinorUnits: 0,
    checkpoint: { account: { reservedMinorUnits: maximum, settledMinorUnits: 0, settledExactMinorUnits: '0', frozen: false } } });
});

it('still settles the exact final usage when the same padded stream is cut cleanly after it', async () => {
  const f = await fixture(sseReply(finalDefault));
  const result = await invokeConfiguredModel(f.project, f.streamed, { env: f.env });
  expect(result.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error' });
  const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
  expect(inspection?.record.receipt.outcome).toMatchObject({ state: 'unknown', evidence: { reason: 'interrupted', body: { complete: false } } });
  expect(inspection?.spending).toMatchObject({ disposition: { state: 'settled-measured-tariff' }, measurement: { basis: 'measured-tariff', exactMinorUnits: '0.03' } });
  expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: 0, checkpoint: { account: { settledExactMinorUnits: '0.03' } } });
});

it('settles the final usage (finish chunk itself, or a later usage-only chunk) at the exact charge of the non-streamed call, complete or cut after it', async () => {
  const exact = async (reply: Reply, streamed: boolean, state: string) => {
    const f = await fixture(reply);
    const result = await invokeConfiguredModel(f.project, streamed ? f.streamed : f.command, { env: f.env });
    expect(result.receipt.outcome?.state).toBe(state);
    const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
    expect(inspection?.spending).toMatchObject({ disposition: { state: 'settled-measured-tariff' }, measurement: { basis: 'measured-tariff' } });
    expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: 0 });
    return { exact: inspection!.spending!.measurement!.exactMinorUnits, account: integrity.checkpoint.account.settledExactMinorUnits };
  };
  const reference = await exact(jsonReply, false, 'responded');
  // 100 input x $2 + 10 output x $10 per MTok = 0.03 minor units on the pinned v2 operator tariff.
  expect(reference).toEqual({ exact: '0.03', account: '0.03' });
  const sameChunk = content + chunk({ delta: {}, finish_reason: 'stop' }, { usage });
  const usageOnly = content + chunk({ delta: {}, finish_reason: 'stop' }, { usage: null }) + chunk(null, { usage });
  expect(await exact(sseReply(sameChunk + 'data: [DONE]\n\n'), true, 'responded')).toEqual(reference);
  expect(await exact(sseReply(usageOnly + 'data: [DONE]\n\n'), true, 'responded')).toEqual(reference);
  expect(await exact(sseReply(sameChunk), true, 'unknown')).toEqual(reference);
  expect(await exact(sseReply(usageOnly), true, 'unknown')).toEqual(reference);
});
});
