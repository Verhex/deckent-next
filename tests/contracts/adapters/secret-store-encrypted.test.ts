import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createEncryptedFileSecretStore, createFileSecretStore, openConfiguredSecretStore } from '#adapters/index.js';

// Synthetic canary only: never a real credential.
const CANARY = 'synthetic-canary-5d21e9-not-a-real-key';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function root() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-secret-sealed-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const global = join(base, 'global');
  await mkdir(global, { mode: 0o700 });
  return { base, global, path: join(global, 'secrets.sealed.json'), key: join(global, 'secrets.key') };
}
const store = (global: string) => createEncryptedFileSecretStore({ root: global, platform: 'linux' });
const leaks = (error: unknown) => JSON.stringify({ message: (error as Error)?.message, params: (error as { params?: unknown })?.params,
  cause: String((error as { cause?: unknown })?.cause ?? '') }).includes(CANARY);
const windows = process.platform === 'win32';

it.skipIf(windows)('requires POSIX private file secret store — encrypted backend: round trip; no value, name-value pair or plaintext document on disk', async () => {
  const f = await root(), s = store(f.global);
  expect(s.descriptor).toEqual({ id: 'core.secret-store.encrypted-file@1', writable: true, enumerable: true });
  expect(await s.get('PROVIDER_TOKEN')).toBeUndefined();
  // Nothing is created by a read: no key, no store.
  expect(await readdir(f.global)).toEqual([]);
  await s.set('PROVIDER_TOKEN', CANARY);
  await s.set('ANOTHER_TOKEN', 'second-synthetic');
  expect(await s.get('PROVIDER_TOKEN')).toBe(CANARY);
  expect(await s.listNames()).toEqual(['ANOTHER_TOKEN', 'PROVIDER_TOKEN']);
  expect((await readdir(f.global)).sort()).toEqual(['secrets.key', 'secrets.sealed.json']);
  const sealed = await readFile(f.path), key = await stat(f.key);
  expect(sealed.includes(CANARY)).toBe(false);
  expect(sealed.includes('PROVIDER_TOKEN')).toBe(false);
  expect(sealed.includes('second-synthetic')).toBe(false);
  expect(Object.keys(JSON.parse(sealed.toString('utf8'))).sort()).toEqual(['algorithm', 'ciphertext', 'iv', 'schemaVersion', 'tag']);
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect(key.mode & 0o777).toBe(0o600);
  expect(key.size).toBe(32);
  // A new IV per write: the same document sealed twice differs.
  const before = sealed.toString('utf8');
  await s.set('ANOTHER_TOKEN', 'second-synthetic');
  expect((await readFile(f.path, 'utf8')) === before).toBe(false);
  expect(await s.delete('PROVIDER_TOKEN')).toBe(true);
  expect(await s.delete('PROVIDER_TOKEN')).toBe(false);
  expect(await s.get('PROVIDER_TOKEN')).toBeUndefined();
  expect(await s.inspect()).toEqual({ status: 'ready', code: null });
});

it.skipIf(windows)('requires POSIX private file secret store — encrypted backend: a changed byte, a wrong key or a missing key is corrupt; nothing is re-keyed', async () => {
  const f = await root(), s = store(f.global);
  await s.set('PROVIDER_TOKEN', CANARY);
  const original = await readFile(f.path, 'utf8'), envelope = JSON.parse(original) as Record<string, string>;
  // Tampered ciphertext fails the GCM tag.
  const flipped = Buffer.from(envelope['ciphertext']!, 'base64'); flipped[0] = flipped[0]! ^ 0x01;
  await writeFile(f.path, JSON.stringify({ ...envelope, ciphertext: flipped.toString('base64') }), { mode: 0o600 });
  const tampered = await s.get('PROVIDER_TOKEN').catch((error: unknown) => error);
  expect(tampered).toMatchObject({ code: 'SECRET_STORE_CORRUPT' });
  expect(leaks(tampered)).toBe(false);
  await writeFile(f.path, original, { mode: 0o600 });
  // Another installation's key (same shape, other bytes).
  const key = await readFile(f.key); await rm(f.key);
  await writeFile(f.key, Buffer.alloc(32, 7), { mode: 0o600 });
  await expect(s.get('PROVIDER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_STORE_CORRUPT' });
  // A missing key beside an existing store refuses reads and writes; the store is not replaced and no key is minted.
  await rm(f.key);
  await expect(s.get('PROVIDER_TOKEN')).rejects.toMatchObject({ code: 'SECRET_STORE_CORRUPT' });
  await expect(s.set('OTHER', 'synthetic-other')).rejects.toMatchObject({ code: 'SECRET_STORE_CORRUPT' });
  expect(await readFile(f.path, 'utf8')).toBe(original);
  expect((await readdir(f.global)).sort()).toEqual(['secrets.sealed.json']);
  expect(await s.inspect()).toEqual({ status: 'corrupt', code: 'SECRET_STORE_CORRUPT' });
  // The right key restores access.
  await writeFile(f.key, key, { mode: 0o600 });
  expect(await s.get('PROVIDER_TOKEN')).toBe(CANARY);
  // A plaintext document is not accepted as an envelope.
  await writeFile(f.path, JSON.stringify({ schemaVersion: 1, secrets: { PROVIDER_TOKEN: CANARY } }), { mode: 0o600 });
  const plain = await s.get('PROVIDER_TOKEN').catch((error: unknown) => error);
  expect(plain).toMatchObject({ code: 'SECRET_STORE_CORRUPT' });
  expect(leaks(plain)).toBe(false);
});

