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
  getConfigValue, resolveGlobalConfigPaths, productResourcePath, t, ENVIRONMENT_KEYS,
} from '../../../src/platform/index.js';

import { registerProviderConfig } from '../../../src/adapters/index.js';
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
    const a = createDefaultConfig(), b = createDefaultConfig(); a.layout.resources['ledger'] = 'changed';
    expect(b.layout.resources).toEqual({}); expect(b.enforce_principal_assurance).toBe(false);
    const base = { nested: { enabled: true, rows: [1, 2] }, keep: 4 };
    expect(deepMerge(base, { nested: { enabled: false, rows: [3] }, keep: undefined })).toEqual({ nested: { enabled: false, rows: [3] }, keep: 4 });
    expect(base.nested.rows).toEqual([1, 2]);
    expect(() => deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('applies defaults → global → project → env using the remaining bound fields', async () => {
    const f = await fixture();
    await writeFile(f.globalPath, JSON.stringify({ language: 'tr', max_workers: 4, enforce_principal_assurance: true }));
    await writeFile(f.projectPath, JSON.stringify({ max_workers: 2, enforce_principal_assurance: false }));
    const first = await loadConfig(f.project, { env: f.env });
    expect(first).toMatchObject({ max_workers: 2, language: 'tr', enforce_principal_assurance: false, schema_version: 4 });
    const second = await loadConfig(f.project, { env: { ...f.env, DECKENT_LANGUAGE: 'en' } });
    expect(second.language).toBe('en');
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
    expect(JSON.parse(await readFile(f.globalPath, 'utf8'))).toEqual({ schema_version: 4, language: 'en' });
  });
  it('resolves cache against call-time env and file revisions and never returns a shared mutable object', async () => {
    const f = await fixture();
    const one = await loadConfig(f.project, { env: f.env }); one.language = 'tr';
    expect((await loadConfig(f.project, { env: f.env })).language).toBe('en');
    await writeFile(f.projectPath, '{"language":"tr"}');
    expect((await loadConfig(f.project, { env: f.env })).language).toBe('tr');
    expect((await loadConfig(f.project, { env: { ...f.env, DECKENT_LANGUAGE: '', DECKENT_LANG: 'en', DECKENT_CONFIG_RELOAD: '1' } })).language).toBe('en');
  });
  it('does not treat DECKENT_DEBUG as a config input', async () => {
    expect(ENVIRONMENT_KEYS).not.toContain('DECKENT_DEBUG');
    const f = await fixture();
    const unset = await loadConfig(f.project, { env: f.env });
    const debug = await loadConfig(f.project, { env: { ...f.env, DECKENT_DEBUG: '1' } });
    expect(debug).toEqual(unset);
  });
  it('retired environment aliases cannot silently reintroduce removed knobs', async () => {
    const f = await fixture(), env = { ...f.env, DECKENT_MODE: 'api', DECKENT_LIVE_TRACE: 'true', DECKENT_BRAIN_PROVIDER: 'ignored' };
    const first = await loadConfig(f.project, { env });
    const cached = await loadConfig(f.project, { env });
    for (const config of [first, cached]) for (const key of ['mode', 'live_trace', 'providers']) expect(config).not.toHaveProperty(key);
  });
  it('aggregates schema issues, rejects unregistered fields and permits resource-defined worker capacity', () => {
    const config = createDefaultConfig();
    try { validateConfig({ ...config, language: 'xx', max_workers: 0, output_mode: 'wrong' }); expect.fail('must reject'); }
    catch (error) { expect(error).toBeInstanceOf(ConfigValidationError); expect((error as ConfigValidationError).issues).toHaveLength(3); }
    for (const count of [1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) expect(() => validateConfig({ ...config, max_workers: count })).toThrow();
    expect(() => validateConfig({ ...config, future: false })).toThrow();
    expect(validateConfig({ ...config, max_workers: 500 }).config.max_workers).toBe(500);
  });
  it('registers strict package schemas and validates authored layers before merge', async () => {
    const seen: unknown[] = [];
    registerConfigSection('contract_package', z.object({ enabled: z.boolean().default(false) }).strict(), { metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' }, validateLayers: (a, b) => { seen.push([a, b]); } });
    expect(() => registerConfigSection('contract_package', z.object({}).strict(), { metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' } })).toThrow();
    expect(() => registerConfigSection('unstrict', z.object({}), { metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' } })).toThrow();
    expect(() => registerConfigSection('language', z.object({}).strict(), { metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' } })).toThrow();
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
    registerConfigSection('custom_secrets', z.object({ token: z.string(), other: z.string() }).strict(), { metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.1', binding: { state: 'bound', consumers: ['src/platform/core/config'] }, apply: 'live' }, optional: true });
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
    expect(config.schema_version).toBe(4); expect(codes).toContain('CONFIG_GLOBAL_CORRUPT'); expect(codes).toContain('CONFIG_HEALED');
    expect(await readFile(f.globalPath, 'utf8')).toBe('{bad');
    const names = await readdir(join(f.project, '.deckent'));
    const backup = names.find(n => n.startsWith('config.json.bak.'))!;
    expect(await readFile(join(f.project, '.deckent', backup), 'utf8')).toBe('{broken');
    expect(JSON.parse(await readFile(f.projectPath, 'utf8')).schema_version).toBe(4);
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
    expect(await loadConfig(f.project, { env: { ...f.env, DECKENT_MODE: 'max_plan' } })).not.toHaveProperty('mode');
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
  it('resolves remaining registry environment bindings without shared default mutation', async () => {
    const f = await fixture();
    const yes = await loadConfig(f.project, { env: { ...f.env, DECKENT_LANGUAGE: 'tr' } });
    expect(yes.language).toBe('tr');
    const no = await loadConfig(f.project, { env: { ...f.env, DECKENT_LANGUAGE: 'en' } });
    expect(no.language).toBe('en');
    await expect(loadConfig(f.project, { env: { ...f.env, DECKENT_LANGUAGE: 'xx' } })).rejects.toThrow();
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
  it.each(['global', 'project', 'both'] as const)('rejects the unenforced provider limit section in %s config without rewriting it', async placement => {
    const f = await fixture();
    const authored = JSON.stringify({ provider_limits: { schemaVersion: 1, policies: [{ selector: { provider: 'fixture' },
      values: { warnAtRatio: 0.5, blockAtRatio: 0.8 } }] } });
    const paths = placement === 'both' ? [f.globalPath, f.projectPath] : [placement === 'global' ? f.globalPath : f.projectPath];
    for (const path of paths) await writeFile(path, authored);
    await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'CONFIG_VALIDATION',
      issues: expect.arrayContaining([{ path: 'provider_limits', reason: 'unrecognized_keys' }]) });
    for (const path of paths) expect(await readFile(path, 'utf8')).toBe(authored);
    expect(getConfigMetadata().some(field => field.key === 'provider_limits')).toBe(false);
  });
  it('looks up only own keys and never follows object prototypes', () => {
    expect(getConfigValue(createDefaultConfig(), 'layout.root')).toBeNull();
    expect(() => getConfigValue({}, '__proto__.polluted')).toThrow();
    expect(() => getConfigValue({}, 'missing')).toThrow();
  });
  it('does not resolve secrets from the old sibling file and resolves fresh values from the injected backend', async () => {
    const f = await fixture();
    await writeFile(f.projectPath, JSON.stringify({ schema_version: 3, projectName: '$DECK:TOKEN' }));
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

  it('pins configured layouts across cache copies and reloads, including resource paths', async () => {
    const f = await fixture(), firstRoot = join(f.root, 'data-a'), secondRoot = join(f.root, 'data-b');
    await writeFile(f.projectPath, JSON.stringify({ layout: { root: firstRoot } }));
    const first = await loadConfig(f.project, { env: f.env });
    const cached = await loadConfig(f.project, { env: f.env });
    expect(Object.isFrozen(cached.productLayout)).toBe(true);
    expect(Object.isFrozen(cached.productLayout.resources)).toBe(true);
    await writeFile(f.projectPath, JSON.stringify({ layout: { root: secondRoot } }));
    const next = await loadConfig(f.project, { env: f.env });
    expect(next.productLayout.revision).not.toBe(first.productLayout.revision);
    expect(productResourcePath(first.productLayout, 'memory')).toBe(join(firstRoot, 'brain', 'memory.db'));
  });
  it('rejects invalid layout configuration instead of following arbitrary config locations', async () => {
    const f = await fixture();
    for (const layout of [{ root: 'relative' }, { resources: { memory: '../escape' } }, { resources: { unknown: 'x' } },
      { resources: { config: 'elsewhere.json' } }, { resources: { tasks: 'locks' } }]) {
      await writeFile(f.projectPath, JSON.stringify({ layout }));
      await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'CONFIG_VALIDATION' });
    }
  });

});
