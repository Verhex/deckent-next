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
