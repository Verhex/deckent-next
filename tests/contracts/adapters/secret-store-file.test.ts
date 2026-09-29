import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createEnvironmentSecretStore, createFileSecretStore } from '#adapters/index.js';
import { withConfigWriteLock } from '#platform/index.js';

// Synthetic canary only: never a real credential.
const CANARY = 'synthetic-canary-8f3c1a-not-a-real-key';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function root() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-secret-file-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const global = join(base, 'global');
  await mkdir(global, { mode: 0o700 });
  return { base, global, path: join(global, 'secrets.json') };
}
const leaks = (error: unknown) => JSON.stringify({ message: (error as Error)?.message, params: (error as { params?: unknown })?.params,
  cause: String((error as { cause?: unknown })?.cause ?? '') }).includes(CANARY);

it('file backend: round trip with a 0600 schemaVersion 1 document in a 0700 directory, atomic and name-validated', async () => {
  const f = await root(), store = createFileSecretStore({ root: f.global, platform: 'linux' });
  expect(store.descriptor).toEqual({ id: 'core.secret-store.file@1', writable: true, enumerable: true });
  expect(await store.get('PROVIDER_TOKEN')).toBeUndefined();
  expect(await store.listNames()).toEqual([]);
  await store.set('PROVIDER_TOKEN', CANARY);
  await store.set('ANOTHER_TOKEN', 'second-synthetic');
  expect(await store.get('PROVIDER_TOKEN')).toBe(CANARY);
  expect(await store.listNames()).toEqual(['ANOTHER_TOKEN', 'PROVIDER_TOKEN']);
  const info = await stat(f.path);
  expect(info.mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual({ schemaVersion: 1, secrets: { ANOTHER_TOKEN: 'second-synthetic', PROVIDER_TOKEN: CANARY } });
  expect(await store.delete('PROVIDER_TOKEN')).toBe(true);
  expect(await store.delete('PROVIDER_TOKEN')).toBe(false);
  expect(await store.get('PROVIDER_TOKEN')).toBeUndefined();
  // No temporary file or lock is left behind.
  expect((await readdir(f.global)).sort()).toEqual(['secrets.json']);
  await expect(store.set('lower_case', 'x')).rejects.toMatchObject({ code: 'SECRET_NAME_INVALID' });
  await expect(store.set('NAME', '')).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' });
  expect(await store.inspect()).toEqual({ status: 'ready', code: null });
});

it('file backend: creates a missing store directory as 0700 on first write only', async () => {
  const f = await root(), nested = join(f.base, 'fresh-root'), store = createFileSecretStore({ root: nested, platform: 'linux' });
  expect(await store.get('A')).toBeUndefined();
  await expect(lstat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
  await store.set('A', 'synthetic-a');
  expect((await stat(nested)).mode & 0o777).toBe(0o700);
});

it.each([
  ['group-readable file', async (f: Awaited<ReturnType<typeof root>>) => { await chmod(f.path, 0o640); }],
  ['other-readable file', async (f: Awaited<ReturnType<typeof root>>) => { await chmod(f.path, 0o604); }],
  ['group-accessible directory', async (f: Awaited<ReturnType<typeof root>>) => { await chmod(f.global, 0o750); }],
  ['hard-linked file', async (f: Awaited<ReturnType<typeof root>>) => { await link(f.path, join(f.base, 'second-link')); }],
  ['symlinked file', async (f: Awaited<ReturnType<typeof root>>) => {
    const target = join(f.base, 'elsewhere.json'); await writeFile(target, await readFile(f.path), { mode: 0o600 });
    await rm(f.path); await symlink(target, f.path); }],
] as const)('file backend refuses a %s without reading or leaking it', async (_label, damage) => {
  const f = await root(), store = createFileSecretStore({ root: f.global, platform: 'linux' });
  await store.set('PROVIDER_TOKEN', CANARY);
  await damage(f);
  for (const call of [() => store.get('PROVIDER_TOKEN'), () => store.listNames(), () => store.set('OTHER', 'synthetic-x'), () => store.delete('PROVIDER_TOKEN')]) {
    const error = await call().then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'SECRET_STORE_UNSAFE' });
    expect(leaks(error)).toBe(false);
  }
  expect(await store.inspect()).toEqual({ status: 'unsafe', code: 'SECRET_STORE_UNSAFE' });
});

