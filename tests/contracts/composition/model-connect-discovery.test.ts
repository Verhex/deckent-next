import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { connectConfiguredModel, listConfiguredConnectionModels } from '#composition/core/model-connect/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

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
    await expect(connectConfiguredModel(f.project, f.command, { env: f.env }, f.host)).rejects.toMatchObject({ code: 'MODEL_CONNECT_MODEL_UNKNOWN' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect(f.rows('SELECT COUNT(*) AS n FROM model_catalog_models')).toEqual(rows);
    expect(f.state.requests).toEqual([]);
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
