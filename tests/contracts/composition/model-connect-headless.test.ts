// S3-3 `models connect claude-cli-subscription` through the real configured paths (governed config writer, ledger catalog, activation, audit) with
// a scripted fake CLI: no real CLI and no model call. Model ids come from the packaged seed, never from this file.
import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withMcpPrincipal } from '#adapters/index.js';
import { connectConfiguredModel, loginConfiguredHeadless, readConfiguredHeadlessLogins } from '#composition/core/model-connect/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import seed from '../../../assets/model-catalog/claude-cli-subscription.json' with { type: 'json' };
import codexSeed from '../../../assets/model-catalog/codex-cli-subscription.json' with { type: 'json' };
import { roleModelInvocationReference } from '#engine/index.js';
import { CODEX_FAMILY, writeFakeCodexCli } from '../../fixtures/native-headless/codex.js';
import { writeFakeCli } from '../../fixtures/native-headless/stream.js';
import { me, runtime } from '../support/chat-turn-harness.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

// The MCP actor holds the same grants, so the refusal below is the person-only rule itself, not a missing grant.
const both = [...me, { issuer: `${me[0]!.issuer}/mcp`, subject: me[0]!.subject }];
const grants = [{ id: 'config', effect: 'allow', actions: ['write'], scopes: 'all', principals: both, resource: { kind: 'config', ids: 'all' } },
  { id: 'activation', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals: both, resource: { kind: 'model-activation', ids: 'all' } }];
