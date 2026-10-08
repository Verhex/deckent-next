import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
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

async function fixture(limitMinorUnits = 1000, allow = true) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-anthropic-composition-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(data), mkdir(home)]);
  const { key, caPem } = await createLocalTls(root);
  const seen: { headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer({ key, cert: caPem }, (request, response) => {
    const chunks: Buffer[] = []; request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      seen.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
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
  return { project, ledger, command, env, seen, secretResolver: async (reference: string) => reference === 'ANTHROPIC_API_KEY' ? SECRET : undefined };
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
  // A missing key is an effect-free failure recorded as an uncertain outcome (never a response, never a request on the wire).
  const unresolved = await invokeConfiguredModel(keyless.project, keyless.command, { env: keyless.env, secretResolver: async () => undefined });
  expect(unresolved.receipt.outcome).toMatchObject({ state: 'unknown', reason: 'transport-error', evidence: null, content: null });
  expect(keyless.seen).toHaveLength(0);
  // The environment is not a fallback for a resolver that answered: the reference names one exact secret source.
  const viaEnv = await fixture();
  const result = await invokeConfiguredModel(viaEnv.project, viaEnv.command, { env: { ...viaEnv.env, ANTHROPIC_API_KEY: SECRET } });
  expect(result.receipt.outcome?.state).toBe('responded');
});

});
