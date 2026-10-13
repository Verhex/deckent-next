import { quotaExhaustedSchema, type QuotaExhausted, type WorkerEvent } from '#domain/index.js';
/** Prefer sealed structured evidence. Text fallback is restricted to the bootstrap exit record, never arbitrary output prose. */
export function detectWorkerQuota(events: readonly WorkerEvent[] | null, stdout: string): QuotaExhausted | null {
  if (events?.some(event => event.kind === 'dropped')) return null;
  const structured = events?.filter(event => event.kind === 'quota-exhausted').at(-1);
  if (structured && events?.some(event => event.sequence > structured.sequence && event.kind === 'session.ended' && event.outcome === 'success')) return null;
  if (structured) { const { source, resetsAtMs, window } = structured; return quotaExhaustedSchema.parse({ source, resetsAtMs, ...(window === undefined ? {} : { window }) }); }
  for (const line of stdout.trimEnd().split('\n').reverse()) {
    try { const data = JSON.parse(line) as Record<string, unknown>;
      if (data.kind === 'native-coding-exit' && data.schemaVersion === 1) return data.failure === 'capacity' && typeof data.code === 'number' && data.code !== 0
        && data.signal === null ? { source: 'exit-text', resetsAtMs: null } : null;
    } catch { /* Non-JSON output is never quota authority. */ }
  }
  return null;
}
