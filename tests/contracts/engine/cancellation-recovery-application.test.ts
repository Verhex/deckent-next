import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { CancellationDeliveryError, CancellationRecoveryApplication, PolicyAuthorizationError } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits = { maxAttempts: 2, retryDelayMs: 5, claimTtlMs: 10 };
const identity = (attemptId: string, scopeId = 's') => ({ scopeId, runId: 'r', taskId: attemptId, attemptId, generation: 1, layoutRevision: 'l' });

function harness(page: readonly ReturnType<typeof identity>[], options: { scopeDeny?: boolean; runDeny?: (id: string) => boolean; runError?: Error; loadError?: Error; attemptDeny?: (id: string) => boolean; concurrency?: number } = {}) {
  const calls = { scans: 0, limit: 0, verifier: 0, scopes: 0, runs: [] as string[], claims: 0, cancels: [] as string[], active: 0, maximum: 0, cancelCommands: 0 };
  const record = (value: ReturnType<typeof identity>, state: 'claimed' | 'terminal' = 'claimed') => ({ schemaVersion: 1 as const, identity: value, state,
    attempts: 1, token: 'token', claimUntil: 10, nextEligibleAt: 1, lastOutcome: state === 'terminal' ? 'terminal' as const : null });
  const store = {
    async discoverCancellationRecovery(query: { limit: number }) { calls.scans++; calls.limit = query.limit; return { identities: page, nextAfterAttemptId: null }; },
    async loadCancellationDispatch(value: ReturnType<typeof identity>) { if (options.loadError) throw options.loadError; return { request: { identity: value } } as never; },
    async claimCancellationDelivery(value: { identity: ReturnType<typeof identity> }) { calls.claims++; return { acquired: true, record: record(value.identity) }; },
    async finishCancellationDelivery(value: { identity: ReturnType<typeof identity> }) { return record(value.identity, 'terminal'); },
    async cancelRun() { calls.cancelCommands++; },
  };
  const verifier = { async verify() { calls.verifier++; return { id: 'local', issuer: 'host', subject: 'u', assurance: 'os-user', scopeIds: ['s'] }; } };
  const scope = { async authorize() { calls.scopes++; if (options.scopeDeny) throw new PolicyAuthorizationError('POLICY_DENIED'); } };
  const run = { async authorize(_action: unknown, query: { runId: string }) { calls.runs.push(query.runId); if (options.runError) throw options.runError; if (options.runDeny?.(query.runId)) throw new PolicyAuthorizationError('POLICY_DENIED'); } };
  const dispatch = {
    async authorizeCancellation(request: { identity: ReturnType<typeof identity> }) { if (options.attemptDeny?.(request.identity.attemptId)) throw new PolicyAuthorizationError('POLICY_DENIED'); },
    async cancel(request: { identity: ReturnType<typeof identity> }) { calls.cancels.push(request.identity.attemptId); calls.active++; calls.maximum = Math.max(calls.maximum, calls.active); await new Promise(resolve => setTimeout(resolve, 2)); calls.active--; return { kind: 'terminal' }; },
  };
  const app = new CancellationRecoveryApplication(store as never, verifier, scope as never, run as never, dispatch as never,
    { ...limits, maxPageSize: 2, maxConcurrentDeliveries: options.concurrency ?? 1 }, { now: () => 1, token: () => 'token' });
  return { app, calls };
}

it('authorizes scope before scanning any durable cancellation intent', async () => {
  const f = harness([identity('a')], { scopeDeny: true });
  await expect(f.app.drain({ schemaVersion: 1, scopeId: 's', afterAttemptId: null })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.calls.scans).toBe(0); expect(f.calls.claims).toBe(0); expect(f.calls.cancelCommands).toBe(0);
});

it('reauthorizes scope and Run for each bounded identity, while one denied attempt does not block another', async () => {
  const f = harness([identity('a'), identity('b')], { attemptDeny: id => id === 'a', concurrency: 1 });
  const result = await f.app.drain({ schemaVersion: 1, scopeId: 's', afterAttemptId: null });
  expect(f.calls).toMatchObject({ scans: 1, limit: 2, verifier: 3, scopes: 3, runs: ['r', 'r'], claims: 1, cancels: ['b'], maximum: 1, cancelCommands: 0 });
  expect(result.outcomes.map(value => value.outcome.status)).toEqual(['denied', 'terminal']);
});

