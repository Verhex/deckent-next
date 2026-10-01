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

it.skipIf(process.platform === 'win32')('requires POSIX private file secret store — file backend: round trip with a 0600 schemaVersion 1 document in a 0700 directory, atomic and name-validated', async () => {
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

it.skipIf(process.platform === 'win32')('requires POSIX private file secret store — file backend: creates a missing store directory as 0700 on first write only', async () => {
  const f = await root(), nested = join(f.base, 'fresh-root'), store = createFileSecretStore({ root: nested, platform: 'linux' });
  expect(await store.get('A')).toBeUndefined();
  await expect(lstat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
  await store.set('A', 'synthetic-a');
  expect((await stat(nested)).mode & 0o777).toBe(0o700);
});

it.skipIf(process.platform === 'win32').each([
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

it.skipIf(process.platform === 'win32')('requires POSIX private file secret store — file backend: a symlinked store directory is refused', async () => {
  const f = await root(), real = join(f.base, 'real'), linked = join(f.base, 'linked');
  await mkdir(real, { mode: 0o700 }); await symlink(real, linked);
  const store = createFileSecretStore({ root: linked, platform: 'linux' });
  await expect(store.get('A')).rejects.toMatchObject({ code: 'SECRET_STORE_UNSAFE' });
  await expect(store.set('A', 'synthetic')).rejects.toMatchObject({ code: 'SECRET_STORE_UNSAFE' });
});

it.skipIf(process.platform === 'win32')('requires POSIX private file secret store — file backend: corrupt or foreign-schema content is a typed refusal whose error carries no content', async () => {
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

it.skipIf(process.platform === 'win32')('requires POSIX private file secret store — file backend: a held config write lock on the store is contention, not a lost or partial write', async () => {
  const f = await root(), store = createFileSecretStore({ root: f.global, platform: 'linux', lockTimeoutMs: 150 });
  await store.set('A', 'synthetic-a');
  let release!: () => void, acquired!: () => void;
  const holding = new Promise<void>(resolve => { acquired = resolve; });
  // Deterministic: the contender starts only once the holder is inside the lock (no timing assumption under load).
  const held = withConfigWriteLock(f.path, () => new Promise<void>(resolve => { release = resolve; acquired(); }));
  await holding;
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

// SECRET-BOUNDS (Astra 2185 R5): the writer admits the exact document it will write against the reader's bound, so no sequence of accepted
// changes can leave a store the backend itself refuses to read. The oracle below is independent of the product: the pretty JSON (2-space
// indent, sorted names, trailing newline) the store writes, measured in UTF-8 bytes.
const LIMIT = 1_048_576;
const documentBytes = (secrets: Readonly<Record<string, string>>) => Buffer.byteLength(`${JSON.stringify({ schemaVersion: 1,
  secrets: Object.fromEntries(Object.keys(secrets).sort().map(name => [name, secrets[name]])) }, null, 2)}\n`, 'utf8');
/** A value of exactly `bytes` UTF-8 bytes built from 4-byte characters (JS length about half its bytes), padded with ASCII. */
const multibyte = (bytes: number) => '\u{1F600}'.repeat(Math.floor(bytes / 4)) + 'x'.repeat(bytes % 4);
async function filled(f: Awaited<ReturnType<typeof root>>, value: (index: number) => string, count = 15) {
  const store = createFileSecretStore({ root: f.global, platform: 'linux' }), secrets: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    const name = `FILL_${String(index).padStart(2, '0')}`; secrets[name] = value(index); await store.set(name, secrets[name]);
  }
  return { store, secrets };
}
const full = { code: 'SECRET_STORE_FULL', params: { backend: 'core.secret-store.file@1', maxBytes: String(LIMIT) } };

it.skipIf(process.platform === 'win32')('requires POSIX private file secret store — file backend: a change is admitted only when its whole document fits the reader bound — exact limit accepted, one byte over refused', async () => {
  const f = await root(), { store, secrets } = await filled(f, () => 'x'.repeat(65_536));
  // `LAST` sorts after every FILL_ name: an empty value is the document with the entry, the room is what its value may add.
  const room = LIMIT - documentBytes({ ...secrets, LAST: '' });
  expect(room).toBeGreaterThan(0); expect(room + 1).toBeLessThanOrEqual(65_536);
  const before = await readFile(f.path);
  const refused = await store.set('LAST', `${CANARY}${'x'.repeat(room + 1 - CANARY.length)}`).then(() => null, (error: unknown) => error);
  expect(refused).toMatchObject(full);
  expect(leaks(refused)).toBe(false);
  expect((refused as { cause?: unknown }).cause).toBeUndefined();
  // Nothing was written: the same bytes, no temporary file, every earlier secret readable.
  expect((await readFile(f.path)).equals(before)).toBe(true);
  expect((await readdir(f.global)).sort()).toEqual(['secrets.json']);
  expect(await store.get('LAST')).toBeUndefined();
  expect(await store.get('FILL_00')).toBe(secrets['FILL_00']);
  await store.set('LAST', 'x'.repeat(room));
  expect((await stat(f.path)).size).toBe(LIMIT);
  expect((await store.get('LAST'))?.length).toBe(room);
  expect(await store.inspect()).toEqual({ status: 'ready', code: null });
  // A full store still deletes (a delete only shrinks) and then admits a change that fits again.
  expect(await store.delete('FILL_00')).toBe(true);
  await store.set('AFTER', 'synthetic-after');
  expect(await store.listNames()).toContain('AFTER');
  expect((await stat(f.path)).size).toBeLessThanOrEqual(LIMIT);
}, 30_000);

it.skipIf(process.platform === 'win32')('requires POSIX private file secret store — file backend: bytes are counted after JSON escaping and in UTF-8 (4-byte characters, control characters, quotes)', async () => {
  const f = await root(), { store, secrets } = await filled(f, () => multibyte(65_536));
  // A 4-byte character is 2 JS units: counting characters instead of bytes would admit this document at twice the bound.
  const room = LIMIT - documentBytes({ ...secrets, LAST: '' });
  await expect(store.set('LAST', multibyte(room + 1))).rejects.toMatchObject(full);
  await store.set('LAST', multibyte(room));
  expect((await stat(f.path)).size).toBe(LIMIT);
  expect(await store.get('LAST')).toBe(multibyte(room));
  // Escaping growth: a 64 KiB value of U+0001 is 6 bytes per character once serialized (\u0001), a quote or backslash 2.
  const g = await root(), escaped = createFileSecretStore({ root: g.global, platform: 'linux' });
  const control = '\u0001'.repeat(65_536), quoted = '"\\'.repeat(32_768);
  expect(Buffer.byteLength(control, 'utf8')).toBe(65_536);
  await escaped.set('CONTROL_A', control); await escaped.set('CONTROL_B', control);
  await escaped.set('QUOTED_A', quoted);
  const before = await readFile(g.path);
  expect(documentBytes({ CONTROL_A: control, CONTROL_B: control, QUOTED_A: quoted, QUOTED_B: quoted })).toBeGreaterThan(LIMIT);
  await expect(escaped.set('QUOTED_B', quoted)).rejects.toMatchObject(full);
  await expect(escaped.set('CONTROL_C', control)).rejects.toMatchObject(full);
  expect((await readFile(g.path)).equals(before)).toBe(true);
  expect(await escaped.get('CONTROL_A')).toBe(control);
  expect(await escaped.listNames()).toEqual(['CONTROL_A', 'CONTROL_B', 'QUOTED_A']);
}, 30_000);

it.skipIf(process.platform === 'win32')('requires POSIX private file secret store — file backend: overwriting an existing name is admitted on the net document (growth refused, same or smaller size accepted)', async () => {
  const f = await root(), { store, secrets } = await filled(f, () => 'x'.repeat(65_536));
  const room = LIMIT - documentBytes({ ...secrets, LAST: '' });
  await store.set('LAST', 'a'.repeat(room));
  expect((await stat(f.path)).size).toBe(LIMIT);
  const before = await readFile(f.path);
  await expect(store.set('LAST', 'b'.repeat(room + 1))).rejects.toMatchObject(full);
  await expect(store.set('FILL_03', 'b'.repeat(65_536 - 1).concat('"'))).rejects.toMatchObject(full);
  expect((await readFile(f.path)).equals(before)).toBe(true);
  expect(await store.get('LAST')).toBe('a'.repeat(room));
  await store.set('LAST', 'c'.repeat(room));
  expect(await store.get('LAST')).toBe('c'.repeat(room));
  await store.set('FILL_03', 'synthetic-small');
  expect((await stat(f.path)).size).toBe(LIMIT - 65_536 + 'synthetic-small'.length);
}, 30_000);

it.skipIf(process.platform === 'win32')('requires POSIX private file secret store — file backend: two writers that each fit but not together — the lock orders them, the second is refused and the store stays readable', async () => {
  const f = await root(), { secrets } = await filled(f, () => 'x'.repeat(65_536));
  const room = LIMIT - documentBytes({ ...secrets });
  const value = 'y'.repeat(Math.floor(room * 0.6));
  expect(documentBytes({ ...secrets, RACE_A: value })).toBeLessThanOrEqual(LIMIT);
  expect(documentBytes({ ...secrets, RACE_A: value, RACE_B: value })).toBeGreaterThan(LIMIT);
  const outcomes = await Promise.allSettled(['RACE_A', 'RACE_B'].map(name =>
    createFileSecretStore({ root: f.global, platform: 'linux', lockTimeoutMs: 10_000 }).set(name, value)));
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  expect(rejected).toHaveLength(1); expect(rejected[0]!.reason).toMatchObject(full);
  const store = createFileSecretStore({ root: f.global, platform: 'linux' });
  expect((await store.listNames()).filter(name => name.startsWith('RACE_'))).toHaveLength(1);
  expect(await store.get('FILL_14')).toBe(secrets['FILL_14']);
  expect((await stat(f.path)).size).toBeLessThanOrEqual(LIMIT);
  expect((await readdir(f.global)).sort()).toEqual(['secrets.json']);
}, 30_000);