it('file backend: a symlinked store directory is refused', async () => {
  const f = await root(), real = join(f.base, 'real'), linked = join(f.base, 'linked');
  await mkdir(real, { mode: 0o700 }); await symlink(real, linked);
  const store = createFileSecretStore({ root: linked, platform: 'linux' });
  await expect(store.get('A')).rejects.toMatchObject({ code: 'SECRET_STORE_UNSAFE' });
  await expect(store.set('A', 'synthetic')).rejects.toMatchObject({ code: 'SECRET_STORE_UNSAFE' });
});

it('file backend: corrupt or foreign-schema content is a typed refusal whose error carries no content', async () => {
  const f = await root(), store = createFileSecretStore({ root: f.global, platform: 'linux' });
  for (const text of [`{"schemaVersion":1,"secrets":{"A":"${CANARY}"`, JSON.stringify({ schemaVersion: 2, secrets: { A: CANARY } }),
    JSON.stringify({ schemaVersion: 1, secrets: { lower: CANARY } }), `${CANARY} not json`]) {
    await writeFile(f.path, text, { mode: 0o600 }); await chmod(f.path, 0o600);
    const error = await store.get('A').then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'SECRET_STORE_CORRUPT' });
    expect(leaks(error)).toBe(false);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  }
});

it('file backend: a held config write lock on the store is contention, not a lost or partial write', async () => {
  const f = await root(), store = createFileSecretStore({ root: f.global, platform: 'linux', lockTimeoutMs: 150 });
  await store.set('A', 'synthetic-a');
  let release!: () => void;
  const held = withConfigWriteLock(f.path, () => new Promise<void>(resolve => { release = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 20));
  await expect(store.set('B', 'synthetic-b')).rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
  release(); await held;
  expect(await store.listNames()).toEqual(['A']);
  // Concurrent writers serialize through the same lock: no update is lost.
  await Promise.all(['C', 'D', 'E', 'F'].map(name => createFileSecretStore({ root: f.global, platform: 'linux', lockTimeoutMs: 5_000 }).set(name, `synthetic-${name}`)));
  expect(await store.listNames()).toEqual(['A', 'C', 'D', 'E', 'F']);
});

it('file backend is unavailable without POSIX ownership (Windows is later in the accepted OS order)', async () => {
  const f = await root(), store = createFileSecretStore({ root: f.global, platform: 'win32' });
  await expect(store.get('A')).rejects.toMatchObject({ code: 'SECRET_STORE_UNAVAILABLE' });
  expect(await store.inspect()).toEqual({ status: 'unavailable', code: 'SECRET_STORE_UNAVAILABLE' });
  const rootless = createFileSecretStore({ root: null, platform: 'linux' });
  await expect(rootless.get('A')).rejects.toMatchObject({ code: 'SECRET_STORE_UNAVAILABLE' });
});

it('env backend: the previous behaviour (own properties only), read-only and not enumerable', async () => {
  const env = Object.create({ INHERITED: 'from-prototype' }) as Record<string, string>;
  env['PROVIDER_TOKEN'] = CANARY;
  const store = createEnvironmentSecretStore(env);
  expect(store.descriptor).toEqual({ id: 'core.secret-store.env@1', writable: false, enumerable: false });
  expect(await store.get('PROVIDER_TOKEN')).toBe(CANARY);
  expect(await store.get('INHERITED')).toBeUndefined();
  expect(await store.get('MISSING')).toBeUndefined();
  await expect(store.set('A', 'x')).rejects.toMatchObject({ code: 'SECRET_STORE_READ_ONLY' });
  await expect(store.delete('A')).rejects.toMatchObject({ code: 'SECRET_STORE_READ_ONLY' });
  await expect(store.listNames()).rejects.toMatchObject({ code: 'SECRET_STORE_UNSUPPORTED' });
  expect(await store.inspect()).toEqual({ status: 'ready', code: null });
});
