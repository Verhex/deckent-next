import { afterEach, expect, it, vi } from 'vitest';
import { ResourceCollector, resourceGap, projectResourceView, validateResourceSample, type ResourceSample } from '#engine/index.js';
import { getConfigFieldDefault } from '#platform/index.js';
import type { ExecutionSupervisor, SandboxRequest } from '#engine/index.js';
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
const worker = { kind: 'container' as const, id: 'a'.repeat(64), startedAt: '2026-10-12T00:00:00Z' };
const settings = { ...getConfigFieldDefault('resourceObservation'), intervalMs: 100, timeoutMs: 100, maxConcurrentReads: 1 };
const request: SandboxRequest = { protocolVersion: 1, identity, workspace: '/test', argv: ['worker'] };
const sample = (observedAtMs: number, cpuSeconds: number): ResourceSample => ({ ...resourceGap(identity, observedAtMs, 'starting', worker), gap: null, cpuSeconds, memoryBytes: 100, memoryLimitBytes: 1000 });
afterEach(() => vi.useRealTimers());
it('rejects another attempt or incarnation and preserves null first interval, stale state and replay deduplication', () => {
  expect(() => validateResourceSample(sample(100, 1), { ...identity, generation: 2 }, worker)).toThrow('RESOURCE_IDENTITY');
  expect(() => validateResourceSample(sample(100, 1), identity, { ...worker, id: 'b'.repeat(64) })).toThrow('RESOURCE_IDENTITY');
  expect(projectResourceView(identity, { samples: [sample(100, 1)], trimmedBeforeMs: null }, 101, 50).cpuSeconds).toBeNull();
  const view = projectResourceView(identity, { samples: [sample(100, 1), sample(200, 2), sample(200, 2)], trimmedBeforeMs: null }, 300, 50);
  expect(view).toMatchObject({ state: 'stale', sampleCount: 2, cpuSeconds: 1, coverage: 'partial' });
  expect(projectResourceView(identity, { samples: [sample(100, 2), sample(200, 1)], trimmedBeforeMs: null }, 200, 50)).toMatchObject({ state: 'gap', reason: 'counter-reset', cpuSeconds: null });
});
it('caps concurrent reads and aborts observation without cancelling work', async () => {
  vi.useFakeTimers(); const written: ResourceSample[] = []; let signal: AbortSignal | undefined;
  const reader = { async readResources(_r: unknown, _w: unknown, _s: unknown, input: AbortSignal) { signal = input; return await new Promise<ResourceSample>((_resolve, reject) => input.addEventListener('abort', () => reject(new Error('abort')), { once: true })); } };
  const collector = new ResourceCollector({ async append(row) { written.push(row); }, async read() { return { samples: [], trimmedBeforeMs: null }; } }, settings, () => 100);
  const one = collector.start(request, reader as unknown as ExecutionSupervisor), two = collector.start({ ...request, identity: { ...identity, attemptId: 'b' } }, reader as unknown as ExecutionSupervisor);
  await vi.advanceTimersByTimeAsync(0); expect(written.some(row => row.gap === 'overload')).toBe(true);
  one.stop(); two.stop(); await vi.advanceTimersByTimeAsync(500); expect(signal?.aborted).toBe(true);
});
it('keeps storage failure off the work path and retains a gap on recovery', async () => {
  vi.useFakeTimers(); const written: ResourceSample[] = []; let fail = true;
  const reader = { async readResources() { return sample(Date.now(), 1); } };
  const collector = new ResourceCollector({ async append(row) { if (fail) throw new Error('ENOSPC'); written.push(row); }, async read() { return { samples: [], trimmedBeforeMs: null }; } }, settings);
  const observed = collector.start(request, reader as unknown as ExecutionSupervisor);
  await vi.advanceTimersByTimeAsync(0); fail = false; await vi.advanceTimersByTimeAsync(100); observed.stop();
  expect(written.some(row => row.gap === 'store-unavailable')).toBe(true);
});
it('records unsupported supervision once without polling or touching execution', async () => {
  vi.useFakeTimers(); const written: ResourceSample[] = [];
  const collector = new ResourceCollector({ async append(row) { written.push(row); }, async read() { return { samples: [], trimmedBeforeMs: null }; } }, settings);
  const observed = collector.start(request, {} as ExecutionSupervisor);
  await vi.advanceTimersByTimeAsync(1000); observed.stop(); expect(written.map(row => row.gap)).toEqual(['unsupported']);
});
it('bounds a slow writer queue and carries its overflow gap into the next successful write', async () => {
  vi.useFakeTimers(); const written: ResourceSample[] = []; let release!: () => void, waiting = true;
  const blocked = new Promise<void>(done => { release = done; });
  const collector = new ResourceCollector({ async append(row) { if (waiting) { waiting = false; await blocked; } written.push(row); }, async read() { return { samples: [], trimmedBeforeMs: null }; } },
    { ...settings, maxQueueEntries: 1 });
  const reader = { async readResources() { return sample(Date.now(), 1); } };
  const observed = collector.start(request, reader as unknown as ExecutionSupervisor);
  await vi.advanceTimersByTimeAsync(500); release(); await vi.advanceTimersByTimeAsync(0); observed.stop();
  expect(written.some(row => row.gap === 'queue-full')).toBe(true);
});
it('does not read or write telemetry when disabled', async () => {
  const append = vi.fn(async () => undefined), readResources = vi.fn(async () => sample(100, 1));
  const collector = new ResourceCollector({ append, async read() { return { samples: [], trimmedBeforeMs: null }; } }, { ...settings, enabled: false });
  collector.start(request, { readResources } as unknown as ExecutionSupervisor).stop();
  expect(append).not.toHaveBeenCalled(); expect(readResources).not.toHaveBeenCalled();
});