const nativeId = seed.recommendedActivations[0]!.modelIds[0]!;
type Profile = { schemaVersion: number; billingAxis?: string; adapter: { id: string; definition: Record<string, unknown> } };
async function harness(preview: boolean | null, auth?: Record<string, unknown>) {
  // S3-5: the CLI runs isolated, so the fake logs into its own state file in the login dir (the one place it may write).
  const f = await runtime({ extraGrants: grants, noServer: true }), configDir = join(f.data, 'claude-login'), bin = join(f.data, 'bin'), logPath = join(configDir, '.claude.json');
  await mkdir(configDir, { mode: 0o700 }); await mkdir(bin);
  const executable = await writeFakeCli(bin, { logPath, ...(auth ? { auth } : {}) }), options = { env: f.env };
  // alpha.55.1: the retired key is protected, so the fixture sets it as the person at a terminal (the witness attests).
  if (preview !== null) await createConfiguredConfigApplication(f.project, options, undefined, { attest: async () => true }).submit('set', { keyPath: 'models.headless.preview', value: preview, layer: 'global',
    commandId: 'preview-on', scopeId: 'scope', principal: await resolveConfiguredConfigPrincipal(f.project, 'scope', options) });
  const connect = (commandId: string, over: Record<string, unknown> = {}) => connectConfiguredModel(f.project, { schemaVersion: 1, commandId, scopeId: 'scope',
    connection: 'claude-cli-subscription', endpoint: null, model: { nativeId }, cli: { executable, configDir }, ...over }, options);
  const profile = async () => ((JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8')) as { provider_invocation_profiles: { profiles: Profile[] } })
    .provider_invocation_profiles.profiles.find(item => item.adapter.id === 'native-cli-headless'));
  const spawns = async () => existsSync(logPath) ? (await readFile(logPath, 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { mode: string }).mode) : [];
  return { f, configDir, executable, connect, profile, spawns };
}

const sandbox = (await measureTestShellHost()).bubblewrap.status === 'available';
describe.skipIf(process.platform !== 'linux' || !sandbox)('S3-3 models connect claude-cli-subscription (fake CLI, no model call)', () => {
  it('S3-5: the kind needs no preview switch any more: it connects wherever its isolation realm works, the retired key set or not', async () => {
    for (const preview of [null, false]) {
      const h = await harness(preview);
      await expect(h.connect('c-1')).resolves.toMatchObject({ status: 'connected' });
      expect(await h.spawns()).toEqual(expect.arrayContaining(['version', 'help', 'auth'])); expect(await h.profile()).toBeDefined();
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
    expect(granted.cli).toEqual({ configDir: h.configDir, owned: false, delegate: ['ai', 'system'] });
    const consent = (await h.profile())!.adapter.definition['delegatedUse'];
    expect(consent).toEqual({ consentedBy: me[0], atMs: expect.any(Number), classes: ['ai', 'system'] });
    // A reconnect without a consent choice keeps it byte for byte; the same choice again changes nothing.
    expect(await h.connect('c-3')).toMatchObject({ steps: { profile: 'present' }, cli: { delegate: ['ai', 'system'] } });
    expect(await h.connect('c-4', { delegate: ['ai', 'system'] })).toMatchObject({ steps: { profile: 'present' } });
    expect((await h.profile())!.adapter.definition['delegatedUse']).toEqual(consent);
    expect(await h.connect('c-5', { delegate: [] })).toMatchObject({ steps: { profile: 'written' }, cli: { delegate: [] } });
    expect((await h.profile())!.adapter.definition['delegatedUse']).toBeNull();
  });
  it('without flags: the first CLI of the registry name in PATH (by realpath) and s3c the Brain\'s own login dir (never ~/.claude); none in PATH is refused typed', async () => {
    const h = await harness(true), bin = join(h.f.data, 'path-bin'), home = h.f.env.HOME;
    await mkdir(bin); await symlink(h.executable, join(bin, 'claude')); await mkdir(join(home, '.claude'), { mode: 0o700 });
    const run = (env: Record<string, string>, commandId: string) => connectConfiguredModel(h.f.project, { schemaVersion: 1, commandId, scopeId: 'scope',
      connection: 'claude-cli-subscription', endpoint: null, model: { nativeId } }, { env: { ...h.f.env, ...env } });
    await expect(run({ PATH: join(h.f.data, 'empty-bin') }, 'c-0')).rejects.toMatchObject({ code: 'HEADLESS_CLI_UNAVAILABLE' });
    expect(await h.spawns()).toEqual([]);
    const owned = join(await realpath(home), '.deckent', 'headless', 'logins', 'claude');
    await expect(run({ PATH: bin }, 'c-1')).resolves.toMatchObject({ status: 'connected', cli: { configDir: owned, owned: true } });
    expect((await h.profile())!.adapter.definition).toMatchObject({ executable: await realpath(h.executable), configDir: owned });
    expect((await lstat(owned)).mode & 0o777).toBe(0o700);
    // An explicit dir is the person's override, never the default; the doctor tells the two apart (no spawn, nothing created).
    expect(await h.connect('c-2')).toMatchObject({ cli: { configDir: h.configDir, owned: false } });
    const section = () => readFile(join(h.f.project, '.deckent/config.json'), 'utf8').then(text => (JSON.parse(text) as Record<string, unknown>)['provider_invocation_profiles']);
    expect((await readConfiguredHeadlessLogins(await section(), 'scope', { env: h.f.env })).map(login => [login.configDir, login.owned])).toEqual([[h.configDir, false]]);
    await run({ PATH: bin }, 'c-3');
    expect((await readConfiguredHeadlessLogins(await section(), 'scope', { env: h.f.env })).map(login => [login.configDir, login.owned])).toEqual([[owned, true]]);
  });
  it('s3c models login: an MCP actor or a caller without the terminal witness is refused before anything is created or started; the person signs the own dir in', async () => {
    const h = await harness(null), owned = join(await realpath(h.f.env.HOME), '.deckent', 'headless', 'logins');
    const exe = await writeFakeCli(join(h.f.data, 'bin'), { logPath: join(h.configDir, '.claude.json'), authFromLogin: true });
    const login = (confirm: () => Promise<boolean>, attest = true, over: Record<string, unknown> = {}) => loginConfiguredHeadless({ connection: 'claude-cli-subscription',
      executable: exe, ...over }, { env: h.f.env }, confirm, { attest: async () => attest });
    const asked: unknown[] = [], yes = async (dir?: unknown) => { asked.push(dir); return true; };
    await expect(withMcpPrincipal(() => login(yes))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect(login(yes, false)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(asked).toEqual([]); expect(existsSync(owned)).toBe(false); expect(await h.spawns()).toEqual([]);
    await expect(login(yes, true, { connection: 'anthropic-api' })).rejects.toMatchObject({ code: 'MODEL_CONNECT_NOT_CONNECTABLE' });
    // The card answered no: the dir exists (0700, empty), nothing ran.
    expect(await login(async () => false)).toBeNull();
    expect(await readdir(join(owned, 'claude'))).toEqual([]); expect(await h.spawns()).toEqual([]);
    const done = await login(yes);
    expect(done).toMatchObject({ configDir: join(owned, 'claude'), owned: true, exit: 'completed', signedIn: true, authMethod: 'claude.ai' });
    expect(asked).toEqual([{ configDir: join(owned, 'claude'), owned: true }]);
    expect(await h.spawns()).toEqual(['login']);
    // The person's override signs a dir they name in instead (an AI actor never reaches this: refused above for every input).
    expect(await login(yes, true, { configDir: h.configDir })).toMatchObject({ configDir: h.configDir, owned: false });
  });
  it('N9: a CLI that is not logged in is refused typed and nothing is written; Codex: the worker kind with an admitted image also writes a headless profile a role finds', async () => {
    const h = await harness(true, { loggedIn: false });
    await expect(h.connect('c-1')).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_REQUIRED' });
    expect(await h.profile()).toBeUndefined();
    // Codex (owner 2026-10-31): the image gate stays first; with an admitted worker CLI the connect writes the declaration, the headless profile
    // (catalog family, the consent given) and the chat activation beside the worker activation. Preflight only: no model call.
    const codexDir = join(h.f.data, 'codex-login'), codexModel = codexSeed.recommendedActivations[0]!.modelIds[0]!, path = join(h.f.project, '.deckent/config.json');
    await mkdir(codexDir, { mode: 0o700 });
    const codexExe = await writeFakeCodexCli(join(h.f.data, 'bin'), { logPath: join(codexDir, 'config.toml') });
    const codex = (commandId: string) => connectConfiguredModel(h.f.project, { schemaVersion: 1, commandId, scopeId: 'scope', connection: 'codex-cli-subscription', endpoint: null,
      model: { nativeId: codexModel }, cli: { executable: codexExe, configDir: codexDir }, delegate: ['ai'] }, { env: h.f.env });
    await expect(codex('x-0')).rejects.toMatchObject({ code: 'MODEL_CONNECT_WORKER_IMAGE_REQUIRED' });
    const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...config, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { profiles: [{ id: 'codex-worker', version: 1,
      parameters: { nativeSubscription: { provider: 'codex', preflight: { cliVersion: 'codex-cli 9.1.0' } } } }] } } }));
    await expect(codex('x-1')).resolves.toMatchObject({ status: 'connected', cli: { configDir: codexDir, delegate: ['ai'] },
      steps: { declaration: 'written', profile: 'written', activation: 'written' } });
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const profiles = (written['provider_invocation_profiles'] as { profiles: (Profile & { protocol: { family: string } })[] }).profiles;
    expect(profiles.find(item => item.protocol.family === CODEX_FAMILY)).toMatchObject({ schemaVersion: 2, billingAxis: 'subscription', adapter: { id: 'native-cli-headless',
      definition: { executable: codexExe, configDir: codexDir, delegatedUse: { classes: ['ai'] } } } });
    expect(roleModelInvocationReference({ modelRoles: undefined, providerCatalog: written['provider_catalog'], activation: async () => null }, written['provider_invocation_profiles'], 'scope',
      { channelId: 'codex-cli-subscription', modelId: codexModel })).toMatchObject({ providerId: 'codex-cli-subscription' });
  });
});
