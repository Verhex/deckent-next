import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileResourceTraceStore } from '#adapters/index.js';
import { projectResourceView, resourceGap, ResourceCollector, type ExecutionSupervisor } from '#engine/index.js';
import { getConfigFieldDefault, type ResourceObservationSettings } from '#platform/index.js';
import { hostBound } from '../support/host-bounds.js';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
const roots: string[] = [], identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
const linux = it.skipIf(process.platform !== 'linux');
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(overrides: Partial<ResourceObservationSettings> = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'trace-segments-')); roots.push(root); await fs.chmod(root, 0o700);
  const settings = { ...getConfigFieldDefault('resourceObservation'), ...overrides }; let now = 1000;
  const store = new FileResourceTraceStore(async () => root, settings, () => now);
  return { root, settings, store, setNow: (value: number) => { now = value; } };
}
async function files(root: string) { return (await fs.readdir(root)).filter(name => name.includes('.segment-')).sort(); }
function trackWrites() {
  const original = fs.open; const writes: { path: string; bytes: number }[] = [], syncs: string[] = [], lockWrites: number[] = [];
  let active = 0, peak = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await original(...args), path = String(args[0]);
    const trace = path.includes('.segment-') || path.endsWith('.trim.pending');
    if (trace || path.endsWith('/owner.json')) {
      const write = file.writeFile.bind(file), sync = file.sync.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementation(async (...values: Parameters<typeof file.writeFile>) => {
        const bytes = Buffer.byteLength(values[0] as string);
        if (trace) writes.push({ path, bytes }); else lockWrites.push(bytes);
        peak = Math.max(peak, ++active);
        try { await write(...values); } finally { active--; }
      });
      vi.spyOn(file, 'sync').mockImplementation(async () => { if (trace) syncs.push(path); await sync(); });
    }
    return file;
  });
  return { writes, syncs, lockWrites, peak: () => peak };
}
linux('writes only the new record at both small and near-full retained sizes, with no per-sample fsync', async () => {
  const sizes = [1, 12000], measured: { retainedBytes: number; appendBytes: number; recordBytes: number; lockBytes: number; syncs: number }[] = [];
  for (const size of sizes) {
    const { root, settings, store } = await fixture({ maxStoreEntries: 20000, segmentMaxEntries: 2048, segmentMaxBytes: 1048576 });
    // Seed immutable bounded segments: the measurement observes actual FileHandle writes of the next append.
    const header = JSON.stringify({ schemaVersion: 2, createdAtMs: 1000 }) + '\n';
    const line = JSON.stringify(resourceGap(identity, 100, 'starting')) + '\n';
    for (let remaining = size, segment = 1; remaining > 0; segment++) {
      const count = Math.min(2000, remaining); remaining -= count;
      const name = `${settings.fileName}.segment-${String(segment).padStart(16, '0')}-00000000-0000-0000-0000-000000000001.jsonl`;
      await fs.writeFile(join(root, name), header + line.repeat(count), { mode: 0o600 });
    }
    await store.append(resourceGap(identity, 200, 'missing')); // Establish this writer's sync interval.
    let before = 0; for (const name of await files(root)) before += (await fs.stat(join(root, name))).size;
    const tracking = trackWrites();
    const next = resourceGap(identity, 300, 'timeout'); await store.append(next);
    measured.push({ retainedBytes: before, appendBytes: tracking.writes.reduce((sum, row) => sum + row.bytes, 0),
      recordBytes: Buffer.byteLength(JSON.stringify(next) + '\n'), lockBytes: tracking.lockWrites.reduce((sum, bytes) => sum + bytes, 0), syncs: tracking.syncs.length });
    expect(tracking.writes).toHaveLength(1); expect(tracking.syncs).toHaveLength(0);
    vi.restoreAllMocks();
  }
  expect(measured[0]!.appendBytes).toBe(measured[1]!.appendBytes);
  expect(measured.every(row => row.appendBytes === row.recordBytes)).toBe(true);
  console.log('RESOURCE_TRACE_WRITE_BYTES', JSON.stringify(measured));
});
linux('rotates at the entry bound and unlinks the oldest whole segment, preserving a durable trim record', async () => {
  const { root, settings, store } = await fixture({ maxStoreEntries: 3, segmentMaxEntries: 2 });
  for (const at of [100, 200, 300]) await store.append(resourceGap(identity, at, 'starting'));
  const old = await files(root); expect(old).toHaveLength(2);
  await store.append(resourceGap(identity, 400, 'starting'));
  const retained = await files(root); expect(retained).toEqual([old[1]]);
  await expect(fs.stat(join(root, old[0]!))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await store.read(identity)).samples.map(row => row.observedAtMs)).toEqual([300, 400]);
  expect(JSON.parse(await fs.readFile(join(root, `${settings.fileName}.trim`), 'utf8'))).toMatchObject({ lastTrim: { identity, throughMs: 200 } });
  const restarted = new FileResourceTraceStore(async () => root, settings, () => 1000);
  expect((await restarted.read(identity)).trimmedBeforeMs).toBe(200);
});
linux('rotates at byte and age bounds and evicts entire oldest segments within the total byte budget', async () => {
  const { root, settings, store, setNow } = await fixture({ maxStoreBytes: 2000, segmentMaxBytes: 750, segmentMaxAgeMs: 100 });
  await store.append(resourceGap(identity, 100, 'starting'));
  await store.append(resourceGap(identity, 200, 'starting'));
  expect(await files(root)).toHaveLength(1);
  await store.append(resourceGap(identity, 300, 'starting')); expect(await files(root)).toHaveLength(2);
  setNow(1100); await store.append(resourceGap(identity, 400, 'starting')); expect(await files(root)).toHaveLength(3);
  const oldest = (await files(root))[0]!;
  for (const at of [500, 600, 700, 800]) await store.append(resourceGap(identity, at, 'starting'));
  await expect(fs.stat(join(root, oldest))).rejects.toMatchObject({ code: 'ENOENT' });
  let bytes = 0; for (const name of await fs.readdir(root)) { const stat = await fs.stat(join(root, name)); if (stat.isFile()) bytes += stat.size; }
  expect(bytes).toBeLessThanOrEqual(settings.maxStoreBytes);
  expect((await store.read(identity)).trimmedBeforeMs).not.toBeNull();
});
linux('enforces retention through whole-segment unlink and refuses an already expired incoming sample', async () => {
  const { root, store, setNow } = await fixture({ retentionMs: 1000, segmentMaxEntries: 1 });
  await store.append(resourceGap(identity, 500, 'starting')); const old = (await files(root))[0]!;
  setNow(1600); await store.append(resourceGap(identity, 1600, 'starting'));
  await expect(fs.stat(join(root, old))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await store.read(identity)).toMatchObject({ trimmedBeforeMs: 500, samples: [{ observedAtMs: 1600 }] });
  await expect(store.append(resourceGap(identity, 599, 'missing'))).rejects.toThrow('RESOURCE_TRACE_FULL');
});
linux('skips a crash tail, counts an explicit invalid gap and never appends into the damaged segment', async () => {
  const { root, settings, store } = await fixture(); await store.append(resourceGap(identity, 100, 'starting'));
  const old = (await files(root))[0]!, original = await fs.readFile(join(root, old), 'utf8');
  await fs.appendFile(join(root, old), '{"schemaVersion":1,"identity":');
  const restarted = new FileResourceTraceStore(async () => root, settings, () => 1000), view = projectResourceView(identity, await restarted.read(identity), 1000, settings.staleMs);
  expect(view.gapCount).toBe(2); expect(view.latest?.gap).toBe('invalid'); expect(view.cpuSeconds).toBeNull();
  await restarted.append(resourceGap(identity, 1100, 'missing'));
  expect(await files(root)).toHaveLength(2); expect(await fs.readFile(join(root, old), 'utf8')).toBe(original + '{"schemaVersion":1,"identity":');
  expect((await restarted.read(identity)).samples.some(row => row.observedAtMs === 1100)).toBe(true);
  expect((await restarted.read({ ...identity, attemptId: 'other' })).samples).toEqual([]);
});
linux('reads legacy v1 without rewriting it, deduplicates across formats and eventually evicts it', async () => {
  const { root, settings, store } = await fixture({ maxStoreEntries: 2, segmentMaxEntries: 1 });
  const first = resourceGap(identity, 100, 'starting'), content = JSON.stringify({ schemaVersion: 1, trimmedBeforeMs: null, lastTrim: null, samples: [first] });
  await fs.writeFile(join(root, settings.fileName), content, { mode: 0o600 });
  expect((await store.read(identity)).samples).toEqual([first]);
  await store.append(first); expect(await files(root)).toHaveLength(0);
  await store.append(resourceGap(identity, 200, 'missing')); expect(await fs.readFile(join(root, settings.fileName), 'utf8')).toBe(content);
  await store.append(resourceGap(identity, 300, 'timeout'));
  await expect(fs.stat(join(root, settings.fileName))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await store.read(identity)).trimmedBeforeMs).toBe(100);
});
linux('keeps segment/checkpoint modes 0600 and serializes distinct store instances without overlapping writes', async () => {
  const { root, settings, store } = await fixture({ maxStoreEntries: 4, segmentMaxEntries: 1, timeoutMs: 5000 });
  const other = new FileResourceTraceStore(async () => root, settings, () => 1000), tracking = trackWrites();
  await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? store : other).append(resourceGap(identity, 100 + index, 'starting'))));
  expect(tracking.peak()).toBe(1); expect((await store.read(identity)).samples).toHaveLength(4);
  for (const name of await fs.readdir(root)) expect((await fs.stat(join(root, name))).mode & 0o777).toBe(0o600);
});
linux('syncs at the bounded interval and when closing a segment without maintaining a shutdown timer', async () => {
  const { store, setNow } = await fixture({ syncIntervalMs: 100, segmentMaxEntries: 3 }), tracking = trackWrites();
  await store.append(resourceGap(identity, 100, 'starting')); expect(tracking.syncs).toHaveLength(1);
  await store.append(resourceGap(identity, 200, 'starting')); expect(tracking.syncs).toHaveLength(1);
  setNow(1100); await store.append(resourceGap(identity, 300, 'starting')); expect(tracking.syncs).toHaveLength(2);
  await store.append(resourceGap(identity, 400, 'starting')); expect(tracking.syncs).toHaveLength(4);
});
linux.each(['symlink', 'hardlink', 'public-mode'] as const)('refuses %s segment custody before adding bytes', async kind => {
  const { root, store } = await fixture(); await store.append(resourceGap(identity, 100, 'starting'));
  const path = join(root, (await files(root))[0]!), original = await fs.readFile(path, 'utf8');
  const outside = join(root, 'outside');
  if (kind === 'symlink') { await fs.rename(path, outside); await fs.symlink(outside, path); }
  if (kind === 'hardlink') await fs.link(path, outside);
  if (kind === 'public-mode') await fs.chmod(path, 0o644);
  await expect(store.append(resourceGap(identity, 200, 'missing'))).rejects.toBeDefined();
  await expect(store.read(identity)).rejects.toBeDefined();
  expect(await fs.readFile(kind === 'public-mode' ? path : outside, 'utf8')).toBe(original);
});
linux('a pre-aborted append publishes no segment or trim record', async () => {
  const { root, store } = await fixture(); const abort = new AbortController(); abort.abort();
  await expect(store.append(resourceGap(identity, 100, 'starting'), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(await fs.readdir(root)).toEqual([]);
});
linux('refuses a FIFO segment without opening a blocking reader or changing its target', async () => {
  const { root, store } = await fixture(); await store.append(resourceGap(identity, 100, 'starting'));
  const path = join(root, (await files(root))[0]!); await fs.unlink(path);
  await promisify(execFile)('mkfifo', ['-m', '600', path], { timeout: 2000 });
  await expect(store.append(resourceGap(identity, 200, 'missing'))).rejects.toThrow('RESOURCE_TRACE_UNSAFE');
  expect((await fs.lstat(path)).isFIFO()).toBe(true);
});
linux('reclaims only the fixed private checkpoint staging file after a crash', async () => {
  const { root, settings, store } = await fixture({ segmentMaxEntries: 1, maxStoreEntries: 1 });
  await store.append(resourceGap(identity, 100, 'starting'));
  const pending = join(root, `${settings.fileName}.trim.pending`); await fs.writeFile(pending, '{"schemaVersion":', { mode: 0o600 });
  await store.append(resourceGap(identity, 200, 'missing'));
  await expect(fs.stat(pending)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await store.read(identity)).trimmedBeforeMs).toBe(100);
});
linux('evicts oldest empty crash segments before the next write can exceed the directory entry bound', async () => {
  const { root, settings, store } = await fixture({ maxStoreEntries: 1 });
  for (const sequence of [1, 2]) {
    const name = `${settings.fileName}.segment-${String(sequence).padStart(16, '0')}-00000000-0000-0000-0000-000000000001.jsonl`;
    await fs.writeFile(join(root, name), '', { mode: 0o600 });
  }
  const oldest = (await files(root))[0]!; await store.append(resourceGap(identity, 100, 'starting'));
  expect(await files(root)).toHaveLength(2);
  await expect(fs.stat(join(root, oldest))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await store.read(identity)).samples.some(row => row.observedAtMs === 100)).toBe(true);
});
linux('empty readers create no storage or lock and checkpoint symlinks fail closed', async () => {
  const { root, settings, store } = await fixture();
  expect(await store.read(identity)).toEqual({ samples: [], trimmedBeforeMs: null }); expect(await fs.readdir(root)).toEqual([]);
  const outside = join(root, 'outside'); await fs.writeFile(outside, 'private', { mode: 0o600 });
  await fs.symlink(outside, join(root, `${settings.fileName}.trim`));
  await expect(store.append(resourceGap(identity, 100, 'starting'))).rejects.toBeDefined();
  expect(await fs.readFile(outside, 'utf8')).toBe('private'); expect(await files(root)).toEqual([]);
});
linux('collector stop returns immediately while its real file write waits for another writer', async () => {
  const { root, settings, store } = await fixture();
  const lock = join(root, `${settings.fileName}.write-lock`); await fs.mkdir(lock, { mode: 0o700 });
  const owner = JSON.stringify({ pid: process.pid, hostname: hostname(), nonce: 'other-owner', createdAt: new Date().toISOString() });
  await fs.writeFile(join(lock, 'owner.json'), owner, { mode: 0o600 });
  let pending: Promise<void> | undefined; const append = store.append.bind(store);
  vi.spyOn(store, 'append').mockImplementation((sample, signal) => { pending = append(sample, signal); return pending; });
  const collector = new ResourceCollector(store, settings, () => 1000);
  const observed = collector.start({ protocolVersion: 1, identity, workspace: '/fixture', argv: ['worker'] },
    { async readResources() { return resourceGap(identity, 100, 'starting'); } } as unknown as ExecutionSupervisor);
  await vi.waitFor(() => expect(pending).toBeDefined());
  expect(observed.stop()).toBeUndefined(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(await fs.readFile(join(lock, 'owner.json'), 'utf8')).toBe(owner);
  expect(await files(root)).toEqual([]);
});
linux('one snapshot reads each segment once for many attempts, with the exact per-attempt result, within a host-scaled bound', async () => {
  // Monitor 2026-10-17: N1 had 231 attempts × 21 segments and re-read and re-parsed every segment per attempt (5.8 s for one source).
  const { root, settings, store } = await fixture({ maxStoreEntries: 20000, segmentMaxEntries: 2048, segmentMaxBytes: 1048576 });
  const attempts = Array.from({ length: 200 }, (_, index) => ({ ...identity, attemptId: `a${index}` })), header = JSON.stringify({ schemaVersion: 2, createdAtMs: 1000 }) + '\n';
  for (let segment = 1; segment <= 20; segment++) {
    const lines = attempts.filter((_, index) => index % 20 === segment - 1 || index % 7 === segment % 7).map((value, index) => JSON.stringify(resourceGap(value, 100 * segment + index, 'starting')) + '\n');
    // The last segment ends in a crash tail: its gap reaches only the attempts it holds, exactly as a single read reports it.
    const name = `${settings.fileName}.segment-${String(segment).padStart(16, '0')}-00000000-0000-0000-0000-${String(segment).padStart(12, '0')}.jsonl`;
    await fs.writeFile(join(root, name), header + lines.join('') + (segment === 20 ? '{"partial' : ''), { mode: 0o600 });
  }
  const original = fs.open; let segmentOpens = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => { if (String(args[0]).includes('.segment-')) segmentOpens++; return original(...args); });
  const started = performance.now(), many = await store.readMany(attempts), elapsed = performance.now() - started;
  expect(segmentOpens).toBe(20); expect(elapsed).toBeLessThan(hostBound(1000));
  vi.restoreAllMocks();
  for (const index of [0, 1, 7, 19, 20, 199]) expect(many[index]).toEqual(await store.read(attempts[index]!));
  expect(many[19]!.samples.some(sample => sample.gap === 'invalid')).toBe(true); expect(many[0]!.samples.some(sample => sample.gap === 'invalid')).toBe(false);
  expect(many.map(trace => trace.samples.length).every(count => count > 0)).toBe(true);
});
