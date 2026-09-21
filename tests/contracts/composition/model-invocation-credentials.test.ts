import { createLocalTls } from '../../fixtures/local-tls.js';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { invokeConfiguredModel, invokePeerConfiguredModel, inspectConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { clearConfigCache(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const reference = { providerId: 'openrouter', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const secret = 'synthetic-local-fixture-token';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-composed-credential-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const { key, caPem: certificate } = await createLocalTls(root);
  const headers: (string | undefined)[] = []; const metadataHeaders: (string | undefined)[] = []; let echo = false;
  const server = createServer({ key, cert: certificate }, (request, reply) => {
    if (request.url === '/api/v1/models/vendor/model/endpoints' && request.method === 'GET') {
      metadataHeaders.push(request.headers.authorization);
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ data: { id: 'vendor/model', endpoints: [{
        model_id: 'vendor/model', tag: 'provider/region', provider_name: 'Fixture', context_length: 4096,
        max_prompt_tokens: 1000, max_completion_tokens: 32, status: 0, supported_parameters: ['max_completion_tokens'],
        pricing: { prompt: '0.000001', completion: '0.000002', request: '0', input_cache_read: '0', input_cache_write: '0', internal_reasoning: '0' },
      }] } })); return;
    }
    if (request.url !== '/chat' || request.method !== 'POST') { reply.writeHead(404); reply.end(); return; }
    headers.push(request.headers.authorization); request.resume();
    request.on('end', () => reply.end(JSON.stringify({ id: 'completion', object: 'chat.completion', created: 1, model: 'vendor/model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: echo ? secret : 'done' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })));
  });
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
  const model = { id: 'model', version: 1, nativeId: 'vendor/model', protocols: [{ family: 'openrouter-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ id: 'openrouter', version: 1, models: [model] }] };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256')
    .update(encodeModelBindingDefinition({ encodingVersion: 1, provider: { id: 'openrouter', version: 1 }, model })).digest('hex') };
  const profile = { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openrouter-chat-completions', version: 'v1' }, adapter: { id: 'openrouter-chat-http', version: 1,
      definition: { endpoint: `https://127.0.0.1:${address.port}/chat`, maxOutputTokens: 8,
        authentication: { type: 'bearer', credentialRef: 'FIXTURE_PROVIDER_TOKEN' }, tls: { caPem: certificate },
        metadataEndpoint: `https://127.0.0.1:${address.port}/api/v1/models/vendor/model/endpoints`, endpointTag: 'provider/region',
        metadataLimits: { maxAgeMs: 60_000, maxResponseBytes: 64_000, timeoutMs: 1_000 } } },
    allocation: { id: 'allocation', maxCalls: 8, maxInFlight: 1 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 8192, timeoutMs: 2_000 } };
  const configPath = join(project, '.deckent/config.json');
  const writeConfig = async () => { await writeFile(configPath, JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    provider_spending: { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1,
      currency: 'USD', limitMinorUnits: 1_000 }] } }), { mode: 0o600 }); clearConfigCache(); };
  await writeConfig();
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const identity = readLocalOsIdentity(), principal = { ...identity, scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'fixture', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: binding });
  const policy = async (allow: boolean) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1,
    revision: allow ? 'allowed' : 'denied', restrictions: [], grants: allow ? [{ id: 'invocation', effect: 'allow',
      actions: ['invoke', 'inspect', 'inspect-content'], scopes: ['scope'], principals: [{ issuer: identity.issuer, subject: identity.subject }],
      resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } }] : [] }), { mode: 0o600 });
  await policy(true);
  const command = (commandId: string) => ({ schemaVersion: 1 as const, commandId, scopeId: 'scope', reference,
    catalogRevision: catalog.revision, expectedBinding: binding, nativeRequest: { model: 'vendor/model',
      messages: [{ role: 'user', content: 'hello' }], max_completion_tokens: 4 } });
  return { project, ledger, configPath, profile, command, policy, headers, metadataHeaders, writeConfig, setEcho() { echo = true; },
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    peer: { pid: process.pid, uid: Number(identity.subject), gid: process.getgid!(), assurance: 'linux-so-peercred' as const } };
}

