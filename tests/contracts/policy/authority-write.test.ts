import { renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePolicySource } from '#adapters/index.js';

// POLICY-ADMIN P2: policy.json + bindings.json change together, conditional on exactly the files read, each through its own
// O_EXCL temporary + fsync + rename, in the order the change needs, and every write leaves an archive record (before/after documents).
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const policy = (revision: string, grants: unknown[] = []) => ({ schemaVersion: 2, revision, roles: [{ id: 'r', permissions: [
  { id: 'p', effect: 'allow', actions: 'all', resource: { kind: 'scope', ids: 'all' } }] }], grants, restrictions: [], separationOfDuties: [] });
const bindings = (revision: string, extra: unknown[] = []) => ({ schemaVersion: 2, revision, modes: [], bindings: extra });
const grant = { id: 'g', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: 'all', resource: { kind: 'scope', ids: ['s'] } };
const binding = { id: 'b', principals: [{ issuer: 'h', subject: '1' }], roles: ['r'], scopes: ['s'] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-authority-write-')); roots.push(root);
  await writeFile(join(root, 'policy.json'), JSON.stringify(policy('p1')), { mode: 0o600 });
  await writeFile(join(root, 'bindings.json'), JSON.stringify(bindings('b1')), { mode: 0o600 });
  const archive = join(root, 'archive');
  const source = new FilePolicySource({ path: join(root, 'policy.json'), bindingsPath: join(root, 'bindings.json'), archivePath: archive, ownerUid: process.getuid!(), maxBytes: 8192 });
  const read = async (name: string) => JSON.parse(await readFile(join(root, name), 'utf8')) as { revision: string };
  const entries = async () => (await readdir(archive).catch(() => [] as string[])).sort();
  return { root, archive, source, read, entries };
}
const both = (order: 'policy-first' | 'bindings-first') => ({ policy: policy('p2', [grant]), bindings: bindings('b2', [binding]), order });

