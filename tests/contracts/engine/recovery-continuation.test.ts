import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { RECOVERY_POLICY_SEED, freezeRecoveryPolicy, loadRecoveryPolicy, mcpPrincipalRef, nervousPrincipalRef, recoveryPrincipal, effectRecordSchema,
  type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
import { AuditApplication, RecoveryApplication, recoveryContinuationApproval, taskScopedIdempotencyKey } from '#engine/index.js';
import { openSqliteRecoveryStore, type SqliteAttemptStore } from '#adapters/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { LEDGER_OPTIONS, effectIntent, loseAttempt, lostIntegrity, owner, releasedLostTask, sealDetection } from '../support/lost-task.js';

// S6R-4 (S6R-DESIGN §7 steps 4–6, §8, §9, §10; owner Q-R1/Q-R3/Q-R5; lead notes on s6r3 Q3/Q4): `continueLostTask` is the one application that opens
// a new Attempt for a lost worker — only for the recovery principal, under the owner's standing grant, after the slot was released with proof,
// with every effect of the lost Attempt settled (re-checked in the writer transaction) and within the frozen registry bounds. It never calls a
// model (S6R-5) and never re-sends an effect. Every refusal writes nothing; every escalation is a sealed case plus a hold for a person.
const roots: string[] = [], stores: SqliteAttemptStore[] = [], closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close(); for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const policy = freezeRecoveryPolicy(loadRecoveryPolicy(RECOVERY_POLICY_SEED));
const recovery = recoveryPrincipal(owner, ['s']);
const grant = (ids: readonly string[] | 'all' = ['continue-new-attempt']) => ({ schemaVersion: 1, revision: 'owner-policy', restrictions: [], grants: [
  { id: 'recovery-standing', effect: 'allow', actions: ['apply'], scopes: ['s'], principals: [{ issuer: owner.issuer, subject: owner.subject }], resource: { kind: 'recovery-action', ids } }] });

async function harness(input: { recovery?: unknown } = {}) {
  const f = await releasedLostTask(roots, stores, input.recovery === undefined ? policy : input.recovery);
  const caseId = await sealDetection(f.path, f.identity);
  const cases = openSqliteRecoveryStore(f.path, LEDGER_OPTIONS); closers.push(() => cases.close());
  const audit = await openSqliteAuditStore(f.path, LEDGER_OPTIONS); closers.push(() => audit.close());
  const state = { document: grant() as unknown, principal: recovery as VerifiedPrincipal };
  const holds: unknown[] = [];
  const app = new RecoveryApplication({ store: cases, detections: new AuditApplication(audit, lostIntegrity), recorder: target => new AuditApplication(target, lostIntegrity),
    approval: async scopeId => recoveryContinuationApproval(state.document, owner, scopeId, 30), hold: async command => { holds.push(command); return null; },
    policyRevision: 'owner-policy', now: () => 30, timeoutMs: 1000 }, { async verify() { return state.principal; } });
  const rows = (sql: string) => { const db = new DatabaseSync(f.path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const events = () => rows("SELECT record FROM audit_events WHERE kind='run-lifecycle' ORDER BY sequence").map(row => JSON.parse(String(row['record'])).event.subject);
  const caseRows = () => rows('SELECT state,revision FROM recovery_cases ORDER BY case_id');
  const claim = (commandId: string, extra: Parameters<typeof effectIntent>[1] = {}) => f.store.claimEffect(effectIntent(commandId, { producer: { kind: 'attempt', identity: f.identity }, ...extra }));
  return { ...f, caseId, app, state, holds, events, cases: caseRows, claim, rows };
}
const command = (caseId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, scopeId: 's', caseId, ...extra });

it('assess → continue: one gated case, then the task returns to pending with one sealed system event; the next generation takes the slot', async () => {
  const h = await harness(), before = (await h.store.readPoolHold('fixture-pool')).occupancy;
  const gated = await h.app.assess(command(h.caseId));
  expect(gated).toMatchObject({ state: 'gated', caseId: h.caseId, identity: h.identity, gate: { result: 'clear', settled: 'none' },
    termination: { kind: 'supervisor-exit', exitCode: 137 }, detection: { ruleId: 'launcher-dead-orphan', ruleVersion: 1 } });
  expect(await h.app.assess(command(h.caseId))).toEqual(gated); // replay: one row
  const outcome = await h.app.continueLostTask(command(h.caseId, { evidenceDigest: gated.evidenceDigest, causeClass: 'infra-transient' }));
  expect(outcome.kind).toBe('continued');
  if (outcome.kind !== 'continued') throw new Error('not continued');
  expect(outcome.case).toMatchObject({ state: 'applied', decision: { action: 'continue-new-attempt', causeClass: 'infra-transient', standingRef: 'recovery-standing' } });
  expect(outcome.run.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: false });
  expect(outcome.run.previousBindings).toEqual([expect.objectContaining({ observedKind: 'lost', recoveryDecisionId: outcome.case.decision!.decisionId })]);
  expect(await h.store.loadRun('s', 'run')).toEqual(outcome.run);
  expect(h.events().map(event => [event.action, event.deciderClass ?? null, event.decisionRuleId ?? null])).toEqual([
    ['hold', null, null], ['release-worker-custody', null, null], ['continue-lost-task', 'system', 'recovery-standing']]);
  expect(before).toEqual({ execution: 0, inFlight: 0 }); expect((await h.store.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 0, inFlight: 0 });
  const next = { ...h.identity, attemptId: 'attempt-2', generation: 2 };
  await h.store.reserveRunTasks({ commandId: 'reserve-2', actor: { id: 'fixture', issuer: 'test', subject: 'service' }, scopeId: 's', runId: 'run', expectedRevision: outcome.run.revision, now: 31, identities: [next] });
  expect((await h.store.readPoolHold('fixture-pool')).occupancy).toEqual({ execution: 1, inFlight: 1 });
  // Duplicate continuation: the sealed case replays, nothing is written twice; a different decision for the same case conflicts.
  const replay = await h.app.continueLostTask(command(h.caseId, { evidenceDigest: gated.evidenceDigest, causeClass: 'infra-transient' }));
  expect(replay).toMatchObject({ kind: 'continued', case: outcome.case });
  await expect(h.app.continueLostTask(command(h.caseId, { evidenceDigest: gated.evidenceDigest, causeClass: 'unknown' }))).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' });
  expect(h.events()).toHaveLength(3); expect(h.cases()).toEqual([{ state: 'applied', revision: 2 }]); expect(h.holds).toEqual([]);
});

it('N14: only the recovery principal may assess or continue (owner, Nervous, MCP refused); nothing is written', async () => {
  const h = await harness();
  for (const principal of [owner, { ...owner, ...nervousPrincipalRef(owner), assurance: 'workload-verified' as const }, { ...owner, ...mcpPrincipalRef(owner), assurance: 'token-verified' as const }]) {
    h.state.principal = principal;
    await expect(h.app.assess(command(h.caseId))).rejects.toMatchObject({ code: 'RECOVERY_PRINCIPAL_REQUIRED' });
  }
  h.state.principal = { ...recovery, scopeIds: ['other'] };
  await expect(h.app.assess(command(h.caseId))).rejects.toMatchObject({ code: expect.stringMatching(/^(RECOVERY_PRINCIPAL_REQUIRED|AUTHENTICATION_SCOPE_DENIED|AUTH.*)$/) });
  expect(h.cases()).toEqual([]);
});

it('revoked standing grant: the gated case stays gated, the Run is untouched; N27: a Run without frozen bounds opens no case', async () => {
  const h = await harness(), gated = await h.app.assess(command(h.caseId)), run = await h.store.loadRun('s', 'run');
  h.state.document = grant(['fence-attempt']);
  await expect(h.app.continueLostTask(command(h.caseId, { evidenceDigest: gated.evidenceDigest, causeClass: 'infra-transient' }))).rejects.toMatchObject({ code: 'RECOVERY_NOT_APPROVED' });
  expect(await h.store.loadRun('s', 'run')).toEqual(run); expect(h.cases()).toEqual([{ state: 'gated', revision: 1 }]);
  const off = await harness({ recovery: null });
  await expect(off.app.assess(command(off.caseId))).rejects.toMatchObject({ code: 'RECOVERY_OFF' });
  expect(off.cases()).toEqual([]);
});

it('stale case: a decision that does not echo the sealed evidence digest is refused; an unknown case is not found', async () => {
  const h = await harness(); await h.app.assess(command(h.caseId));
  await expect(h.app.continueLostTask(command(h.caseId, { evidenceDigest: 'e'.repeat(64), causeClass: 'infra-transient' }))).rejects.toMatchObject({ code: 'RECOVERY_STALE' });
  await expect(h.app.continueLostTask(command('f'.repeat(64), { evidenceDigest: 'e'.repeat(64), causeClass: 'infra-transient' }))).rejects.toMatchObject({ code: 'RECOVERY_NOT_FOUND' });
  expect(h.cases()).toEqual([{ state: 'gated', revision: 1 }]);
});

it('N1/N24: an unsettled effect of the lost Attempt, or a legacy open intent in the scope, seals the case escalated and holds the Run for a person', async () => {
  const h = await harness(); await h.claim('open-1');
  const escalated = await h.app.assess(command(h.caseId));
  expect(escalated).toMatchObject({ state: 'escalated', gate: { result: 'open' }, decision: { action: 'escalate-human', code: 'effects-open' } });
  const hold = { schemaVersion: 1, scopeId: 's', runId: 'run', commandId: `recovery-hold:${h.caseId}`, holdReason: `recovery:effects-open:${h.caseId.slice(0, 12)}` };
  expect(h.holds).toEqual([hold]);
  // A crash between the sealed escalation and its hold: the replayed assess re-issues the same idempotent hold, nothing else.
  expect(await h.app.assess(command(h.caseId))).toEqual(escalated); expect(h.holds).toEqual([hold, hold]); expect(h.cases()).toEqual([{ state: 'escalated', revision: 2 }]);
  await expect(h.app.continueLostTask(command(h.caseId, { evidenceDigest: escalated.evidenceDigest, causeClass: 'infra-transient' }))).rejects.toMatchObject({ code: 'RECOVERY_STALE' });
  expect((await h.store.loadRun('s', 'run'))!.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  const legacy = await harness(), db = new DatabaseSync(legacy.path);
  try { // a row as written before S6R-1 (no producer); the store refuses such a claim now, so it is inserted raw
    const old = effectRecordSchema.parse({ intent: effectIntent('legacy'), sequence: 1, state: 'unknown', evidence: null, refusal: null });
    db.prepare('INSERT INTO effect_intents(scope_id,command_id,target_kind,target_id,sequence,idempotency_key_hash,state,record) VALUES(?,?,?,?,?,?,?,?)')
      .run('s', 'legacy', 'record', 'item-legacy', 1, old.intent.idempotencyKeyHash, 'unknown', JSON.stringify(old));
  } finally { db.close(); }
  expect(await legacy.app.assess(command(legacy.caseId))).toMatchObject({ state: 'escalated', gate: { result: 'open', intents: [{ commandId: 'legacy', producer: 'legacy' }] } });
});

it('N2: an intent that appears between assess and continue is caught by the writer re-check: no continuation, the case escalates', async () => {
  const h = await harness(), gated = await h.app.assess(command(h.caseId)); expect(gated.state).toBe('gated');
  await h.claim('late-1');
  const outcome = await h.app.continueLostTask(command(h.caseId, { evidenceDigest: gated.evidenceDigest, causeClass: 'infra-transient' }));
  expect(outcome).toMatchObject({ kind: 'escalated', case: { state: 'escalated', decision: { code: 'effects-open' } } });
  expect((await h.store.loadRun('s', 'run'))!.progress[0]).toMatchObject({ phase: 'reconciling' });
  expect(h.events().map(event => event.action)).toEqual(['hold', 'release-worker-custody']); expect(h.holds).toHaveLength(1);
});

it('N22: settled work of an operation without task-scoped idempotency escalates; N3/N23: task-idempotent settled work continues as a fact and its repeat stays one record', async () => {
  const plain = await harness(), done = await plain.claim('done');
  await plain.store.saveEffect(done, effectRecordSchema.parse({ ...done, state: 'settled', evidence: { kind: 'idempotency-record', version: 'v2', observedAt: 9 } }));
  expect(await plain.app.assess(command(plain.caseId))).toMatchObject({ state: 'escalated', decision: { code: 'settled-not-idempotent' } });
  const h = await harness(), operation = { id: 'record.write', version: 1 }, target = { kind: 'record', id: 'po-1' };
  const key = taskScopedIdempotencyKey(h.identity.taskId, operation, target);
  expect(taskScopedIdempotencyKey(h.identity.taskId, operation, target)).toBe(key); // never derived from the Attempt
  expect(taskScopedIdempotencyKey('other-task', operation, target)).not.toBe(key);
  // N3: the late reply of the test target settles the old intent after the fence; the gate sees `settled`.
  const late = await h.claim('po-write', { idempotencyKey: key, idempotencyScope: 'task', target: 'po-1' });
  await h.store.saveEffect(late, effectRecordSchema.parse({ ...late, state: 'settled', evidence: { kind: 'idempotency-record', version: 'v2', observedAt: 9 } }));
  const gated = await h.app.assess(command(h.caseId));
  expect(gated).toMatchObject({ state: 'gated', gate: { result: 'reconciled', settled: 'task-idempotent', facts: [{ commandId: 'po-write', target }] } });
  expect((await h.app.continueLostTask(command(h.caseId, { evidenceDigest: gated.evidenceDigest, causeClass: 'infra-transient' }))).kind).toBe('continued');
  // The new Attempt produces the same task-scoped key: its repeat cannot become a second record.
  const next: AttemptIdentity = { ...h.identity, attemptId: 'attempt-2', generation: 2 };
  await expect(h.store.claimEffect(effectIntent('po-write-2', { producer: { kind: 'attempt', identity: next }, idempotencyKey: key, idempotencyScope: 'task', target: 'po-1' })))
    .rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
  expect(h.rows('SELECT count(*) AS n FROM effect_intents')).toEqual([{ n: 1 }]);
});

it('second loss of a continued task: a new case for the new Attempt escalates at the per-task bound (1), never a 3rd automatic Attempt', async () => {
  const h = await harness(), gated = await h.app.assess(command(h.caseId));
  const first = await h.app.continueLostTask(command(h.caseId, { evidenceDigest: gated.evidenceDigest, causeClass: 'infra-transient' }));
  if (first.kind !== 'continued') throw new Error('not continued');
  const next: AttemptIdentity = { ...h.identity, attemptId: 'attempt-2', generation: 2 };
  await h.store.reserveRunTasks({ commandId: 'reserve-2', actor: { id: 'fixture', issuer: 'test', subject: 'service' }, scopeId: 's', runId: 'run', expectedRevision: first.run.revision, now: 31, identities: [next] });
  await loseAttempt(h.store, h.root, next);
  const second = await sealDetection(h.path, next);
  expect(await h.app.assess(command(second))).toMatchObject({ state: 'escalated', identity: next, decision: { code: 'continuation-bound' } });
  expect(h.holds).toEqual([expect.objectContaining({ commandId: `recovery-hold:${second}`, holdReason: `recovery:continuation-bound:${second.slice(0, 12)}` })]);
  expect((await h.store.loadRun('s', 'run'))!.previousBindings).toHaveLength(1);
});

it('not ready: a detection whose slot was not released with proof, or that names no Attempt of this Run, opens no case', async () => {
  const h = await harness(), stranger = { ...h.identity, attemptId: 'stranger' };
  await expect(h.app.assess(command(await sealDetection(h.path, stranger)))).rejects.toMatchObject({ code: 'RECOVERY_NOT_READY' });
  await expect(h.app.assess(command('0'.repeat(64)))).rejects.toMatchObject({ code: 'RECOVERY_NOT_FOUND' });
  expect(h.cases()).toEqual([]);
});
