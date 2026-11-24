import { workerEventSchema, verifyWorkerModels, type WorkerEvent } from '#domain/index.js';

/** Validated, bounded reported evidence. Only the existing host verifier produces model verdicts. */
export function createWorkerEventCollector(binding: Pick<Parameters<typeof verifyWorkerModels>[0], 'evidenceCapability' | 'admitted'> & { provider: string },
  maxBytes: number, accept: (events: readonly WorkerEvent[]) => void, observationMaxBytes?: number) {
  let sequence = 0, bytes = 0, events = 0, unreported = 0, started: string | null = null, used: readonly string[] | null = null, ended = false;
  let sourceSeen = false, observation: Extract<WorkerEvent, { kind: 'cli.observation' }> | undefined;
  const evidenceCapability = binding.evidenceCapability;
  return {
    accept(batch: readonly WorkerEvent[]) {
      for (const raw of batch) {
        const parsed = workerEventSchema.safeParse(raw);
        if (!parsed.success || parsed.data.sequence <= sequence || ended) { unreported++; continue; }
        const event = parsed.data;
        if (event.kind === 'cli.observation') {
          if (!observationMaxBytes || !sourceSeen || observation || event.observation.builtinPlugins?.names.length
            || Buffer.byteLength(JSON.stringify(event) + '\n') > observationMaxBytes) { unreported++; continue; }
          observation = event; sequence = event.sequence;
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(event) + '\n');
        if (event.kind === 'model.verification' || event.kind === 'dropped' || bytes + size > maxBytes
          || event.kind === 'session.started' && event.provider !== binding.provider) { unreported++; continue; }
        sequence = event.sequence; bytes += size; events++;
        if (event.kind === 'session.started') { sourceSeen = true; started = event.model; }
        if (event.kind === 'session.ended') { ended = true; used = event.models ?? null; }
        accept([event]);
      }
    },
    protectedObservation: () => observation,
    statistics: () => ({ events, eventBytes: bytes, eventsUnreported: unreported, eventsDropped: 0, connected: 0, bytes: 0 }),
    modelVerification: () => ({ ...(ended ? verifyWorkerModels({ evidenceCapability, admitted: binding.admitted,
      startedModel: started, usedModels: used }) : { status: 'unverified' as const, admitted: binding.admitted?.modelId ?? null, observed: [], unexpected: [] }),
      evidenceCapability }),
  };
}
