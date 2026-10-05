import { arch, cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { acceptSurfaceEvent, openSurfacePush, releaseSurfacePush, type SurfacePushEvent } from '#surfaces/core/terminal-kit/index.js';
import { latencySample, readLatencyClock, summarizeLatency } from './latency-metrics.js';

export const SURFACE_PUSH_WORKLOAD = Object.freeze({ id: 'S18-in-process-v1', samples: 25, warmup: 5, scopeId: 'scope-a' });

/** One in-process producer handoff, then the surface accepts the event. No runtime, network, or screen. */
export async function measureSurfacePush(now: () => number = () => performance.now()) {
  const samples = [];
  let state = openSurfacePush();
  const total = SURFACE_PUSH_WORKLOAD.warmup + SURFACE_PUSH_WORKLOAD.samples;
  for (let cursor = 1; cursor <= total; cursor++) {
    const event: SurfacePushEvent = { kind: 'worker', scopeId: SURFACE_PUSH_WORKLOAD.scopeId, sequence: cursor, id: `e${cursor}`, text: `S18-${cursor}` };
    const start = readLatencyClock(now);
    await Promise.resolve();
    const step = acceptSurfaceEvent(state, event, SURFACE_PUSH_WORKLOAD.scopeId, 5);
    if (step.status !== 'applied') throw new Error(`S18_MEASURE_STEP_${step.status}`);
    state = releaseSurfacePush(step.state);
    const sample = latencySample(start, readLatencyClock(now));
    if (cursor > SURFACE_PUSH_WORKLOAD.warmup) samples.push(sample);
  }
  return summarizeLatency(samples, SURFACE_PUSH_WORKLOAD.samples);
}

export function surfacePushLatencyReport(summary: Awaited<ReturnType<typeof measureSurfacePush>>) {
  return {
    schemaVersion: 1, metric: 'eventToSurface', status: summary.status, samples: summary.samples, invalid: summary.invalid,
    missing: summary.missing, p50Ms: summary.p50Ms, p95Ms: summary.p95Ms,
    environment: { node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length, memoryBytes: totalmem(), tty: 'none (in-process function, no screen)',
      maxWorkers: process.env['VITEST_MAX_FORKS'] ?? 'unknown', CI: process.env['CI'] ?? null },
    workload: SURFACE_PUSH_WORKLOAD,
    clock: 'node:perf_hooks performance.now; same process; producer microtask then acceptSurfaceEvent',
    percentile: 'S00 nearest rank via summarizeLatency; warmup excluded; invalid samples stay unmeasured',
    target: { eventToHumanSurfaceP95Ms: 500, status: 'target; not acceptance' },
    limits: ['in-process fake producer; no runtime, approval outbox, network, provider, or physical paint',
      'a zero or backward clock stays unmeasured and is not recorded as 0 ms',
      '500 ms p95 remains the owner target and is not a pass condition'],
  };
}
