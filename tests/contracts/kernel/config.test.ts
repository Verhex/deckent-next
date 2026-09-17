import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createDefaultConfig, deepMerge, loadConfig, clearConfigCache, validateConfig, ConfigValidationError,
  registerConfigSection, saveGlobalConfig, writeConfig,
  withConfigWriteLock, readJsonFile, healCorruptProjectConfig, resolveConfigSecrets, getConfigMetadata,
  getConfigValue, resolveGlobalConfigPaths, t,
} from '../../../src/kernel/index.js';

import { registerProviderConfig, assertProviderLimitPolicyLayerPrecedence } from '../../../src/providers/index.js';
registerProviderConfig();

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-k1-')); roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project'), xdg = join(home, '.config');
  await mkdir(join(project, '.deckent'), { recursive: true });
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: xdg };
  const globalPath = resolveGlobalConfigPaths(env).platformPath, projectPath = join(project, '.deckent', 'config.json');
  await mkdir(dirname(globalPath), { recursive: true });
  return { root, home, project, env, globalPath, projectPath };
}
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('config public contract', () => {
  it('returns independent defaults and merges arrays/false/undefined without mutating either input', () => {
    const a = createDefaultConfig(), b = createDefaultConfig(); a.providers.overrides['x'] = 'changed';
    expect(b.providers.overrides).toEqual({}); expect(b.enforce_principal_assurance).toBe(false);
    const base = { nested: { enabled: true, rows: [1, 2] }, keep: 4 };
    expect(deepMerge(base, { nested: { enabled: false, rows: [3] }, keep: undefined })).toEqual({ nested: { enabled: false, rows: [3] }, keep: 4 });
    expect(base.nested.rows).toEqual([1, 2]);
    expect(() => deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('applies defaults → global → project → env with provider projection before env', async () => {
    const f = await fixture();
    await writeFile(f.globalPath, JSON.stringify({ mode: 'balanced', language: 'tr', enforce_principal_assurance: true, providers: { brain: 'global-provider' } }));
    await writeFile(f.projectPath, JSON.stringify({ mode: 'economic', enforce_principal_assurance: false, providers: { brain: 'project-provider' } }));
    const first = await loadConfig(f.project, { env: f.env });
    expect(first).toMatchObject({ mode: 'economic', language: 'tr', enforce_principal_assurance: false, providers: { brain: 'project-provider' }, schema_version: 2 });
    const second = await loadConfig(f.project, { env: { ...f.env, DECKENT_MODE: 'performance', DECKENT_BRAIN_PROVIDER: 'env-provider' } });
    expect(second).toMatchObject({ mode: 'performance', providers: { brain: 'env-provider' } });
    expect(second.providers.brain).toBe('env-provider');
  });
  it('uses the canonical global root without importing scattered platform configuration', async () => {
    const f = await fixture();
    await mkdir(join(f.home, '.config', 'deckent'), { recursive: true });
    const legacy = join(f.home, '.config', 'deckent', 'config.json');
    await writeFile(legacy, '{"language":"tr"}');
    expect((await loadConfig(f.project, { env: f.env })).language).toBe('en');
    await saveGlobalConfig({ language: 'en' }, { env: f.env });
    expect((await loadConfig(f.project, { env: f.env })).language).toBe('en');
    expect(JSON.parse(await readFile(legacy, 'utf8'))).toEqual({ language: 'tr' });
    expect(JSON.parse(await readFile(f.globalPath, 'utf8'))).toEqual({ schema_version: 2, language: 'en' });
  });
  it('resolves cache against call-time env and file revisions and never returns a shared mutable object', async () => {
    const f = await fixture();
    const one = await loadConfig(f.project, { env: f.env }); one.providers.brain = 'mutated';
    expect((await loadConfig(f.project, { env: f.env })).providers.brain).toBeNull();
    await writeFile(f.projectPath, '{"language":"tr"}');
    expect((await loadConfig(f.project, { env: f.env })).language).toBe('tr');
    expect((await loadConfig(f.project, { env: { ...f.env, DECKENT_LANGUAGE: '', DECKENT_LANG: 'en', DECKENT_CONFIG_RELOAD: '1' } })).language).toBe('en');
  });
  it('fails closed for API mode without auth, allowing the configured key without retaining it in config', async () => {
    const f = await fixture();
    await expect(loadConfig(f.project, { env: { ...f.env, DECKENT_MODE: 'api' } })).rejects.toBeInstanceOf(ConfigValidationError);
    const config = await loadConfig(f.project, { env: { ...f.env, DECKENT_MODE: 'api', ANTHROPIC_API_KEY: 'test-secret' } });
    expect(config.mode).toBe('api'); expect(JSON.stringify(config)).not.toContain('test-secret');
  });
  it('aggregates schema issues, rejects unregistered fields and permits resource-defined worker capacity', () => {
    const config = createDefaultConfig();
    try { validateConfig({ ...config, language: 'xx', max_workers: 0, mode: 'wrong' }); expect.fail('must reject'); }
    catch (error) { expect(error).toBeInstanceOf(ConfigValidationError); expect((error as ConfigValidationError).issues).toHaveLength(3); }
    for (const count of [1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) expect(() => validateConfig({ ...config, max_workers: count })).toThrow();
    expect(() => validateConfig({ ...config, future: false })).toThrow();
    expect(validateConfig({ ...config, max_workers: 500 }).config.max_workers).toBe(500);
  });
  it('registers strict package schemas and validates authored layers before merge', async () => {
    const seen: unknown[] = [];
    registerConfigSection('contract_package', z.object({ enabled: z.boolean().default(false) }).strict(), { validateLayers: (a, b) => { seen.push([a, b]); } });
    expect(() => registerConfigSection('contract_package', z.object({}).strict())).toThrow();
    expect(() => registerConfigSection('unstrict', z.object({}))).toThrow();
    expect(() => registerConfigSection('language', z.object({}).strict())).toThrow();
    expect(() => validateConfig({ ...createDefaultConfig(), contract_package: { unexpected: true } })).toThrow();
    const f = await fixture();
    await writeFile(f.globalPath, '{"contract_package":{"enabled":true}}');
    await writeFile(f.projectPath, '{"contract_package":{"enabled":false}}');
    const config = await loadConfig(f.project, { env: f.env });
    expect(config['contract_package']).toEqual({ enabled: false });
    expect(seen).toEqual([[{ enabled: true }, { enabled: false }]]);
    expect(getConfigMetadata().find(row => row.key === 'contract_package')?.owner).toBe('contract_package');
  });
  it('interpolates only exact $DECK references after layering and leaves missing references visible', async () => {
    const f = await fixture();
    registerConfigSection('custom_secrets', z.object({ token: z.string(), other: z.string() }).strict(), { optional: true });
    await writeFile(f.projectPath, '{"custom_secrets":{"token":"$DECK:TOKEN","other":"prefix $DECK:TOKEN"}}');
    f.env = { ...f.env, TOKEN: 'private-value' } as typeof f.env;
    const config = await loadConfig(f.project, { env: f.env });
    expect(config['custom_secrets']).toEqual({ token: 'private-value', other: 'prefix $DECK:TOKEN' });
    const missing: string[] = [];
    expect((await resolveConfigSecrets({ value: '$DECK:MISSING' }, async () => undefined, key => missing.push(key))).config).toEqual({ value: '$DECK:MISSING' });
    expect(missing).toEqual(['MISSING']);
  });
  it('uses defaults for corrupt global data without modifying it and heals persistent project parse failure', async () => {
    const f = await fixture(); await writeFile(f.globalPath, '{bad'); await writeFile(f.projectPath, '{broken');
    const codes: string[] = [];
    const config = await loadConfig(f.project, { env: f.env, onWarning: w => codes.push(w.code) });
    expect(config.schema_version).toBe(2); expect(codes).toContain('CONFIG_GLOBAL_CORRUPT'); expect(codes).toContain('CONFIG_HEALED');
    expect(await readFile(f.globalPath, 'utf8')).toBe('{bad');
    const names = await readdir(join(f.project, '.deckent'));
    const backup = names.find(n => n.startsWith('config.json.bak.'))!;
    expect(await readFile(join(f.project, '.deckent', backup), 'utf8')).toBe('{broken');
    expect(JSON.parse(await readFile(f.projectPath, 'utf8')).schema_version).toBe(2);
  });
  it('rereads after 150ms and never quarantines a transient partial write', async () => {
    const f = await fixture(); await writeFile(f.projectPath, '{partial');
    const loading = loadConfig(f.project, { env: f.env });
    await sleep(35); await writeFile(f.projectPath, '{"language":"tr"}');
    expect((await loading).language).toBe('tr');
    expect(await readdir(join(f.project, '.deckent'))).toEqual(['config.json']);
  });
  it('holds on non-regular files, symlinks, and stale healer preimages without moving healthy data', async () => {
    const f = await fixture(); await mkdir(f.projectPath);
    await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'CONFIG_READ_IO_HOLD' });
    await rm(f.projectPath, { recursive: true });
    await writeFile(f.globalPath, '{"language":"tr"}'); await symlink(f.globalPath, f.projectPath);
    await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'CONFIG_READ_IO_HOLD' });
    await rm(f.projectPath); await writeFile(f.projectPath, '{broken');
    const observed = await readJsonFile(f.projectPath); expect(observed.kind).toBe('corrupt');
    await writeFile(f.projectPath, '{"language":"tr"}');
    if (observed.kind === 'corrupt') await expect(healCorruptProjectConfig(f.projectPath, observed)).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
    expect(await readFile(f.projectPath, 'utf8')).toBe('{"language":"tr"}');
  });
});

