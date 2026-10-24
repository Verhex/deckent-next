import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nervousPrincipalRef, type AttemptIdentity, type EffectIntent } from '#domain/index.js';
import { AuditApplication, LostDispatchApplication, nervousCaseId } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { admitRunAttempts } from './admission.js';
import { custodyPrincipal, custodyProfiles, dispatchAdmission, grantTestLaunch } from './custody.js';

/**
 * S6R-4 fixture: a real ledger whose one task lost its worker and had its slot released with a termination proof (MARK-LOST-ATOMIC through the
 * existing LostDispatchApplication: fence, then `supervisor-exit` of the retained incarnation), plus the sealed Nervous `recovery-detection` the
 * recovery case opens from. Nothing here opens an Attempt.
 */
export const LEDGER_OPTIONS = { busyTimeoutMs: 200, journalMode: 'wal' as const, durability: 'full' as const };
export const LOST_TIMING = { now: () => 10, timeoutMs: 1000 };
export const lostIntegrity = createHmacIntegrity('fixture', randomBytes(32));
export const owner = { id: 'owner', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export async function openLostLedger(roots: string[], stores: SqliteAttemptStore[]) {
  const root = await mkdtemp(join(tmpdir(), 'dn-recovery-')); roots.push(root);
  const path = join(root, 'ledger.db'), store = await openSqliteAttemptStore(path, LEDGER_OPTIONS, LOST_TIMING, 'allow', custodyProfiles); stores.push(store);
  return { root, path, store };
}
/** Claims, grants and loses one Attempt: fenced and released with the exit proof of its retained incarnation (exit 137). */
export async function loseAttempt(store: SqliteAttemptStore, root: string, identity: AttemptIdentity, owner = `owner-${identity.attemptId}`, exitCode = 137) {
  const claim = { request: { protocolVersion: 1 as const, identity, workspace: root, argv: ['fixture'] }, owner };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  const worker = { kind: 'container' as const, id: digest(identity.attemptId), startedAt: '2026-10-23T10:00:00.000000001Z' };
  await store.retainDispatchWorker(claim, worker);
  const app = new LostDispatchApplication(store, { async verify() { return custodyPrincipal; } }, { async authorizeIdentity() {} },
    { async observe() { return { handle: 'worker', result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }; },
      async termination() { return { kind: 'supervisor-exit', worker, result: { exitCode } }; } },
    target => new AuditApplication(target, lostIntegrity), 'fixture-policy', () => 20);
  const run = (await store.loadRun(identity.scopeId, identity.runId))!, attempt = (await store.load(identity.scopeId, identity.attemptId))!;
  const released = await app.recover({ schemaVersion: 1, identity, expectedRunRevision: run.revision, expectedAttemptRevision: attempt.revision });
  if (released.decision.kind !== 'release') throw new Error('FIXTURE_NOT_RELEASED');
  return { claim, worker, run: released.receipt.snapshot };
}
/** Seals the Nervous detection of one lost Attempt (what S6R-2/3 writes) and returns its case id. */
export async function sealDetection(path: string, identity: AttemptIdentity, ruleId = 'launcher-dead-orphan', integrity = lostIntegrity,
  disposition: 'execute' | 'shadow-only' | 'proposal-only' = 'execute') {
  const caseId = nervousCaseId(identity.scopeId, ruleId, { kind: 'attempt', identity });
  const store = await openSqliteAuditStore(path, LEDGER_OPTIONS);
  try {
    new AuditApplication(store, integrity).record({ schemaVersion: 1, eventId: `recovery-detection:${caseId}`, scopeId: identity.scopeId,
      principal: nervousPrincipalRef(owner), policyRevision: 'fixture-policy', atMs: 5, subject: { kind: 'recovery-detection', caseId,
        rule: { id: ruleId, version: 1, status: disposition === 'execute' ? 'live' : 'provisional' }, registryRevision: 'core-2026-10-23', action: 'stop-orphan', disposition,
        target: { runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId, generation: identity.generation },
        evidence: { activity: 'running', launcher: 'dead', launcherPhase: 'dispatch', absentObservations: 0, absentForMs: null, unavailableForMs: null,
          containerRecorded: true, workerRecorded: true, source: null }, evidenceDigest: digest(`evidence:${caseId}`), ...(disposition === 'execute' ? { standingRef: 'nervous-standing' } : {}) } });
  } finally { store.close(); }
  return caseId;
}
/** One released lost task on a Run admitted with (or, `recovery: null`, without) frozen recovery bounds. */
export async function releasedLostTask(roots: string[], stores: SqliteAttemptStore[], recovery: unknown) {
  const { root, path, store } = await openLostLedger(roots, stores);
  const identity: AttemptIdentity = { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'attempt-1', layoutRevision: 'layout', generation: 1 };
  await admitRunAttempts(store, [identity], recovery === null ? {} : { recovery });
  const lost = await loseAttempt(store, root, identity);
  return { root, path, store, identity, ...lost };
}
/** alpha.56 G1: one task whose worker was granted its launch and still runs (Nervous shadow stopped nothing): the would-stop input. */
export async function grantedTask(roots: string[], stores: SqliteAttemptStore[], recovery: unknown) {
  const { root, path, store } = await openLostLedger(roots, stores);
  const identity: AttemptIdentity = { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'attempt-1', layoutRevision: 'layout', generation: 1 };
  await admitRunAttempts(store, [identity], recovery === null ? {} : { recovery });
  const claim = { request: { protocolVersion: 1 as const, identity, workspace: root, argv: ['fixture'] }, owner: 'owner-attempt-1' };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  return { root, path, store, identity, run: (await store.loadRun(identity.scopeId, identity.runId))! };
}
/** An effect intent as the store records it; `producer` absent = a row written before S6R-1 (inserted raw, the store refuses it now). */
export function effectIntent(commandId: string, input: { producer?: EffectIntent['producer']; idempotencyKey?: string; idempotencyScope?: 'task' | 'command'; target?: string; scopeId?: string } = {}): EffectIntent {
  const scopeId = input.scopeId ?? 's', key = input.idempotencyKey ?? `key-${commandId}`;
  const descriptor = { schemaVersion: 1 as const, operation: { id: 'record.write', version: 1 }, targetKind: 'record', effectClass: 'write' as const, approval: 'policy' as const,
    precondition: 'none' as const, compensation: null, inputMaxBytes: 4096, ...(input.idempotencyScope ? { idempotencyScope: input.idempotencyScope } : {}) };
  return { schemaVersion: 1, command: { schemaVersion: 1, commandId, scopeId, operation: descriptor.operation, target: { kind: 'record', id: input.target ?? `item-${commandId}` },
    idempotencyKey: key, input: null, expectedVersion: null }, descriptor, actor: { id: 'author', issuer: 'test', subject: 'fixture' },
    idempotencyKeyHash: digest(`${scopeId}\0${key}`), inputDigest: digest('input'), ...(input.producer ? { producer: input.producer } : {}) };
}
