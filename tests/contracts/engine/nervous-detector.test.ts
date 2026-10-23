import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RECOVERY_ACTIONS, auditEventSchema, type AuditEvent, type AuditRecord } from '#domain/index.js';
import { AuditApplication, NERVOUS_RULES_SEED, NervousApplication, NervousError, loadNervousRules, type NervousAttemptSignal } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';

// S6 Nervous K-B + S6R-2 (owner 2026-10-23, anchor s6r-kayip-calisan-2026-10-23; PROGRAM law-audit fold 4): deterministic rules from a
// versioned registry over existing signals; ONE typed proposal from the K-B standing list; sealed as `recovery-detection`; shadow first.
// Nervous writes no state: its only write is its own sealed detection record. It never opens an Attempt.
const roots: string[] = [], closers: (() => void)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('audit-key', randomBytes(32));
const seed = NERVOUS_RULES_SEED as { rules: { id: string; status: string; action: string; [key: string]: unknown }[]; [key: string]: unknown };
const rules = loadNervousRules(seed), rule = (id: string) => seed.rules.find(entry => entry.id === id)! as Record<string, number>;
const context = { owner: { issuer: 'host', subject: '1000' }, policyRevision: 'p1' };
const identity = (n = 1, scopeId = 's') => ({ scopeId, runId: 'r', taskId: `t${n}`, attemptId: `a${n}`, generation: 1, layoutRevision: 'l1' });
const signal = (overrides: Partial<NervousAttemptSignal> = {}): NervousAttemptSignal => ({ identity: identity(), activity: 'running',
  launcher: { basis: 'same-process', phase: 'dispatch' }, containerRecorded: true, workerRecorded: true, ...overrides });

