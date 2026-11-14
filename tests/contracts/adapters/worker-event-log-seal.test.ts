import { expect, it } from 'vitest';
import { sealWorkerEventLog, WORKER_EVENT_SEAL_RESERVE_BYTES } from '#adapters/index.js';
import { summarizeWorkerEvents, workerEventSchema, type WorkerEvent } from '#domain/index.js';

// COMPOSITION-RELIEF: the retained worker event log of an ended attempt, sealed by the worker-observation adapter (moved verbatim from the
// execution composition). The markers keep every loss visible: the host verdict, batches refused after the gateway's budget, the byte cap.
const event = (sequence: number): WorkerEvent => ({ schemaVersion: 1, sequence, atMs: sequence * 10, kind: 'unmapped', nativeType: 'x', count: 1 });
const parse = (lines: readonly string[]) => lines.map(line => { expect(line.endsWith('\n')).toBe(true); return JSON.parse(line) as Record<string, unknown>; });
const verdict = { status: 'substituted' as const, admitted: 'model-a', observed: ['model-a', 'model-b'], unexpected: ['model-b'] };

it('seals nothing when nothing was received, verified or refused', () => {
  expect(sealWorkerEventLog([], null, 0, 1_000_000)).toEqual([]);
});

it('appends the host verdict and one event-cap marker after the received events, in sequence', () => {
  const sealed = parse(sealWorkerEventLog([event(1), event(2)], verdict, 3, 1_000_000));
  expect(sealed.map(line => line['kind'])).toEqual(['unmapped', 'unmapped', 'model.verification', 'dropped']);
  expect(sealed[2]).toEqual({ schemaVersion: 1, sequence: 3, atMs: 20, kind: 'model.verification', ...verdict });
  expect(sealed[3]).toEqual({ schemaVersion: 1, sequence: 4, atMs: 20, kind: 'dropped', reason: 'event-cap', count: 3 });
  // Markers alone still seal (a session that reported nothing): they start the sequence.
  expect(parse(sealWorkerEventLog([], null, 2, 1_000_000))).toEqual([{ schemaVersion: 1, sequence: 1, atMs: 0, kind: 'dropped', reason: 'event-cap', count: 2 }]);
});

it('reserves the host verdict and both loss markers before retaining the event prefix', () => {
  const events = Array.from({ length: 30 }, (_, index) => event(index + 1));
  const lines = sealWorkerEventLog(events, verdict, 7, 700), sealed = parse(lines);
  expect(Buffer.byteLength(lines.join(''))).toBeLessThanOrEqual(700);
  expect(sealed.find(line => line['kind'] === 'model.verification')).toMatchObject(verdict);
  expect(sealed.find(line => line['reason'] === 'event-cap')).toMatchObject({ count: 7 });
  const retained = sealed.filter(line => line['kind'] === 'unmapped').length;
  expect(sealed.find(line => line['reason'] === 'byte-cap')).toMatchObject({ count: events.length - retained });
  expect(sealed.map(line => line['sequence'])).toEqual(sealed.map((_, index) => index + 1));
  const validated = sealed.map(line => workerEventSchema.parse(line));
  expect(summarizeWorkerEvents(validated).modelVerification).toEqual({ status: 'substituted', unexpected: ['model-b'] });
});

it('counts encoded bytes and retains a complete verdict with escaped unicode model identifiers', () => {
  const model = '\u0000'.repeat(128);
  const longVerdict = { status: 'substituted' as const, admitted: model.repeat(2),
    observed: Array.from({ length: 17 }, () => model), unexpected: Array.from({ length: 17 }, () => model) };
  // Schema-v1-maximal verdict: this case is the proof behind the declared WORKER_EVENT_SEAL_RESERVE_BYTES invariant.
  const lines = sealWorkerEventLog(Array.from({ length: 100 }, (_, index) => event(index + 1)), longVerdict, 7, WORKER_EVENT_SEAL_RESERVE_BYTES);
  expect(Buffer.byteLength(lines.join(''))).toBeLessThanOrEqual(WORKER_EVENT_SEAL_RESERVE_BYTES);
  expect(parse(lines).find(line => line['kind'] === 'model.verification')).toMatchObject(longVerdict);
});

it('refuses a seal smaller than the host markers rather than silently discarding their evidence', () => {
  expect(() => sealWorkerEventLog([event(1)], verdict, 1, 1)).toThrow();
});

