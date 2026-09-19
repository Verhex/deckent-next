import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, utimes } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig, configDisplayView, withConfigWriteLock, clearConfigCache, registerConfigSection,
  resolveProductPaths, productResourcePath, ConfigValidationError, type ConfigWarning } from '../../../src/platform/index.js';
import { registerProviderConfig } from '../../../src/adapters/index.js';

registerProviderConfig();
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-revision-')); roots.push(root);
  await mkdir(join(root, '.deckent'));
  const path = join(root, '.deckent/config.json');
  const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: root };
  return { root, path, env, lock: `${path}.write-lock` };
}
async function deadPid(): Promise<number> {
  const result = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(result.stdout);
}
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('K1 review regression contracts', () => {
  it('keeps secrets available to runtime but masks nested, array, escaped and projected display paths', async () => {
    const f = await fixture(), secret = 'private value with spaces " quotes';
    f.env = { ...f.env, API_TOKEN: secret } as typeof f.env;
    registerConfigSection('redaction_probe', z.object({ extra: z.array(z.object({ value: z.string() }).strict()), credentials: z.object({ api_key: z.string() }).strict(), note: z.string() }).strict(), { optional: true });
    await writeFile(f.path, JSON.stringify({ providers: { brain: '$DECK:API_TOKEN', overrides: { 'a/b~c': '$DECK:API_TOKEN' } },
      redaction_probe: { extra: [{ value: '$DECK:API_TOKEN' }], credentials: { api_key: 'another plaintext value' }, note: 'Bearer token-example' } }));
    const config = await loadConfig(f.root, { env: f.env });
    expect(config.providers.brain).toBe(secret);
    expect(config.secretPaths).toEqual(expect.arrayContaining(['/providers/brain', '/providers/overrides/a~1b~0c', '/redaction_probe/extra/0/value']));
    const view = configDisplayView(config);
    expect(view).toMatchObject({ providers: { brain: '[REDACTED]', overrides: { 'a/b~c': '[REDACTED]' } },
      redaction_probe: { extra: [{ value: '[REDACTED]' }], credentials: { api_key: '[REDACTED]' } } });
    for (const value of [secret, 'another plaintext value', 'token-example']) expect(JSON.stringify(view)).not.toContain(value);
    expect(view).not.toHaveProperty('secretPaths');
    expect(config.providers.brain).toBe(secret);
    expect(configDisplayView(await loadConfig(f.root, { env: f.env }))).toEqual(view);
  });
  it('reclaims a dead legacy owner once and serializes concurrent recovery callers', async () => {
    const f = await fixture(), pid = await deadPid(), warnings: ConfigWarning[] = [];
    await writeFile(f.lock, JSON.stringify({ pid }));
    let inside = 0, max = 0;
    await Promise.all(Array.from({ length: 8 }, () => withConfigWriteLock(f.path, async () => {
      max = Math.max(max, ++inside); await sleep(8); inside--;
      const owner = JSON.parse(await readFile(join(f.lock, 'owner.json'), 'utf8'));
      expect(owner).toMatchObject({ pid: process.pid, hostname: hostname() });
      expect(owner.nonce).toMatch(/^[\da-f-]+$/); expect(Date.parse(owner.createdAt)).toBeGreaterThan(0);
    }, 2_000, { onWarning: w => warnings.push(w) })));
    expect(max).toBe(1); expect(warnings.map(w => w.code)).toEqual(['CONFIG_LOCK_STALE_RECLAIMED']);
    expect((await readdir(join(f.root, '.deckent'))).filter(name => name.includes('.stale-'))).toHaveLength(1);
  });
  it('atomically removes an aged unpublished empty directory', async () => {
    const f = await fixture(); await mkdir(f.lock);
    const old = new Date(Date.now() - 660_000); await utimes(f.lock, old, old);
    const warnings: ConfigWarning[] = [];
    await withConfigWriteLock(f.path, async () => {}, 100, { onWarning: w => warnings.push(w) });
    expect(warnings[0]?.code).toBe('CONFIG_LOCK_STALE_RECLAIMED');
    expect(await readdir(join(f.root, '.deckent'))).toEqual([]);
  });
  it('never steals an old live lock and reports path, pid and age on timeout', async () => {
    const f = await fixture(), old = new Date(Date.now() - 3600_000);
    const text = JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: old.toISOString(), nonce: 'live' });
    await writeFile(f.lock, text); await utimes(f.lock, old, old);
    let entered = false;
    await expect(withConfigWriteLock(f.path, async () => { entered = true; }, 60)).rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED',
      params: { path: f.lock, pid: process.pid, ageSeconds: expect.any(Number) }, message: expect.stringContaining(f.lock) });
    expect(entered).toBe(false); expect(await readFile(f.lock, 'utf8')).toBe(text);
  });
  it('holds on a foreign owner even after ten minutes because its liveness is unprovable locally', async () => {
    const f = await fixture(), old = new Date(Date.now() - 3600_000);
    await writeFile(f.lock, JSON.stringify({ pid: await deadPid(), hostname: `${hostname()}-other`, createdAt: old.toISOString() }));
    await expect(withConfigWriteLock(f.path, async () => {}, 30)).rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
  });
  it('excludes unrelated environment values from cache identity and reruns effective validators on cache hits', async () => {
    const f = await fixture(); let layers = 0, effective = 0, admitted = true;
    registerConfigSection('review_cache_probe', z.object({}).strict(), { optional: true,
      validateLayers: () => { layers++; }, validateEffective: () => {
        effective++;
        if (!admitted) throw new ConfigValidationError([{ path: 'review_cache_probe', reason: 'REQUIRED' }]);
      } });
    const env = { ...f.env, DECKENT_MODE: 'api', UNRELATED_VALUE: 'first' };
    await loadConfig(f.root, { env });
    await loadConfig(f.root, { env: { ...env, UNRELATED_VALUE: 'second' } });
    expect(layers).toBe(1); expect(effective).toBe(2);
    admitted = false;
    try {
      await expect(loadConfig(f.root, { env })).rejects.toMatchObject({ code: 'CONFIG_VALIDATION' });
      expect(layers).toBe(1); expect(effective).toBe(3);
    } finally { admitted = true; }
  });
  it('keeps project bootstrap config separate from a relocated Windows data root', () => {
    const context = { platform: 'win32', env: { DECKENT_HOME: 'D:\\state', BRAIN_HOME: 'E:\\brain' } };
    const layout = resolveProductPaths('C:\\project', context);
    expect(productResourcePath(layout, 'config')).toBe('C:\\project\\.deckent\\config.json');
    expect(productResourcePath(layout, 'memory')).toBe('D:\\state\\brain\\memory.db');
  });
});