describe('new config contract and write authority', () => {
  it('rejects old versions, aliases and retired execution selectors without changing authored bytes', async () => {
    const f = await fixture();
    for (const input of [{ schema_version: 1 }, { mode: 'pro_plan' }, { outputMode: 'json' },
      { brain_provider: 'old' }, { deckent_style: 'task' }, { routing_engine: 'v1' }, { output_mode: 'standart' }]) {
      const bytes = JSON.stringify(input);
      await writeFile(f.projectPath, bytes);
      await expect(loadConfig(f.project, { env: f.env, force: true })).rejects.toThrow();
      expect(await readFile(f.projectPath, 'utf8')).toBe(bytes);
      await expect(writeConfig(f.projectPath, input)).rejects.toThrow();
    }
    await writeFile(f.projectPath, '{}');
    await expect(loadConfig(f.project, { env: { ...f.env, DECKENT_MODE: 'max_plan' } })).rejects.toThrow();
  });
  it('retains the newest three corruption backups without leaving locks or temporary files', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) {
      await writeFile(f.projectPath, '{broken' + i);
      const observed = await readJsonFile(f.projectPath);
      if (observed.kind !== 'corrupt') throw new Error('fixture must be corrupt');
      const healed = await healCorruptProjectConfig(f.projectPath, observed);
      expect(await readFile(healed.backupPath, 'utf8')).toBe('{broken' + i);
    }
    const names = await readdir(join(f.project, '.deckent'));
    expect(names.filter(name => name.includes('.bak.'))).toHaveLength(3);
    expect(names.some(name => name.endsWith('.tmp') || name.endsWith('.write-lock'))).toBe(false);
  });
  it('resolves registry environment bindings with validated booleans and no shared default mutation', async () => {
    const f = await fixture();
    const yes = await loadConfig(f.project, { env: { ...f.env, DECKENT_LIVE_TRACE: 'true', DECKENT_WORKER_PROVIDER: 'provider-a' } });
    expect(yes.live_trace.enabled).toBe(true);
    expect(yes.providers.worker).toBe('provider-a');
    const no = await loadConfig(f.project, { env: { ...f.env, DECKENT_LIVE_TRACE: '0' } });
    expect(no.live_trace.enabled).toBe(false);
    expect(no.providers.worker).toBeNull();
    await expect(loadConfig(f.project, { env: { ...f.env, DECKENT_LIVE_TRACE: 'maybe' } })).rejects.toThrow();
    await writeFile(f.projectPath, '{"schema_version":null}');
    await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'CONFIG_VERSION_UNSUPPORTED' });
    expect(getConfigMetadata().find(row => row.key === 'max_workers')?.defaultValue).toBe('auto');
    expect(getConfigMetadata().some(row => row.key === 'deckent_style')).toBe(false);
    for (const row of getConfigMetadata()) {
      expect(row.since).toMatch(/^\d+\.\d+\.\d+/);
      expect(row.tier).toBe('core');
      for (const locale of ['en', 'tr'] as const) expect(t(row.descriptionKey, {}, locale)).not.toBe(row.descriptionKey);
    }
    expect(no).not.toHaveProperty('brain_provider');
    expect(no).not.toHaveProperty('worker_provider');
    expect(no).not.toHaveProperty('fallback_provider');
    expect(no).not.toHaveProperty('provider_overrides');
  });
  it('serializes cooperating writers and refuses obsolete revision digests', async () => {
    const f = await fixture(); const events: number[] = [];
    await Promise.all([withConfigWriteLock(f.projectPath, async () => { events.push(1); await sleep(45); events.push(2); }),
      sleep(5).then(() => withConfigWriteLock(f.projectPath, async () => { events.push(3); }))]);
    expect(events).toEqual([1, 2, 3]);
    await writeFile(f.projectPath, '{"language":"tr"}');
    await expect(writeConfig(f.projectPath, { language: 'en' }, 'obsolete')).rejects.toMatchObject({ code: 'CONFIG_CONCURRENT_REVISION_HOLD' });
    expect(JSON.parse(await readFile(f.projectPath, 'utf8'))).toEqual({ language: 'tr' });
  });
  it('requires parent policy and prevents weaker child quotas, including selector mismatch', () => {
    const selector = { tenantId: 'local', provider: 'test-provider' };
    const parent = { schemaVersion: 1, policies: [{ selector, values: { warnAtRatio: 0.7, blockAtRatio: 0.9, minimumRemaining: { tokens: 10 } } }] };
    const child = (values: unknown, id = selector) => ({ schemaVersion: 1, policies: [{ selector: id, values }] });
    expect(() => assertProviderLimitPolicyLayerPrecedence(parent, child({ blockAtRatio: 0.8 }))).not.toThrow();
    for (const value of [{ blockAtRatio: 0.99 }, { ratioEnforcement: 'observe_only' }, { minimumRemaining: { tokens: 1 } }]) expect(() => assertProviderLimitPolicyLayerPrecedence(parent, child(value))).toThrow();
    expect(() => assertProviderLimitPolicyLayerPrecedence(undefined, child({}))).toThrow();
    expect(() => assertProviderLimitPolicyLayerPrecedence(parent, child({}, { ...selector, tenantId: 'other' }))).toThrow();
  });
  it('looks up only own keys and never follows object prototypes', () => {
    expect(getConfigValue(createDefaultConfig(), 'providers.brain')).toBeNull();
    expect(() => getConfigValue({}, '__proto__.polluted')).toThrow();
    expect(() => getConfigValue({}, 'missing')).toThrow();
  });
  it('does not resolve secrets from the old sibling file and resolves fresh values from the injected backend', async () => {
    const f = await fixture();
    await writeFile(f.projectPath, JSON.stringify({ schema_version: 2, projectName: '$DECK:TOKEN' }));
    await writeFile(join(f.project, '.deck'), 'TOKEN="outside-value"\n');
    const first = await loadConfig(f.project, { env: f.env });
    expect(first.projectName).toBe('$DECK:TOKEN');
    const next = await loadConfig(f.project, { env: f.env, secretResolver: async name => name === 'TOKEN' ? 'inside-value' : undefined });
    expect(next.projectName).toBe('inside-value');
  });

  it('observes secret rotation and revocation without caching resolved values', async () => {
    const f = await fixture();
    await writeFile(f.projectPath, JSON.stringify({ projectName: '$DECK:TOKEN' }));
    let secret: string | undefined = 'first';
    const options = { env: f.env, secretResolver: async () => secret };
    expect((await loadConfig(f.project, options)).projectName).toBe('first');
    secret = 'second';
    expect((await loadConfig(f.project, options)).projectName).toBe('second');
    secret = undefined;
    expect((await loadConfig(f.project, options)).projectName).toBe('$DECK:TOKEN');
    expect(await readdir(join(f.project, '.deckent'))).toEqual(['config.json']);
  });
  it('resolves repeated references once per load and does not expose backend error content', async () => {
    let calls = 0;
    const result = await resolveConfigSecrets({ a: '$DECK:TOKEN', b: ['$DECK:TOKEN'] }, async () => { calls++; return 'value'; });
    expect(calls).toBe(1); expect(result.secretPaths).toEqual(['/a', '/b/0']);
    await expect(resolveConfigSecrets({ a: '$DECK:TOKEN' }, async () => { throw new Error('private-backend-value'); })).rejects.toThrow(/^SECRET_RESOLUTION_FAILED$/);
  });

});
