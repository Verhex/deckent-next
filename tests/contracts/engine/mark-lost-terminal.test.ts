import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { applyAttemptObservation, createAttempt, markEffectUnknown, requestAttemptCancellation } from '#domain/index.js';
import { measureTaskOccupancy, projectDispatchTerminal } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([false, true])('keeps durable unknown across late terminal and projection (project first=%s), including reopen', async projectFirst => {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-loss-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const }, timing = { now: () => 10, timeoutMs: 1000 };
  const store = await openSqliteAttemptStore(path, options, timing, 'allow', custodyProfiles); stores.push(store);
  const identity = { runId: 'run', taskId: 'task', attemptId: 'attempt', scopeId: 's', layoutRevision: 'l', generation: 1 };
  await admitRunAttempts(store, [identity]);
  const claim = { request: { protocolVersion: 1 as const, identity, workspace: root, argv: ['fixture'] }, owner: 'lost-owner' };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  const effect = await store.claimEffect({ schemaVersion: 1,
    command: { schemaVersion: 1, commandId: 'business-effect', scopeId: 's', operation: { id: 'fixture-operation', version: 1 },
      target: { kind: 'fixture-record', id: 'record-a' }, idempotencyKey: 'effect-key', input: {}, expectedVersion: 'v1' },
    descriptor: { schemaVersion: 1, operation: { id: 'fixture-operation', version: 1 }, targetKind: 'fixture-record', effectClass: 'write',
      approval: 'policy', precondition: 'record-version', compensation: null, inputMaxBytes: 1000 },
    actor: { id: 'actor', issuer: 'test', subject: 'actor' }, idempotencyKeyHash: 'a'.repeat(64), inputDigest: 'b'.repeat(64) });
  const unknownEffect = markEffectUnknown(effect); await store.saveEffect(effect, unknownEffect);
  const current = (await store.load('s', 'attempt'))!;
  const unknown = applyAttemptObservation(current, { protocolVersion: 1, identity, sequence: (current.lastObservation?.sequence ?? 0) + 1,
    eventId: 'worker-lost', result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }, current.revision);
  await store.commit({ commandId: 'mark-lost', command: 'fixture-mark-lost', expectedRevision: current.revision, snapshot: unknown });
  const project = async () => {
    const run = (await store.loadRun('s', 'run'))!;
    return store.projectRunAttempt({ commandId: 'project-lost', actor: { id: 'actor', issuer: 'test', subject: 'actor' },
      scopeId: 's', runId: 'run', attemptId: 'attempt', expectedRevision: run.revision });
  };
  if (projectFirst) await project();
  const terminal = { handle: 'stopped-worker', exitCode: 0, interrupted: null };
  await store.finishDispatch(claim, terminal);
  if (!projectFirst) {
    // finishDispatch projects the preserved unknown in its own transaction; no stale second projection is required.
    expect((await store.loadRun('s', 'run'))!.bindings[0]!.observedKind).toBe('unknown');
  }
  expect(await store.load('s', 'attempt')).toEqual(unknown);
  const run = (await store.loadRun('s', 'run'))!;
  expect(run.bindings[0]).toMatchObject({ observedKind: 'unknown', observedRevision: unknown.revision });
  expect(run.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  expect(measureTaskOccupancy(run.progress)).toEqual({ execution: 1, inFlight: 1 });
  expect(run.state.kind).toBe('running');
  expect((await store.readDispatch(claim.request))!.terminal).toEqual(terminal);
  expect(await store.loadEffect('s', 'business-effect')).toEqual(unknownEffect);
  expect(() => projectDispatchTerminal(unknown, { ...claim, request: { ...claim.request, identity: { ...identity, generation: 2 } } }, terminal)).toThrow('DISPATCH_CONFLICT');
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = await openSqliteAttemptStore(path, options, timing, 'allow', custodyProfiles); stores.push(reopened);
  expect(await reopened.load('s', 'attempt')).toEqual(unknown);
  expect(await reopened.loadRun('s', 'run')).toEqual(run);
  expect(await reopened.loadEffect('s', 'business-effect')).toEqual(unknownEffect);
  const inventory = await reopened.listDispatches({ schemaVersion: 1, scopeId: 's', after: null, limit: 10 });
  expect(inventory.entries).toHaveLength(1); expect(inventory.entries[0]!.identity).toEqual(identity);
  expect((await reopened.finishDispatch(claim, terminal)).terminal).toEqual(terminal);
  expect(await reopened.load('s', 'attempt')).toEqual(unknown);
});

it('keeps ordinary exit projection and cancellation intent independent of the unknown hold', () => {
  const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
  const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/workspace', argv: ['fixture'] }, owner: 'owner' };
  const cancelled = requestAttemptCancellation(createAttempt(identity), 0);
  const projected = projectDispatchTerminal(cancelled, claim, { handle: 'worker', exitCode: null, signal: 'SIGTERM', interrupted: true });
  expect(projected.cancelRequested).toBe(true);
  expect(projected.lastObservation?.result).toEqual({ kind: 'exited', exitCode: null, signal: 'SIGTERM' });
  const unknown = applyAttemptObservation(cancelled, { protocolVersion: 1, identity, sequence: 1, eventId: 'lost',
    result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }, cancelled.revision);
  expect(projectDispatchTerminal(unknown, claim, { handle: 'worker', exitCode: 0, interrupted: false })).toBe(unknown);
});
