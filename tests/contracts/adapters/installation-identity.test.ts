import { mkdtemp, mkdir, cp, chmod, readFile, rename, rm, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { installationIdentitySchema, installationIdentityRecordSchema } from '#domain/index.js';
import { resolveProductLayout, withConfigWriteLock } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'deckent-installation-id-')); roots.push(parent);
  const root = join(parent, 'installation'); await mkdir(root);
  return { root, parent, layout: resolveProductLayout({ projectRoot: root, platform: process.platform === 'win32' ? 'win32' : 'posix' }), directory: join(root, '.deckent/installation-identity'), path: join(root, '.deckent/installation-identity/identity.json') };
}

describe('durable installation identity', () => {
  beforeEach(context => { if (process.platform !== 'linux') context.skip('INSTALLATION_IDENTITY_UNSUPPORTED: Linux machine binding is unavailable; typed refusal has a separate active test'); });
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

  it('detects a changed machine binding and refuses implicit or repeated choices', async () => {
    const f = await fixture(), original = await new FileInstallationIdentityStore(f.layout).loadOrCreate();
    const before = await readFile(f.path, 'utf8'), binding = JSON.parse(before).binding;
    const source = { capture: async () => ({ ...binding, machineDigest: 'a'.repeat(64) }) };
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
  it('requires explicit consent to bind a legacy v1 identity', async () => {
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