it('keeps a byte-cap loss marker when there is no model verdict', () => {
  const lines = sealWorkerEventLog(Array.from({ length: 20 }, (_, index) => event(index + 1)), null, 0, 256);
  expect(Buffer.byteLength(lines.join(''))).toBeLessThanOrEqual(256);
  const sealed = parse(lines), retained = sealed.filter(line => line['kind'] === 'unmapped').length;
  expect(sealed.at(-1)).toMatchObject({ kind: 'dropped', reason: 'byte-cap', count: 20 - retained });
});


it('seals stamped production host verdicts as v2 while preserving v1 recorded verdicts', () => {
  const sealed = parse(sealWorkerEventLog([event(1)], { ...verdict, evidenceCapability: 'session-events' }, 0, 1_000_000));
  expect(sealed[1]).toEqual({ schemaVersion: 2, sequence: 2, atMs: 10, kind: 'model.verification', ...verdict, evidenceCapability: 'session-events' });
  expect(workerEventSchema.parse(sealed[1])).toEqual(sealed[1]);
  expect(summarizeWorkerEvents(sealed.map(line => workerEventSchema.parse(line))).modelVerification).toEqual({ status: 'substituted', unexpected: ['model-b'] });
});

it('reads beta.2.1 body/live/suffix observations without changing phase or model verdict, while beta.2 direct ingress drops them', async () => {
  const { createWorkerEventCollector } = await import('../../../src/engine/core/worker-observation/internal/events.js');
  const { workerActivityPhase } = await import('#domain/index.js');
  const { readWorkerEventTail } = await import('#adapters/core/worker-observation/index.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const observation = workerEventSchema.parse({ schemaVersion: 1, sequence: 1, atMs: 1, kind: 'cli.observation', observation: {
    schemaVersion: 1, cliVersion: 'fixture-version', builtinPlugins: { names: ['fixture-plugin'], omitted: 1 },
    paidExtraUsage: { kind: 'overage', status: 'rejected', window: 'five_hour', resetsAtMs: null } } });
  const original = sealWorkerEventLog([event(1)], verdict, 2, 1_000_000).map(line => workerEventSchema.parse(JSON.parse(line)));
  const recorded = [observation, ...original, { ...observation, sequence: original.length + 2 }].map((event, index) => workerEventSchema.parse({ ...event, sequence: index + 1 }));
  expect(summarizeWorkerEvents(recorded)).toEqual({ ...summarizeWorkerEvents(original), events: recorded.length });
  expect(workerActivityPhase(recorded)).toEqual(workerActivityPhase(original));
  const accepted: WorkerEvent[] = [], collector = createWorkerEventCollector({ provider: 'claude', admitted: null, evidenceCapability: 'session-events' }, 10000, events => accepted.push(...events));
  collector.accept([observation]); expect(accepted).toEqual([]); expect(collector.statistics().eventsUnreported).toBe(1);
  const root = await mkdtemp(join(tmpdir(), 'dn-observation-reader-'));
  try {
    await writeFile(join(root, 'worker.events'), recorded.map(event => JSON.stringify({ receivedAt: 100, event })).join('\n') + '\n', { mode: 0o600 });
    const live = await readWorkerEventTail(root, 'worker', 65536);
    expect(live.map(item => item.event)).toEqual(recorded);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('scrubs every observation text field independently of the beta.2 ingress drop', async () => {
  const { scrubWorkerEvent } = await import('../../../src/adapters/core/native-connection/internal/event-guard.js');
  const { snapshotKnownSecrets } = await import('#platform/index.js');
  const secret = 'fixture-secret', input = workerEventSchema.parse({ schemaVersion: 1, sequence: 1, atMs: 1, kind: 'cli.observation',
    observation: { schemaVersion: 1, cliVersion: secret, builtinPlugins: { names: [secret, 'other-secret'], omitted: 0 },
      paidExtraUsage: { kind: 'overage', status: secret, window: secret, resetsAtMs: null } } });
  const scrubbed = scrubWorkerEvent(input, snapshotKnownSecrets([{ name: null, value: secret }, { name: null, value: 'other-secret' }]));
  expect(JSON.stringify(scrubbed)).not.toContain(secret);
  expect(JSON.stringify(scrubbed)).not.toContain('other-secret');
  expect(workerEventSchema.parse(scrubbed)).toMatchObject({ observation: { cliVersion: '[REDACTED]',
    builtinPlugins: { names: ['[REDACTED]'], omitted: 1 }, paidExtraUsage: { status: '?', window: '?' } } });
});
