import { arch, cpus, platform, release, totalmem } from 'node:os';
import { latencySample, summarizeLatency, type LatencySample } from '../contracts/support/latency-metrics.js';

/** Owner target (2026-10-05 wave 6): event -> human surface p95 <= 500 ms. A measurement-run input, not product config or a registry value. */
export const OWNER_P95_TARGET_MS = 500;
export const LATENCY_METRIC_IDS = ['ledgerRunEventToSurface', 'runCreateToWorkerStart', 'approvalRequestToAnnounce'] as const;
export type LatencyMetricId = typeof LATENCY_METRIC_IDS[number];

export type RepetitionSummary = Readonly<{ samples: number; invalid: number; missing: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null }>;
export type MetricResult = Readonly<{ id: LatencyMetricId; repetitions: readonly RepetitionSummary[]; band: Readonly<{ p50Ms: Band; p95Ms: Band }> }>;
type Band = Readonly<{ min: number | null; max: number | null; spreadMs: number | null }>;
export type GateVerdict = Readonly<{ status: 'pass' | 'fail'; thresholdMs: number; failures: readonly { id: string; repetition: number | null; p95Ms: number | null; reason: 'over-threshold' | 'unmeasured' }[] }>;

/** One repetition: the S00 nearest-rank summary over measured samples, plus the slowest sample (a p95 over few samples can hide it). */
export function summarizeRepetition(samples: readonly LatencySample[], expected: number): RepetitionSummary {
  const summary = summarizeLatency(samples, expected);
  const measured = samples.flatMap(sample => sample.status === 'measured' ? [sample.ms] : []);
  return { samples: summary.samples, invalid: summary.invalid, missing: summary.missing, p50Ms: summary.p50Ms, p95Ms: summary.p95Ms,
    maxMs: measured.length ? Math.max(...measured) : null };
}
export const sampleBetween = latencySample;

function band(values: readonly (number | null)[]): Band {
  const numbers = values.filter((value): value is number => value !== null);
  if (!numbers.length) return { min: null, max: null, spreadMs: null };
  const min = Math.min(...numbers), max = Math.max(...numbers);
  return { min, max, spreadMs: max - min };
}
export function metricResult(id: LatencyMetricId, repetitions: readonly RepetitionSummary[]): MetricResult {
  return { id, repetitions, band: { p50Ms: band(repetitions.map(r => r.p50Ms)), p95Ms: band(repetitions.map(r => r.p95Ms)) } };
}

/** The gate is red when ANY repetition of ANY metric has an unmeasured or over-threshold p95 (worst repetition decides, not the mean). */
export function evaluateGate(results: readonly MetricResult[], thresholdMs = OWNER_P95_TARGET_MS): GateVerdict {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) throw new RangeError('LATENCY_THRESHOLD');
  const failures: { id: string; repetition: number | null; p95Ms: number | null; reason: 'over-threshold' | 'unmeasured' }[] = [];
  for (const result of results) {
    if (!result.repetitions.length) failures.push({ id: result.id, repetition: null, p95Ms: null, reason: 'unmeasured' });
    result.repetitions.forEach((repetition, index) => {
      if (repetition.p95Ms === null || repetition.invalid || repetition.missing) failures.push({ id: result.id, repetition: index + 1, p95Ms: repetition.p95Ms, reason: 'unmeasured' });
      else if (repetition.p95Ms > thresholdMs) failures.push({ id: result.id, repetition: index + 1, p95Ms: repetition.p95Ms, reason: 'over-threshold' });
    });
  }
  return { status: failures.length ? 'fail' : 'pass', thresholdMs, failures };
}

export function latencyEnvironment() {
  return { node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length,
    memoryBytes: totalmem(), maxWorkers: process.env['VITEST_MAX_FORKS'] ?? 'unknown', CI: process.env['CI'] ?? null };
}