it('denies a Run before claiming delivery or consuming its retry budget', async () => {
  const f = harness([identity('a')], { runDeny: () => true });
  const result = await f.app.drain({ schemaVersion: 1, scopeId: 's', afterAttemptId: null });
  expect(result.outcomes[0]!.outcome.status).toBe('denied'); expect(result.outcomes[0]!.reason).toBe('POLICY_DENIED'); expect(f.calls.claims).toBe(0); expect(f.calls.cancels).toEqual([]); expect(f.calls.cancelCommands).toBe(0);
});

it.each([
  [new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'), 'CANCELLATION_DELIVERY_CORRUPT'],
  [new Error('secret=/tmp/private-token'), 'UNKNOWN'],
] as const)('reports a bounded recovery reason for identity failures without exposing exception text', async (error, reason) => {
  const f = harness([identity('a')], { runError: error }); const result = await f.app.drain({ schemaVersion: 1, scopeId: 's', afterAttemptId: null });
  expect(result.outcomes[0]!.outcome.status).toBe('unavailable'); expect(result.outcomes[0]!.reason).toBe(reason);
  expect(JSON.stringify(result)).not.toContain('secret=/tmp/private-token'); expect(f.calls.claims).toBe(0); expect(f.calls.cancels).toEqual([]);
});

it.each(['wrong-scope', 'duplicate', 'oversized'] as const)('fails closed for a %s recovery page before dispatching', async kind => {
  const page = kind === 'wrong-scope' ? [identity('a', 'foreign')] : kind === 'duplicate' ? [identity('a'), identity('a')] : [identity('a'), identity('b'), identity('c')];
  const f = harness(page);
  await expect(f.app.drain({ schemaVersion: 1, scopeId: 's', afterAttemptId: null })).rejects.toMatchObject({ code: 'CANCELLATION_DELIVERY_CORRUPT' });
  expect(f.calls.claims).toBe(0); expect(f.calls.cancels).toEqual([]);
});

it('persists terminal recovery once in SQLite, so a retry drain finds no work and creates no cancellation command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cancellation-recovery-app-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, 'allow', custodyProfiles); stores.push(store);
  const attempt = identity('a'); await admitRunAttempts(store, [attempt]);
  await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity: attempt, workspace: '/recorded', argv: ['recorded'] } }));
  await store.cancelRun({ commandId: 'intent', actor: { id: 'operator', issuer: 'test', subject: 'u' }, scopeId: 's', runId: 'r', expectedRevision: 1 });
  let cancels = 0;
  const app = new CancellationRecoveryApplication(store, { async verify() { return { id: 'local', issuer: 'host', subject: 'u', assurance: 'os-user', scopeIds: ['s'] }; } },
    { async authorize() {} }, { async authorize() {} }, { async authorizeCancellation() {}, async cancel() { cancels++; return { kind: 'terminal' }; } } as never,
    { ...limits, maxPageSize: 2, maxConcurrentDeliveries: 1 }, { now: () => 1, token: () => 'recovery-token' });
  const input = { schemaVersion: 1 as const, scopeId: 's', afterAttemptId: null };
  expect((await app.drain(input)).outcomes[0]!.outcome.status).toBe('terminal');
  expect((await app.drain(input)).outcomes).toEqual([]); expect(cancels).toBe(1);
});

it.each([
  [new CancellationDeliveryError('CANCELLATION_DELIVERY_CORRUPT'), 'CANCELLATION_DELIVERY_CORRUPT'],
  [new Error('secret=/tmp/private-token'), 'UNKNOWN'],
] as const)('preserves safe failure identity from inside the shared delivery worker', async (error, reason) => {
  const f = harness([identity('a')], { loadError: error });
  const result = await f.app.drain({ schemaVersion: 1, scopeId: 's', afterAttemptId: null });
  expect(result.outcomes[0]!.outcome.status).toBe('unavailable');
  expect(result.outcomes[0]!.reason).toBe(reason);
  expect(JSON.stringify(result)).not.toContain('private-token');
  expect(f.calls.claims).toBe(0); expect(f.calls.cancels).toEqual([]);
});
