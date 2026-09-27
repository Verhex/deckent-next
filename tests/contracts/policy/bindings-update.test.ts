import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource } from '#adapters/index.js';

// T-L4 slice 4c: the bindings file as a conditional, atomic write target. The replacement happens only when the file is still exactly
// the one read; a file replaced in between (another writer, the owner) is a typed conflict and stays as that writer left it.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const policy = { schemaVersion: 2, revision: 'p1', roles: [], grants: [], restrictions: [], separationOfDuties: [] };
const bindings = (revision: string) => ({ schemaVersion: 2, revision, bindings: [], modes: [] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-bindings-update-')); roots.push(root);
  await writeFile(join(root, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  await writeFile(join(root, 'bindings.json'), JSON.stringify(bindings('b1')), { mode: 0o600 });
  return { root, source: new FilePolicySource({ path: join(root, 'policy.json'), bindingsPath: join(root, 'bindings.json'), ownerUid: process.getuid!(), maxBytes: 4096 }) };
}

describe.skipIf(process.platform === 'win32')('conditional bindings replacement (T-L4 slice 4c)', () => {
  it('replaces the file atomically with a new inode and the same mode, and leaves no temporary file', async () => {
    const f = await fixture();
    const before = await stat(join(f.root, 'bindings.json'));
    const seen = await f.source.update(snapshot => ({ write: bindings('b2'), result: (snapshot.bindings as { revision: string }).revision }));
    expect(seen).toBe('b1');
    const after = await stat(join(f.root, 'bindings.json'));
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(f.root, 'bindings.json'), 'utf8'))).toEqual(bindings('b2'));
    expect((await readdir(f.root)).sort()).toEqual(['bindings.json', 'policy.json']);
    expect((await f.source.load()).revision).toBe('p1+b2');
  });

  it('refuses with a typed conflict when the file was replaced after it was read, keeping the other writer\'s file', async () => {
    // The replacement happens synchronously inside the read-to-rename window.
    const g = await fixture();
    const { renameSync, writeFileSync } = await import('node:fs');
    await expect(g.source.update(() => {
      writeFileSync(join(g.root, 'other'), JSON.stringify(bindings('theirs')), { mode: 0o600 });
      renameSync(join(g.root, 'other'), join(g.root, 'bindings.json'));
      return { write: bindings('mine'), result: null };
    })).rejects.toMatchObject({ code: 'PERMISSION_MODE_CONFLICT' });
    expect(JSON.parse(await readFile(join(g.root, 'bindings.json'), 'utf8'))).toEqual(bindings('theirs'));
    expect((await readdir(g.root)).sort()).toEqual(['bindings.json', 'policy.json']);
  });

  it('serializes updates of the same file: the second sees the first one\'s result', async () => {
    const f = await fixture();
    const revisions = await Promise.all(['b2', 'b3'].map(next => f.source.update(snapshot => ({ write: bindings(next), result: (snapshot.bindings as { revision: string }).revision }))));
    expect(revisions).toEqual(['b1', 'b2']);
    expect((await f.source.load()).revision).toBe('p1+b3');
  });

  it('keeps the file guards: nothing is written through an unsafe bindings file, and writing nothing leaves the file untouched', async () => {
    const f = await fixture();
    await chmod(join(f.root, 'bindings.json'), 0o644);
    await expect(f.source.update(() => ({ write: bindings('b2'), result: null }))).rejects.toThrow('POLICY_FILE_UNSAFE');
    await chmod(join(f.root, 'bindings.json'), 0o600);
    await rename(join(f.root, 'bindings.json'), join(f.root, 'real'));
    await symlink(join(f.root, 'real'), join(f.root, 'bindings.json'));
    await expect(f.source.update(() => ({ write: bindings('b2'), result: null }))).rejects.toThrow('POLICY_FILE_UNSAFE');
    expect(JSON.parse(await readFile(join(f.root, 'real'), 'utf8'))).toEqual(bindings('b1'));
    const g = await fixture();
    const before = await stat(join(g.root, 'bindings.json'));
    expect(await g.source.update(() => ({ write: null, result: 'kept' }))).toBe('kept');
    expect((await stat(join(g.root, 'bindings.json'))).ino).toBe(before.ino);
  });
});
