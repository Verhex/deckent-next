import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { classifyDependencyBinary, DependencyTreePatternCache } from '#engine/index.js';
import { pathsShareTree } from '#platform/index.js';

// S6 dependency class (owner 2026-10-17): the engine half — bounded cache keys and document, bounded binary windows, tree eligibility.
const WINDOW = 1 << 20, roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const memoryStore = (stored: string | null, writes: string[]) => ({ read: async () => stored === null ? { kind: 'absent' } : { kind: 'ready', value: JSON.parse(stored) as unknown },
  write: async (text: string) => { writes.push(text); } });

it('keeps bounded keys only, reuses a result only for the same bytes, and never writes a document above the reader cap', async () => {
  const writes: string[] = [];
  let evaluations = 0; const evaluate = async () => { evaluations++; return 'url-userinfo'; };
  const first = await DependencyTreePatternCache.open({ label: '/d', lockfile: Buffer.from('lock'), rules: ['r'], store: memoryStore(null, writes) });
  await first.rule('x'.repeat(4097), Buffer.from('a'), evaluate); await first.rule('ok', Buffer.from('a'), evaluate);
  expect(await first.save()).toEqual({ label: '/d', reused: 0, evaluated: 2, saved: true });
  expect(Object.keys((JSON.parse(writes[0]!) as { files: object }).files)).toEqual(['ok']);
  const second = await DependencyTreePatternCache.open({ label: '/d', lockfile: Buffer.from('lock'), rules: ['r'], store: memoryStore(writes[0]!, writes) });
  expect(await second.rule('ok', Buffer.from('a'), evaluate)).toBe('url-userinfo'); await second.rule('x'.repeat(4097), Buffer.from('a'), evaluate);
  expect(evaluations).toBe(3); expect(await second.save()).toMatchObject({ reused: 1, evaluated: 1 });
  // Changed bytes, another lockfile or another rule table: evaluated again.
  for (const [lockfile, rules, bytes] of [['lock', ['r'], 'b'], ['lock2', ['r'], 'a'], ['lock', ['r2'], 'a']] as const) {
    const cache = await DependencyTreePatternCache.open({ label: '/d', lockfile: Buffer.from(lockfile), rules, store: memoryStore(writes[0]!, []) });
    await cache.rule('ok', Buffer.from(bytes), evaluate); expect(await cache.save(), `${lockfile} ${rules[0]} ${bytes}`).toMatchObject({ reused: 0, evaluated: 1 });
  }
  const big = await DependencyTreePatternCache.open({ label: '/d', lockfile: null, rules: [], store: memoryStore(null, writes) }), count = writes.length;
  for (let index = 0; index < 120_000; index++) await big.rule(`node_modules/${'p'.repeat(100)}/${index}`, Buffer.from(String(index)), async () => null);
  expect(await big.save()).toMatchObject({ saved: false, evaluated: 120_000 }); expect(writes).toHaveLength(count);
});

it('classifies a native binary through bounded windows; reads only the header of anything else; a short read is a changed file', async () => {
  const size = 3 * WINDOW + 5, body = Buffer.alloc(size, 0x41); body.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  const requests: number[] = [];
  const source = (bytes: Buffer, shrink = false) => ({ size, read: async (offset: number, length: number) => { requests.push(length);
    return bytes.subarray(offset, offset + (shrink && offset > 0 ? length - 1 : length)); } });
  const checks = (known = false) => ({ decode: (bytes: Buffer) => [bytes.toString('latin1')], known: { spans: () => known ? [1] : [], pendingStart: (text: string) => text.length },
    rows: [], match: async () => [], first: async () => null });
  expect(await classifyDependencyBinary(source(body), checks(), () => undefined)).toEqual([{ rule: expect.stringMatching(/^native-binary:elf:sha256=[0-9a-f]{64}$/u), refuse: false }]);
  expect(Math.max(...requests)).toBeLessThanOrEqual(WINDOW);
  requests.length = 0;
  expect(await classifyDependencyBinary(source(Buffer.alloc(size, 0x41)), checks(), () => undefined)).toBeNull();
  expect(requests).toEqual([1024]);
  await expect(classifyDependencyBinary(source(body, true), checks(), () => undefined)).rejects.toThrow('WORKER_TREE_ENTRY_CHANGED');
  // The deadline is checked per window; a configured value stops the read with a refusal.
  let ticks = 0; await classifyDependencyBinary(source(body), checks(), () => { ticks++; }); expect(ticks).toBe(4);
  await expect(classifyDependencyBinary(source(body), checks(true), () => undefined)).resolves.toEqual([{ rule: 'known-secret', refuse: true }]);
});

it('judges tree overlap by device and inode along real paths: a linked spelling is the same tree, an unresolvable path fails closed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dn-share-tree-'))); roots.push(root);
  await mkdir(join(root, 'repo', 'node_modules'), { recursive: true }); await mkdir(join(root, 'deps')); await symlink(join(root, 'repo'), join(root, 'link'));
  expect(await pathsShareTree(join(root, 'repo'), join(root, 'repo', 'node_modules'))).toBe(true);
  expect(await pathsShareTree(join(root, 'repo', 'node_modules'), join(root, 'repo'))).toBe(true);
  expect(await pathsShareTree(join(root, 'link', 'node_modules'), join(root, 'repo'))).toBe(true);
  expect(await pathsShareTree(join(root, 'repo'), join(root, 'deps'))).toBe(false);
  expect(await pathsShareTree(join(root, 'repo'), join(root, 'repo-deps-missing'))).toBe(true);
  expect(await pathsShareTree('/', join(root, 'deps'))).toBe(true);
});