it.skipIf(windows).each([
  ['group-readable key', async (f: Awaited<ReturnType<typeof root>>) => { await chmod(f.key, 0o640); }],
  ['hard-linked key', async (f: Awaited<ReturnType<typeof root>>) => { await link(f.key, join(f.base, 'second-link')); }],
  ['symlinked key', async (f: Awaited<ReturnType<typeof root>>) => {
    const target = join(f.base, 'elsewhere.key'); await writeFile(target, await readFile(f.key), { mode: 0o600 });
    await rm(f.key); await symlink(target, f.key); }],
  ['short key', async (f: Awaited<ReturnType<typeof root>>) => { await rm(f.key); await writeFile(f.key, Buffer.alloc(16, 1), { mode: 0o600 }); }],
  ['group-readable store', async (f: Awaited<ReturnType<typeof root>>) => { await chmod(f.path, 0o640); }],
])('requires POSIX private file secret store — encrypted backend: an unsafe key or store is refused unread (%s)', async (_label, breach) => {
  const f = await root(), s = store(f.global);
  await s.set('PROVIDER_TOKEN', CANARY);
  await breach(f);
  const error = await s.get('PROVIDER_TOKEN').catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'SECRET_STORE_UNSAFE' });
  expect(leaks(error)).toBe(false);
});

it.skipIf(windows)('requires POSIX private file secret store — encrypted backend: separate from the plaintext backend and selected only explicitly', async () => {
  const f = await root(), env = { HOME: f.base, DECKENT_GLOBAL_HOME: f.global };
  await createFileSecretStore({ root: f.global, platform: 'linux' }).set('PLAIN_ONLY', 'synthetic-plain');
  // The sealed store does not read the plaintext file, and an absent `secrets` section stays the environment backend.
  expect(await store(f.global).get('PLAIN_ONLY')).toBeUndefined();
  expect(openConfiguredSecretStore({}, env, 'linux').descriptor.id).toBe('core.secret-store.env@1');
  const selected = openConfiguredSecretStore({ secrets: { store: 'core.secret-store.encrypted-file@1' } }, env, 'linux');
  expect(selected.descriptor.id).toBe('core.secret-store.encrypted-file@1');
  await selected.set('SEALED_TOKEN', CANARY);
  expect(await selected.get('SEALED_TOKEN')).toBe(CANARY);
  expect((await readFile(join(f.global, 'secrets.sealed.json'))).includes(CANARY)).toBe(false);
});

it('encrypted backend: unavailable on native Windows and without an installation root', async () => {
  await expect(createEncryptedFileSecretStore({ root: 'C:\\deckent', platform: 'win32' }).set('A', 'synthetic')).rejects.toMatchObject({ code: 'SECRET_STORE_UNAVAILABLE' });
  await expect(createEncryptedFileSecretStore({ root: null, platform: 'linux' }).get('A')).rejects.toMatchObject({ code: 'SECRET_STORE_UNAVAILABLE' });
});

it('doctor names who can read the keys for each Core backend, in both languages, and the text survives the record redactor', async () => {
  const { renderDoctorReport } = await import('#surfaces/core/doctor/index.js');
  const { redactForRecord } = await import('#platform/index.js');
  const render = (backend: string, locale: 'tr' | 'en') => renderDoctorReport({ platform: 'linux', host: { cpuCores: 1, totalMemMB: 1, recommendedMaxWorkers: 1 },
    company: { companyId: 'c' }, principal: { id: 'p' }, secretStore: { backend, status: 'ready', code: null }, imageRefresh: null,
    installationBinding: null, shellRealm: null }, [], locale);
  const sealed = render('core.secret-store.encrypted-file@1', 'tr');
  expect(sealed).toContain('diğer programlar okuyabilir');
  expect(render('core.secret-store.encrypted-file@1', 'en')).toContain('other programs running as your user can');
  expect(render('core.secret-store.file@1', 'tr')).toContain('düz metin');
  expect(render('core.secret-store.env@1', 'en')).toContain('secrets.store = core.secret-store.encrypted-file@1');
  expect(render('enterprise.secret-store.vault@1', 'en').split('\n').filter(line => line.startsWith('  '))).toEqual([]);
  for (const backend of ['core.secret-store.env@1', 'core.secret-store.file@1', 'core.secret-store.encrypted-file@1']) {
    for (const locale of ['tr', 'en'] as const) expect(redactForRecord(render(backend, locale))).toBe(render(backend, locale));
  }
});

it('the agent read floor denies both sealed-store files wherever they sit (workers and tools never read them)', async () => {
  const { createGlobMatcher, DEFAULT_WORKSPACE_READ_DENY } = await import('#adapters/index.js');
  const denied = (path: string) => DEFAULT_WORKSPACE_READ_DENY.some(pattern => createGlobMatcher(pattern)(path));
  for (const path of ['secrets.sealed.json', 'secrets.key', 'home/.local/state/deckent/secrets.sealed.json', 'home/.local/state/deckent/secrets.key']) {
    expect(denied(path), path).toBe(true);
  }
});