describe.skipIf(process.platform === 'win32')('conditional two-file authority write (POLICY-ADMIN P2)', () => {
  it('replaces both files atomically (new inodes, same mode), in the requested order, and archives before/after documents under the key', async () => {
    const f = await fixture();
    const before = { policy: await stat(join(f.root, 'policy.json')), bindings: await stat(join(f.root, 'bindings.json')) };
    const seen = await f.source.updateAuthority(snapshot => ({ write: both('policy-first'), result: [(snapshot.policy as { revision: string }).revision,
      (snapshot.bindings as { revision: string }).revision] }), 'k'.repeat(64));
    expect(seen).toEqual(['p1', 'b1']);
    expect((await f.read('policy.json')).revision).toBe('p2'); expect((await f.read('bindings.json')).revision).toBe('b2');
    expect((await stat(join(f.root, 'policy.json'))).ino).not.toBe(before.policy.ino);
    expect((await stat(join(f.root, 'bindings.json'))).ino).not.toBe(before.bindings.ino);
    expect((await stat(join(f.root, 'policy.json'))).mode & 0o777).toBe(0o600);
    expect((await readdir(f.root)).sort()).toEqual(['archive', 'bindings.json', 'policy.json']);
    expect((await f.source.load()).revision).toBe('p2+b2');
    expect(await f.entries()).toEqual([`k-${'k'.repeat(64)}.json`]);
    const entry = JSON.parse(await readFile(join(f.archive, `k-${'k'.repeat(64)}.json`), 'utf8'));
    expect(entry).toMatchObject({ schemaVersion: 1, state: 'committed', key: 'k'.repeat(64), before: { revision: 'p1+b1', policy: policy('p1'), bindings: bindings('b1') },
      after: { revision: 'p2+b2', policy: policy('p2', [grant]), bindings: bindings('b2', [binding]) } });
    expect((await stat(f.archive)).mode & 0o777).toBe(0o700);
    expect(await f.source.lookupAuthority('k'.repeat(64))).toEqual({ status: 'applied', version: 'p2+b2' });
    expect(await f.source.lookupAuthority('0'.repeat(64))).toEqual({ status: 'absent' });
  });

  it('refuses with a typed conflict, writing neither file, when either file was replaced after it was read', async () => {
    for (const replaced of ['policy.json', 'bindings.json']) {
      const f = await fixture();
      await expect(f.source.updateAuthority(() => {
        writeFileSync(join(f.root, 'other'), JSON.stringify(replaced === 'policy.json' ? policy('theirs') : bindings('theirs')), { mode: 0o600 });
        renameSync(join(f.root, 'other'), join(f.root, replaced));
        return { write: both('bindings-first'), result: null };
      })).rejects.toMatchObject({ code: 'POLICY_CONFLICT' });
      const revisions = [(await f.read('policy.json')).revision, (await f.read('bindings.json')).revision];
      expect(revisions, replaced).toEqual(replaced === 'policy.json' ? ['theirs', 'b1'] : ['p1', 'theirs']);
      expect((await readdir(f.root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    }
  });

  it('writes only the file that changes, keeps the legacy bindings-only update and its conflict code, and archives a keyless write too', async () => {
    const f = await fixture();
    await f.source.updateAuthority(() => ({ write: { policy: policy('p2', [grant]), bindings: null, order: 'policy-first' }, result: null }));
    expect((await f.source.load()).revision).toBe('p2+b1');
    await f.source.update(() => ({ write: bindings('b2'), result: null }));
    expect((await f.source.load()).revision).toBe('p2+b2');
    expect((await f.entries()).filter(name => name.startsWith('r-'))).toHaveLength(2);
    await expect(f.source.update(() => {
      writeFileSync(join(f.root, 'other'), JSON.stringify(bindings('theirs')), { mode: 0o600 });
      renameSync(join(f.root, 'other'), join(f.root, 'bindings.json'));
      return { write: bindings('mine'), result: null };
    })).rejects.toMatchObject({ code: 'PERMISSION_MODE_CONFLICT' });
  });

  it('answers lookup from the archive and the files: prepared + untouched files is absent, prepared + both written is applied, a mixed state is unknown', async () => {
    const f = await fixture();
    const key = 'a'.repeat(64);
    await f.source.updateAuthority(() => ({ write: both('policy-first'), result: null }), key);
    const path = join(f.archive, `k-${key}.json`);
    const entry = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...entry, state: 'prepared' }), { mode: 0o600 });
    expect(await f.source.lookupAuthority(key)).toEqual({ status: 'applied', version: 'p2+b2' });
    // Only the first file of the pair reached the disk (a crash between the renames): never a blind resend.
    await writeFile(join(f.root, 'bindings.json'), JSON.stringify(bindings('b1')), { mode: 0o600 });
    expect(await f.source.lookupAuthority(key)).toBeNull();
    await writeFile(join(f.root, 'policy.json'), JSON.stringify(policy('p1')), { mode: 0o600 });
    expect(await f.source.lookupAuthority(key)).toEqual({ status: 'absent' });
    await writeFile(path, '{"torn":', { mode: 0o600 });
    expect(await f.source.lookupAuthority(key)).toBeNull();
  });

  it('runs every authority write inside the injected cross-process lock, and a lock refusal writes nothing', async () => {
    const f = await fixture();
    const held: string[] = [];
    const locked = new FilePolicySource({ path: join(f.root, 'policy.json'), bindingsPath: join(f.root, 'bindings.json'), ownerUid: process.getuid!(), maxBytes: 8192 },
      async work => { held.push('enter'); try { return await work(); } finally { held.push('leave'); } });
    await locked.updateAuthority(() => ({ write: { policy: policy('p2'), bindings: null, order: 'policy-first' }, result: null }));
    await locked.update(() => ({ write: bindings('b2'), result: null }));
    expect(held).toEqual(['enter', 'leave', 'enter', 'leave']);
    const refused = new FilePolicySource({ path: join(f.root, 'policy.json'), bindingsPath: join(f.root, 'bindings.json'), ownerUid: process.getuid!(), maxBytes: 8192 },
      async () => { throw Object.assign(new Error('CONFIG_WRITE_LOCKED'), { code: 'CONFIG_WRITE_LOCKED' }); });
    await expect(refused.updateAuthority(() => ({ write: { policy: policy('p3'), bindings: null, order: 'policy-first' }, result: null })))
      .rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
    expect((await f.source.load()).revision).toBe('p2+b2');
  });

  it('serializes authority writes in one process: the second write sees the first one\'s documents', async () => {
    const f = await fixture();
    const seen = await Promise.all(['2', '3'].map(next => f.source.updateAuthority(snapshot => ({
      write: { policy: policy(`p${next}`), bindings: bindings(`b${next}`), order: 'policy-first' as const },
      result: (snapshot.policy as { revision: string }).revision }))));
    expect(seen).toEqual(['p1', 'p2']);
    expect((await f.source.load()).revision).toBe('p3+b3');
  });
});
