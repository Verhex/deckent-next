import { optionalField } from '#platform/index.js';

import { quotaExhaustedSchema, type QuotaExhausted, type WorkerEvent } from '#domain/index.js';
/** Prefer sealed structured evidence. Text fallback is restricted to the bootstrap exit record, never arbitrary output prose. */
export function detectWorkerQuota(events: readonly WorkerEvent[] | null, stdout: string): QuotaExhausted | null {
  const structured = events?.some(event => event.kind === 'dropped') ? undefined : events?.filter(event => event.kind === 'quota-exhausted').at(-1);
  if (structured && events?.some(event => event.sequence > structured.sequence && event.kind === 'session.ended' && event.outcome === 'success')) return null;
  if (structured) { const { source, resetsAtMs, window } = structured; return quotaExhaustedSchema.parse({ source, resetsAtMs, ...optionalField('window', window) }); }
  for (const line of stdout.trimEnd().split('\n').reverse()) {
    try { const data = JSON.parse(line) as Record<string, unknown>;
      if (data.kind === 'native-coding-exit' && data.schemaVersion === 1) {
        const observedStop = data.failure === 'capacity:quota-stop' || data.failure === 'capacity:quota-stop-incomplete';
        // Only an observed stop admits SIGKILL or the CLI exit-0 race; text guesses keep their old nonzero-exit rule.
        const quota = observedStop
          ? (typeof data.code === 'number' && data.signal === null) || (data.code === null && data.signal === 'SIGKILL')
          : data.failure === 'capacity' && typeof data.code === 'number' && data.code !== 0 && data.signal === null;
        return quota ? { source: 'exit-text', resetsAtMs: null } : null;
      }
    } catch { /* Non-JSON output is never quota authority. */ }
  }
  return null;
}
