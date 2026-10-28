import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearConfigCache, ErrorRegistry } from '#platform/index.js';
import { connectConfiguredModel, listConfiguredConnectionModels } from '#composition/core/model-connect/index.js';
import { probeProviderConnection } from '#adapters/index.js';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { inspectModelBinding } from '#composition/core/provider-catalog/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';
import { grantFixtureSecrets } from '../../fixtures/project-grant.js';

const grants = [
  { id: 'config', effect: 'allow', actions: ['write'], scopes: 'all', principals: me, resource: { kind: 'config', ids: 'all' } },
  { id: 'activation', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals: me, resource: { kind: 'model-activation', ids: 'all' } },
  { id: 'invoke-all', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'], principals: me, resource: { kind: 'model-invocation', ids: 'all' } },
];
async function fixture(extra: Record<string, unknown>[] = [], network = false) {
  let ids = ['Org/Exact-Model:Q4_K_M'], reads = 0;
  const list = () => { reads++; return ids; };
  const f = await runtime({ extraGrants: [...grants, ...extra], modelList: list, noServer: !network });
  const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
  const endpoint = config.provider_invocation_profiles.profiles[0].adapter.definition.endpoint.replace(/\/v1\/chat\/completions$/u, '');
  config.service.responseMaxBytes = 1_048_576;
  await writeFile(path, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
  const command = { schemaVersion: 1, commandId: 'discover-connect', scopeId: 'scope', connection: 'local-openai', endpoint, model: { nativeId: ids[0]! } };
  const host = { discoveryOptions: { fetch: async () => new Response(JSON.stringify({ data: list().map(id => ({ id })) })) } };
  return { ...f, host, endpoint, command, path, reads: () => reads, setIds: (next: string[]) => { ids = next; } };
}

describe.skipIf(process.platform !== 'linux')('configured seedless model connection', () => {
  it('free listing → selection → catalog/profile/activation/audit → actual runtime request carries the exact id; retry is stable', async () => {
    const f = await fixture([], true); await f.start();
    expect(await listConfiguredConnectionModels(f.project, 'scope', 'local-openai', f.endpoint, { env: f.env }))
      .toEqual([{ nativeId: f.command.model.nativeId, displayName: f.command.model.nativeId, priced: true }]);
    expect(f.state.requests).toEqual([]);
    const result = await connectConfiguredModel(f.project, f.command, { env: f.env });
    expect(result).toMatchObject({ status: 'connected', tariff: 'unmetered', credentialRef: null,
      steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written' } });
    expect(f.reads()).toBe(2);
    const config = JSON.parse(await readFile(f.path, 'utf8'));
    const model = config.provider_catalog.providers.find((row: { id: string }) => row.id === result.reference.providerId).models[0];
    expect(model.nativeId).toBe(f.command.model.nativeId); expect(model.protocols[0].capabilities).toEqual([]);
    const stored = f.rows('SELECT record FROM model_catalog_models').map(row => String(row.record)).join('');
    expect(stored).toContain(f.command.model.nativeId);
    f.state.script = [{ content: 'Exact model.' }];
    const answer = await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'discovered-turn', reference: result.reference,
      messages: [{ role: 'user', content: 'hi' }] }, () => undefined);
    expect(answer).toMatchObject({ answer: 'Exact model.', finish: 'stop' });
    expect(f.state.requests[0]).toMatchObject({ model: f.command.model.nativeId });
    const audit = f.rows('SELECT record FROM audit_events').map(row => String(row.record)).join('');
    expect(audit).toContain('model-connect');
    const again = await connectConfiguredModel(f.project, f.command, { env: f.env });
    expect(again.reference).toEqual(result.reference);
    expect(again.steps).toMatchObject({ catalog: 'present', declaration: 'present', profile: 'present', activation: 'present' });
    expect(f.reads()).toBe(3);
  }, 60_000);

  // G2-7 (owner 2026-10-18, "no key over plain http"), end to end over a real loopback server: the connection check refuses a key before any
  // request, listing and connecting go keyless even with a key at hand, the profile authenticates with none and the real call carries no key.
  it('probe → list → connect → invoke on plain-http loopback: a key never reaches the server; the keyless path works end to end', async () => {
    const f = await fixture([], true), KEY = 'sk-plain-http-canary-7c2e';
    await expect(probeProviderConnection({ kind: 'local-openai', endpoint: f.endpoint, key: KEY })).rejects.toMatchObject({ code: 'PROVIDER_KEY_INSECURE' });
    expect(f.state.authorization).toEqual([]); expect(f.reads()).toBe(0);
    expect(await probeProviderConnection({ kind: 'local-openai', endpoint: f.endpoint, key: null })).toEqual({ outcome: 'ok', httpStatus: 200, key: 'none' });
    const options = { env: f.env, secretResolver: () => KEY };
    expect(await listConfiguredConnectionModels(f.project, 'scope', 'local-openai', f.endpoint, options)).toMatchObject([{ nativeId: f.command.model.nativeId }]);
    const result = await connectConfiguredModel(f.project, f.command, options);
    expect(result).toMatchObject({ status: 'connected', credentialRef: null, tariff: 'unmetered' });
    const config = JSON.parse(await readFile(f.path, 'utf8')) as { provider_invocation_profiles: { profiles: { reference: unknown; adapter: { definition: { authentication: unknown } } }[] } };
    const connected = config.provider_invocation_profiles.profiles.find(row => JSON.stringify(row.reference) === JSON.stringify(result.reference))!;
    expect(connected.adapter.definition.authentication).toEqual({ type: 'none' });
    // The governed in-process invocation (the runtime's own path without a service start) through the connected profile.
    const binding = await inspectModelBinding(f.project, result.reference, options);
    if (binding.status !== 'declared') throw new Error('FIXTURE_BINDING');
    f.state.script = [{ content: 'No key.' }];
    const invoked = await invokeConfiguredModel(f.project, { schemaVersion: 1, commandId: 'plain-http-call', scopeId: 'scope', reference: result.reference,
      catalogRevision: binding.catalogRevision, expectedBinding: binding.binding, nativeRequest: { model: f.command.model.nativeId, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 8, stream: true, stream_options: { include_usage: true } } }, options);
    expect(invoked.receipt.outcome, JSON.stringify(invoked.receipt.outcome)).toMatchObject({ state: 'responded' });
    expect(f.state.requests).toHaveLength(1); expect(f.state.authorization.length).toBeGreaterThanOrEqual(4); // probe, list, connect's list, the call
    expect(f.state.authorization.every(header => header === null)).toBe(true);
    expect(await readFile(f.path, 'utf8')).not.toContain(KEY);
  }, 60_000);

  it('configured discovery uses the real governed config, catalog, activation and audit owners without a runtime start', async () => {
    const f = await fixture();
    const listed = await listConfiguredConnectionModels(f.project, 'scope', 'local-openai', f.endpoint, { env: f.env }, f.host);
    expect(listed).toEqual([{ nativeId: f.command.model.nativeId, displayName: f.command.model.nativeId, priced: true }]);
    const result = await connectConfiguredModel(f.project, f.command, { env: f.env }, f.host);
    expect(result).toMatchObject({ status: 'connected', tariff: 'unmetered', credentialRef: null,
      steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written' } });
    const config = JSON.parse(await readFile(f.path, 'utf8'));
    expect(config.provider_catalog.providers.find((row: { id: string }) => row.id === result.reference.providerId).models[0].nativeId)
      .toBe(f.command.model.nativeId);
    expect(f.rows('SELECT record FROM model_catalog_models').map(row => String(row.record)).join('')).toContain(f.command.model.nativeId);
    expect(f.rows('SELECT record FROM audit_events').map(row => String(row.record)).join('')).toContain('model-connect');
    const again = await connectConfiguredModel(f.project, f.command, { env: f.env }, f.host);
    expect(again.reference).toEqual(result.reference);
    expect(again.steps).toMatchObject({ catalog: 'present', declaration: 'present', profile: 'present', activation: 'present' });
    expect(f.reads()).toBe(3); expect(f.state.requests).toEqual([]);
  });

  it('a generic remote endpoint with an exact shipped published tariff binds, using only the configured secret in the HTTPS header', async () => {
    const f = await fixture(), key = 'sk-discovery-configured-canary'; f.setIds(['gpt-6-luna']);
    const seen: unknown[] = [];
    const host = { discoveryOptions: { fetch: async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers }); return new Response('{"data":[{"id":"gpt-6-luna"}]}');
    } } };
    await grantFixtureSecrets(f.project, 'scope', ['DECKENT_OAICOMPAT_API_OPENAI_COM'], { env: f.env }); // PRE-8 v2: the admin lent the main key.
    const result = await connectConfiguredModel(f.project, { ...f.command, connection: 'openai-compatible', endpoint: 'https://api.openai.com/v1',
      model: { nativeId: 'gpt-6-luna' } }, { env: f.env, secretResolver: () => key }, host);
    expect(result).toMatchObject({ status: 'connected', tariff: 'published', credentialRef: 'DECKENT_OAICOMPAT_API_OPENAI_COM' });
    expect(seen).toEqual([{ url: 'https://api.openai.com/v1/models', headers: { accept: 'application/json', authorization: `Bearer ${key}` } }]);
    expect(JSON.stringify(result)).not.toContain(key); expect(await readFile(f.path, 'utf8')).not.toContain(key);
    expect(f.rows('SELECT record FROM audit_events').map(row => String(row.record)).join('')).not.toContain(key);
  });

  it('a removed or invented id is refused before any declaration/catalog/profile write', async () => {
    const f = await fixture();
    await listConfiguredConnectionModels(f.project, 'scope', 'local-openai', f.endpoint, { env: f.env }, f.host);
    f.setIds(['other']); const before = await readFile(f.path, 'utf8');
    const rows = f.rows('SELECT COUNT(*) AS n FROM model_catalog_models');
    // BeUser KER-07: the refusal names the requested model and connection and what the server lists (EN/TR); an empty list says so.
    const refused = await connectConfiguredModel(f.project, f.command, { env: f.env }, f.host).then(() => null, (error: { code: string; params?: Record<string, unknown>; localize?: (l: 'en' | 'tr') => { message: string } }) => error);
    expect(refused).toMatchObject({ code: 'MODEL_CONNECT_MODEL_UNKNOWN', params: { models: 'other', connection: 'local-openai' } });
    expect(refused!.localize!('en').message).toContain('local-openai at this address; it lists: other.'); expect(refused!.localize!('tr').message).toContain('listedekiler: other.');
    f.setIds([]); expect((await connectConfiguredModel(f.project, f.command, { env: f.env }, f.host).catch((error: { localize: (l: 'en') => { message: string } }) => error.localize('en').message))).toContain('listed no models');
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect(f.rows('SELECT COUNT(*) AS n FROM model_catalog_models')).toEqual(rows);
    expect(f.state.requests).toEqual([]);
  });

  it('alpha.56.1: an unreachable server names the exact address tried and, for a loopback server, the port-mapping hint; never a credential', async () => {
    const f = await fixture(), unreachable = { discoveryOptions: { fetch: async () => { throw new TypeError('fetch failed'); } } };
    const error = await listConfiguredConnectionModels(f.project, 'scope', 'local-openai', f.endpoint, { env: f.env }, unreachable).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE', params: { cause: 'network', address: `${f.endpoint}/v1/models` } });
    const params = (error as { params: Record<string, string> }).params;
    // BeUser alpha.56.1 (Ayşe): a local server that did not answer is named as such; the plain steps first, then the container/VM hint.
    expect(ErrorRegistry.get('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'en', params)!.message).toBe(`The model list could not be read: the server at ${f.endpoint}/v1/models did not answer. `
      + 'Check that the server is running and that this is the port it listens on. If it runs in a container or a VM, also check that this port is published to this computer (port mapping).');
    const tr = ErrorRegistry.get('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'tr', params)!.message;
    expect(tr).toContain(`${f.endpoint}/v1/models adresindeki sunucu yanıt vermedi. Sunucunun açık olduğunu`); expect(tr).not.toContain('ağa ulaşılamadı');
    expect(ErrorRegistry.get('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'en', { ...params, cause: 'timeout' })!.message).toContain('did not answer in time');
    expect(ErrorRegistry.createError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE').category).toBe('error'); // a server condition: the error exit, not usage
    // A remote address is named without the local hint; a non-network cause names no address.
    expect(ErrorRegistry.get('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'en', { ...params, address: 'https://llm.example/v1/models' })!.message).toBe('The model list could not be read: network unavailable (tried https://llm.example/v1/models).');
    expect(ErrorRegistry.get('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'en', { ...params, cause: 'http-status', status: 503 })!.message).toBe('The model list could not be read: HTTP status 503.');
    // Astra R2: the renderer shows only the display form of any address it is given.
    expect(ErrorRegistry.get('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'en', { ...params, address: 'https://u:secret-canary@llm.example/v1/models?api_key=secret-canary#secret-canary' })!.message)
      .toBe('The model list could not be read: network unavailable (tried https://llm.example/v1/models).');
  });

  it('inspect policy denial precedes network and preserves configuration', async () => {
    const f = await fixture([{ id: 'deny-inspect', effect: 'deny', actions: ['inspect'], scopes: ['scope'], principals: me,
      resource: { kind: 'model-activation', ids: 'all' } }]);
    const before = await readFile(f.path, 'utf8');
    await expect(connectConfiguredModel(f.project, f.command, { env: f.env }, f.host)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.reads()).toBe(0); expect(await readFile(f.path, 'utf8')).toBe(before);
  });

  it('an unpriced remote connection is refused before discovery, secret resolution or configuration writes', async () => {
    const f = await fixture(); const before = await readFile(f.path, 'utf8');
    let called = false;
    await expect(connectConfiguredModel(f.project, { ...f.command, connection: 'openai-compatible', endpoint: 'https://unpriced.example/v1' },
      { env: f.env, secretResolver: () => { throw new Error('secret must not be read'); } },
      { discoveryOptions: { fetch: async () => { called = true; throw new Error('network must not open'); } } }))
      .rejects.toMatchObject({ code: 'MODEL_CONNECT_PRICE_REQUIRED' });
    expect(called).toBe(false); expect(await readFile(f.path, 'utf8')).toBe(before);
  });
});