it('authenticates a peer send once, persists only its reference, and replays without a credential lookup', async () => {
  const f = await fixture(), lookups: string[] = [];
  const options = { env: f.env, async secretResolver(ref: string) { lookups.push(ref); return secret; } };
  const input = f.command('one'), result = await invokePeerConfiguredModel(f.project, input, f.peer, options);
  expect(result.receipt.outcome).toMatchObject({ state: 'responded' });
  expect(f.headers).toEqual([`Bearer ${secret}`]); expect(lookups).toEqual(['FIXTURE_PROVIDER_TOKEN']);
  expect(f.metadataHeaders).toEqual([undefined]);
  expect((await invokePeerConfiguredModel(f.project, input, f.peer, options)).replayed).toBe(true);
  expect(lookups).toHaveLength(1); expect(f.headers).toHaveLength(1);
  const inspection = await inspectConfiguredModelInvocation(f.project, { schemaVersion: 2, scopeId: 'scope', reference,
    invocationId: result.receipt.claim.invocationId, includeResponseContent: true }, { env: f.env });
  expect(JSON.stringify(inspection)).not.toContain(secret); expect(await readFile(f.configPath, 'utf8')).not.toContain(secret);
  expect((await readFile(f.ledger)).includes(Buffer.from(secret))).toBe(false);
  await expect(invokeConfiguredModel(f.project, f.command('cannot-deliver'), options, undefined, { maxResultBytes: 1 }))
    .rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' });
  expect(lookups).toHaveLength(1); expect(f.headers).toHaveLength(1);
  await f.policy(false);
  await expect(invokeConfiguredModel(f.project, f.command('denied'), options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(lookups).toHaveLength(1); expect(f.headers).toHaveLength(1);
});

it.each(['policy', 'profile', 'cancel'] as const)('does not send if %s changes while the secret backend is resolving', async change => {
  const f = await fixture(), abort = new AbortController(); let lookups = 0;
  const options = { env: f.env, async secretResolver() {
    lookups++;
    if (change === 'policy') await f.policy(false);
    if (change === 'profile') { f.profile.version++; await f.writeConfig(); }
    if (change === 'cancel') abort.abort();
    return secret;
  } };
  const result = await invokeConfiguredModel(f.project, f.command('one'), options, abort.signal);
  expect(result.receipt.outcome).toMatchObject({ state: 'unknown' }); expect(f.headers).toEqual([]); expect(lookups).toBe(1);
  expect(f.metadataHeaders).toEqual([undefined]);
  expect(JSON.stringify(result)).not.toContain(secret); expect((await readFile(f.ledger)).includes(Buffer.from(secret))).toBe(false);
  await f.policy(true);
  expect((await invokeConfiguredModel(f.project, f.command('one'), options)).replayed).toBe(true);
  await expect(invokeConfiguredModel(f.project, f.command('next'), options)).rejects.toThrow();
  expect(lookups).toBe(1); expect(f.headers).toEqual([]);
});

it('retains no echoed secret or response body when the authenticated provider echoes its credential', async () => {
  const f = await fixture(); f.setEcho();
  const result = await invokeConfiguredModel(f.project, f.command('echo'), { env: f.env, async secretResolver() { return secret; } });
  expect(result.receipt.outcome).toMatchObject({ state: 'unknown' }); expect(result.response).toBeNull();
  expect(f.headers).toEqual([`Bearer ${secret}`]); expect(JSON.stringify(result)).not.toContain(secret);
  expect(f.metadataHeaders).toEqual([undefined]);
  expect((await readFile(f.ledger)).includes(Buffer.from(secret))).toBe(false);
});

it.each(['missing', 'backend-error'] as const)('keeps %s secret resolution failures private and never opens the provider request', async mode => {
  const f = await fixture();
  const result = await invokeConfiguredModel(f.project, f.command('one'), { env: f.env, async secretResolver() {
    if (mode === 'backend-error') throw new Error(`private backend context ${secret}`);
    return undefined;
  } });
  expect(result.receipt.outcome).toMatchObject({ state: 'unknown' }); expect(f.headers).toEqual([]);
  expect(f.metadataHeaders).toEqual([undefined]);
  expect(JSON.stringify(result)).not.toContain(secret); expect((await readFile(f.ledger)).includes(Buffer.from(secret))).toBe(false);
});
