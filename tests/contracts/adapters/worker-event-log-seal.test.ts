import { expect, it } from 'vitest';
import { sealWorkerEventLog, WORKER_EVENT_SEAL_RESERVE_BYTES } from '#adapters/index.js';
import { summarizeWorkerEvents, workerEventSchema, WORKER_OBSERVATION_ROW_MAX_BYTES, type WorkerEvent } from '#domain/index.js';

// COMPOSITION-RELIEF: the retained worker event log of an ended attempt, sealed by the worker-observation adapter (moved verbatim from the
// execution composition). The markers keep every loss visible: the host verdict, batches refused after the gateway's budget, the byte cap.
const event = (sequence: number): WorkerEvent => ({ schemaVersion: 1, sequence, atMs: sequence * 10, kind: 'unmapped', nativeType: 'x', count: 1 });
const parse = (lines: readonly string[]) => lines.map(line => { expect(line.endsWith('\n')).toBe(true); return JSON.parse(line) as Record<string, unknown>; });
const verdict = { status: 'substituted' as const, admitted: 'model-a', observed: ['model-a', 'model-b'], unexpected: ['model-b'] };
type Observation = Extract<WorkerEvent, { kind: 'cli.observation' }>;
const observed = (sequence: number, observation: object = {}) => workerEventSchema.parse({ schemaVersion: 1, sequence, atMs: sequence, kind: 'cli.observation',
  observation: { schemaVersion: 1, cliVersion: 'v', builtinPlugins: { names: [], omitted: 2 }, paidExtraUsage: null, ...observation } }) as Observation;
const kinds = (lines: readonly Record<string, unknown>[]) => lines.map(line => line['kind'] === 'dropped' ? line['reason'] : line['kind']);

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
  // Ruling 3650 (a): near the largest safe sequence the prefix is trimmed so every suffix row keeps a safe, increasing sequence.
  const top = Number.MAX_SAFE_INTEGER, high = (sequence: number) => ({ ...event(sequence), atMs: 1 });
  const near = parse(sealWorkerEventLog([high(top - 5), high(top - 4), high(top - 1)], verdict, 2, 1_000_000, observed(1)));
  expect(kinds(near)).toEqual(['unmapped', 'unmapped', 'byte-cap', 'model.verification', 'event-cap', 'cli.observation']);
  expect(near.map(line => line['sequence'])).toEqual([top - 5, top - 4, top - 3, top - 2, top - 1, top]);
  expect(near[2]).toMatchObject({ count: 1 }); near.forEach(line => workerEventSchema.parse(line));
});

it('counts encoded bytes and retains a complete verdict with escaped unicode model identifiers', () => {
  const model = '\u0000'.repeat(128);
  const longVerdict = { status: 'substituted' as const, admitted: model.repeat(2),
    observed: Array.from({ length: 17 }, () => model), unexpected: Array.from({ length: 17 }, () => model) };
  // Schema-v1-maximal verdict: this case is the proof behind the declared WORKER_EVENT_SEAL_RESERVE_BYTES invariant.
  const lines = sealWorkerEventLog(Array.from({ length: 100 }, (_, index) => event(index + 1)), longVerdict, 7, WORKER_EVENT_SEAL_RESERVE_BYTES);
  expect(Buffer.byteLength(lines.join(''))).toBeLessThanOrEqual(WORKER_EVENT_SEAL_RESERVE_BYTES);
  expect(parse(lines).find(line => line['kind'] === 'model.verification')).toMatchObject(longVerdict);
  // N0: the widest observation row (6-byte escapes, full counters, longest fact kind) is the declared bound and follows both markers in the reserve.
  const max = Number.MAX_SAFE_INTEGER, widest = { ...observed(max, { cliVersion: '\ud800'.repeat(64), builtinPlugins: { names: [], omitted: max },
    paidExtraUsage: { kind: 'credits-required', status: 's'.repeat(16), window: 'w'.repeat(24), resetsAtMs: max } }), atMs: max };
  expect(Buffer.byteLength(JSON.stringify(widest) + '\n')).toBe(WORKER_OBSERVATION_ROW_MAX_BYTES);
  const full = (row: object) => Buffer.byteLength(JSON.stringify({ schemaVersion: 1, sequence: max, atMs: max, ...row }) + '\n');
  expect(full({ kind: 'dropped', reason: 'byte-cap', count: max }) + full({ kind: 'model.verification', ...longVerdict }) + full({ kind: 'dropped', reason: 'event-cap', count: max })
    + WORKER_OBSERVATION_ROW_MAX_BYTES).toBeLessThanOrEqual(WORKER_EVENT_SEAL_RESERVE_BYTES);
  const sealed = sealWorkerEventLog(Array.from({ length: 100 }, (_, index) => event(index + 1)), longVerdict, 7, WORKER_EVENT_SEAL_RESERVE_BYTES, widest);
  expect(Buffer.byteLength(sealed.join(''))).toBeLessThanOrEqual(WORKER_EVENT_SEAL_RESERVE_BYTES);
  expect(kinds(parse(sealed).slice(-4))).toEqual(['byte-cap', 'model.verification', 'event-cap', 'cli.observation']);
  expect(parse(sealed).at(-1)).toMatchObject({ atMs: max, observation: widest.observation });
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
  // N0 opt-in slot: only the first count-only observation after the provider's start, outside the ordinary budget (here full after the start row).
  const binding = { provider: 'claude', admitted: null, evidenceCapability: 'session-events' } as const;
  const start = workerEventSchema.parse({ schemaVersion: 1, sequence: 2, atMs: 2, kind: 'session.started', provider: 'claude', model: null, cliVersion: null });
  const slotted: WorkerEvent[] = [], slot = createWorkerEventCollector(binding, Buffer.byteLength(JSON.stringify(start) + '\n'), events => slotted.push(...events), WORKER_OBSERVATION_ROW_MAX_BYTES);
  slot.accept([observed(1)]); slot.accept([start, event(3), observed(4, { builtinPlugins: { names: ['named'], omitted: 0 } }), observed(5), observed(6)]);
  expect(slot.protectedObservation()).toEqual(observed(5)); expect(slotted).toEqual([start]); expect(slot.statistics()).toMatchObject({ events: 1, eventsUnreported: 4 });
  const small = createWorkerEventCollector(binding, 10000, () => {}, 10), ended = createWorkerEventCollector(binding, 10000, () => {}, WORKER_OBSERVATION_ROW_MAX_BYTES);
  small.accept([start, observed(3)]); ended.accept([start, workerEventSchema.parse({ schemaVersion: 1, sequence: 3, atMs: 3, kind: 'session.ended', outcome: 'success',
    turns: 1, durationMs: 1, apiDurationMs: null, costUsd: null, costBasis: null, tokens: null, permissionDenials: 0, models: ['m'] }), observed(4)]);
  expect([small.protectedObservation(), ended.protectedObservation()]).toEqual([undefined, undefined]);
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
