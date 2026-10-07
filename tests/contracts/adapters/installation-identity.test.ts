import { mkdtemp, mkdir, cp, chmod, readFile, rename, rm, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { installationIdentitySchema, installationIdentityRecordSchema } from '#domain/index.js';
import { resolveProductLayout, withConfigWriteLock } from '#platform/index.js';
import { installationBindingNotRunReason, machineBindingNotRunReason } from '../support/binding-capability.js';
// Location evidence (root, device, inode) is bound on every posix host; only machine-digest assertions need a machine identity.
const bindingNotRun = await installationBindingNotRunReason(), machineNotRun = await machineBindingNotRunReason();

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'deckent-installation-id-')); roots.push(parent);
  const root = join(parent, 'installation'); await mkdir(root);
  return { root, parent, layout: resolveProductLayout({ projectRoot: root, platform: process.platform === 'win32' ? 'win32' : 'posix' }), directory: join(root, '.deckent/installation-identity'), path: join(root, '.deckent/installation-identity/identity.json') };
}

describe('durable installation identity', () => {
  beforeEach(context => { if (process.platform !== 'linux') context.skip('INSTALLATION_IDENTITY_UNSUPPORTED: Linux machine binding is unavailable; typed refusal has a separate active test'); else if (bindingNotRun) context.skip(bindingNotRun); });
  it('automatically persists a typed identity and reopens the same bytes', async () => {
    const f = await fixture(); const first = await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    expect(installationIdentitySchema.parse(first)).toEqual(first);
    const before = await readFile(f.path, 'utf8');
    expect(installationIdentityRecordSchema.parse(JSON.parse(before))).toMatchObject({ schemaVersion: 2, installationId: first.installationId, binding: { canonicalRoot: f.layout.root } });
    expect(await new FileInstallationIdentityStore(f.layout).loadOrCreate()).toEqual(first);
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });
  it('reads an established identity without acquiring the initialization lock', async () => {
    const f = await fixture(); const first = await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    await withConfigWriteLock(f.directory, async () => {
      expect(await new FileInstallationIdentityStore(f.layout, 20).loadOrCreate()).toEqual(first);
    });
  });
  it('serializes two concurrent first uses into one durable value', async () => {
    const f = await fixture();
    const values = await Promise.all([new FileInstallationIdentityStore(f.layout).loadOrCreate(), new FileInstallationIdentityStore(f.layout).loadOrCreate()]);
    expect(values[0]).toEqual(values[1]);
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ schemaVersion: 2, installationId: values[0]!.installationId });
  });
  it('requires explicit keep after a move; different roots receive distinct random identities', async () => {
    const f = await fixture(); const first = await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    const moved = join(f.parent, 'moved'); await rename(f.root, moved);
    const relocated = new FileInstallationIdentityStore(resolveProductLayout({ projectRoot: moved }));
    await expect(relocated.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await relocated.resolveRelocation('keep', { issuer: 'host', subject: '1000' })).toMatchObject({ previousInstallationId: first.installationId, installationId: first.installationId });
    expect(await relocated.loadOrCreate()).toEqual(first);
    await mkdir(f.root);
    expect((await new FileInstallationIdentityStore(f.layout).loadOrCreate()).installationId).not.toBe(first.installationId);
  });
  it.each(['{', '{}', '{"schemaVersion":1}', '{"schemaVersion":2,"installationId":"bad"}', '{"schemaVersion":1,"installationId":"path/to/installation"}'])(
    'refuses corrupt or incomplete retained records without repair: %s', async content => {
    const f = await fixture(); const store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    await writeFile(f.path, content);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(content);
  });
  it('refuses a lost record and an interrupted first publication instead of generating a new identity', async () => {
    const f = await fixture(); const store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    await unlink(f.path);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const other = await fixture(); await mkdir(other.directory, { recursive: true, mode: 0o700 });
    await expect(new FileInstallationIdentityStore(other.layout).loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
  });
  // B5 (owner terminal test 2026-10-07): inside a Deckent sandbox the identity directory is an empty tmpfs mount and reads as MASKED (proof:
  // the real CLI under the sandbox's own bubblewrap view, L6 review). A real loss stays INVALID — on a disk and on a tmpfs alike, because the
  // directory is not its own mount there.
  it('keeps a lost record INVALID when its directory is not a mount of its own, on a disk and on a tmpfs', async () => {
    const f = await fixture(); await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    await unlink(f.path);
    await expect(new FileInstallationIdentityStore(f.layout, 20).read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    let shm: string;
    try { shm = await mkdtemp('/dev/shm/deckent-installation-id-'); } catch { return; }
    roots.push(shm);
    const layout = resolveProductLayout({ projectRoot: shm, platform: 'posix' });
    await new FileInstallationIdentityStore(layout).loadOrCreate();
    await unlink(join(shm, '.deckent/installation-identity/identity.json'));
    await expect(new FileInstallationIdentityStore(layout, 20).read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
  });
  it('does not follow a substituted identity record', async () => {
    const f = await fixture(); const store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    const outside = join(f.parent, 'outside'); await rename(f.path, outside); await symlink(outside, f.path);
    const before = await readFile(outside, 'utf8');
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(outside, 'utf8')).toBe(before);
  });
  it('refuses a restored copy until explicitly accepted as a new installation', async () => {
    const f = await fixture(), restored = await fixture(), fresh = await fixture();
    const original = await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    await cp(f.layout.root, restored.layout.root, { recursive: true });
    const store = new FileInstallationIdentityStore(restored.layout);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    const result = await store.resolveRelocation('new', { issuer: 'host', subject: '1000' });
    expect(result.previousInstallationId).toBe(original.installationId);
    expect(result.installationId).not.toBe(original.installationId);
    expect((await store.loadOrCreate()).installationId).toBe(result.installationId);
    expect(JSON.parse(await readFile(restored.path, 'utf8')).lastResolution).toEqual(result);
    expect(await new FileInstallationIdentityStore(f.layout).loadOrCreate()).toEqual(original);
    expect((await new FileInstallationIdentityStore(fresh.layout).loadOrCreate()).installationId).not.toBe(original.installationId);
  });

  it('detects a changed machine binding and refuses implicit or repeated choices', async context => {
    if (machineNotRun) context.skip(machineNotRun);
    const f = await fixture(), original = await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    const before = await readFile(f.path, 'utf8'), binding = JSON.parse(before).binding;
    // Persisted in the v1 shape; the injected source returns a current (v2) capture at the same location.
    const location = { canonicalRoot: binding.canonicalRoot, device: binding.device, inode: binding.inode };
    const source = { capture: async () => ({ ...location, schemaVersion: 2 as const, strength: 'machine' as const, source: 'platform' as const, machineDigest: 'a'.repeat(64) }) };
    const store = new FileInstallationIdentityStore(f.layout, undefined, source);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await readFile(f.path, 'utf8')).toBe(before);
    await expect(store.resolveRelocation(undefined as never, { issuer: 'h', subject: '1' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' });
    const results = await Promise.allSettled(['keep', 'new'].map(choice => store.resolveRelocation(choice as 'keep' | 'new', { issuer: 'h', subject: '1' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' } });
    const accepted = await store.loadOrCreate();
    await expect(store.resolveRelocation('new', { issuer: 'h', subject: '1' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RESOLUTION_INVALID' });
    expect(await store.loadOrCreate()).toEqual(accepted);
    expect(JSON.parse(await readFile(f.path, 'utf8')).lastResolution.previousInstallationId).toBe(original.installationId);
  });
  it('detects restoration at the same canonical path with a replaced directory inode', async () => {
    const f = await fixture(), original = await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    const retained = join(f.parent, 'retained'); await rename(f.layout.root, retained);
    await cp(retained, f.layout.root, { recursive: true });
    const store = new FileInstallationIdentityStore(f.layout);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect((await store.resolveRelocation('keep', { issuer: 'h', subject: '1' })).installationId).toBe(original.installationId);
    expect(await store.loadOrCreate()).toEqual(original);
  });
  it('requires explicit consent to bind a legacy v1 identity on a machine-capable host', async context => {
    if (machineNotRun) context.skip(machineNotRun);
    const f = await fixture(), store = new FileInstallationIdentityStore(f.layout), original = await store.loadOrCreate();
    await writeFile(f.path, JSON.stringify(original)); const bytes = await readFile(f.path, 'utf8');
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    await store.resolveRelocation('keep', { issuer: 'h', subject: '1' });
    expect(await store.loadOrCreate()).toEqual(original);
  });
  it.each([null, {}, { schemaVersion: 1, machineDigest: 'raw-host-id' }])('refuses corrupt binding metadata without repairing it: %j', async binding => {
    const f = await fixture(), store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    const record = JSON.parse(await readFile(f.path, 'utf8')); await writeFile(f.path, JSON.stringify({ ...record, binding }));
    const bytes = await readFile(f.path, 'utf8');
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    await expect(store.resolveRelocation('keep', { issuer: 'h', subject: '1' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
  });
  it('refuses unsafe storage without changing or replacing the identity', async () => {
    const f = await fixture(); const store = new FileInstallationIdentityStore(f.layout); await store.loadOrCreate();
    const bytes = await readFile(f.path, 'utf8'); await chmod(f.directory, 0o777);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNAVAILABLE' });
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
  });
  it('bounds contention with a typed error and leaves the record uncreated', async () => {
    const f = await fixture();
    await withConfigWriteLock(f.directory, async () => {
      await expect(new FileInstallationIdentityStore(f.layout, 20).loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_LOCKED' });
      await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    expect((await new FileInstallationIdentityStore(f.layout).loadOrCreate()).installationId).toBeTruthy();
  });
});

it('refuses unsupported layout capability before reading or creating identity metadata', async () => {
  const f = await fixture();
  const layout = { ...f.layout, platform: 'win32' as const };
  await expect(new FileInstallationIdentityStore(layout).loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNSUPPORTED' });
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  if (process.platform === 'win32') {
    await expect(new FileInstallationIdentityStore(f.layout).loadOrCreate()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNSUPPORTED' });
  }
});

it.skipIf(process.platform === 'win32')('observes absence without creating ancestors or locks, and validates retained loss on reads', async () => {
  const f = await fixture(), store = new FileInstallationIdentityStore(f.layout);
  expect(await store.read()).toEqual({ status: 'unavailable', reason: 'not-created', bindingCapability: 'not-observed' });
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  const { lstat } = await import('node:fs/promises');
  await expect(lstat(f.layout.root)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(f.directory, { recursive: true, mode: 0o700 });
  await expect(store.read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
  await expect(lstat(f.directory + '-lock')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform === 'win32')('reports unsupported binding capability without blocking identity reads or writes, preserving bound bytes', async () => {
  const f = await fixture(), unsupported = { capture: async () => ({ status: 'unsupported' as const }) };
  const store = new FileInstallationIdentityStore(f.layout, undefined, unsupported);
  const identity = await store.loadOrCreate();
  expect(await store.read()).toEqual({ status: 'available', value: identity, bindingCapability: 'unsupported' });
  const bytes = await readFile(f.path, 'utf8');
  expect(JSON.parse(bytes)).toEqual(identity); // v1 is explicitly unbound; no made-up machine discriminator.
  expect(await store.loadOrCreate()).toEqual(identity);
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
  await expect(store.resolveRelocation('new', { issuer: 'h', subject: '1' })).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_UNSUPPORTED' });
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
  await writeFile(f.path, '{}');
  await expect(store.read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_INVALID' });
});

it.skipIf(process.platform !== 'linux' || machineNotRun !== null)('[requires machine binding capability] skips only the unsupported comparison and resumes relocation enforcement when capability returns', async () => {
  const f = await fixture(), original = new FileInstallationIdentityStore(f.layout), identity = await original.loadOrCreate();
  const bytes = await readFile(f.path, 'utf8');
  const store = new FileInstallationIdentityStore(f.layout, undefined, { capture: async () => ({ status: 'unsupported' }) });
  expect(await store.read()).toEqual({ status: 'available', value: identity, bindingCapability: 'unsupported' });
  expect(await readFile(f.path, 'utf8')).toBe(bytes);
  const record = JSON.parse(bytes); record.binding.machineDigest = 'b'.repeat(64); await writeFile(f.path, JSON.stringify(record));
  await expect(original.read()).rejects.toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
});
