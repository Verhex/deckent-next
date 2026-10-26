import { afterEach, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { AUDIT_EVENT_SCHEMA_VERSION, RECOVERY_DECISION_SEED, RECOVERY_POLICY_SEED, effectRecordSchema, freezeRecoveryPolicy, loadRecoveryPolicy, mcpPrincipalRef, nervousPrincipalRef, recoveryPrincipal, recoveryPrincipalRef,
  type VerifiedPrincipal } from '#domain/index.js';
import { AuditApplication, RecoveryApplication, RecoveryDecisionApplication, RecoveryReviewApplication, prepareTaskStart, readRecoveryRollout, recoveryContinuationApproval, recoveryDecisionCommandId,
  type RecoveryModelRequest, type RecoveryModelResult, type RecoveryModelRow } from '#engine/index.js';
import { openSqliteRecoveryStore, type SqliteAttemptStore } from '#adapters/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { LEDGER_OPTIONS, effectIntent, grantedTask, lostIntegrity, owner, releasedLostTask, sealDetection } from '../support/lost-task.js';

// S6R-5 (S6R-DESIGN §6, §7 step 5–6, §8, §9, §10, §11 phase 1; owner Q-R1/Q-R2/Q-R5, Q-H3): the recovery decision. Only after the deterministic gate passed
// does the `recovery-decision` role model read the sealed evidence and choose ONE typed action; the decision is sealed before its apply, replays
// without a second model call and never re-asks. Shadow seals what would happen and changes nothing. The model port here is a stub: no model call.
const roots: string[] = [], stores: SqliteAttemptStore[] = [], closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close(); for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const live = freezeRecoveryPolicy(loadRecoveryPolicy(RECOVERY_POLICY_SEED), 'live', ['task']), shadow = freezeRecoveryPolicy(loadRecoveryPolicy(RECOVERY_POLICY_SEED), 'shadow', ['task']);
const recovery = recoveryPrincipal(owner, ['s']);
const standing = { schemaVersion: 1, revision: 'owner-policy', restrictions: [], grants: [
  { id: 'recovery-standing', effect: 'allow', actions: ['apply'], scopes: ['s'], principals: [{ issuer: owner.issuer, subject: owner.subject }], resource: { kind: 'recovery-action', ids: ['continue-new-attempt'] } }] };
const metered: RecoveryModelRow = { channelId: 'channel-a', modelId: 'model-a', invocable: true, billing: 'metered', consent: null };
type Answer = Record<string, unknown> | ((request: RecoveryModelRequest) => RecoveryModelResult);

async function harness(input: { policy?: unknown; rows?: readonly RecoveryModelRow[]; answer?: Answer; document?: unknown; registry?: unknown; wouldStop?: boolean } = {}) {
  const f = await (input.wouldStop ? grantedTask : releasedLostTask)(roots, stores, input.policy === undefined ? live : input.policy);
  const caseId = await sealDetection(f.path, f.identity, undefined, undefined, input.wouldStop ? 'shadow-only' : 'execute');
  const cases = openSqliteRecoveryStore(f.path, LEDGER_OPTIONS); closers.push(() => cases.close());
  const audit = await openSqliteAuditStore(f.path, LEDGER_OPTIONS); closers.push(() => audit.close());
  const state = { document: input.document === undefined ? standing as unknown : input.document, principal: recovery as VerifiedPrincipal, answer: input.answer ?? {} as Answer,
    rows: input.rows ?? [metered], crash: false, crashAssess: false };
  const holds: unknown[] = [], calls: RecoveryModelRequest[] = [];
  const ledger = new AuditApplication(audit, lostIntegrity), verifier = { async verify() { return state.principal; } };
  const approval = async (scopeId: string) => recoveryContinuationApproval(state.document, owner, scopeId, 30);
  const app = new RecoveryApplication({ store: cases, detections: ledger, recorder: target => new AuditApplication(target, lostIntegrity), approval,
    hold: async command => { holds.push(command); return null; }, isolation: async () => ({ schemaVersion: 1, network: 'none', egress: { kind: 'none' } }), policyRevision: 'owner-policy', now: () => 30, timeoutMs: 1000 }, verifier);
  const make = () => new RecoveryDecisionApplication({ recovery: { prepare: (...args) => app.prepare(...args), escalate: (...args) => app.escalate(...args),
    assess: async (...args) => { if (state.crashAssess) { state.crashAssess = false; throw new Error('CRASH_BEFORE_ASSESS'); } return app.assess(...args); },
    continueLostTask: async (...args) => { if (state.crash) { state.crash = false; throw new Error('CRASH_AFTER_SEAL'); } return app.continueLostTask(...args); } },
  store: cases, seals: ledger, approval, owner: { issuer: owner.issuer, subject: owner.subject }, policyRevision: 'owner-policy', registry: input.registry ?? RECOVERY_DECISION_SEED, now: () => 40,
  models: { rows: async () => state.rows, invoke: async request => { calls.push(request); const given = state.answer;
    if (typeof given === 'function') return given(request);
    const user = JSON.parse(request.messages[1]!.content) as { caseId: string; evidenceDigest: string };
    return { status: 'responded', invocationId: 'inv-1', text: JSON.stringify({ schemaVersion: 1, caseId: user.caseId, evidenceDigest: user.evidenceDigest, action: 'continue-new-attempt',
      causeClass: 'infra-transient', rationale: 'launcher died; nothing open', nextAttemptNote: 'previous-attempt-launcher-died', ...given }) }; } } }, verifier);
  const rows = (sql: string) => { const db = new DatabaseSync(f.path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const sealed = () => rows("SELECT record FROM audit_events WHERE kind='recovery-decision' ORDER BY sequence").map(row => JSON.parse(String(row['record'])).event.subject);
  const lifecycle = () => rows("SELECT record FROM audit_events WHERE kind IN('run-lifecycle','recovery-decision') ORDER BY sequence")
    .map(row => { const subject = JSON.parse(String(row['record'])).event.subject; return subject.kind === 'recovery-decision' ? 'recovery-decision' : subject.action; });
  const caseRows = () => rows('SELECT state,revision FROM recovery_cases ORDER BY case_id');
  return { ...f, caseId, app, make, state, holds, calls, sealed, lifecycle, cases: caseRows };
}
const decide = (h: Awaited<ReturnType<typeof harness>>, mode: 'shadow' | 'live' = 'live', app = h.make()) => app.decide({ schemaVersion: 1, scopeId: 's', caseId: h.caseId, mode });

it('live: after the gate passed, one call of the role model with retries 0; the sealed decision precedes the continuation; a replay calls nothing', async () => {
  const h = await harness();
  const outcome = await decide(h);
  expect(outcome).toMatchObject({ kind: 'continued', case: { state: 'applied', decision: { action: 'continue-new-attempt', causeClass: 'infra-transient', note: 'previous-attempt-launcher-died' } } });
  expect(h.calls).toHaveLength(1);
  const [call] = h.calls, gated = (await openSqliteRecoveryStore(h.path, LEDGER_OPTIONS));
  try { expect(call!.commandId).toBe(recoveryDecisionCommandId(h.caseId, (await gated.loadCase('s', h.caseId))!.evidenceDigest, 'live')); } finally { gated.close(); }
  expect(call!.row).toEqual(metered); expect(call!.maxCompletionTokens).toBeGreaterThan(0);
  expect(call!.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('JSON') });
  const user = JSON.parse(call!.messages[1]!.content);
  expect(user).toMatchObject({ schemaVersion: 1, caseId: h.caseId, offered: ['continue-new-attempt', 'escalate-human'], noteCodes: expect.arrayContaining(['previous-attempt-oom']),
    evidence: { rule: { id: 'launcher-dead-orphan', version: 1 }, termination: { kind: 'supervisor-exit', exitCode: 137 }, gate: { result: 'clear', settled: 'none', intents: 0 },
      attempts: { used: 1, ceiling: 3 } } });
  expect(JSON.stringify(user)).not.toMatch(/fixture-policy|owner-policy|1000/u); // no policy, principal or host detail reaches the model
  expect(h.sealed()).toEqual([expect.objectContaining({ kind: 'recovery-decision', caseId: h.caseId, mode: 'live', action: 'continue-new-attempt', causeClass: 'infra-transient',
    note: 'previous-attempt-launcher-died', code: null, failure: null, standingRef: 'recovery-standing',
    model: expect.objectContaining({ channelId: 'channel-a', modelId: 'model-a', template: { id: 'recovery-decision', version: 1 }, invocationId: 'inv-1',
      inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }) })]);
  expect(h.lifecycle()).toEqual(['hold', 'release-worker-custody', 'recovery-decision', 'continue-lost-task']);
  const run = (await h.store.loadRun('s', 'run'))!;
  expect(run.progress[0]).toMatchObject({ phase: 'pending', unresolvedEffects: false });
  expect(run.previousBindings).toEqual([expect.objectContaining({ observedKind: 'lost', recoveryContext: { note: 'previous-attempt-launcher-died', facts: [] } })]);
  expect(await decide(h)).toMatchObject({ kind: 'continued', replay: true }); expect(h.calls).toHaveLength(1); expect(h.sealed()).toHaveLength(1);
  // The next generation's Attempt learns the note as its registry text (one labelled data line), never the model's rationale.
  const next = { ...h.identity, attemptId: 'attempt-2', generation: 2 };
  await h.store.reserveRunTasks({ commandId: 'reserve-2', actor: { id: 'fixture', issuer: 'test', subject: 'service' }, scopeId: 's', runId: 'run', expectedRevision: run.revision, now: 41, identities: [next] });
  const artifacts = { async put() { throw new Error('unused'); }, async read() { throw new Error('unused'); }, async prepareReadOnlyFile() { throw new Error('unused'); } };
  const start = await prepareTaskStart(next, h.store, artifacts as never, { async verify() { return owner; } }, { async authorizeIdentity() {} }, { artifacts: { maxInputs: 4, maxBytes: 8192 } });
  const line = JSON.parse(start.dependencyContext!.text.split('\n').find(text => text.includes('recovery-continuation'))!);
  expect(line).toEqual({ kind: 'recovery-continuation', note: { code: 'previous-attempt-launcher-died', text: expect.stringContaining('launched it ended') }, settledWork: [] });
  expect(start.dependencyContext!.text).not.toContain('nothing open');
});

it('N17: a crash between the sealed decision and its apply applies the sealed choice on the next pass, without a second model call', async () => {
  const h = await harness(); h.state.crash = true;
  await expect(decide(h)).rejects.toThrow('CRASH_AFTER_SEAL');
  expect(h.sealed()).toHaveLength(1); expect(h.cases()).toEqual([{ state: 'gated', revision: 1 }]);
  expect(await decide(h, 'live', h.make())).toMatchObject({ kind: 'continued', case: { state: 'applied' } });
  expect(h.calls).toHaveLength(1); expect(h.sealed()).toHaveLength(1);
});

it('N1: an unsettled effect — the model is never called; the escalation is sealed with no model, then the case closes and the Run is held', async () => {
  const h = await harness();
  await h.store.claimEffect(effectIntent('open-1', { producer: { kind: 'attempt', identity: h.identity } }));
  expect(await decide(h)).toMatchObject({ kind: 'escalated', case: { state: 'escalated', decision: { code: 'effects-open' } } });
  expect(h.calls).toEqual([]);
  expect(h.sealed()).toEqual([expect.objectContaining({ action: 'escalate-human', code: 'effects-open', model: null, mode: 'live' })]);
  expect(h.lifecycle()).toEqual(['hold', 'release-worker-custody', 'recovery-decision']);
  expect(h.holds).toEqual([expect.objectContaining({ commandId: `recovery-hold:${h.caseId}` })]);
});

it('a sealed gate escalation whose evidence then changed (crash before the case was written) still goes to a person, without a model call', async () => {
  const h = await harness(), open = await h.store.claimEffect(effectIntent('open-3', { producer: { kind: 'attempt', identity: h.identity } }));
  h.state.crashAssess = true;
  await expect(decide(h)).rejects.toThrow('CRASH_BEFORE_ASSESS');
  expect(h.sealed()).toEqual([expect.objectContaining({ code: 'effects-open', model: null })]); expect(h.cases()).toEqual([]);
  await h.store.saveEffect(open, effectRecordSchema.parse({ ...open, state: 'refused', refusal: 'EFFECT_REJECTED' })); // the effect settles: the gate would pass now
  expect(await decide(h)).toMatchObject({ kind: 'escalated', case: { state: 'escalated', decision: { code: 'effects-open' } } });
  expect(h.calls).toEqual([]); expect(h.sealed()).toHaveLength(1); expect(h.holds).toHaveLength(1);
});

it.each([
  ['no active role row', { rows: [] }, 'no-eligible-model'],
  ['only a non-invocable row', { rows: [{ ...metered, invocable: false }] }, 'no-eligible-model'],
  ['Q-H3: a subscription row without the connection\'s delegated-use consent', { rows: [{ ...metered, billing: 'subscription' as const }] }, 'consent-required'],
  ['no owner standing grant for continuation (only a person could act)', { document: { ...standing, grants: [] } }, 'continuation-not-approved'],
  ['the installation circuit breaker is open', { registry: { ...RECOVERY_DECISION_SEED as object, breaker: { maxCasesPerWindow: 0, windowMs: 3600000, scanLimit: 256 } } }, 'breaker-open'],
] as const)('%s: deterministic escalation, no model call', async (_name, input, code) => {
  const h = await harness(input);
  expect(await decide(h)).toMatchObject({ kind: 'escalated', case: { state: 'escalated', decision: { action: 'escalate-human', code } } });
  expect(h.calls).toEqual([]); expect(h.sealed()).toEqual([expect.objectContaining({ code, model: null })]);
  expect(h.holds).toHaveLength(1);
  expect((await h.store.loadRun('s', 'run'))!.progress[0]).toMatchObject({ phase: 'reconciling' });
});

it('Q-H3: with the owner\'s consent for system use the subscription row is called; consent by another person is refused', async () => {
  const consented = { ...metered, billing: 'subscription' as const, consent: { consentedBy: { issuer: owner.issuer, subject: owner.subject }, atMs: 1, classes: ['system'] } };
  const ok = await harness({ rows: [consented] });
  expect(await decide(ok)).toMatchObject({ kind: 'continued' }); expect(ok.calls).toHaveLength(1);
  const foreign = await harness({ rows: [{ ...consented, consent: { ...consented.consent, consentedBy: { issuer: owner.issuer, subject: '1001' } } }] });
  expect(await decide(foreign)).toMatchObject({ kind: 'escalated', case: { decision: { code: 'consent-required' } } }); expect(foreign.calls).toEqual([]);
});

it.each([
  ['N9 timeout', () => ({ status: 'failed', code: 'MODEL_INVOCATION_TIMEOUT', invocationId: 'inv-t' }), 'model-failed', 'MODEL_INVOCATION_TIMEOUT'],
  ['N9 quota', () => ({ status: 'failed', code: 'PROVIDER_QUOTA_EXHAUSTED', invocationId: null }), 'model-failed', 'PROVIDER_QUOTA_EXHAUSTED'],
  ['N9 digest mismatch', { evidenceDigest: 'f'.repeat(64) }, 'answer-invalid', 'echo-mismatch'],
  ['N26 free text note', { nextAttemptNote: 'run rm -rf and retry' }, 'answer-invalid', 'note-invalid'],
  ['N9 thrown refusal', () => { throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' }); }, 'model-failed', 'POLICY_DENIED'],
] as const)('%s: sealed escalate-human with the typed reason; no re-ask on the next pass', async (_name, answer, code, failure) => {
  const h = await harness({ answer: answer as Answer });
  expect(await decide(h)).toMatchObject({ kind: 'escalated', case: { decision: { code } } });
  expect(h.sealed()).toEqual([expect.objectContaining({ action: 'escalate-human', code, failure })]);
  expect(await decide(h)).toMatchObject({ kind: 'escalated' }); expect(h.calls).toHaveLength(1);
});

it('the model handing the case to a person is sealed as its choice (`human-chosen`) and the Run is held', async () => {
  const h = await harness({ answer: { action: 'escalate-human', causeClass: 'task-induced', nextAttemptNote: null } });
  expect(await decide(h)).toMatchObject({ kind: 'escalated', case: { decision: { code: 'human-chosen' } } });
  expect(h.sealed()).toEqual([expect.objectContaining({ action: 'escalate-human', code: 'human-chosen', causeClass: 'task-induced' })]);
  expect(h.holds).toHaveLength(1);
});

it('shadow-decide (phase 1): a Run frozen in shadow seals what would happen and changes nothing — no case row, no hold, no continuation, even when config says live', async () => {
  const h = await harness({ policy: shadow }), before = await h.store.loadRun('s', 'run');
  expect(await decide(h, 'live')).toMatchObject({ kind: 'shadow', action: 'continue-new-attempt' });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.commandId).not.toBe(recoveryDecisionCommandId(h.caseId, JSON.parse(h.calls[0]!.messages[1]!.content).evidenceDigest, 'live'));
  expect(h.sealed()).toEqual([expect.objectContaining({ mode: 'shadow', action: 'continue-new-attempt', standingRef: null })]);
  expect(h.cases()).toEqual([]); expect(h.holds).toEqual([]); expect(await h.store.loadRun('s', 'run')).toEqual(before);
  expect(await decide(h, 'live')).toMatchObject({ kind: 'shadow', replay: true }); expect(h.calls).toHaveLength(1);
  // A live Run under a shadow config is shadow too (the stricter mode wins); a refused gate is sealed in shadow without a model call.
  const capped = await harness();
  await capped.store.claimEffect(effectIntent('open-2', { producer: { kind: 'attempt', identity: capped.identity } }));
  expect(await decide(capped, 'shadow')).toMatchObject({ kind: 'shadow', action: 'escalate-human', code: 'effects-open' });
  expect(capped.calls).toEqual([]); expect(capped.cases()).toEqual([]); expect(capped.holds).toEqual([]);
});

it('N27: a Run admitted without frozen recovery is never decided; N14: only the recovery principal decides', async () => {
  const off = await harness({ policy: null });
  expect(await decide(off)).toEqual({ kind: 'skipped', reason: 'off' }); expect(off.calls).toEqual([]); expect(off.sealed()).toEqual([]);
  const h = await harness();
  h.state.principal = { ...owner, ...nervousPrincipalRef(owner), assurance: 'workload-verified' } as VerifiedPrincipal;
  await expect(decide(h)).rejects.toMatchObject({ code: 'RECOVERY_PRINCIPAL_REQUIRED' });
  h.state.principal = owner as VerifiedPrincipal;
  await expect(decide(h)).rejects.toMatchObject({ code: 'RECOVERY_PRINCIPAL_REQUIRED' });
  expect(h.calls).toEqual([]); expect(h.sealed()).toEqual([]);
});

// S6R-6 (lead item 3): the circuit breaker is read from the sealed decisions, so it survives a restart and is bounded by registry values; a case
// already decided by its model in shadow is not asked again after the switch to live.
const priorSeal = async (path: string, eventId: string, atMs: number, extra: Record<string, unknown> = {}) => {
  const audit = await openSqliteAuditStore(path, LEDGER_OPTIONS);
  try {
    const ref = recoveryPrincipalRef(owner);
    new AuditApplication(audit, lostIntegrity).record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId, scopeId: 's', principal: { issuer: ref.issuer, subject: ref.subject },
      policyRevision: 'owner-policy', atMs, subject: { kind: 'recovery-decision', caseId: 'e'.repeat(64), mode: 'live', evidenceDigest: 'd'.repeat(64),
        target: { runId: 'other', taskId: 't', attemptId: 'x', generation: 1 }, gate: { result: 'clear', settled: 'none', intents: 0 }, terminationReceiptId: 'release-x',
        model: { channelId: 'channel-a', modelId: 'model-a', template: { id: 'recovery-decision', version: 1 }, registryRevision: 'r', inputDigest: 'a'.repeat(64), outputDigest: null, invocationId: null },
        action: 'escalate-human', causeClass: null, note: null, code: 'model-failed', failure: 'MODEL_INVOCATION_TIMEOUT', standingRef: null, ...extra } });
  } finally { audit.close(); }
};
const narrow = { ...RECOVERY_DECISION_SEED as object, breaker: { maxCasesPerWindow: 1, windowMs: 10, scanLimit: 16 } };

it('persistent breaker: a model call sealed before a restart counts in a fresh application; one outside the window or adopted from shadow does not', async () => {
  const counted = await harness({ registry: narrow });
  await priorSeal(counted.path, 'recovery-decision:prior-in-window', 35);
  expect(await decide(counted, 'live', counted.make())).toMatchObject({ kind: 'escalated', case: { decision: { code: 'breaker-open' } } });
  expect(counted.calls).toEqual([]);
  const old = await harness({ registry: narrow });
  await priorSeal(old.path, 'recovery-decision:prior-old', 5); // since = 40 - 10 + 1 = 31: older than the window
  await priorSeal(old.path, 'recovery-decision:prior-adopted', 36, { basis: 'shadow' }); // the same call as its shadow seal: not a second call
  await priorSeal(old.path, 'recovery-decision:prior-deterministic', 37, { model: null, code: 'no-eligible-model', failure: null }); // nothing spent
  expect(await decide(old, 'live', old.make())).toMatchObject({ kind: 'continued' }); expect(old.calls).toHaveLength(1);
});

it('persistent breaker is bounded: a window holding scanLimit decision seals without reaching the bound counts as open (fail closed, no call)', async () => {
  const h = await harness({ registry: { ...RECOVERY_DECISION_SEED as object, breaker: { maxCasesPerWindow: 8, windowMs: 3600000, scanLimit: 2 } } });
  for (const id of ['a', 'b']) await priorSeal(h.path, `recovery-decision:prior-${id}`, 30, { model: null, code: 'no-eligible-model', failure: null });
  expect(await decide(h)).toMatchObject({ kind: 'escalated', case: { decision: { code: 'breaker-open' } } }); expect(h.calls).toEqual([]);
});

it('shadow → live: a case its model decided in shadow is not asked again; the live seal adopts it (basis shadow) and the continuation applies', async () => {
  const h = await harness();
  expect(await decide(h, 'shadow')).toMatchObject({ kind: 'shadow', action: 'continue-new-attempt' }); expect(h.calls).toHaveLength(1);
  expect(h.cases()).toEqual([]);
  expect(await decide(h, 'live', h.make())).toMatchObject({ kind: 'continued', case: { state: 'applied', decision: { note: 'previous-attempt-launcher-died' } } });
  expect(h.calls).toHaveLength(1);
  const [shadowSeal, liveSeal] = h.sealed();
  expect(shadowSeal).toMatchObject({ mode: 'shadow', standingRef: null });
  // The shadow seal names no grant: the adoption re-derives it now (lead decision, R-DESIGN §9).
  expect(liveSeal).toMatchObject({ mode: 'live', basis: 'shadow', action: 'continue-new-attempt', model: shadowSeal.model, standingRef: 'recovery-standing' });
  expect(await decide(h, 'live', h.make())).toMatchObject({ kind: 'continued', replay: true }); expect(h.calls).toHaveLength(1);
});

it('shadow → live: a shadow seal without a model (a deterministic escalation, nothing spent) is decided afresh once the cause is gone', async () => {
  const h = await harness({ rows: [] });
  expect(await decide(h, 'shadow')).toMatchObject({ kind: 'shadow', action: 'escalate-human', code: 'no-eligible-model' }); expect(h.calls).toEqual([]);
  h.state.rows = [metered];
  expect(await decide(h, 'live')).toMatchObject({ kind: 'continued' }); expect(h.calls).toHaveLength(1);
  expect(h.sealed().at(-1)).toMatchObject({ mode: 'live', action: 'continue-new-attempt' }); expect(h.sealed().at(-1)).not.toHaveProperty('basis');
});

it('a shadow model decision of other evidence is never adopted: the changed case is decided by its own call', async () => {
  const h = await harness();
  expect(await decide(h, 'shadow')).toMatchObject({ kind: 'shadow' });
  const settled = await h.store.claimEffect(effectIntent('late-1', { producer: { kind: 'attempt', identity: h.identity } }));
  await h.store.saveEffect(settled, effectRecordSchema.parse({ ...settled, state: 'refused', refusal: 'EFFECT_REJECTED' })); // the gate now sees one reconciled intent
  expect(await decide(h, 'live')).toMatchObject({ kind: 'continued' }); expect(h.calls).toHaveLength(2);
  expect(h.sealed().at(-1)).not.toHaveProperty('basis');
});

it('revoked grant between the sealed decision and its apply: the case ends escalated with a hold, never left gated for a retry', async () => {
  const h = await harness(); h.state.crash = true;
  await expect(decide(h)).rejects.toThrow('CRASH_AFTER_SEAL');
  h.state.document = { ...standing, grants: [] };
  expect(await decide(h, 'live', h.make())).toMatchObject({ kind: 'escalated', case: { state: 'escalated', decision: { code: 'continuation-not-approved' } } });
  expect(h.cases()).toEqual([{ state: 'escalated', revision: 2 }]); expect(h.holds).toHaveLength(1); expect(h.calls).toHaveLength(1);
  expect(await decide(h, 'live', h.make())).toMatchObject({ kind: 'escalated', replay: true }); expect(h.calls).toHaveLength(1);
});

it('alpha.56 G1: a would-stop case is decided in shadow only — the model is asked without the grant, the seal says would-stop, live never adopts or stores it; the breaker counts it', async () => {
  const h = await harness({ wouldStop: true, document: { ...standing, grants: [] } }), before = await h.store.loadRun('s', 'run');
  expect(await decide(h, 'live')).toMatchObject({ kind: 'shadow', action: 'continue-new-attempt', replay: false });
  expect(h.calls).toHaveLength(1);
  expect(JSON.parse(h.calls[0]!.messages[1]!.content).evidence.termination).toEqual({ kind: 'supervisor-exit', exitCode: null }); // what a live stop would yield
  expect(h.sealed()).toEqual([expect.objectContaining({ mode: 'shadow', basis: 'would-stop', terminationReceiptId: null, standingRef: null, action: 'continue-new-attempt' })]);
  expect(h.cases()).toEqual([]); expect(h.holds).toEqual([]); expect(await h.store.loadRun('s', 'run')).toEqual(before);
  await expect(h.app.assess({ schemaVersion: 1, scopeId: 's', caseId: h.caseId })).rejects.toMatchObject({ code: 'RECOVERY_OFF' });
  expect(await decide(h, 'live')).toMatchObject({ kind: 'shadow', replay: true }); expect(h.calls).toHaveLength(1);
  // A shadow continuation adopted after the switch without a grant is sealed to a person, never applied on the shadow seal's null grant.
  const adopted = await harness({ document: { ...standing, grants: [] } });
  expect(await decide(adopted, 'shadow')).toMatchObject({ kind: 'shadow', action: 'continue-new-attempt' }); expect(adopted.calls).toHaveLength(1);
  expect(await decide(adopted, 'live', adopted.make())).toMatchObject({ kind: 'escalated', case: { decision: { code: 'continuation-not-approved' } } });
  expect(adopted.calls).toHaveLength(1);
  // The breaker counts a would-stop shadow call like any other model call.
  const counted = await harness({ registry: narrow });
  await priorSeal(counted.path, 'recovery-decision:shadow:prior-would-stop', 35, { mode: 'shadow', basis: 'would-stop', terminationReceiptId: null });
  expect(await decide(counted, 'live', counted.make())).toMatchObject({ kind: 'escalated', case: { decision: { code: 'breaker-open' } } }); expect(counted.calls).toEqual([]);
});

it('alpha.56 G4: the blind review lists a model-decided case without its choice, seals one verdict per case as a person, then reveals; AI is refused; the view counts it', async () => {
  const h = await harness({ wouldStop: true });
  await decide(h, 'shadow');
  const audit = await openSqliteAuditStore(h.path, LEDGER_OPTIONS); closers.push(() => audit.close());
  const ledger = new AuditApplication(audit, lostIntegrity), person = owner as VerifiedPrincipal, authorized: string[] = [];
  const ports = { listRecentKind: (scopeId: string, kind: 'recovery-detection' | 'recovery-decision' | 'recovery-verdict', since: number, limit: number) => ledger.listRecentKind(scopeId, kind, since, limit),
    loadRun: (scopeId: string, runId: string) => h.store.loadRun(scopeId, runId), load: (scopeId: string, eventId: string) => ledger.load(scopeId, eventId),
    record: (event: unknown) => ledger.record(event), authorize: async (_principal: VerifiedPrincipal, scopeId: string) => { authorized.push(scopeId); },
    interactive: async () => true, policyRevision: 'owner-policy', now: () => 50 };
  const review = new RecoveryReviewApplication(ports);
  const [item] = await review.pending({ schemaVersion: 1, scopeId: 's' }, person);
  expect(item).toMatchObject({ caseId: h.caseId, decisionEventId: `recovery-decision:shadow:${h.caseId}`, rule: { id: 'launcher-dead-orphan', version: 1 }, wouldStop: true, attempts: 1 });
  expect(JSON.stringify(item)).not.toMatch(/continue-new-attempt|escalate-human/u); // blind
  const answer = { schemaVersion: 1, scopeId: 's', caseId: h.caseId, detection: 'lost', choice: 'escalate-human' };
  await expect(review.answer(answer, { ...person, ...mcpPrincipalRef(person), assurance: 'workload-verified' } as VerifiedPrincipal)).rejects.toMatchObject({ code: 'AI_AUTHORITY_NON_DELEGABLE' });
  await expect(new RecoveryReviewApplication({ ...ports, interactive: async () => false }).answer(answer, person)).rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
  expect(await review.answer(answer, person)).toEqual({ status: 'recorded', caseId: h.caseId, detection: 'lost', choice: 'escalate-human',
    model: { action: 'continue-new-attempt', causeClass: 'infra-transient' }, agreed: false });
  expect(await review.answer(answer, person)).toMatchObject({ status: 'current' });
  await expect(review.answer({ ...answer, detection: 'not-lost', choice: null }, person)).rejects.toMatchObject({ code: 'RECOVERY_VERDICT_CONFLICT' });
  expect(await review.pending({ schemaVersion: 1, scopeId: 's' }, person)).toEqual([]);
  expect(authorized.length).toBeGreaterThan(0);
  // The audit writer itself refuses a verdict from a workload (MCP) reference, whatever the caller.
  expect(() => ledger.record({ schemaVersion: 1, eventId: 'recovery-verdict:forged', scopeId: 's', principal: mcpPrincipalRef(person), policyRevision: 'p', atMs: 1,
    subject: { kind: 'recovery-verdict', caseId: 'f'.repeat(64), decisionEventId: 'x', evidenceDigest: 'f'.repeat(64), detection: 'not-lost', choice: null } })).toThrow('AUDIT_INVALID');
  // The view measures the reviewed case from the sealed records only: one decided, no agreement.
  const rollout = await readRecoveryRollout(ports, 's', [{ id: 'launcher-dead-orphan', version: 1 }]);
  expect(rollout.rules).toEqual([expect.objectContaining({ id: 'launcher-dead-orphan', shadowCases: 1, falsePositives: 0 })]);
  expect(rollout.decisions).toMatchObject({ decided: 1, agreements: 0, waiting: 0, met: false });
});
