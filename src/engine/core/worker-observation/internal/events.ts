import { workerEventSchema, verifyWorkerModels, type WorkerEvent } from '#domain/index.js';
type Observation = Extract<WorkerEvent, { kind: 'cli.observation' }>;

/** N0: the one protected local observation, projected by the host (`project`: configured secrets and the turn token) with the field rules of the
 * export guard (64-character version, identifier-only status/window) and count-only plugins, so names never travel; undefined when not a valid row. */
export function protectedWorkerObservation(input: unknown, project: (text: string) => string): Observation | undefined {
  const parsed = workerEventSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== 'cli.observation') return undefined;
  // The export guard's bounding (redactBounded): controls become spaces, a cut ends in '…'; `project` already applied the record redaction.
  // eslint-disable-next-line no-control-regex
  const red = (value: string, max: number) => { const out = project(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' '); return out.length > max ? out.slice(0, max - 1) + '…' : out; };
  const identifier = (value: string, max: number) => { const clean = red(value, max); return /^[A-Za-z0-9_.:?-]+$/u.test(clean) ? clean : '?'; };
  const { cliVersion, builtinPlugins: plugins, paidExtraUsage: paid } = parsed.data.observation;
  const row = workerEventSchema.safeParse({ ...parsed.data, observation: { ...parsed.data.observation, cliVersion: cliVersion === null ? null : red(cliVersion, 64),
    builtinPlugins: plugins && { names: [], omitted: plugins.omitted + plugins.names.length },
    paidExtraUsage: paid && { ...paid, status: identifier(paid.status, 16), window: identifier(paid.window, 24) } } });
  return row.success && row.data.kind === 'cli.observation' ? row.data : undefined;
}

/** Validated, bounded reported evidence. Only the existing host verifier produces model verdicts. `observationMaxBytes` opts into N0's slot:
 * the first count-only observation after the provider's start is held outside the ordinary budget (never live-projected) for the seal suffix. */
export function createWorkerEventCollector(binding: Pick<Parameters<typeof verifyWorkerModels>[0], 'evidenceCapability' | 'admitted'> & { provider: string },
  maxBytes: number, accept: (events: readonly WorkerEvent[]) => void, observationMaxBytes?: number) {
  let sequence = 0, bytes = 0, events = 0, unreported = 0, started: string | null = null, used: readonly string[] | null = null, ended = false;
  let sourced = false, observation: Observation | undefined;
  const evidenceCapability = binding.evidenceCapability;
  return {
    accept(batch: readonly WorkerEvent[]) {
      for (const raw of batch) {
        const parsed = workerEventSchema.safeParse(raw), size = parsed.success ? Buffer.byteLength(JSON.stringify(parsed.data) + '\n') : 0;
        if (observationMaxBytes !== undefined && parsed.success && parsed.data.kind === 'cli.observation' && sourced && !observation && !ended
          && parsed.data.sequence > sequence && !parsed.data.observation.builtinPlugins?.names.length && size <= observationMaxBytes) { observation = parsed.data; sequence = observation.sequence; continue; }
        if (!parsed.success || parsed.data.kind === 'cli.observation' || parsed.data.kind === 'model.verification' || parsed.data.kind === 'dropped' || parsed.data.sequence <= sequence
          || bytes + size > maxBytes || ended || parsed.data.kind === 'session.started' && parsed.data.provider !== binding.provider) { unreported++; continue; }
        const event = parsed.data;
        sequence = event.sequence; bytes += size; events++;
        if (event.kind === 'session.started') { started = event.model; sourced = true; }
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
