import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { invokeConfiguredModel, inspectConfiguredModelInvocation, invokePeerConfiguredModel,
  inspectPeerConfiguredModelInvocation } from '#composition/core/model-invocation/index.js';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, ModelInvocationStoreError, modelInvocationProfileDigest, modelInvocationTargetId,
  verifyModelInvocationReceipt } from '#engine/index.js';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'provider', version: 1, models: [{ id: 'model',
  version: 1, nativeId: 'native-model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] };

async function fixture(options: { maxCalls?: number; maxInFlight?: number; responseMaxBytes?: number; response?: 'ok' | 'large' | 'reset' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  let requests = 0, response = options.response ?? 'ok'; const bodies: string[] = [];
  const server = createServer((request, reply) => { requests++; const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', () => { bodies.push(Buffer.concat(chunks).toString('utf8'));
      if (response === 'reset') { request.socket.destroy(); return; }
      const native = response === 'large' ? { value: 'x'.repeat(4096) } : { id: 'completion', object: 'chat.completion', created: 1,
        model: 'native-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done', refusal: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify(native)); }); });
  servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const definition = { encodingVersion: 1 as const, provider: { id: 'provider', version: 1 }, model: catalog.providers[0]!.models[0]! };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
    digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  let profile = { schemaVersion: 1 as const, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 1,
      definition: { origin: `http://127.0.0.1:${address.port}`, maxOutputTokens: 8 } },
    allocation: { id: 'allocation', maxCalls: options.maxCalls ?? 4, maxInFlight: options.maxInFlight ?? 2 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: options.responseMaxBytes ?? 8192, timeoutMs: 2_000 } };
  const configPath = join(project, '.deckent/config.json'); const writeConfig = async () => {
    await writeFile(configPath, JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog,
      provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] } }), { mode: 0o600 }); clearConfigCache(); };
  await writeConfig(); const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { ...readLocalOsIdentity(), scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  const activate = { schemaVersion: 1 as const, action: 'activate' as const, commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: binding };
  await activation.admit(activate);
  const policyPath = join(data, 'policy.json'), target = modelInvocationTargetId(reference);
  const policy = async (allow: boolean) => { await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, revision: allow ? 'allow' : 'deny', restrictions: [],
    grants: allow ? [{ id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect'], scopes: ['scope'],
      principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'model-invocation', ids: [target] } }] : [] }), { mode: 0o600 }); };
  await policy(true); const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const command = (commandId: string) => ({ schemaVersion: 1 as const, commandId, scopeId: 'scope', reference,
    catalogRevision: catalog.revision, expectedBinding: binding,
    nativeRequest: { model: 'native-model', messages: [{ role: 'user', content: 'prompt-must-not-persist' }], max_completion_tokens: 4 } });
  return { project, env, ledger, binding, command, policy, activation, activate, writeConfig,
    setProfile(value: typeof profile) { profile = value; }, get profile() { return profile; },
    setResponse(value: typeof response) { response = value; }, get requests() { return requests; }, bodies };
}

