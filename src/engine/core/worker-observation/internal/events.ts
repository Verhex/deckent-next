import { workerEventSchema, verifyWorkerModels, type WorkerEvent } from '#domain/index.js';

/** Validated, bounded reported evidence. Only the existing host verifier produces model verdicts. */
export function createWorkerEventCollector(binding: Pick<Parameters<typeof verifyWorkerModels>[0], 'evidenceCapability' | 'admitted'> & { provider: string },
  maxBytes: number, accept: (events: readonly WorkerEvent[]) => void) {
  let sequence = 0, bytes = 0, events = 0, unreported = 0, started: string | null = null, used: readonly string[] | null = null, ended = false;
  const evidenceCapability = binding.evidenceCapability;
  return {
    accept(batch: readonly WorkerEvent[]) {
      for (const raw of batch) {
        const parsed = workerEventSchema.safeParse(raw), size = parsed.success ? Buffer.byteLength(JSON.stringify(parsed.data) + '\n') : 0;
        if (!parsed.success || parsed.data.kind === 'cli.observation' || parsed.data.kind === 'model.verification' || parsed.data.kind === 'dropped' || parsed.data.sequence <= sequence
          || bytes + size > maxBytes || ended || parsed.data.kind === 'session.started' && parsed.data.provider !== binding.provider) { unreported++; continue; }
        const event = parsed.data;
        sequence = event.sequence; bytes += size; events++;
        if (event.kind === 'session.started') started = event.model;
        if (event.kind === 'session.ended') { ended = true; used = event.models ?? null; }
        accept([event]);
      }
    },
    statistics: () => ({ events, eventBytes: bytes, eventsUnreported: unreported, eventsDropped: 0, connected: 0, bytes: 0 }),
    modelVerification: () => ({ ...(ended ? verifyWorkerModels({ evidenceCapability, admitted: binding.admitted,
      startedModel: started, usedModels: used }) : { status: 'unverified' as const, admitted: binding.admitted?.modelId ?? null, observed: [], unexpected: [] }),
      evidenceCapability }),
  };
}
