import { sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { sameResourceWorker, resourceGap, type ResourceTrace, type ResourceView } from './contract.js';
/** Telemetry is always partial; retained counters are consumed once, never summed across replay or incarnations. */
export function projectResourceView(identity: AttemptIdentity, trace: ResourceTrace, now: number, staleMs: number): ResourceView {
  const samples = [...new Map(trace.samples.filter(row => sameAttemptIdentity(row.identity, identity))
    .map(row => [JSON.stringify(row), row])).values()].sort((a, b) => a.observedAtMs - b.observedAtMs);
  let latest = samples.at(-1) ?? null;
  const valid = samples.filter(row => !row.gap && sameResourceWorker(row.worker, latest?.worker ?? null));
  const resets = valid.some((row, index) => index > 0 && row.cpuSeconds != null && valid[index - 1]!.cpuSeconds != null && row.cpuSeconds < valid[index - 1]!.cpuSeconds!);
  if (resets && latest) latest = resourceGap(identity, latest.observedAtMs, 'counter-reset', latest.worker);
  const ageMs = latest && now >= latest.observedAtMs ? now - latest.observedAtMs : null;
  const values = valid.flatMap(row => row.memoryBytes === null ? [] : [row.memoryBytes]);
  const first = valid[0]?.cpuSeconds, last = valid.at(-1)?.cpuSeconds;
  return Object.freeze({ schemaVersion: 1, coverage: 'partial', provisional: true,
    state: latest?.gap === 'disabled' ? 'disabled' : latest?.gap ? 'gap' : !latest || ageMs === null ? 'unavailable' : ageMs > staleMs ? 'stale' : 'fresh',
    ageMs, latest, sampleCount: valid.length, gapCount: samples.filter(row => row.gap).length + Number(resets),
    cpuSeconds: !resets && valid.length >= 2 && first != null && last != null ? last - first : null,
    sampledPeakBytes: values.length ? Math.max(...values) : null, trimmedBeforeMs: trace.trimmedBeforeMs,
    reason: latest?.gap ?? (!latest ? 'missing' : ageMs === null ? 'invalid' : null) });
}
export function unavailableResourceView(reason: ResourceView['reason'] = 'store-unavailable'): ResourceView {
  return Object.freeze({ schemaVersion: 1, state: reason === 'disabled' ? 'disabled' : 'unavailable', coverage: 'partial', provisional: true,
    ageMs: null, latest: null, sampleCount: 0, gapCount: 0, cpuSeconds: null, sampledPeakBytes: null, trimmedBeforeMs: null, reason });
}
