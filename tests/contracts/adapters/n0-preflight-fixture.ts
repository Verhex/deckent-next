import { workerEventSchema, type WorkerEvent } from '#domain/index.js';

export const safeMax = Number.MAX_SAFE_INTEGER;
export const ndjson = (event: WorkerEvent) => JSON.stringify(event) + '\n';
export const unmapped = (sequence: number): WorkerEvent =>
  ({ schemaVersion: 1, sequence, atMs: sequence, kind: 'unmapped', nativeType: 'fixture', count: 1 });

export const observation = (sequence: number) => workerEventSchema.parse({
  schemaVersion: 1, sequence, atMs: safeMax, kind: 'cli.observation',
  observation: { schemaVersion: 1, cliVersion: 'fixture-version', builtinPlugins: { names: ['fixture-plugin'], omitted: 2 },
    paidExtraUsage: { kind: 'overage', status: 'allowed_warning', window: 'five_hour', resetsAtMs: safeMax } },
});

/** Fill a byte budget exactly with schema-sized ordinary records. */
export function fillOrdinaryBytes(bytes: number, firstSequence: number): WorkerEvent[] {
  let sequence = firstSequence;
  const events: WorkerEvent[] = [];
  const wide = (): WorkerEvent => ({ schemaVersion: 1, sequence, atMs: 1, kind: 'tool.call',
    toolId: 'ࠀ'.repeat(96), name: 'ࠀ'.repeat(64), toolClass: 'other', target: 'ࠀ'.repeat(256), detail: 'ࠀ'.repeat(240) });
  const pad = (width: number): WorkerEvent => ({ schemaVersion: 1, sequence, atMs: 1, kind: 'message',
    role: 'assistant', textBytes: 0, thinking: false, excerpt: 'a'.repeat(width) });
  const add = (event: WorkerEvent) => {
    bytes -= Buffer.byteLength(ndjson(event));
    events.push(event);
    sequence++;
  };
  for (let event = wide(); bytes >= Buffer.byteLength(ndjson(event)) + 400; event = wide()) add(event);
  while (bytes > Buffer.byteLength(ndjson(pad(0))) + 240) add(pad(0));
  const padding = bytes - Buffer.byteLength(ndjson(pad(0)));
  if (padding < 0) throw new Error('Fixture byte budget cannot be filled');
  add(pad(padding));
  return events;
}