describe('configured native model invocation', () => {
  it('binds peer invocation and inspection to current policy without an ambient-identity fallback', async () => {
    const f = await fixture(), identity = readLocalOsIdentity();
    const peer = { pid: process.pid, uid: Number(identity.subject), gid: process.getgid!(), assurance: 'linux-so-peercred' as const };
    const input = f.command('peer-call'), before = await readFile(f.ledger);
    for (const invalid of [undefined, { ...peer, uid: peer.uid + 1 }, { ...peer, assurance: 'wire-actor' }]) {
      await expect(invokePeerConfiguredModel(f.project, input, invalid as never, { env: f.env }))
        .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
      await expect(inspectPeerConfiguredModelInvocation(f.project, { schemaVersion: 1, scopeId: 'scope',
        invocationId: 'absent', reference }, invalid as never, { env: f.env }))
        .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    }
    // No valid project/config exists here: peer denial must occur before trying to load either.
    await expect(invokePeerConfiguredModel(join(f.project, 'not-initialized'), input, undefined as never, { env: f.env }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(f.requests).toBe(0); expect(await readFile(f.ledger)).toEqual(before);
    const result = await invokePeerConfiguredModel(f.project, input, peer, { env: f.env }, { maxResultBytes: 100_000 });
    expect(result.receipt.actor).toEqual(identity); expect(f.requests).toBe(1);
    const query = { schemaVersion: 1 as const, scopeId: 'scope', invocationId: result.receipt.claim.invocationId, reference };
    expect((await inspectPeerConfiguredModelInvocation(f.project, query, peer, { env: f.env })).invocation).toEqual(result.receipt);
    await f.policy(false);
    await expect(invokePeerConfiguredModel(f.project, input, peer, { env: f.env })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(inspectPeerConfiguredModelInvocation(f.project, query, peer, { env: f.env })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.requests).toBe(1);
  });

  it('records one bounded native response, replays without a request and exposes exact durable inspection', async () => {
    const f = await fixture(), first = await invokeConfiguredModel(f.project, f.command('one'), { env: f.env });
    expect(first).toMatchObject({ replayed: false, receipt: { outcome: { state: 'responded', response: { native: { model: 'native-model' } } } } });
    // This non-echo fixture checks request-body omission, not confidentiality of arbitrary provider responses.
    expect(f.requests).toBe(1); expect(f.bodies[0]).toContain('prompt-must-not-persist');
    expect(await invokeConfiguredModel(f.project, f.command('one'), { env: f.env })).toEqual({ replayed: true, receipt: first.receipt });
    // This non-echo fixture checks request-body omission, not confidentiality of arbitrary provider responses.
    expect(f.requests).toBe(1); expect((await readFile(f.ledger)).includes(Buffer.from('prompt-must-not-persist'))).toBe(false);
    expect((await inspectConfiguredModelInvocation(f.project, { schemaVersion: 1, scopeId: 'scope',
      invocationId: first.receipt.claim.invocationId, reference }, { env: f.env })).invocation).toEqual(first.receipt);
  });

  it('rejects accessors at the public boundary and validates persisted response limits without imposing clock ordering', async () => {
    const f = await fixture(), getter = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { throw new Error('GETTER_CALLED'); } });
    await expect(invokeConfiguredModel(f.project, getter as never, { env: f.env })).rejects.toMatchObject({ code: 'MODEL_INVOCATION_INVALID' });
    await expect(inspectConfiguredModelInvocation(f.project, getter as never, { env: f.env })).rejects.toMatchObject({ code: 'MODEL_INVOCATION_INVALID' });
    expect(f.requests).toBe(0);
    const responded = await invokeConfiguredModel(f.project, f.command('bounded'), { env: f.env }), receipt = responded.receipt;
    if (receipt.outcome?.state !== 'responded') throw new Error('FIXTURE_RESPONSE');
    const rollback = { ...receipt, outcome: { ...receipt.outcome, observedAtMs: 0 } };
    expect(verifyModelInvocationReceipt(rollback).outcome).toMatchObject({ state: 'responded', observedAtMs: 0 });
    const limitedProfile = { ...receipt.profile, limits: { ...receipt.profile.limits, responseMaxBytes: 1 } },
      limitedDigest = modelInvocationProfileDigest(limitedProfile);
    const oversized = { ...receipt, profile: limitedProfile, profileDigest: limitedDigest,
      claim: { ...receipt.claim, profileDigest: limitedDigest } };
    expect(() => verifyModelInvocationReceipt(oversized)).toThrow(ModelInvocationStoreError);
  });

  it('denies before transport for current policy, inactive activation and changed profile binding', async () => {
    const denied = await fixture(); await denied.policy(false);
    await expect(invokeConfiguredModel(denied.project, denied.command('denied'), { env: denied.env })).rejects.toThrow(); expect(denied.requests).toBe(0);
    const inactive = await fixture(); await inactive.activation.admit({ schemaVersion: 1, action: 'deactivate', commandId: 'deactivate',
      scopeId: 'scope', reference, expectedRevision: 1, expectedBinding: inactive.binding });
    await expect(invokeConfiguredModel(inactive.project, inactive.command('inactive'), { env: inactive.env })).rejects.toThrow(); expect(inactive.requests).toBe(0);
    const changed = await fixture(); changed.setProfile({ ...changed.profile, bindingDigest: 'f'.repeat(64) }); await changed.writeConfig();
    await expect(invokeConfiguredModel(changed.project, changed.command('changed'), { env: changed.env })).rejects.toThrow(); expect(changed.requests).toBe(0);
  });

  it('enforces durable call quota and retains capacity after an unknown bounded response without resending', async () => {
    const quota = await fixture({ maxCalls: 1, maxInFlight: 1 });
    await invokeConfiguredModel(quota.project, quota.command('first'), { env: quota.env });
    await expect(invokeConfiguredModel(quota.project, quota.command('second'), { env: quota.env })).rejects.toThrow(); expect(quota.requests).toBe(1);
    const unknown = await fixture({ maxCalls: 3, maxInFlight: 1, response: 'large', responseMaxBytes: 128 });
    const first = await invokeConfiguredModel(unknown.project, unknown.command('unknown'), { env: unknown.env });
    expect(first.receipt.outcome).toMatchObject({ state: 'unknown' }); expect(unknown.requests).toBe(1);
    expect((await invokeConfiguredModel(unknown.project, unknown.command('unknown'), { env: unknown.env })).replayed).toBe(true);
    await expect(invokeConfiguredModel(unknown.project, unknown.command('blocked'), { env: unknown.env })).rejects.toThrow();
    // This non-echo fixture checks request-body omission, not confidentiality of arbitrary provider responses.
    expect(unknown.requests).toBe(1); expect((await readFile(unknown.ledger)).includes(Buffer.from('prompt-must-not-persist'))).toBe(false);
  });
});