async function ledger() {
  const root = await mkdtemp(join(tmpdir(), 'dn-nervous-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  const store = await openSqliteAuditStore(path, options); closers.push(() => store.close());
  return new AuditApplication(store, integrity);
}
async function harness(input: { mode?: 'shadow' | 'live'; approval?: unknown; executors?: Record<string, (proposal: unknown) => Promise<unknown>>; rules?: unknown; audit?: AuditApplication } = {}) {
  const audit = input.audit ?? await ledger(), clock = { t: 1_000_000 };
  const app = new NervousApplication({ audit, now: () => clock.t }, 'rules' in input ? input.rules : seed, { live: input.mode === 'live', approval: input.approval ?? null, executors: input.executors ?? {} });
  const rows = (scopeId = 's') => audit.listKind(scopeId, 'recovery-detection', 0, 1000).map(record => record.event);
  return { app, audit, clock, rows };
}
type Detection = Extract<AuditEvent['subject'], { kind: 'recovery-detection' }>;
const subject = (event: AuditEvent) => event.subject as Detection;

it('loads the versioned seed registry: every rule provisional, every action inside the K-B standing list, no action opens an Attempt', () => {
  expect(RECOVERY_ACTIONS).toEqual(['fence-attempt', 'hold-run', 'stop-orphan', 'restart-component', 'alert-brain', 'hand-to-human']);
  expect(rules.rules.map(entry => entry.id).sort()).toEqual(['container-gone', 'crash-loop', 'daemon-unavailable', 'daemon-unavailable-escalate',
    'launcher-dead-gone', 'launcher-dead-orphan', 'policy-refusal-flood']);
  expect(rules.rules.every(entry => entry.status === 'provisional' && (RECOVERY_ACTIONS as readonly string[]).includes(entry.action))).toBe(true);
  expect(RECOVERY_ACTIONS.some(action => /attempt$/u.test(action) && action !== 'fence-attempt')).toBe(false);
});

it.each([
  ['absent', null], ['empty rules', { ...seed, rules: [] }], ['a missing rule', { ...seed, rules: seed.rules.slice(1) }],
  ['an action outside the standing list', { ...seed, rules: seed.rules.map(entry => entry.id === 'container-gone' ? { ...entry, action: 'continue-new-attempt' } : entry) }],
  ['an unknown rule', { ...seed, rules: [...seed.rules, { id: 'guess-exit', version: 1, status: 'provisional', action: 'alert-brain' }] }],
  ['a duplicate rule', { ...seed, rules: [...seed.rules, seed.rules[0]] }],
  ['escalation before the grace', { ...seed, rules: seed.rules.map(entry => entry.id === 'daemon-unavailable-escalate' ? { ...entry, afterMs: rule('daemon-unavailable').graceMs } : entry) }],
  ['a threshold of zero', { ...seed, rules: seed.rules.map(entry => entry.id === 'container-gone' ? { ...entry, consecutiveAbsent: 0 } : entry) }],
])('refuses an unreadable registry (%s) typed, never as an empty rule set', async (_label, input) => {
  expect(() => loadNervousRules(input)).toThrow(NervousError);
  expect(() => loadNervousRules(input)).toThrow(expect.objectContaining({ code: 'NERVOUS_RULES_UNREADABLE' }));
  await expect(harness({ rules: input })).rejects.toMatchObject({ code: 'NERVOUS_RULES_UNREADABLE' });
});

it('never opens a case for a worker its launcher still holds or one of a live other instance, whatever the daemon says about it', async () => {
  const h = await harness();
  for (let tick = 0; tick < 2 * rule('container-gone').consecutiveAbsent + 2; tick++) {
    h.clock.t += rule('container-gone').minAbsentMs;
    await h.app.observeAttempts('s', [signal(), signal({ identity: identity(2), launcher: { basis: 'alive', phase: 'dispatch' } }),
      signal({ identity: identity(3), activity: 'created' }), signal({ identity: identity(4), activity: 'paused', launcher: { basis: 'alive', phase: 'dispatch' } }),
      signal({ identity: identity(5), activity: 'unknown', launcher: { basis: 'none', phase: null } }), signal({ identity: identity(6), activity: 'exited' })], context);
  }
  expect(h.rows()).toEqual([]);
});

it('container-gone: proposes one fence only after k consecutive absences spanning the minimum time; a present sample resets the series', async () => {
  const h = await harness(), { consecutiveAbsent, minAbsentMs } = rule('container-gone');
  const missing = signal({ activity: 'missing' });
  for (let tick = 1; tick < consecutiveAbsent; tick++) { h.clock.t += minAbsentMs; expect(await h.app.observeAttempts('s', [missing], context)).toEqual([]); }
  // A present sample between absences starts the series again.
  await h.app.observeAttempts('s', [signal()], context);
  for (let tick = 1; tick < consecutiveAbsent; tick++) { h.clock.t += 1; await h.app.observeAttempts('s', [missing], context); }
  h.clock.t += 1; expect(await h.app.observeAttempts('s', [missing], context)).toEqual([]); // k absences, but not yet the minimum time
  expect(h.rows()).toEqual([]);
  h.clock.t += minAbsentMs;
  const [outcome] = await h.app.observeAttempts('s', [missing], context);
  expect(outcome).toMatchObject({ ruleId: 'container-gone', action: 'fence-attempt', disposition: 'shadow-only', replay: false, executed: false });
  for (let tick = 0; tick < 3; tick++) { h.clock.t += minAbsentMs; await h.app.observeAttempts('s', [missing], context); }
  const rows = h.rows();
  expect(rows).toHaveLength(1);
  expect(auditEventSchema.parse(rows[0])).toEqual(rows[0]);
  expect(subject(rows[0]!)).toMatchObject({ kind: 'recovery-detection', rule: { id: 'container-gone', version: 1, status: 'provisional' }, action: 'fence-attempt',
    disposition: 'shadow-only', target: { runId: 'r', taskId: 't1', attemptId: 'a1', generation: 1 },
    evidence: { activity: 'missing', launcher: 'same-process', absentObservations: consecutiveAbsent + 1 } });
  expect(subject(rows[0]!).caseId).toBe(outcome!.caseId);
  expect(rows[0]!.eventId).toBe(`recovery-detection:${outcome!.caseId}`);
});

it('launcher dead: a running container is an orphan to stop, a gone one is fenced at once; an unreadable or absent launcher record proves nothing', async () => {
  const h = await harness(), dead = { basis: 'dead' as const, phase: 'dispatch' as const };
  const outcomes = await h.app.observeAttempts('s', [signal({ launcher: dead }), signal({ identity: identity(2), activity: 'missing', launcher: dead }),
    signal({ identity: identity(3), activity: 'created', launcher: dead }), signal({ identity: identity(4), activity: 'missing', launcher: { basis: 'unreadable', phase: null } }),
    signal({ identity: identity(5), activity: 'running', launcher: { basis: 'none', phase: null } })], context);
  expect(outcomes.map(outcome => [outcome.ruleId, outcome.action])).toEqual([['launcher-dead-orphan', 'stop-orphan'], ['launcher-dead-gone', 'fence-attempt'],
    ['launcher-dead-orphan', 'stop-orphan']]);
  expect(h.rows().map(event => subject(event).target?.attemptId)).toEqual(['a1', 'a2', 'a3']);
  // Precedence: one proposal per Attempt and observation, the most specific rule first (no extra container-gone case for a2 later).
  for (let tick = 0; tick < rule('container-gone').consecutiveAbsent + 1; tick++) { h.clock.t += rule('container-gone').minAbsentMs; await h.app.observeAttempts('s', [signal({ identity: identity(2), activity: 'missing', launcher: dead })], context); }
  expect(h.rows()).toHaveLength(3);
});

it('daemon unavailable: alerts the Brain after the grace and hands to a human after the escalation time; never a fence', async () => {
  const h = await harness(), { graceMs } = rule('daemon-unavailable'), { afterMs } = rule('daemon-unavailable-escalate');
  const down = [signal({ activity: 'control-failed' }), signal({ identity: identity(2), activity: 'control-failed', launcher: { basis: 'dead', phase: 'dispatch' } })];
  await h.app.observeAttempts('s', down, context);
  h.clock.t += graceMs - 1; expect(await h.app.observeAttempts('s', down, context)).toEqual([]);
  h.clock.t += 1; expect((await h.app.observeAttempts('s', down, context)).map(outcome => [outcome.ruleId, outcome.action])).toEqual([['daemon-unavailable', 'alert-brain']]);
  h.clock.t = 1_000_000 + afterMs; expect((await h.app.observeAttempts('s', down, context)).map(outcome => [outcome.ruleId, outcome.action])).toEqual([['daemon-unavailable-escalate', 'hand-to-human']]);
  h.clock.t += afterMs; await h.app.observeAttempts('s', down, context);
  expect(h.rows().map(event => [subject(event).rule.id, subject(event).action, subject(event).target])).toEqual([['daemon-unavailable', 'alert-brain', null],
    ['daemon-unavailable-escalate', 'hand-to-human', null]]);
  // The daemon answering ends the episode; a later outage is a new one.
  await h.app.observeAttempts('s', [signal()], context);
  await h.app.observeAttempts('s', down, context); h.clock.t += graceMs; await h.app.observeAttempts('s', down, context);
  expect(h.rows().map(event => subject(event).rule.id)).toEqual(['daemon-unavailable', 'daemon-unavailable-escalate', 'daemon-unavailable']);
});

it('audit feed: a crash-loop at its bound goes to a human, a policy refusal flood alerts the Brain; below the bound or without a ceiling nothing', async () => {
  const h = await harness(), at = (sequence: number, event: Omit<AuditEvent, 'schemaVersion' | 'scopeId' | 'principal' | 'policyRevision' | 'atMs'>) => ({ sequence,
    event: auditEventSchema.parse({ schemaVersion: 1, scopeId: 's', principal: context.owner, policyRevision: 'p1', atMs: 5, ...event }) });
  const aborted = (n: number, aborts: number) => at(n, { eventId: `abort-${n}`, subject: { kind: 'dispatch-preparation-aborted', runId: 'r', taskId: 't1', attemptId: 'a1', phase: 'workspace', aborts, bound: 2 } });
  const turn = (n: number, ceiling: boolean) => at(n, { eventId: `turn-${n}`, subject: { kind: 'policy-turn', turnId: `turn-${n}`, ceiling, refused: { count: ceiling ? 70 : 1, calls: [] }, allowed: { count: 0, calls: [] } } });
  expect(h.app.feedCursor('s', 'dispatch-preparation-aborted')).toBe(0);
  await h.app.observeFeed('s', 'dispatch-preparation-aborted', [aborted(3, 1), aborted(7, 2)], context);
  await h.app.observeFeed('s', 'policy-turn', [turn(4, false), turn(9, true)], context);
  expect(h.app.feedCursor('s', 'dispatch-preparation-aborted')).toBe(7); expect(h.app.feedCursor('s', 'policy-turn')).toBe(9);
  // A replayed page (a restarted reader starting from 0) seals nothing twice.
  const restarted = await harness({ audit: h.audit });
  expect((await restarted.app.observeFeed('s', 'dispatch-preparation-aborted', [aborted(3, 1), aborted(7, 2)], context)).map(outcome => outcome.replay)).toEqual([true]);
  expect(h.rows().map(event => [subject(event).rule.id, subject(event).action, subject(event).target?.attemptId ?? null, subject(event).evidence.source])).toEqual([
    ['crash-loop', 'hand-to-human', 'a1', { kind: 'dispatch-preparation-aborted', eventId: 'abort-7', sequence: 7 }],
    ['policy-refusal-flood', 'alert-brain', null, { kind: 'policy-turn', eventId: 'turn-9', sequence: 9 }]]);
  await expect(h.app.observeFeed('s', 'policy-turn', [turn(8, true)], context)).rejects.toMatchObject({ code: 'NERVOUS_SIGNAL_INVALID' }); // behind the cursor
});

it('a duplicate signal is one proposal, also across a restart of the detector over the same ledger', async () => {
  const first = await harness(), orphan = signal({ launcher: { basis: 'dead', phase: 'dispatch' } });
  await first.app.observeAttempts('s', [orphan, orphan], context);
  await first.app.observeAttempts('s', [orphan], context);
  const restarted = await harness({ audit: first.audit });
  restarted.clock.t += 60_000;
  const [again] = await restarted.app.observeAttempts('s', [orphan], context);
  expect(again).toMatchObject({ ruleId: 'launcher-dead-orphan', replay: true });
  expect(first.rows()).toHaveLength(1);
});

it('scope isolation: a signal or feed record of another scope refuses the whole batch and seals nothing', async () => {
  const h = await harness(), dead = { basis: 'dead' as const, phase: 'dispatch' as const };
  await expect(h.app.observeAttempts('s', [signal({ launcher: dead }), signal({ identity: identity(2, 'other'), launcher: dead })], context)).rejects.toMatchObject({ code: 'NERVOUS_SIGNAL_INVALID' });
  const foreign = { sequence: 1, event: auditEventSchema.parse({ schemaVersion: 1, eventId: 'x', scopeId: 'other', principal: context.owner, policyRevision: 'p1', atMs: 1,
    subject: { kind: 'dispatch-preparation-aborted', runId: 'r', taskId: 't', attemptId: 'a', phase: null, aborts: 2, bound: 2 } }) };
  await expect(h.app.observeFeed('s', 'dispatch-preparation-aborted', [foreign], context)).rejects.toMatchObject({ code: 'NERVOUS_SIGNAL_INVALID' });
  expect(h.rows()).toEqual([]); expect(h.rows('other')).toEqual([]);
});

it('writes nothing but its own detection record, attributed to the Nervous workload principal; in shadow no executor ever runs', async () => {
  const calls: unknown[] = [], executors = Object.fromEntries(RECOVERY_ACTIONS.map(action => [action, async (proposal: unknown) => { calls.push([action, proposal]); }]));
  const h = await harness({ executors, approval: { schemaVersion: 1, decisionRef: 's6r-kayip-calisan-2026-10-23', approvedBy: { ...context.owner, assurance: 'os-user' }, approvedAtMs: 1, scopeIds: ['s'], actions: [...RECOVERY_ACTIONS] },
    rules: { ...seed, rules: seed.rules.map(entry => ({ ...entry, status: 'live' })) } });
  await h.app.observeAttempts('s', [signal({ launcher: { basis: 'dead', phase: 'dispatch' } }), signal({ identity: identity(2), activity: 'missing', launcher: { basis: 'dead', phase: 'dispatch' } })], context);
  expect(calls).toEqual([]);
  const all = h.audit.list('s', 0, 1000).map((record: AuditRecord) => record.event);
  expect(all.map(event => event.subject.kind)).toEqual(['recovery-detection', 'recovery-detection']);
  expect(all.every(event => event.principal.issuer === 'host/nervous' && event.principal.subject === '1000' && subject(event).disposition === 'shadow-only')).toBe(true);
});

const approval = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, decisionRef: 's6r-kayip-calisan-2026-10-23',
  approvedBy: { issuer: 'host', subject: '1000', assurance: 'os-user' }, approvedAtMs: 1, scopeIds: ['s'], actions: ['stop-orphan', 'fence-attempt'], ...overrides });
