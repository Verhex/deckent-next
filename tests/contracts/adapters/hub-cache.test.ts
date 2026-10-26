import { mkdtemp, rm, utimes, lstat, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HUB_LIMITS } from '#domain/index.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
import { sha256 } from '#platform/index.js';
import { HubArtifactCache } from '#adapters/core/hub-cache/index.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const code = (code: string) => expect.objectContaining({ code });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hub-cache-')); roots.push(root);
  const cache = new HubArtifactCache(root, 10, 10), refs: ArtifactReceipt[] = [];
  const put = (scope: string, text: string) => cache.withRetention(async () => refs, () => cache.put(scope, Buffer.from(text)));
  return { root, cache, refs, put, path: (r: ArtifactReceipt) => join(root, sha256(r.scopeId), r.digest) };
}
it.skipIf(process.platform === 'win32')('LRU evicts only unreferenced blobs across scopes, preserving installed and retained Run pins and read recency', async () => {
  const f = await fixture(), installed = await f.put('s', 'aaaa'), older = await f.put('other', 'bbb'), newer = await f.put('s', 'ccc');
  f.refs.push(installed);
  await utimes(f.path(older), new Date(1000), new Date(1000)); await utimes(f.path(newer), new Date(2000), new Date(2000));
  await f.cache.read('other', older); // read makes the old insertion most recently used
  await link(f.path(older), join(f.root, sha256('other'), '.staging.crashed'));
  const next = await f.put('s', 'ddd');
  await expect(lstat(join(f.root, sha256('other'), '.staging.crashed'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(f.path(newer))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(Buffer.from(await f.cache.read('s', installed)).toString()).toBe('aaaa');
  expect(Buffer.from(await f.cache.read('other', older)).toString()).toBe('bbb');
  f.refs.push(older, next);
  await expect(f.put('s', 'e')).rejects.toThrow(code('HUB_LIMIT_EXCEEDED'));
  expect(Buffer.from(await f.cache.read('s', next)).toString()).toBe('ddd');
  await expect(f.cache.read('other', installed)).rejects.toThrow(code('ARTIFACT_SCOPE_DENIED'));
  expect(() => new HubArtifactCache(f.root, 10, HUB_LIMITS.cacheMaxBytes + 1)).toThrow(code('ARTIFACT_INVALID'));
});
it.skipIf(process.platform === 'win32')('serializes capacity reservations; abandoned writes become evictable on the next transaction', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const first = f.cache.withRetention(async () => [], async () => { await f.cache.put('s', Buffer.from('123456')); entered(); await barrier; throw new Error('rollback'); });
  const firstEnd = expect(first).rejects.toThrow('rollback'); await ready;
  const other = new HubArtifactCache(f.root, 10, 10), second = other.withRetention(async () => [], () => other.put('other', Buffer.from('abcdef')));
  release(); await firstEnd; const receipt = await second;
  expect(Buffer.from(await other.read('other', receipt)).toString()).toBe('abcdef');
  await expect(lstat(join(f.root, sha256('s'), sha256('123456')))).rejects.toMatchObject({ code: 'ENOENT' });
});
