// S3-3 `models connect claude-cli-subscription` through the real configured paths (governed config writer, ledger catalog, activation, audit) with
// a scripted fake CLI: no real CLI and no model call. Model ids come from the packaged seed, never from this file.
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withMcpPrincipal } from '#adapters/index.js';
import { connectConfiguredModel } from '#composition/core/model-connect/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import seed from '../../../assets/model-catalog/claude-cli-subscription.json' with { type: 'json' };
import { writeFakeCli } from '../../fixtures/native-headless/stream.js';
import { me, runtime } from '../support/chat-turn-harness.js';

// The MCP actor holds the same grants, so the refusal below is the person-only rule itself, not a missing grant.
const both = [...me, { issuer: `${me[0]!.issuer}/mcp`, subject: me[0]!.subject }];
const grants = [{ id: 'config', effect: 'allow', actions: ['write'], scopes: 'all', principals: both, resource: { kind: 'config', ids: 'all' } },
  { id: 'activation', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals: both, resource: { kind: 'model-activation', ids: 'all' } }];
const nativeId = seed.recommendedActivations[0]!.modelIds[0]!;
type Profile = { schemaVersion: number; billingAxis?: string; adapter: { id: string; definition: Record<string, unknown> } };
async function harness(preview: boolean | null, auth?: Record<string, unknown>) {
  const f = await runtime({ extraGrants: grants, noServer: true }), configDir = join(f.data, 'claude-login'), bin = join(f.data, 'bin'), logPath = join(f.data, 'cli.jsonl');
  await mkdir(configDir, { mode: 0o700 }); await mkdir(bin);
  const executable = await writeFakeCli(bin, { logPath, ...(auth ? { auth } : {}) }), options = { env: f.env };
  if (preview !== null) await createConfiguredConfigApplication(f.project, options).submit('set', { keyPath: 'models.headless.preview', value: preview, layer: 'global',
    commandId: 'preview-on', scopeId: 'scope', principal: await resolveConfiguredConfigPrincipal(f.project, 'scope', options) });
  const connect = (commandId: string, over: Record<string, unknown> = {}) => connectConfiguredModel(f.project, { schemaVersion: 1, commandId, scopeId: 'scope',
    connection: 'claude-cli-subscription', endpoint: null, model: { nativeId }, cli: { executable, configDir }, ...over }, options);
  const profile = async () => ((JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8')) as { provider_invocation_profiles: { profiles: Profile[] } })
    .provider_invocation_profiles.profiles.find(item => item.adapter.id === 'native-cli-headless'));
  const spawns = async () => existsSync(logPath) ? (await readFile(logPath, 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { mode: string }).mode) : [];
  return { f, configDir, executable, connect, profile, spawns };
}

describe.skipIf(process.platform !== 'linux')('S3-3 models connect claude-cli-subscription (fake CLI, no model call)', () => {
  it('N23: refuses the kind typed while the owner has not turned the preview on, before any spawn', async () => {
    for (const preview of [null, false]) {
      const h = await harness(preview);
      await expect(h.connect('c-1')).rejects.toMatchObject({ code: 'HEADLESS_KIND_UNAVAILABLE' });
      expect(await h.spawns()).toEqual([]); expect(await h.profile()).toBeUndefined();
    }
  });
  it('N19: an MCP actor can neither connect the person\'s login nor change its consent', async () => {
    const h = await harness(true);
    await expect(withMcpPrincipal(() => h.connect('c-1', { delegate: ['ai'] }))).rejects.toMatchObject({ code: 'HEADLESS_PERSON_REQUIRED' });
    expect(await h.spawns()).toEqual([]);
  });
  it('the person connects: preflight without a model call, uid floor and login dir sealed, subscription profile with no key; consent is theirs to give, keep and withdraw', async () => {
    const h = await harness(true);
    const first = await h.connect('c-1');
    expect(first).toMatchObject({ status: 'connected', credentialRef: null, tariff: 'unmetered', cli: { configDir: h.configDir, delegate: [] },
      steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written' } });
    expect(await h.spawns()).toEqual(expect.arrayContaining(['version', 'help', 'auth']));
    expect(await h.spawns()).not.toContain('call');
    const profile = (await h.profile())!;
    expect(profile).toMatchObject({ schemaVersion: 2, billingAxis: 'subscription', allocation: { maxCalls: null, maxInFlight: 1 }, adapter: { id: 'native-cli-headless', definition: { schemaVersion: 1, executable: h.executable,
      configDir: h.configDir, ownerUid: process.getuid!(), delegatedUse: null } } });
    expect(String(profile.adapter.definition['stateDir'])).toContain(join('headless', ''));
    const granted = await h.connect('c-2', { delegate: ['system', 'ai'] });
    expect(granted.cli).toEqual({ configDir: h.configDir, delegate: ['ai', 'system'] });
    const consent = (await h.profile())!.adapter.definition['delegatedUse'];
    expect(consent).toEqual({ consentedBy: me[0], atMs: expect.any(Number), classes: ['ai', 'system'] });
    // A reconnect without a consent choice keeps it byte for byte; the same choice again changes nothing.
    expect(await h.connect('c-3')).toMatchObject({ steps: { profile: 'present' }, cli: { delegate: ['ai', 'system'] } });
    expect(await h.connect('c-4', { delegate: ['ai', 'system'] })).toMatchObject({ steps: { profile: 'present' } });
    expect((await h.profile())!.adapter.definition['delegatedUse']).toEqual(consent);
    expect(await h.connect('c-5', { delegate: [] })).toMatchObject({ steps: { profile: 'written' }, cli: { delegate: [] } });
    expect((await h.profile())!.adapter.definition['delegatedUse']).toBeNull();
  });
  it('N9: a CLI that is not logged in is refused typed and nothing is written', async () => {
    const h = await harness(true, { loggedIn: false });
    await expect(h.connect('c-1')).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_REQUIRED' });
    expect(await h.profile()).toBeUndefined();
  });
});