const liveRules = { ...seed, rules: seed.rules.map(entry => ({ ...entry, status: 'live' })) };
it.each([
  ['no standing approval', null, liveRules],
  ['an AI-authored standing approval', approval({ approvedBy: { issuer: 'host/mcp', subject: '1000', assurance: 'workload-verified' } }), liveRules],
  ['a standing approval of another scope', approval({ scopeIds: ['other'] }), liveRules],
  ['a standing approval without this action', approval({ actions: ['fence-attempt'] }), liveRules],
  ['an unreadable standing approval', { schemaVersion: 9 }, liveRules],
  ['a provisional (unmeasured) rule', approval(), seed],
])('broker: %s is a proposal only — sealed, never executed', async (_label, record, ruleSet) => {
  const calls: unknown[] = [], h = await harness({ mode: 'live', approval: record, rules: ruleSet, executors: { 'stop-orphan': async proposal => { calls.push(proposal); } } });
  const [outcome] = await h.app.observeAttempts('s', [signal({ launcher: { basis: 'dead', phase: 'dispatch' } })], context);
  expect(outcome).toMatchObject({ action: 'stop-orphan', disposition: 'proposal-only', executed: false });
  expect(calls).toEqual([]); expect(subject(h.rows()[0]!).disposition).toBe('proposal-only');
});

