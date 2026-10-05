import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileArtifactStore } from '#adapters/index.js';

// Forces the interleaving a loaded runner produced (ubuntu node 24, run 37308549749): a publisher that missed the existence check
// publishes while another put sits between its lstat and open. Only scheduling is controlled; every file operation is real.
const gate = vi.hoisted(() => ({
  held: null as null | { arrived: () => void; release: Promise<void> },
  onLstat: null as null | { file: string; run: () => Promise<void> },
  afterLink: null as null | (() => Promise<void>),
  failUnlink: false,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const publish = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A) => {
    const held = gate.held; gate.held = null;
    if (held) { held.arrived(); await held.release; }
    return fn(...args);
  };
  return { ...real,
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      const result = await real.lstat(...args); const hook = gate.onLstat;
      if (hook && String(args[0]) === hook.file) { gate.onLstat = null; await hook.run(); }
      return result;
    },
    link: async (...args: Parameters<typeof real.link>) => {
      const held = gate.held; gate.held = null;
      if (held) { held.arrived(); await held.release; }
      const linked = await real.link(...args);
      const after = gate.afterLink; gate.afterLink = null;
      if (after) await after();
      return linked;
    },
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      if (gate.failUnlink && String(args[0]).includes('.staging.')) throw Object.assign(new Error('unlink failed'), { code: 'EIO' });
      return real.unlink(...args);
    },
    rename: publish(real.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  gate.held = null; gate.onLstat = null; gate.afterLink = null; gate.failUnlink = false;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const scopeOf = (root: string, scope: string) => join(root, createHash('sha256').update(scope).digest('hex'));
const receiptOf = (scopeId: string, bytes: Buffer) => ({ schemaVersion: 1 as const, scopeId, digest: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length });

describe.skipIf(process.platform === 'win32')('concurrent identical artifact publication', () => {
  it('a late identical publisher never replaces the published file under a reader between lstat and open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-artifact-race-')); roots.push(root);
    const path = join(root, 'artifacts'); await mkdir(path, { mode: 0o700 });
    const store = new FileArtifactStore({ root: path, maxBytes: 1024 }); const bytes = Buffer.from('same-content');
    let arrived!: () => void, release!: () => void;
    const atPublish = new Promise<void>(resolve => { arrived = resolve; });
    gate.held = { arrived, release: new Promise<void>(resolve => { release = resolve; }) };
    const late = store.put('s', bytes); await atPublish; // missed the existence check, staged, waits to publish
    const first = await store.put('s', bytes);
    const file = join(path, createHash('sha256').update('s').digest('hex'), first.digest); const published = (await lstat(file)).ino;
    gate.onLstat = { file, run: async () => { release(); await late; } }; // the late publisher completes inside the reader's lstat→open window
    await expect(store.put('s', bytes)).resolves.toEqual(first);
    await expect(late).resolves.toEqual(first);
    expect((await lstat(file)).ino).toBe(published);
    expect(await readdir(join(path, createHash('sha256').update('s').digest('hex')))).toEqual([first.digest]);
    expect(Buffer.from(await store.read('s', first)).toString()).toBe('same-content');
  });

  it('a second put and read during the first link both receive the same receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-artifact-race-')); roots.push(root);
    const path = join(root, 'artifacts'); await mkdir(path, { mode: 0o700 });
    const bytes = Buffer.from('same-content'); const expected = receiptOf('s', bytes);
    const store = new FileArtifactStore({ root: path, maxBytes: 1024 });
    const other = new FileArtifactStore({ root: path, maxBytes: 1024 });
    gate.afterLink = async () => {
      await expect(other.read('s', expected)).resolves.toEqual(bytes);
      await expect(other.put('s', bytes)).resolves.toEqual(expected);
    };
    await expect(store.put('s', bytes)).resolves.toEqual(expected);
    expect((await lstat(join(scopeOf(path, 's'), expected.digest))).nlink).toBe(1);
  });

  it('a publish that dies before the staging name is removed does not block the next put', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-artifact-race-')); roots.push(root);
    const path = join(root, 'artifacts'); await mkdir(path, { mode: 0o700 });
    const bytes = Buffer.from('same-content'); const expected = receiptOf('s', bytes);
    const store = new FileArtifactStore({ root: path, maxBytes: 1024 });
    gate.failUnlink = true;
    await expect(store.put('s', bytes)).rejects.toThrow('unlink failed');
    gate.failUnlink = false;
    const file = join(scopeOf(path, 's'), expected.digest);
    const inode = (await lstat(file)).ino;
    expect((await lstat(file)).nlink).toBe(2);
    const reopened = new FileArtifactStore({ root: path, maxBytes: 1024 });
    await expect(reopened.put('s', bytes)).resolves.toEqual(expected);
    expect((await lstat(file)).ino).toBe(inode);
    expect((await lstat(file)).nlink).toBe(1);
    expect(Buffer.from(await reopened.read('s', expected))).toEqual(bytes);
    expect(await readdir(scopeOf(path, 's'))).toEqual([expected.digest]);
  });

  it('still refuses a symlink, a foreign hard link, corrupt bytes and a wrong mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-artifact-race-')); roots.push(root);
    const path = join(root, 'artifacts'); await mkdir(path, { mode: 0o700 });
    const store = new FileArtifactStore({ root: path, maxBytes: 1024 }); const bytes = Buffer.from('original');
    const receipt = await store.put('s', bytes);
    const file = join(scopeOf(path, 's'), receipt.digest); const inode = (await lstat(file)).ino;
    await writeFile(file, 'tampered');
    await expect(store.read('s', receipt)).rejects.toThrow('ARTIFACT_CORRUPT');
    await expect(store.put('s', bytes)).rejects.toThrow('ARTIFACT_CORRUPT');
    expect((await lstat(file)).ino).toBe(inode);
    await writeFile(file, bytes); await chmod(file, 0o640);
    await expect(store.read('s', receipt)).rejects.toThrow('ARTIFACT_UNSAFE');
    await chmod(file, 0o600);
    const outside = join(root, 'other');
    await link(file, outside);
    await expect(store.read('s', receipt)).rejects.toThrow('ARTIFACT_UNSAFE');
    await expect(store.put('s', bytes)).rejects.toThrow('ARTIFACT_UNSAFE');
    expect((await lstat(file)).ino).toBe(inode);
    await rm(outside); await rm(file); const sentinel = join(root, 'sentinel'); await writeFile(sentinel, 'outside'); await symlink(sentinel, file);
    await expect(store.read('s', receipt)).rejects.toThrow('ARTIFACT_UNSAFE');
    expect(await readFile(sentinel, 'utf8')).toBe('outside');
  });
});
