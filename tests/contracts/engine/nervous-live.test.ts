import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RECOVERY_ACTIONS, type AttemptIdentity, type AuditEvent, type DispatchLossDecision } from '#domain/index.js';
import { AuditApplication, NERVOUS_RULES_SEED, NervousApplication, nervousExecutors, nervousStandingApproval, type NervousAttemptSignal, type NervousRecoveryPorts } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';

// S6R-3 (S6R-DESIGN §7 steps 1–3, §10; owner Q-R1/Q-R4/Q-R5; lead notes on s6r1/s6 questions): the broker executes a sealed Nervous proposal
// only in `live`, for a measured rule, under the owner's standing policy grant, through the existing applications (fence → stop → release
// with proof; no proof → a person). Nothing here opens an Attempt, calls a model or retries a worker.
const roots: string[] = [], closers: (() => void)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('audit-key', randomBytes(32));
const seed = NERVOUS_RULES_SEED as { rules: { id: string; status: string; [key: string]: unknown }[]; [key: string]: unknown };
const liveRules = { ...seed, rules: seed.rules.map(entry => ({ ...entry, status: 'live' })) };
const owner = { id: 'owner', issuer: 'host', subject: '1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const identity = (n = 1): AttemptIdentity => ({ scopeId: 's', runId: 'r', taskId: `t${n}`, attemptId: `a${n}`, generation: 1, layoutRevision: 'l1' });
const signal = (overrides: Partial<NervousAttemptSignal> = {}): NervousAttemptSignal => ({ identity: identity(), activity: 'running',
  launcher: { basis: 'dead', phase: 'dispatch' }, containerRecorded: true, workerRecorded: true, ...overrides });
const grant = (actions: readonly string[] | 'all' = 'all', principals: unknown = [{ issuer: 'host', subject: '1000' }]) => ({ schemaVersion: 1, revision: 'owner-policy', restrictions: [], grants: [
  { id: 'nervous-standing', effect: 'allow', actions: ['apply'], scopes: ['s'], principals, resource: { kind: 'recovery-action', ids: actions } }] });
type Detection = Extract<AuditEvent['subject'], { kind: 'recovery-detection' }>;

async function ledger() {
  const root = await mkdtemp(join(tmpdir(), 'dn-nervous-live-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  const store = await openSqliteAuditStore(path, options); closers.push(() => store.close());
  return new AuditApplication(store, integrity);
}
/** A fake of the existing applications behind the broker; it records every call so a test can see that nothing else was reached. */
function ports(results: Partial<Record<'fence' | 'stop', Readonly<{ status: string; disposition: DispatchLossDecision; retained: 'incarnation' | 'container' | 'none' }>>> = {}) {
  const calls: unknown[][] = [];
  const recovery: NervousRecoveryPorts = {
    async recover(target, step) { calls.push(['recover', target.attemptId, step]); return results[step] ?? { status: 'unresolved', disposition: { kind: 'release', fenceReceiptId: 'f', terminationReceiptId: 'p' }, retained: 'incarnation' }; },
    async hold(command) { calls.push(['hold', command.runId, command.commandId, command.holdReason]); return null; },
  };
  return { calls, recovery };
}
async function harness(input: { live?: boolean; document?: unknown; principal?: typeof owner; rules?: unknown; recovery?: NervousRecoveryPorts; audit?: AuditApplication } = {}) {
  const audit = input.audit ?? await ledger(), clock = { t: 1_000_000 }, fake = ports();
  const recovery = input.recovery ?? fake.recovery;
  const app = new NervousApplication({ audit, now: () => clock.t }, input.rules ?? liveRules, { live: input.live ?? true, approval: null, executors: nervousExecutors(recovery) });
  const context = { owner: { issuer: 'host', subject: '1000' }, policyRevision: 'owner-policy',
    approval: (proposal: Parameters<typeof nervousStandingApproval>[2]) => nervousStandingApproval(input.document ?? grant(), input.principal ?? owner, proposal, clock.t) };
  const rows = () => audit.listKind('s', 'recovery-detection', 0, 1000).map(record => record.event.subject as Detection);
  return { app, audit, clock, rows, context, calls: fake.calls };
}

it('the standing approval is the owner\'s policy grant on recovery-action: no grant, another action or an AI principal is no approval', () => {
  const proposal = { scopeId: 's', action: 'stop-orphan' } as Parameters<typeof nervousStandingApproval>[2];
  expect(nervousStandingApproval(grant(), owner, proposal, 5)).toMatchObject({ schemaVersion: 1, decisionRef: 'nervous-standing', scopeIds: ['s'], actions: ['stop-orphan'],
    approvedBy: { issuer: 'host', subject: '1000', assurance: 'os-user' } });
  expect(nervousStandingApproval({ ...grant(), grants: [] }, owner, proposal, 5)).toBeNull();
  expect(nervousStandingApproval(grant(['fence-attempt']), owner, proposal, 5)).toBeNull();
  expect(nervousStandingApproval(grant('all', 'all'), { ...owner, id: 'mcp', issuer: 'host/mcp', assurance: 'workload-verified' as never }, proposal, 5)).toBeNull();
  expect(nervousStandingApproval(grant('all', [{ issuer: 'host/nervous', subject: '1000' }]), { ...owner, issuer: 'host/nervous' }, proposal, 5)).toBeNull();
  expect(nervousStandingApproval({ schemaVersion: 7 }, owner, proposal, 5)).toBeNull();
  expect(nervousStandingApproval(grant(), { ...owner, scopeIds: ['other'] }, proposal, 5)).toBeNull();
});

it('live orphan: one sealed `execute` case runs fence → stop → release through the recovery port once; the grant is sealed with it', async () => {
  const h = await harness();
  const [outcome] = await h.app.observeAttempts('s', [signal()], h.context);
  expect(outcome).toMatchObject({ ruleId: 'launcher-dead-orphan', action: 'stop-orphan', disposition: 'execute', executed: true });
  await h.app.observeAttempts('s', [signal()], h.context);
  expect(h.calls).toEqual([['recover', 'a1', 'stop']]);
  expect(h.rows()).toHaveLength(1);
  expect(h.rows()[0]).toMatchObject({ disposition: 'execute', standingRef: 'nervous-standing' });
});

it('live gone: a dead launcher with no container is fenced and released with proof; no hold, nothing else', async () => {
  const h = await harness();
  await h.app.observeAttempts('s', [signal({ activity: 'missing' })], h.context);
  expect(h.calls).toEqual([['recover', 'a1', 'fence']]);
});

it.each([
  ['no retained identity', { kind: 'hold-manual', reason: 'termination-required' }, 'none', 'termination-required'],
  ['only the created container id, which is still there', { kind: 'hold-manual', reason: 'termination-required' }, 'container', 'termination-required'],
  ['another incarnation', { kind: 'hold-manual', reason: 'termination-mismatch' }, 'incarnation', 'termination-mismatch'],
] as const)('no termination proof (%s) → the fenced worker goes to a person through one Nervous safety hold (replay-safe command id)', async (_label, disposition, retained, code) => {
  const fake = ports({ fence: { status: 'unresolved', disposition, retained } }), h = await harness({ recovery: fake.recovery });
  const [outcome] = await h.app.observeAttempts('s', [signal({ activity: 'missing' })], h.context);
  expect(fake.calls).toEqual([['recover', 'a1', 'fence'], ['hold', 'r', `nervous-hold:${outcome!.caseId}`, `nervous:${code}:launcher-dead-gone:${outcome!.caseId.slice(0, 12)}`]]);
});

it('stop issued, proof pending: re-applied from its sealed case on later pages (the stop is sent again), then the last application goes to a person', async () => {
  const fake = ports({ stop: { status: 'unresolved', disposition: { kind: 'hold-manual', reason: 'termination-required' }, retained: 'incarnation' } }), h = await harness({ recovery: fake.recovery });
  const max = h.app.rules.tracking.maxApplications;
  const [first] = await h.app.observeAttempts('s', [signal()], h.context);
  expect(fake.calls).toEqual([['recover', 'a1', 'stop']]);
  // The fence is written now: the dispatch's signal only re-applies the sealed case, it never opens a new one.
  for (let page = 1; page < max + 2; page++) await h.app.observeAttempts('s', [signal({ fenced: true })], h.context);
  expect(fake.calls).toEqual([...Array.from({ length: max }, () => ['recover', 'a1', 'stop']),
    ['hold', 'r', `nervous-hold:${first!.caseId}`, `nervous:termination-required:launcher-dead-orphan:${first!.caseId.slice(0, 12)}`]]);
  expect(h.rows()).toHaveLength(1);
});

it('a fenced dispatch never opens a new case (any rule): its signal only replays a sealed one', async () => {
  const h = await harness();
  expect(await h.app.observeAttempts('s', [signal({ fenced: true }), signal({ identity: identity(2), activity: 'missing', fenced: true })], h.context)).toEqual([]);
  for (let page = 0; page < 5; page++) { h.clock.t += 60_000; await h.app.observeAttempts('s', [signal({ identity: identity(3), activity: 'missing', launcher: { basis: 'same-process', phase: 'dispatch' }, fenced: true })], h.context); }
  expect(h.calls).toEqual([]); expect(h.rows()).toEqual([]);
});

it.each([
  ['shadow mode', { live: false }],
  ['no standing grant', { document: { ...grant(), grants: [] } }],
  ['a grant of another action only', { document: grant(['hold-run']) }],
  ['a provisional (unmeasured) rule', { rules: seed }],
])('%s: the case is sealed and nothing is executed', async (_label, input) => {
  const h = await harness(input);
  const [outcome] = await h.app.observeAttempts('s', [signal()], h.context);
  expect(outcome).toMatchObject({ executed: false });
  expect(outcome!.disposition).not.toBe('execute');
  expect(h.calls).toEqual([]);
});

it('a hold action needs a Run: a scope case (daemon unavailable) stays a proposal even under a grant of every action', async () => {
  const h = await harness();
  h.clock.t = 0;
  const down = [signal({ activity: 'control-failed', launcher: { basis: 'same-process', phase: 'dispatch' } })];
  await h.app.observeAttempts('s', down, h.context);
  h.clock.t = 10_000_000;
  const outcomes = await h.app.observeAttempts('s', down, h.context);
  expect(outcomes.map(outcome => [outcome.action, outcome.disposition])).toEqual([['alert-brain', 'proposal-only'], ['hand-to-human', 'proposal-only']]);
  expect(h.calls).toEqual([]);
});

it('a crash-loop case of a task goes to a person through the Nervous safety hold of its Run', async () => {
  const h = await harness();
  const event = { schemaVersion: 1 as const, eventId: 'abort-1', scopeId: 's', principal: { issuer: 'host', subject: '1000' }, policyRevision: 'p', atMs: 5,
    subject: { kind: 'dispatch-preparation-aborted' as const, runId: 'r', taskId: 't1', attemptId: 'a1', phase: 'workspace' as const, aborts: 2, bound: 2 } };
  const [outcome] = await h.app.observeFeed('s', 'dispatch-preparation-aborted', [{ sequence: 1, event }], h.context);
  expect(outcome).toMatchObject({ ruleId: 'crash-loop', action: 'hand-to-human', disposition: 'execute', executed: true });
  expect(h.calls).toEqual([['hold', 'r', `nervous-hold:${outcome!.caseId}`, `nervous:hand-to-human:crash-loop:${outcome!.caseId.slice(0, 12)}`]]);
});

it('re-applies a sealed `execute` case from the ledger after a crash between seal and effect, never a sealed shadow case, never without the grant now', async () => {
  const audit = await ledger(), crashed = { ...ports().recovery, async recover() { throw new Error('process died'); } };
  const first = await harness({ audit, recovery: crashed });
  await expect(first.app.observeAttempts('s', [signal()], first.context)).rejects.toThrow('process died');
  expect(first.rows()).toHaveLength(1);
  const revoked = await harness({ audit, document: { ...grant(), grants: [] } });
  expect((await revoked.app.observeAttempts('s', [signal()], revoked.context))[0]).toMatchObject({ replay: true, executed: false });
  expect(revoked.calls).toEqual([]);
  const restarted = await harness({ audit });
  expect((await restarted.app.observeAttempts('s', [signal({ fenced: true })], restarted.context))[0]).toMatchObject({ replay: true, disposition: 'execute', executed: true });
  expect(restarted.calls).toEqual([['recover', 'a1', 'stop']]);
  // A case sealed in shadow is never executed later (switching to live does not act on it).
  const shadowAudit = await ledger(), shadow = await harness({ audit: shadowAudit, live: false });
  await shadow.app.observeAttempts('s', [signal()], shadow.context);
  const live = await harness({ audit: shadowAudit });
  expect((await live.app.observeAttempts('s', [signal()], live.context))[0]).toMatchObject({ replay: true, disposition: 'shadow-only', executed: false });
  expect(live.calls).toEqual([]);
  expect(audit.listKind('s', 'recovery-detection', 0, 10)).toHaveLength(1);
});

it.each(['prepare', 'workspace', 'secret-gate', 'handoff', null] as const)('a dead launcher whose record is not at `dispatch` (%s) is inconsistent evidence: no orphan stop and no fence', async phase => {
  const h = await harness();
  expect(await h.app.observeAttempts('s', [signal({ launcher: { basis: 'dead', phase } }), signal({ identity: identity(2), activity: 'missing', launcher: { basis: 'dead', phase } })], h.context)).toEqual([]);
  expect(h.calls).toEqual([]); expect(h.rows()).toEqual([]);
});

it('the executors cover only the stop list the broker may run; alert, restart and anything that would open an Attempt have none', () => {
  const executors = nervousExecutors(ports().recovery);
  expect(Object.keys(executors).sort()).toEqual(['fence-attempt', 'hand-to-human', 'hold-run', 'stop-orphan']);
  expect(Object.keys(executors).every(action => (RECOVERY_ACTIONS as readonly string[]).includes(action))).toBe(true);
});

it('one case\'s failed step never blocks the other cases of the page; the failure is still reported and that case is re-applied later', async () => {
  const fake = ports(), recovery: NervousRecoveryPorts = { ...fake.recovery,
    async recover(target, step) { if (target.attemptId === 'a1') throw new Error('ledger busy'); return fake.recovery.recover(target, step); } };
  const h = await harness({ recovery });
  await expect(h.app.observeAttempts('s', [signal(), signal({ identity: identity(2), activity: 'missing' })], h.context)).rejects.toThrow('ledger busy');
  expect(fake.calls).toEqual([['recover', 'a2', 'fence']]);
  expect(h.rows().map(row => row.target?.attemptId)).toEqual(['a1', 'a2']);
});

it('alpha.56 G2: a person\'s promotion of the exact rule id and version makes the seeded provisional rule live; another version stays provisional, and the seal says so', async () => {
  const exact = await harness({ rules: NERVOUS_RULES_SEED });
  const promoted = { ...exact.context, promoted: (ruleId: string, version: number) => ruleId === 'launcher-dead-orphan' && version === 1 };
  expect(await exact.app.observeAttempts('s', [signal()], promoted)).toEqual([expect.objectContaining({ disposition: 'execute', executed: true })]);
  expect(exact.rows()[0]).toMatchObject({ rule: { id: 'launcher-dead-orphan', version: 1, status: 'live' }, disposition: 'execute' });
  // A seed version bump (or a promotion of another version) demotes: the proposal stays provisional and nothing executes.
  const other = await harness({ rules: NERVOUS_RULES_SEED });
  const stale = { ...other.context, promoted: (ruleId: string, version: number) => ruleId === 'launcher-dead-orphan' && version === 2 };
  expect(await other.app.observeAttempts('s', [signal()], stale)).toEqual([expect.objectContaining({ disposition: 'proposal-only', executed: false })]);
  expect(other.rows()[0]).toMatchObject({ rule: { status: 'provisional' } }); expect(other.calls).toEqual([]);
});
