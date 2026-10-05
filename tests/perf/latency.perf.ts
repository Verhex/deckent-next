import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { LatencySample } from '../contracts/support/latency-metrics.js';
import { evaluateGate, latencyEnvironment, metricResult, OWNER_P95_TARGET_MS, summarizeRepetition, type LatencyMetricId, type MetricResult } from './latency-gate.js';
import { latencyProject, measureApprovalAnnounce, measureLedgerRunEvent, measureRunCreateToWorkerStart, type Workload } from './latency-workloads.js';

// Run: VITEST_MAX_FORKS=1 npx vitest run --config tests/perf/vitest.config.ts
// Inputs (measurement run, not product config): DECKENT_PERF_THRESHOLD_MS (default 500, owner p95 target), DECKENT_PERF_REPETITIONS (default 3),
// DECKENT_PERF_SAMPLES (default 30), DECKENT_PERF_BASELINE_OUT (directory; writes baseline.json there).
const threshold = Number(process.env['DECKENT_PERF_THRESHOLD_MS'] ?? OWNER_P95_TARGET_MS);
const repetitions = Number(process.env['DECKENT_PERF_REPETITIONS'] ?? 3);
const samples = Number(process.env['DECKENT_PERF_SAMPLES'] ?? 30);
const workload: Workload = { warmup: 5, samples };
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

const measures: Record<LatencyMetricId, (f: Awaited<ReturnType<typeof latencyProject>>, w: Workload) => Promise<LatencySample[]>> = {
  ledgerRunEventToSurface: measureLedgerRunEvent, runCreateToWorkerStart: measureRunCreateToWorkerStart, approvalRequestToAnnounce: measureApprovalAnnounce };

async function measureAll(w: Workload, reps: number): Promise<MetricResult[]> {
  const out: MetricResult[] = [];
  for (const id of Object.keys(measures) as LatencyMetricId[]) {
    const summaries = [];
    for (let rep = 0; rep < reps; rep++) {
      const f = await latencyProject(); disposers.push(f.dispose); // fresh ledger per repetition: no state carried between repetitions
      summaries.push(summarizeRepetition(await measures[id](f, w), w.samples));
    }
    out.push(metricResult(id, summaries));
  }
  return out;
}
const sha = () => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
const dirty = () => { try { return execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim().length > 0; } catch { return null; } };

describe('latency gate (event -> surface, owner target p95)', () => {
  it('measures the three paths on the real composition, writes the baseline and holds the owner threshold', async () => {
    const results = await measureAll(workload, repetitions);
    const verdict = evaluateGate(results, threshold);
    const report = { schemaVersion: 1, kind: 'latency-baseline', generatedAt: new Date().toISOString(), version: { gitSha: sha(), srcDirty: dirty() },
      environment: latencyEnvironment(), workload: { id: 'W1-latency-v1', repetitions, ...workload,
        paths: { ledgerRunEventToSurface: 'createConfiguredRun commit -> production followLedgerSurface (fs.watch + heartbeat 2000 ms default) -> acceptSurfaceEvent',
          runCreateToWorkerStart: 'createConfiguredRun + reserveConfiguredRunTasks -> DispatchApplication claim+grantLaunch -> fake supervisor.execute entry (no Docker)',
          approvalRequestToAnnounce: 'requestTaskApproval (approval_outbox) -> production followLedgerSurface approval event -> acceptSurfaceEvent' } },
      clock: 'node:perf_hooks performance.now, one process', percentile: 'S00 nearest rank per repetition (summarizeLatency), warmup excluded; band = min/max across repetitions',
      gate: { thresholdMs: threshold, ownerTargetMs: OWNER_P95_TARGET_MS, rule: 'red when any repetition p95 of any path is unmeasured or above the threshold', verdict },
      results,
      limits: ['isolated temp project and ledger on this machine, not the live install; no Docker, provider or model call', 'surface step is the terminal reducer acceptSurfaceEvent, not a physical paint',
        'worker start is the supervisor port call, not container start', 'single-process in-process producer and consumer; cross-process runtime service latency is not included'] };
    const out = process.env['DECKENT_PERF_BASELINE_OUT'];
    if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, 'baseline.json'), `${JSON.stringify(report, null, 2)}\n`); }
    console.log(JSON.stringify({ gate: verdict, results: results.map(r => ({ id: r.id, p50: r.band.p50Ms, p95: r.band.p95Ms })) }));
    expect(verdict.failures).toEqual([]);
  });

  // Negative proof: the same real pipeline with a deliberate 600 ms stall in the consumer path must turn the gate red on every path.
  it('goes red on a deliberately slowed fixture', async () => {
    const results = await measureAll({ warmup: 1, samples: 5, consumerDelayMs: 600 }, 1);
    const verdict = evaluateGate(results, OWNER_P95_TARGET_MS);
    console.log(JSON.stringify({ slowed: verdict }));
    expect(verdict.status).toBe('fail');
    expect(new Set(verdict.failures.map(f => f.id))).toEqual(new Set(Object.keys(measures)));
    expect(verdict.failures.every(f => f.reason === 'over-threshold')).toBe(true);
  });

  it('refuses unmeasured and malformed input instead of passing it', () => {
    expect(evaluateGate([metricResult('ledgerRunEventToSurface', [])]).status).toBe('fail');
    expect(evaluateGate([metricResult('ledgerRunEventToSurface', [summarizeRepetition([{ status: 'unmeasured', ms: null }], 1)])]).failures[0]?.reason).toBe('unmeasured');
    expect(evaluateGate([metricResult('ledgerRunEventToSurface', [summarizeRepetition([{ status: 'measured', ms: 500 }], 1)])]).status).toBe('pass');
    expect(evaluateGate([metricResult('ledgerRunEventToSurface', [summarizeRepetition([{ status: 'measured', ms: 500.5 }], 1)])]).status).toBe('fail');
    expect(() => evaluateGate([], 0)).toThrow('LATENCY_THRESHOLD');
  });
});