it('broker: an approved, measured rule executes exactly once through its executor, and only after its detection is sealed', async () => {
  const seen: unknown[] = [];
  const h = await harness({ mode: 'live', approval: approval(), rules: liveRules, executors: { 'stop-orphan': async proposal => { seen.push([proposal, h.rows().length]); } } });
  const orphan = signal({ launcher: { basis: 'dead', phase: 'dispatch' } });
  const [outcome] = await h.app.observeAttempts('s', [orphan], context);
  expect(outcome).toMatchObject({ action: 'stop-orphan', disposition: 'execute', executed: true });
  await h.app.observeAttempts('s', [orphan], context);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual([expect.objectContaining({ caseId: outcome!.caseId, action: 'stop-orphan', target: { kind: 'attempt', identity: identity() } }), 1]);
  // An approved action with no executor wired is a proposal only (nothing is sealed as executing that cannot run).
  const none = await harness({ mode: 'live', approval: approval(), rules: liveRules });
  expect((await none.app.observeAttempts('s', [orphan], context))[0]).toMatchObject({ disposition: 'proposal-only', executed: false });
});

it.each(['continue-new-attempt', 'open-attempt', 'release-slot', 'resume-run'])('broker: refuses a forged proposal with the action %s outside the standing list; nothing sealed or run', async action => {
  const calls: unknown[] = [], h = await harness({ mode: 'live', approval: approval({ actions: [...RECOVERY_ACTIONS] }), rules: liveRules,
    executors: Object.fromEntries([...RECOVERY_ACTIONS, action].map(name => [name, async () => { calls.push(name); }])) });
  const forged = { schemaVersion: 1, caseId: 'c'.repeat(64), scopeId: 's', rule: { id: 'launcher-dead-orphan', version: 1, status: 'live' }, registryRevision: rules.revision,
    action, target: { kind: 'attempt', identity: identity() }, evidence: {}, evidenceDigest: 'd'.repeat(64) };
  await expect(h.app.broker(forged, context)).rejects.toMatchObject({ code: 'NERVOUS_ACTION_REFUSED' });
  expect(calls).toEqual([]); expect(h.rows()).toEqual([]);
});
