import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openSqliteAttemptStore } from '#adapters/core/attempt-store/index.js';
import { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import { sealAttemptWorkerEvents, sealWorkerEventLog, WORKER_EVENT_SEAL_RESERVE_BYTES } from '#adapters/core/worker-observation/index.js';
import { attemptIdentitySchema, nativeCallObservationSchema, pluginNamesSchema, workerEventSchema, type SealedWorkerModelVerification, type WorkerEvent } from '#domain/index.js';
import { readLocalOsOwner } from '#adapters/core/local-principal/index.js';
import { WorkerTranscriptApplication } from '#engine/core/worker-observation/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';
import { ndjson, observation, safeMax, unmapped } from './n0-preflight-fixture.js';

const escaped = '\ud800';
const identity = attemptIdentitySchema.parse({ scopeId: 'n0-scope', runId: 'n0-run', taskId: 'n0-task', attemptId: 'n0-attempt', generation: 1, layoutRevision: 'n0-layout' });
const parse = (lines: string[]) => lines.map(line => workerEventSchema.parse(JSON.parse(line)));

it('measures the actual seal suffix, the protected format envelope and sequence headroom', () => {
  const models = Array.from({ length: 17 }, (_, index) => String.fromCharCode(0xd800 + index).repeat(128));
  // Maximal schema envelope. The verifier's version-4 mismatch actually lists only one unexpected model.
  const verdict: SealedWorkerModelVerification = { status: 'client-reported-mismatch', evidenceCapability: 'client-reported',
    admitted: escaped.repeat(256), observed: models, unexpected: models };
  const protectedEvent = workerEventSchema.parse({ schemaVersion: 1, sequence: safeMax - 1, atMs: safeMax, kind: 'cli.observation',
    observation: { schemaVersion: 1, cliVersion: escaped.repeat(64), builtinPlugins: { names: [], omitted: safeMax },
      paidExtraUsage: { kind: 'overage', status: 's'.repeat(16), window: 'w'.repeat(24), resetsAtMs: safeMax } } });
  const ordinary = Array.from({ length: 120 }, (_, index) => ({ ...unmapped(safeMax - 124 + index), atMs: safeMax }));
  const budget = WORKER_EVENT_SEAL_RESERVE_BYTES;
  const lines = sealWorkerEventLog(ordinary, verdict, 37, budget);
  const events = parse(lines), suffix = events.slice(-3), prefix = events.length - 3;
  expect(prefix).toBeGreaterThan(0);
  expect(prefix).toBeLessThan(ordinary.length);
  expect(events.slice(0, prefix)).toEqual(ordinary.slice(0, prefix));
  expect(suffix).toMatchObject([{ kind: 'dropped', reason: 'byte-cap', count: ordinary.length - prefix },
    { kind: 'model.verification', schemaVersion: 4 }, { kind: 'dropped', reason: 'event-cap', count: 37 }]);
  expect(events.every((event, index) => Number.isSafeInteger(event.sequence) &&
    (index === 0 || event.sequence === events[index - 1]!.sequence + 1))).toBe(true);
  const verdictBytes = Buffer.byteLength(lines.at(-2)!);
  const worstMarkers = (['byte-cap', 'event-cap'] as const).map(reason => workerEventSchema.parse({
    schemaVersion: 1, sequence: safeMax, atMs: safeMax, kind: 'dropped', reason, count: safeMax }));
  // Existing serializer measures each worst marker and protected event as a received row.
  const serializeReceived = (event: WorkerEvent) => sealWorkerEventLog([event], null, 0, budget)[0]!;
  const markerBytes = worstMarkers.map(event => Buffer.byteLength(serializeReceived(event)));
  const observationBytes = Buffer.byteLength(serializeReceived(protectedEvent));
  const longestFact = workerEventSchema.parse({ ...protectedEvent, observation: {
    ...(protectedEvent.kind === 'cli.observation' ? protectedEvent.observation : {}),
    paidExtraUsage: { kind: 'credits-required', status: 's'.repeat(16), window: 'w'.repeat(24), resetsAtMs: safeMax },
  } });
  const longestObservationBytes = Buffer.byteLength(serializeReceived(longestFact));
  const envelope = verdictBytes + markerBytes.reduce((sum, bytes) => sum + bytes, 0) + longestObservationBytes;
  expect({ verdictBytes, markerBytes, observationBytes, longestObservationBytes, envelope, margin: budget - envelope })
    .toEqual({ verdictBytes: 27_967, markerBytes: [134, 135], observationBytes: 718, longestObservationBytes: 727, envelope: 28_963, margin: 3_805 });
  if (longestFact.kind !== 'cli.observation') throw new Error('observation fixture');
  const joint = sealWorkerEventLog(ordinary, verdict, 37, budget, longestFact);
  const final = parse(joint), jointSuffix = final.slice(-4);
  expect(jointSuffix.map(event => event.kind)).toEqual(['dropped', 'model.verification', 'dropped', 'cli.observation']);
  expect(jointSuffix[0]).toMatchObject({ reason: 'byte-cap', count: ordinary.length - (final.length - 4) });
  expect(jointSuffix[2]).toMatchObject({ reason: 'event-cap', count: 37 });
  expect(final.slice(0, -4)).toEqual(ordinary.slice(0, final.length - 4));
  expect(final.every((event, index) => Number.isSafeInteger(event.sequence) &&
    (index === 0 || event.sequence === final[index - 1]!.sequence + 1))).toBe(true);
  expect(Buffer.byteLength(joint.join(''))).toBeLessThanOrEqual(budget);
  const overflow = parse(sealWorkerEventLog([unmapped(safeMax - 4), unmapped(safeMax)], verdict, 1, budget, longestFact));
  expect(overflow.map(row => row.sequence)).toEqual([safeMax - 4, safeMax - 3, safeMax - 2, safeMax - 1, safeMax]);
  expect(overflow.slice(1).map(row => row.kind)).toEqual(['dropped', 'model.verification', 'dropped', 'cli.observation']);
  console.info('N0 size', JSON.stringify({ envelope, margin: budget - envelope, jointBytes: joint.slice(-4).map(line => Buffer.byteLength(line)),
    jointSequence: jointSuffix.map(event => event.sequence), nearLimitSequence: overflow.map(row => row.sequence) }));
});

it('conserves the count at the schema and authenticates the stored bytes before transcript projection', async () => {
  const names = Array.from({ length: 32 }, (_, index) => String.fromCharCode(0xd800 + index).repeat(256));
  const full = pluginNamesSchema.parse({ names, omitted: safeMax - names.length });
  const countOnly = pluginNamesSchema.parse({ names: [], omitted: full.omitted + full.names.length });
  expect(countOnly).toEqual({ names: [], omitted: safeMax });
  expect(pluginNamesSchema.safeParse({ ...full, omitted: full.omitted + 1 }).success).toBe(false);
  expect(pluginNamesSchema.safeParse({ names: [...names, 'excess'], omitted: 0 }).success).toBe(false);
  expect(pluginNamesSchema.safeParse({ names: ['bad\u0000'], omitted: 1 }).success).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(full.names)) - 3 * names.length - 1).toBe(49_152);
  const { scrubWorkerEvent } = await import('../../../src/adapters/core/native-connection/internal/event-guard.js');
  const secretNames = ['n0-secret-name-first', 'n0-secret-name-second'];
  const fixture = observation(1);
  if (fixture.kind !== 'cli.observation') throw new Error('observation fixture');
  const colliding = scrubWorkerEvent({ ...fixture, observation: { ...fixture.observation, builtinPlugins: { names: secretNames, omitted: 3 } } },
    snapshotKnownSecrets(secretNames.map(value => ({ name: null, value }))));
  expect(workerEventSchema.parse(colliding)).toMatchObject({ observation: { builtinPlugins: { names: ['[REDACTED]'], omitted: 4 } } });
  const projected = nativeCallObservationSchema.parse({ ...fixture.observation, builtinPlugins: countOnly });
  expect(projected.paidExtraUsage).toEqual(fixture.observation.paidExtraUsage);
  expect(projected.cliVersion).toBe(fixture.observation.cliVersion);

  const dir = await mkdtemp('/tmp/card-n0pre/artifacts-');
  const artifacts = new FileArtifactStore({ root: dir, maxBytes: 100_000 });
  type Log = Parameters<Parameters<typeof sealAttemptWorkerEvents>[2]['saveWorkerEventLog']>[0];
  let log: Log | null = null;
  const saveWorkerEventLog = async (value: Log) => { log = value; return value; };
  const stored = [workerEventSchema.parse({ ...fixture, observation: { ...fixture.observation, builtinPlugins: full } }),
    workerEventSchema.parse({ ...fixture, sequence: 2, observation: projected })];
  const input = { events: stored, verification: null, unreported: 1, projectionComplete: true, maxBytes: 100_000 };
  expect(await sealAttemptWorkerEvents(identity, artifacts, { saveWorkerEventLog }, input)).toEqual({ status: 'sealed', eventCount: 3 });
  const read = vi.spyOn(artifacts, 'read');
  const authorizeIdentity = vi.fn(async () => {});
  const reader = new WorkerTranscriptApplication({ loadWorkerEventLog: async () => log, loadBoundDispatch: async () => null, loadRun: async () => null },
    artifacts, { authorizeIdentity });
  const principal = readLocalOsOwner();
  const result = await reader.inspect(identity, principal);
  expect(authorizeIdentity).toHaveBeenCalledWith('read-output', identity, principal);
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.events.slice(0, 2)).toEqual([{ ...stored[0], observation: projected }, stored[1]]);
  expect(result.events[2]).toMatchObject({ kind: 'dropped', reason: 'event-cap', count: 1 });
  expect(Buffer.byteLength(ndjson(result.events[0]!))).toBeLessThan(727);
  console.info('N0 name/readback', JSON.stringify({ fullNames: names.length, projectedCount: countOnly.omitted,
    scrubCollisionOmitted: 4, seal: log, projectedEvents: result.events.length }));
  const fails = async () => { throw Object.assign(new Error('fixture write failure'), { code: 'N0_FIXTURE_SAVE_FAILED' }); };
  expect(await sealAttemptWorkerEvents(identity, artifacts, { saveWorkerEventLog: fails }, input)).toEqual({
    status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED', cause: 'N0_FIXTURE_SAVE_FAILED' });
});


