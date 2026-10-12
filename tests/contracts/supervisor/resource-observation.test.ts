import { expect, it } from 'vitest';
import { sampleDockerResources } from '#adapters/index.js';
import { getConfigFieldDefault } from '#platform/index.js';
const settings = getConfigFieldDefault('resourceObservation'), worker = { kind: 'container' as const, id: 'a'.repeat(64), startedAt: '2026-10-12T00:00:00Z' };
const request = { protocolVersion: 1 as const, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' }, workspace: '/test', argv: ['worker'] };
const inspected = { Id: worker.id, Config: { Labels: { 'deckent.request': 'digest' } }, State: { Status: 'running', StartedAt: worker.startedAt } };
const stats = { id: worker.id, read: '2026-10-12T00:00:01Z', cpu_stats: { cpu_usage: { total_usage: 2000000000 } }, memory_stats: { usage: 42, limit: 1000 } };
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
