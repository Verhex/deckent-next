/** TC-M host measurement collector. No runtime telemetry, policy or latency acceptance gate. */
export const LATENCY_METRICS = ['startupFirstFrame', 'submitBusy', 'streamEventPaint', 'approvalCard', 'cancelAcknowledgement',
  'modelGenerationWall', 'compactionWall'] as const;
export type LatencyMetric = typeof LATENCY_METRICS[number];
export type Stamp = number | null;
export type LatencySample = Readonly<{ status: 'measured'; ms: number } | { status: 'unmeasured'; ms: null }>;

export function readLatencyClock(now: () => number): Stamp {
  try { const stamp = now(); return Number.isFinite(stamp) && stamp >= 0 ? stamp : null; } catch { return null; }
}
export function latencySample(start: Stamp, end: Stamp): LatencySample {
  const ms = start === null || end === null ? NaN : end - start;
  // Equal readings cannot resolve this interval; an invalid/backward/overflow clock is never a zero sample.
  return start !== null && end !== null && Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end >= 0 && Number.isFinite(ms) && ms > 0
    ? { status: 'measured', ms } : { status: 'unmeasured', ms: null };
}
export function summarizeLatency(samples: readonly LatencySample[], expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 1 || samples.length > expected) throw new RangeError('LATENCY_SAMPLE_COUNT');
  // Validate ingress as well: malformed retained samples must not become numeric results.
  const measured = samples.flatMap(sample => sample.status === 'measured' && typeof sample.ms === 'number' && Number.isFinite(sample.ms) && sample.ms > 0 ? [sample.ms] : []).sort((a, b) => a - b);
  const invalid = samples.length - measured.length, missing = expected - samples.length;
  const percentile = (p: number) => measured.length ? measured[Math.ceil(measured.length * p) - 1]! : null;
  return { status: !measured.length ? 'unmeasured' : invalid || missing ? 'partial' : 'measured', samples: measured.length, invalid, missing,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), raw: samples };
}
