import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache, loadConfig, resolveGlobalConfigPaths } from '#platform/index.js';

registerProviderConfig(); const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };
const profile = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference,
  bindingDigest: 'a'.repeat(64), protocol: { family: 'openai-chat-completions', version: 'v1' },
  adapter: { id: 'openai-chat-http', version: 3, definition: { endpoint: 'http://127.0.0.1:1234/customer/native-chat', maxOutputTokens: 4, authentication: { type: 'none' } } },
  allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 1 }, limits: { requestMaxBytes: 100, responseMaxBytes: 200, timeoutMs: 1000 }, ...overrides });
const collection = (...profiles: unknown[]) => ({ schemaVersion: 1, profiles });
async function configFixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-invocation-profile-config-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  const projectPath = join(project, '.deckent/config.json'), globalPath = resolveGlobalConfigPaths(env).platformPath;
  await Promise.all([mkdir(dirname(projectPath), { recursive: true }), mkdir(dirname(globalPath), { recursive: true })]);
  return { project, env, projectPath, globalPath };
}

describe('invocation profile configuration authority', () => {
  it('allows an exact parent subset and rejects project replacement of caps, endpoints or definitions', async () => {
    const f = await configFixture();
    const second = profile({ id: 'second', reference: { ...reference, modelId: 'other' } }), parent = collection(profile(), second);
    await writeFile(f.globalPath, JSON.stringify({ provider_invocation_profiles: parent }));
    await writeFile(f.projectPath, JSON.stringify({ provider_invocation_profiles: collection(second) }));
    expect((await loadConfig(f.project, { env: f.env })).provider_invocation_profiles).toEqual(collection(second));
    for (const changed of [profile({ limits: { requestMaxBytes: 101, responseMaxBytes: 200, timeoutMs: 1000 } }),
      profile({ adapter: { id: 'openai-chat-http', version: 3, definition: { endpoint: 'http://127.0.0.1:9999/customer/native-chat', maxOutputTokens: 4, authentication: { type: 'none' } } } })]) {
      await writeFile(f.projectPath, JSON.stringify({ provider_invocation_profiles: collection(changed) })); clearConfigCache();
      await expect(loadConfig(f.project, { env: f.env })).rejects.toThrow();
    }
    await rm(f.globalPath); await writeFile(f.projectPath, JSON.stringify({ provider_invocation_profiles: collection(profile()) })); clearConfigCache();
    expect((await loadConfig(f.project, { env: f.env })).provider_invocation_profiles).toEqual(collection(profile()));
  });

  it('rejects duplicate selection/profile identity and inconsistent shared allocation ceilings', async () => {
    const f = await configFixture();
    const rejected = async (value: unknown) => { await writeFile(f.projectPath, JSON.stringify({ provider_invocation_profiles: value })); clearConfigCache();
      await expect(loadConfig(f.project, { env: f.env })).rejects.toThrow(); };
    await rejected(collection(profile(), profile({ id: 'other' })));
    await rejected(collection(profile(), profile({ reference: { ...reference, modelId: 'other' } })));
    const shared = profile({ id: 'other', reference: { ...reference, modelId: 'other' },
      allocation: { id: 'allocation', maxCalls: 3, maxInFlight: 1 } });
    await rejected(collection(profile(), shared));
  });

  it('rejects secret interpolation before invoking a resolver', async () => {
    const f = await configFixture();
    await writeFile(f.projectPath, JSON.stringify({ provider_invocation_profiles: collection(profile({
      adapter: { id: 'openai-chat-http', version: 3, definition: { endpoint: '$DECK:ENDPOINT', maxOutputTokens: 4, authentication: { type: 'none' } } } })) }));
    let resolutions = 0;
    await expect(loadConfig(f.project, { env: f.env, secretResolver: async () => { resolutions++; return 'http://127.0.0.1:1'; } })).rejects.toThrow();
    expect(resolutions).toBe(0);
  });
});
