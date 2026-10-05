import { mkdtemp, mkdir, readFile, rename, rm, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileProjectIdentityStore } from '#adapters/core/installation-files/index.js';
import { projectIdentitySchema } from '#domain/index.js';
import { withConfigWriteLock } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'deckent-project-id-')); roots.push(parent);
  const root = join(parent, 'project'); await mkdir(root);
  return { root, parent, directory: join(root, '.deckent/project-identity'), path: join(root, '.deckent/project-identity/identity.json') };
}

describe.skipIf(process.platform === 'win32')('durable project identity', () => {
  it('automatically persists a typed identity and reopens the same bytes', async () => {
    const f = await fixture(); const first = await new FileProjectIdentityStore(f.root).loadOrCreate();
    expect(projectIdentitySchema.parse(first)).toEqual(first);
    const before = await readFile(f.path, 'utf8');
    expect(JSON.parse(before)).toEqual(first);
    expect(await new FileProjectIdentityStore(f.root).loadOrCreate()).toEqual(first);
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });
  it('reads an established identity without acquiring the initialization lock', async () => {
    const f = await fixture(); const first = await new FileProjectIdentityStore(f.root).loadOrCreate();
    await withConfigWriteLock(f.directory, async () => {
      expect(await new FileProjectIdentityStore(f.root, 20).loadOrCreate()).toEqual(first);
    });
  });
  it('serializes two concurrent first uses into one durable value', async () => {
    const f = await fixture();
    const values = await Promise.all([new FileProjectIdentityStore(f.root).loadOrCreate(), new FileProjectIdentityStore(f.root).loadOrCreate()]);
    expect(values[0]).toEqual(values[1]);
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(values[0]);
  });
  it('preserves identity when the whole project moves; different roots receive distinct random identities', async () => {
    const f = await fixture(); const first = await new FileProjectIdentityStore(f.root).loadOrCreate();
    const moved = join(f.parent, 'moved'); await rename(f.root, moved);
    expect(await new FileProjectIdentityStore(moved).loadOrCreate()).toEqual(first);
    await mkdir(f.root);
    expect((await new FileProjectIdentityStore(f.root).loadOrCreate()).projectId).not.toBe(first.projectId);
  });
  it.each(['{', '{}', '{"schemaVersion":1}', '{"schemaVersion":2,"projectId":"bad"}', '{"schemaVersion":1,"projectId":"path/to/project"}'])(
    'refuses corrupt or incomplete retained records without repair: %s', async content => {
    const f = await fixture(); const store = new FileProjectIdentityStore(f.root); await store.loadOrCreate();
    await writeFile(f.path, content);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'PROJECT_IDENTITY_INVALID' });
    expect(await readFile(f.path, 'utf8')).toBe(content);
  });
  it('refuses a lost record and an interrupted first publication instead of generating a new identity', async () => {
    const f = await fixture(); const store = new FileProjectIdentityStore(f.root); await store.loadOrCreate();
    await unlink(f.path);
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'PROJECT_IDENTITY_INVALID' });
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const other = await fixture(); await mkdir(other.directory, { recursive: true, mode: 0o700 });
    await expect(new FileProjectIdentityStore(other.root).loadOrCreate()).rejects.toMatchObject({ code: 'PROJECT_IDENTITY_INVALID' });
  });
  it('does not follow a substituted identity record', async () => {
    const f = await fixture(); const store = new FileProjectIdentityStore(f.root); await store.loadOrCreate();
    const outside = join(f.parent, 'outside'); await rename(f.path, outside); await symlink(outside, f.path);
    const before = await readFile(outside, 'utf8');
    await expect(store.loadOrCreate()).rejects.toMatchObject({ code: 'PROJECT_IDENTITY_INVALID' });
    expect(await readFile(outside, 'utf8')).toBe(before);
  });
  it('bounds contention with a typed error and leaves the record uncreated', async () => {
    const f = await fixture();
    await withConfigWriteLock(f.directory, async () => {
      await expect(new FileProjectIdentityStore(f.root, 20).loadOrCreate()).rejects.toMatchObject({ code: 'PROJECT_IDENTITY_LOCKED' });
      await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    expect((await new FileProjectIdentityStore(f.root).loadOrCreate()).projectId).toBeTruthy();
  });
});
