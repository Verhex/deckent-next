import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { sampleDockerResources } from '#adapters/index.js';
import { projectResourceView } from '#engine/index.js';
import { getConfigFieldDefault } from '#platform/index.js';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
vi.mock('node:http', async importOriginal => ({ ...await importOriginal<typeof import('node:http')>() }));
afterEach(() => vi.restoreAllMocks());
const settings = getConfigFieldDefault('resourceObservation'), worker = { kind: 'container' as const, id: 'a'.repeat(64), startedAt: '2026-10-12T00:00:00Z' };
const request = { protocolVersion: 1 as const, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' }, workspace: '/test', argv: ['worker'] };
const inspected = { Id: worker.id, Config: { Labels: { 'deckent.request': 'digest' } }, State: { Status: 'running', StartedAt: worker.startedAt } };
const stats = { id: worker.id, read: '2026-10-12T00:00:01Z', cpu_stats: { cpu_usage: { total_usage: 2000000000 } }, memory_stats: { usage: 42, limit: 1000 } };
function mockDockerApi(reply: (path: string) => { status: number; body?: unknown }) {
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const request = Object.assign(new PassThrough(), { setTimeout() { return request; }, end() {
      queueMicrotask(() => { const value = reply(String(options.path)), response = Object.assign(new PassThrough(), { statusCode: value.status });
        callback(response as unknown as http.IncomingMessage); response.end(value.body === undefined ? '' : JSON.stringify(value.body)); });
      return request;
    } });
    return request as unknown as http.ClientRequest;
  }) as typeof http.request);
}
it.skipIf(process.platform !== 'linux')('pins id/start/label before and after raw stats, and keeps missing kernel peak unknown', async () => {
  const paths: string[] = []; const read = async (_e: string, path: string) => { paths.push(path); return path.includes('/stats?') ? stats : inspected; };
  const result = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, new AbortController().signal, read);
  expect(result).toMatchObject({ gap: null, cpuSeconds: 2, memoryBytes: 42, kernelPeakBytes: null });
  expect(paths.every(path => path.includes(worker.id))).toBe(true);
});
it.skipIf(process.platform !== 'linux')('rejects wrong incarnation, changed labels and malformed or oversized counters', async () => {
  for (const bad of [{ ...inspected, State: { ...inspected.State, StartedAt: '2026-10-12T00:00:02Z' } }, { ...inspected, Config: { Labels: { 'deckent.request': 'other' } } }]) {
    const result = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, new AbortController().signal, async () => bad);
    expect(result).toMatchObject({ gap: 'identity', cpuSeconds: null, memoryBytes: null });
  }
  const result = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, new AbortController().signal,
    async (_e, path) => path.includes('/stats?') ? { ...stats, memory_stats: { usage: Number.MAX_SAFE_INTEGER + 1 } } : inspected);
  expect(result.gap).toBe('invalid');
});
it.skipIf(process.platform !== 'linux')('retains permission denial and cancellation as gaps rather than zero consumption', async () => {
  const denied = Object.assign(new Error('permission'), { code: 'EACCES' });
  const input = new AbortController();
  const result = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, input.signal, async () => { throw denied; });
  expect(result.gap).toBe('denied'); input.abort();
  const canceled = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, input.signal, async () => { throw new Error('abort'); });
  expect(canceled).toMatchObject({ gap: 'timeout', cpuSeconds: null });
});
it.skipIf(process.platform === 'linux')('reports unsupported native platform capability without contacting the daemon', async () => {
  let reads = 0; const result = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, new AbortController().signal, async () => { reads++; return inspected; });
  expect(reads).toBe(0); expect(result.gap).toBe('unsupported');
});
it('measures older one-shot replies without id through the pinned HTTP transport and retains two samples', async () => {
  const paths: string[] = []; let sequence = 0;
  const { id: _id, ...olderStats } = stats; void _id;
  mockDockerApi(path => {
    paths.push(path);
    return { status: 200, body: path.includes('/stats?') ? { ...olderStats, read: `2026-10-12T00:00:0${++sequence}Z` } : inspected };
  });
  const one = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', null, settings, new AbortController().signal);
  const two = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', one.worker, settings, new AbortController().signal);
  if (process.platform !== 'linux') {
    expect([one.gap, two.gap]).toEqual(['unsupported', 'unsupported']); expect(paths).toEqual([]); return;
  }
  const view = projectResourceView(request.identity, { samples: [one, two], trimmedBeforeMs: null }, Date.parse(stats.read) + 1000, settings.staleMs);
  expect(view).toMatchObject({ reason: null, sampleCount: 2, sampledPeakBytes: 42 });
  expect(one).toMatchObject({ worker, source: 'docker-engine', cpuSeconds: 2, memoryBytes: 42, gap: null });
  expect(paths).toEqual(['/containers/handle/json', `/containers/${worker.id}/stats?stream=false&one-shot=true`, `/containers/${worker.id}/json`,
    `/containers/${worker.id}/json`, `/containers/${worker.id}/stats?stream=false&one-shot=true`, `/containers/${worker.id}/json`]);
});
it('rejects supplied wrong stats ids and malformed ids, even when both inspections agree', async () => {
  for (const [id, gap] of [['b'.repeat(64), 'identity'], ['', 'identity'], [null, 'invalid'], [42, 'invalid']] as const) {
    const result = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, new AbortController().signal,
      async (_endpoint, path) => path.includes('/stats?') ? { ...stats, id } : inspected);
    expect(result).toMatchObject({ gap: process.platform === 'linux' ? gap : 'unsupported', cpuSeconds: null, memoryBytes: null });
  }
});
it('rejects changed id, start or label after id-less stats and does not accept an old timestamp', async () => {
  const { id: _id, ...olderStats } = stats; void _id;
  for (const after of [{ ...inspected, Id: 'b'.repeat(64) }, { ...inspected, State: { ...inspected.State, StartedAt: '2026-10-12T00:00:02Z' } },
    { ...inspected, Config: { Labels: { 'deckent.request': 'other' } } }]) {
    let inspections = 0;
    const result = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, new AbortController().signal,
      async (_endpoint, path) => path.includes('/stats?') ? olderStats : ++inspections === 1 ? inspected : after);
    expect(result).toMatchObject({ gap: process.platform === 'linux' ? 'identity' : 'unsupported', cpuSeconds: null, memoryBytes: null });
  }
  for (const read of ['2026-10-11T23:59:59Z', 'not-a-time']) {
    const result = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, new AbortController().signal,
      async (_endpoint, path) => path.includes('/stats?') ? { ...olderStats, read } : inspected);
    expect(result).toMatchObject({ gap: process.platform === 'linux' ? 'invalid' : 'unsupported', cpuSeconds: null, memoryBytes: null });
  }
});
it('keeps Engine measurements when the pinned PID cgroup cannot be read, without inventing kernel peak', async () => {
  const readFile = vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('permission'), { code: 'EACCES' }));
  const result = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, new AbortController().signal,
    async (_endpoint, path) => path.includes('/stats?') ? stats : { ...inspected, State: { ...inspected.State, Pid: 123 } });
  if (process.platform === 'linux') {
    expect(readFile).toHaveBeenCalledWith('/proc/123/cgroup', 'utf8');
    expect(result).toMatchObject({ gap: null, cpuSeconds: 2, memoryBytes: 42, kernelPeakBytes: null });
  } else { expect(readFile).not.toHaveBeenCalled(); expect(result).toMatchObject({ gap: 'unsupported', kernelPeakBytes: null }); }
});
it('reports denied, unsupported and missing Engine stats through the product diagnostic instead of zero usage', async () => {
  let status = 403;
  mockDockerApi(path => path.includes('/stats?') ? { status } : { status: 200, body: inspected });
  for (const [code, reason] of [[401, 'denied'], [403, 'denied'], [501, 'unsupported'], [404, 'missing']] as const) {
    status = code;
    const sample = await sampleDockerResources('unix:///test.sock', request, 'handle', 'digest', worker, settings, new AbortController().signal);
    const view = projectResourceView(request.identity, { samples: [sample], trimmedBeforeMs: null }, sample.observedAtMs, settings.staleMs);
    const gap = process.platform === 'linux' ? reason : 'unsupported';
    expect(view).toMatchObject({ state: 'gap', reason: gap, gapCount: 1, sampleCount: 0, cpuSeconds: null, sampledPeakBytes: null });
    expect(sample).toMatchObject({ worker, gap, memoryBytes: null, kernelPeakBytes: null });
  }
});
