import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { latencySample, readLatencyClock, summarizeLatency } from '../support/latency-metrics.js';
import { measureTerminalControl, terminalMeasurementIdentity } from '../support/terminal-control-measurement.js';

describe('TC-M invalid evidence and percentiles', () => {
  it.each([[null, 2], [1, null], [NaN, 2], [1, Infinity], [3, 2], [0, 0], [-1, 2]] as const)('keeps %s → %s unmeasured', (start, end) => {
    const sample = latencySample(start, end);
    expect(sample).toEqual({ status: 'unmeasured', ms: null });
    expect(summarizeLatency([sample], 1)).toMatchObject({ status: 'unmeasured', p50Ms: null, p95Ms: null, invalid: 1 });
  });
  it('does not turn an absent or throwing clock into zero', () => {
    expect(readLatencyClock(() => { throw new Error('clock unavailable'); })).toBeNull();
    expect(readLatencyClock(() => NaN)).toBeNull(); expect(readLatencyClock(() => -1)).toBeNull();
    expect(summarizeLatency([], 25)).toMatchObject({ status: 'unmeasured', missing: 25, p50Ms: null, p95Ms: null });
    expect(summarizeLatency([{ status: 'measured', ms: Infinity }, { status: 'measured', ms: 0 }], 2))
      .toMatchObject({ status: 'unmeasured', invalid: 2, p50Ms: null, p95Ms: null });
  });
  it('uses nearest rank and discloses invalid/missing observations beside valid samples', () => {
    const samples = Array.from({ length: 100 }, (_, i) => latencySample(0, 100 - i));
    expect(summarizeLatency(samples, 100)).toMatchObject({ status: 'measured', samples: 100, p50Ms: 50, p95Ms: 95 });
    expect(summarizeLatency([latencySample(0, 5), latencySample(1, 1)], 3)).toMatchObject({ status: 'partial', samples: 1, invalid: 1, missing: 1, p95Ms: 5 });
    expect(() => summarizeLatency(samples, 99)).toThrow('LATENCY_SAMPLE_COUNT');
  });
});

it('measures the real Workline through a fake producer without claiming a product latency gate', async () => {
  const metrics = await measureTerminalControl();
  // Deliberately no 500 ms assertion: that remains the owner target until real baseline acceptance.
  expect(Object.keys(metrics)).toHaveLength(7);
  for (const metric of Object.values(metrics)) expect(metric).toMatchObject({ status: 'measured', samples: 25, invalid: 0, missing: 0 });
  const output = process.env['TC_M_OUTPUT'];
  if (output) await writeFile(output, JSON.stringify({ ...await terminalMeasurementIdentity(process.env['TC_M_BASE_REVISION'] ?? ''), metrics }, null, 2) + '\n', { flag: 'wx' });
}, 30_000);

it('keeps every observed path unmeasured when the harness clock is unavailable', async () => {
  const metrics = await measureTerminalControl(() => NaN);
  for (const metric of Object.values(metrics)) expect(metric).toMatchObject({ status: 'unmeasured', samples: 0, invalid: 25, p50Ms: null, p95Ms: null });
}, 30_000);
