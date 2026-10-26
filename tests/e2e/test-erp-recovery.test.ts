import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { RECOVERY_DECISION_SEED, RECOVERY_POLICY_SEED, assessRecoveryEffectGate, freezeRecoveryPolicy, loadRecoveryPolicy, recoveryPrincipal,
  type AttemptIdentity, type EffectCommand, type OperationDescriptor } from '#domain/index.js';
import { AuditApplication, EffectApplication, OperationPolicyAuthorization, RecoveryApplication, RecoveryDecisionApplication, recoveryContinuationApproval,
  refuseRequiredApproval, taskScopedIdempotencyKey, type RecoveryModelRequest } from '#engine/index.js';
import { HttpConditionalEffectTarget, LocalOsSessionAuthority, openSqliteRecoveryStore, type SqliteAttemptStore } from '#adapters/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { admitRunAttempts } from '../contracts/support/admission.js';
import { LEDGER_OPTIONS, loseAttempt, lostIntegrity, openLostLedger, owner, sealDetection } from '../contracts/support/lost-task.js';
import config from '../fixtures/test-erp/config.json' with { type: 'json' };
import { fixtureAvailability } from '../fixtures/test-erp/availability.js';
import { startTestErp } from '../fixtures/test-erp/server.js';

// alpha.56 R-DESIGN §G5 items 6/7 (owner Q-A8: host-lane e2e with the real test-ERP fixture): a lost worker's write to the test ERP meets the recovery
// gate. The loopback HTTP server, the http-conditional target adapter, the SQLite ledger and the recovery applications are real. No product composition
// stamps an Attempt producer on an effect today (every surface uses PRINCIPAL_EFFECT_PRODUCER), so the worker's EffectApplication is built here with
// `producer: { kind: 'attempt' }` — the one input the gate reads (S6R-1).
const roots: string[] = [], stores: SqliteAttemptStore[] = [], closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close(); for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const policy = freezeRecoveryPolicy(loadRecoveryPolicy(RECOVERY_POLICY_SEED), 'live', ['task']);
const recovery = recoveryPrincipal(owner, ['s']);
const standing = { schemaVersion: 1, revision: 'owner-policy', restrictions: [], grants: [{ id: 'recovery-standing', effect: 'allow', actions: ['apply'], scopes: ['s'],
  principals: [{ issuer: owner.issuer, subject: owner.subject }], resource: { kind: 'recovery-action', ids: ['continue-new-attempt'] } }] };
const allow = new OperationPolicyAuthorization({ load: async () => ({ schemaVersion: 1, revision: 'p', restrictions: [],
  grants: [{ id: 'all', effect: 'allow', principals: 'all', scopes: ['s'], actions: 'all', resource: { kind: 'operation', ids: 'all' } }] }) });
const lost: AttemptIdentity = { scopeId: 's', runId: 'run', taskId: 'task', attemptId: 'attempt-1', layoutRevision: 'layout', generation: 1 };
const approve = (idempotencyScope?: 'task'): OperationDescriptor => ({ schemaVersion: 1, operation: config.operations.approve, targetKind: config.targetKind, effectClass: 'write',
  approval: 'policy', precondition: 'record-version', compensation: null, inputMaxBytes: config.http.inputMaxBytes, ...(idempotencyScope ? { idempotencyScope } : {}) });

async function harness(descriptor: OperationDescriptor) {
  const server = await startTestErp(); closers.push(server.close);
  const { root, path, store } = await openLostLedger(roots, stores);
  await admitRunAttempts(store, [lost], { recovery: policy });
  const clock = { sample: () => ({ wallMs: 1_000, monotonicMs: 1_000 }) };
  const sessions = await LocalOsSessionAuthority.create(['s'], 600_000, clock);
  const target = new HttpConditionalEffectTarget({ kind: config.targetKind, baseUrl: server.baseUrl, timeoutMs: config.http.timeoutMs,
    responseMaxBytes: config.http.responseMaxBytes, idempotencyLookup: true });
  /** The worker of one Attempt: its effects carry that Attempt as producer. */
  const worker = (identity: AttemptIdentity) => new EffectApplication({ resolve: async () => descriptor }, { resolve: kind => kind === config.targetKind ? target : null },
    store, refuseRequiredApproval, sessions, allow, clock, { producer: { kind: 'attempt', identity } });
  const command = (commandId: string, idempotencyKey: string): EffectCommand => ({ schemaVersion: 1, commandId, scopeId: 's', operation: config.operations.approve,
    target: { kind: config.targetKind, id: config.recordId }, idempotencyKey, input: { status: config.approvedStatus }, expectedVersion: server.etag(server.current().version) });
  const cases = openSqliteRecoveryStore(path, LEDGER_OPTIONS); closers.push(() => cases.close());
  const audit = await openSqliteAuditStore(path, LEDGER_OPTIONS); closers.push(() => audit.close());
  const holds: unknown[] = [], ledger = new AuditApplication(audit, lostIntegrity), verifier = { async verify() { return recovery; } };
  const approval = async (scopeId: string) => recoveryContinuationApproval(standing, owner, scopeId, 30);
  const app = new RecoveryApplication({ store: cases, detections: ledger, recorder: next => new AuditApplication(next, lostIntegrity), approval,
    hold: async hold => { holds.push(hold); return null; }, isolation: async () => ({ schemaVersion: 1, network: 'none', egress: { kind: 'none' } }), policyRevision: 'owner-policy', now: () => 30, timeoutMs: 1000 }, verifier);
  const rows = (sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  return { server, root, path, store, worker, command, cases, ledger, holds, app, approval, verifier, rows };
}
const ref = (caseId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, scopeId: 's', caseId, ...extra });
const available = () => process.platform === 'linux' && fixtureAvailability().status === 'available';