it('verifies the protected artifact and reopened receipt and fences late verification', async () => {
  const root = await mkdtemp('/tmp/card-n0pre/proto-receipt-');
  const path = join(root, 'ledger.db');
  const options = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
  const timing = { now: Date.now, timeoutMs: 1_000 };
  const store = await openSqliteAttemptStore(path, options, timing);
  const artifacts = new FileArtifactStore({ root, maxBytes: 32_768 });
  const fixture = observation(2);
  if (fixture.kind !== 'cli.observation') throw new Error('observation fixture');
  const protectedRow = { ...fixture, observation: { ...fixture.observation, builtinPlugins: { names: [], omitted: 3 } } };
  const input = { events: [unmapped(1)], observation: protectedRow, verification: null, unreported: 0, projectionComplete: false, maxBytes: 32_768 };
  const typedFailure = { status: 'failed', code: 'WORKER_EVENTS_SEAL_FAILED' };
  const save = vi.fn(store.saveWorkerEventLog.bind(store));
  const verifyStarted = Promise.withResolvers<Uint8Array>(), read = Promise.withResolvers<Uint8Array>();
  try {
    const timely = sealAttemptWorkerEvents(identity, { put: artifacts.put.bind(artifacts), async read(scopeId, receipt) {
      verifyStarted.resolve(await artifacts.read(scopeId, receipt));
      return read.promise;
    } }, { saveWorkerEventLog: save }, { ...input, deadline: performance.now() + 1_000 });
    const validBytes = await verifyStarted.promise;
    expect(await timely).toMatchObject(typedFailure);
    read.resolve(validBytes);
    expect(await store.loadWorkerEventLog(identity.scopeId, identity.attemptId)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(await sealAttemptWorkerEvents(identity, artifacts, { saveWorkerEventLog: async row => ({ ...row, eventCount: 0 }) }, input)).toMatchObject(typedFailure);
    expect(await sealAttemptWorkerEvents(identity, artifacts, store, input)).toEqual({ status: 'sealed', eventCount: 2 });
  } finally { store.close(); }
  const reopened = await openSqliteAttemptStore(path, options, timing, 'forbid');
  try {
    const reader = new WorkerTranscriptApplication(reopened, artifacts, { authorizeIdentity: async () => {} });
    const found = await reader.inspect(identity, readLocalOsOwner());
    expect(found.events).toEqual([unmapped(1), protectedRow]);
    expect(await reopened.loadWorkerEventLog(identity.scopeId, identity.attemptId)).toMatchObject({ identity, eventCount: 2, projection: 'partial' });
  } finally { reopened.close(); }
});
