import { expect, it } from 'vitest';
import { sealWorkerEventLog } from '#adapters/index.js';
import type { WorkerEvent } from '#domain/index.js';

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

it('keeps the lines that fit the limit less 256 bytes and reports the rest as one byte-cap marker', () => {
  const line = Buffer.byteLength(JSON.stringify(event(1)) + '\n');
  const sealed = parse(sealWorkerEventLog([event(1), event(2), event(3)], null, 0, 256 + line * 2));
  expect(sealed.map(value => value['sequence'])).toEqual([1, 2, 3]);
  expect(sealed[2]).toEqual({ schemaVersion: 1, sequence: 3, atMs: 20, kind: 'dropped', reason: 'byte-cap', count: 1 });
  // Nothing fits: the marker alone says how many were lost.
  expect(parse(sealWorkerEventLog([event(1)], verdict, 1, 256))).toEqual([{ schemaVersion: 1, sequence: 1, atMs: 0, kind: 'dropped', reason: 'byte-cap', count: 3 }]);
});