it.skipIf(!available())('[requires Linux /proc session + loopback] item 6: a late ERP reply after the worker was lost settles by lookup; the gate reconciles it as task-idempotent and the continued Attempt\'s repeat writes nothing', async () => {
  const h = await harness(approve('task'));
  const key = taskScopedIdempotencyKey(lost.taskId, config.operations.approve, { kind: config.targetKind, id: config.recordId });
  const write = h.command('po-approve', key);
  // The worker's write is held by the ERP past the client deadline: unknown, not refused, not resent.
  h.server.faults.replyLate = true;
  await expect(h.worker(lost).execute(write)).rejects.toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN' });
  // The worker is lost and its slot released with proof; then the held write lands at the ERP and its reply reaches nobody.
  await loseAttempt(h.store, h.root, lost);
  expect(await h.server.releaseLate()).toMatchObject({ status: 200, clientGone: true });
  expect(h.server.writes).toHaveLength(1);
  // Before reconciliation the gate is open: the ledger still says unknown.
  expect(assessRecoveryEffectGate(lost, await h.cases.listGateEffects(lost, 16), policy)).toMatchObject({ result: 'open', intents: [{ commandId: 'po-approve', state: 'unknown' }] });
  // Reconciliation re-drives the same command under the same producer: the ERP idempotency record settles it, no second POST.
  expect(await h.worker(lost).execute(write)).toMatchObject({ status: 'settled', evidence: 'idempotency-record', version: h.server.etag(config.initialVersion + 1) });
  expect(h.server.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  const caseId = await sealDetection(h.path, lost);
  const gated = await h.app.assess(ref(caseId));
  expect(gated).toMatchObject({ state: 'gated', gate: { result: 'reconciled', settled: 'task-idempotent',
    facts: [{ commandId: 'po-approve', target: { kind: config.targetKind, id: config.recordId }, version: h.server.etag(config.initialVersion + 1) }] } });
  expect((await h.app.continueLostTask(ref(caseId, { evidenceDigest: gated.evidenceDigest, causeClass: 'infra-transient' }))).kind).toBe('continued');
  // The continued Attempt repeats the work with the same task-scoped key: one record, one ERP write.
  const next: AttemptIdentity = { ...lost, attemptId: 'attempt-2', generation: 2 };
  await expect(h.worker(next).execute(h.command('po-approve-2', key))).rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
  expect(h.server.writes).toHaveLength(1); expect(h.rows('SELECT count(*) AS n FROM effect_intents')).toEqual([{ n: 1 }]);
});

it.skipIf(!available())('[requires Linux /proc session + loopback] item 7: settled ERP work of an operation without task-scoped idempotency escalates to a person with no model call', async () => {
  const h = await harness(approve());
  expect(await h.worker(lost).execute(h.command('po-approve', 'po-approve-key'))).toMatchObject({ status: 'settled' });
  expect(h.server.writes).toHaveLength(1);
  await loseAttempt(h.store, h.root, lost);
  const caseId = await sealDetection(h.path, lost), calls: RecoveryModelRequest[] = [];
  const decision = new RecoveryDecisionApplication({ recovery: { prepare: (...args) => h.app.prepare(...args), escalate: (...args) => h.app.escalate(...args),
    assess: (...args) => h.app.assess(...args), continueLostTask: (...args) => h.app.continueLostTask(...args) },
  store: h.cases, seals: h.ledger, approval: h.approval, owner: { issuer: owner.issuer, subject: owner.subject }, policyRevision: 'owner-policy', registry: RECOVERY_DECISION_SEED, now: () => 40,
  models: { rows: async () => [{ channelId: 'channel-a', modelId: 'model-a', invocable: true, billing: 'metered', consent: null }],
    invoke: async request => { calls.push(request); throw new Error('no model call expected'); } } }, h.verifier);
  expect(await decision.decide({ schemaVersion: 1, scopeId: 's', caseId, mode: 'live' }))
    .toMatchObject({ kind: 'escalated', case: { state: 'escalated', gate: { result: 'reconciled', settled: 'not-declared' }, decision: { action: 'escalate-human', code: 'settled-not-idempotent' } } });
  expect(calls).toEqual([]); expect(h.holds).toHaveLength(1);
  expect((await h.store.loadRun('s', 'run'))!.progress[0]).toMatchObject({ phase: 'reconciling' });
  expect(h.server.writes).toHaveLength(1);
});
