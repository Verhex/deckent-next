import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, afterEach, expect, it } from 'vitest';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteProviderSpendIntegrityReader, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId, verifyProviderSpendIntegrity } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createLocalTls } from '../../fixtures/local-tls.js';

// Astra 2462 R1 through the governed invocation path (policy, activation, budget reservation, receipt, SQLite spend ledger) over a real
// https OpenAI-compatible server with a non-zero operator-static v2 tariff: only the final event's own usage settles money. An interim usage
// chunk before the finish reason is never promoted to the final count by a later finish marker; the reservation stays held.
const roots: string[] = [], servers: Server[] = [];
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
const MODEL = 'operator-chat';
afterEach(async () => {
  clearConfigCache();
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
async function fixture(reply: Reply) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-openai-stream-spend-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(data), mkdir(home)]);
  const { key, caPem } = await createLocalTls(root);
  const server = createServer({ key, cert: caPem }, (request, response) => { request.resume(); request.on('end', () => reply(response)); });
  servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE');
  const reference = { providerId: 'operator', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
  const model = { id: 'chat', version: 1, nativeId: MODEL, protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ id: 'operator', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'operator', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: `https://127.0.0.1:${address.port}/chat`, maxOutputTokens: 64, authentication: { type: 'none' }, tls: { caPem },
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
  await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [{
    id: 'invoke', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }],
    resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } }] }), { mode: 0o600 });
  const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: MODEL, messages: [{ role: 'user' as const, content: 'private prompt' }], max_completion_tokens: 16 } };
  const streamed = { ...command, commandId: 'streamed', nativeRequest: { ...command.nativeRequest, stream: true, stream_options: { include_usage: true as const } } };
  return { project, ledger, command, streamed, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
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
