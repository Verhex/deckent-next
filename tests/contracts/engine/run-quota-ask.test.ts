import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteApprovalStore } from '#adapters/index.js';
import { createRun, advanceRunLifecycle, policySchema, aiAuthorityFloor, type VerifiedPrincipal, type RunSnapshot } from '#domain/index.js';
import { RunLifecycleApplication, RunDecisionApprovalBroker, RunPolicyAuthorization, DispatchPolicyAuthorization, AuditApplication, proposeRunLifecycleWrite } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

// S9 quota ask (owner L-A): the answer to an expired subscription-quota wait is a person's. Adapted from the S5b HOLD-RESUME fixture.
// S5b HOLD-RESUME (Auditor owner decision 6, 2026-10-17; PROGRAM law-audit fold 5): a safety hold (Nervous pause, Auditor park) is a separate hold
// source; only a person at a terminal resumes it. The public Run control keeps its `operator` source and resumes through a decision: a witnessed
// person, or an AI actor that holds the explicit `run-decision resume` cell (MCP1). Reading these holds never needs the new source field.
const roots: string[] = [], closers: (() => void)[] = [];
afterEach(async () => { closers.splice(0).forEach(close => close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const human: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['s'] };
const ai: VerifiedPrincipal = { ...human, id: 'ai', issuer: 'host/mcp', assurance: 'workload-verified' };
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['ok'] }],
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const command = (action: string, revision: number, extra = {}) => ({ schemaVersion: 1, scopeId: 's', runId: 'r', expectedRevision: revision, commandId: `cmd-${action}`, action, ...extra });
const grant = (kind: string, actions: string[], person: VerifiedPrincipal) => ({ id: `${kind}-${actions.join('-')}-${person.id}`, effect: 'allow' as const,
  principals: [{ issuer: person.issuer, subject: person.subject }], scopes: ['s'], actions, resource: { kind, ids: 'all' as const } });
const baseRun = () => createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
function quotaRun(): RunSnapshot {
  const run = baseRun(), identity = { ...run.identity, taskId: 't', attemptId: 'quota-a', generation: 1 };
  return { ...run, state: { kind: 'parked', reason: 'quota-exhausted', since: 10, deadline: 1010 },
    execution: { ...run.execution, tasks: run.execution.tasks.map(task => ({ ...task, profile: { ...task.profile, parameters: { ...task.profile.parameters,
      nativeSubscription: { schemaVersion: 2, provider: 'codex', model: { channelId: 'channel', modelId: 'fixture-model', auxiliaryModelIds: [] }, modelUsageEvidence: 'none' } } } })) },
    bindings: [{ identity, observedKind: 'quota-exhausted', observedRevision: 1 }],
    quotaWaits: [{ identity, channelId: 'channel', quota: { source: 'codex-text', resetsAtMs: null }, evidenceDigest: 'a'.repeat(64), since: 10, deadline: 1010, maxResumes: 1 }] };
}
async function fixture(snapshot: RunSnapshot, withQuota = true) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-hold-source-')); roots.push(root);
  const path = join(root, 'ledger.db'), store = await openSqliteAttemptStore(path, options, { now: () => 100, timeoutMs: 1000 }); closers.push(() => store.close());
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await store.createRun({ commandId: 'create', actor: { id: human.id, issuer: human.issuer, subject: human.subject }, identity: snapshot.identity,
    graph, execution: snapshot.execution, now: 0, policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
  const db = new DatabaseSync(path);
  try { db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=?').run(snapshot.revision, JSON.stringify(snapshot), 's', 'r'); } finally { db.close(); }
  const approvals = openSqliteApprovalStore(path, options); closers.push(() => approvals.close());
  let person = human, witness = true, delegated = false;
  // Every actor holds the ordinary Run control grants; `delegate()` adds the explicit `run-decision resume` cell (the strongest AI policy there is).
  const source = { async load() { return policySchema.parse({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [human, ai].flatMap(actor => [
    grant('run', ['reserve', 'cancel', 'inspect'], actor), ...(delegated ? [grant('run-decision', ['resume', 'close'], actor)] : [])]) }); } };
  const verifier = { async verify() { return person; } }, integrity = createHmacIntegrity('test', new Uint8Array(32).fill(1)), audits: unknown[] = [];
  const broker = new RunDecisionApprovalBroker(approvals.store, integrity, source, async principal => witness && principal.assurance === 'os-user', () => 100, 1000, 1000, 'en');
  const lifecycle = new RunLifecycleApplication(store, verifier, new RunPolicyAuthorization(source),
    { authorize: (identity, principal) => new DispatchPolicyAuthorization(source).authorizeIdentity('evaluate', identity, principal) },
    audit => ({ record(event) { audits.push(event); return new AuditApplication(audit, integrity).record(event); } }), () => 100, 1000, 'p', broker, withQuota ? { maxWaitMs: 5000, maxRewaits: 1 } : undefined);
  const raw = () => { const read = new DatabaseSync(path, { readOnly: true }); try { return String(read.prepare('SELECT snapshot FROM runs WHERE run_id=?').get('r')!.snapshot); } finally { read.close(); } };
  const read = async () => (await store.loadRun('s', 'r'))!;
  return { lifecycle, store, audits, raw, read,
    as(value: VerifiedPrincipal, tty = true) { person = value; witness = tty; }, delegate() { delegated = true; } };
}


const asked = (): RunSnapshot => { const run = quotaRun(); return advanceRunLifecycle(run, run.revision, 1010, 1000); };
const quotaCommand = (revision: number, choice: string, commandId = `cmd-${choice}`) => command('quota-answer', revision, { choice, commandId });

it('AI, MCP, a delegated decision cell and an unwitnessed script cannot answer the quota question; nothing is written or cancelled', async () => {
  const ask = asked(), f = await fixture(ask); f.delegate();
  for (const [actor, tty] of [[ai, true], [ai, false], [human, false]] as const) {
    f.as(actor, tty);
    await expect(f.lifecycle.execute(quotaCommand(ask.revision, 'wait', `try-${actor.id}-${tty}`))).rejects.toMatchObject({ code: expect.stringMatching(/RUN_QUOTA_PERSON_REQUIRED|TASK_DECISION_HUMAN_REQUIRED/u) });
  }
  expect(await f.read()).toEqual(ask); expect(f.audits).toHaveLength(0);
  expect(aiAuthorityFloor(ai, { kind: 'run-quota', id: 'ask' }, 'answer')).toBe(true); expect(aiAuthorityFloor(human, { kind: 'run-quota', id: 'ask' }, 'answer')).toBe(false);
  // The ledger floor refuses a forged write as well.
  const write = { ...quotaCommand(ask.revision, 'wait'), action: 'quota-answer', quotaChoice: 'wait', quotaWaitMs: 5000, quotaMaxRewaits: 1, now: 2000, timeoutMs: 1000,
    actor: { id: ai.id, issuer: ai.issuer, subject: ai.subject, assurance: ai.assurance } };
  delete (write as { choice?: string }).choice;
  for (const decision of [undefined, { deciderClass: 'ai-policy', ruleId: 'x' }, { deciderClass: 'human-tty' }])
    expect(() => proposeRunLifecycleWrite(ask, { ...write, ...(decision ? { decision: { schemaVersion: 1, policyRevision: 'p', ...decision } } : {}) } as never, true)).toThrow(/RUN_QUOTA_PERSON_REQUIRED|TASK_DECISION_HUMAN_REQUIRED/u);
});
it('a witnessed person keeps waiting (counted, bounded by config) or takes the next candidate; the audit names the person and the Run is never cancelled', async () => {
  const ask = asked(), f = await fixture(ask); f.as(human, true);
  const waited = await f.lifecycle.execute(quotaCommand(ask.revision, 'wait'));
  expect(waited.snapshot.state).toMatchObject({ kind: 'parked', reason: 'quota-exhausted', deadline: 5100 });
  expect(waited.snapshot.quotaWaits![0]).toMatchObject({ rewaits: 1 });
  expect(f.audits[0]).toMatchObject({ subject: { action: 'quota-answer', deciderClass: 'human-tty' } });
  expect(await f.lifecycle.execute(quotaCommand(ask.revision, 'wait'))).toEqual(waited);
  // The re-armed wait runs out again: the person is asked again; the configured number of re-waits (1) is used up, so waiting is refused, the Run stays asking.
  const again = advanceRunLifecycle(waited.snapshot, waited.snapshot.revision, 5100, 1000), g = await fixture(again); g.as(human, true);
  expect(again.state).toMatchObject({ reason: 'quota-ask' });
  await expect(g.lifecycle.execute(quotaCommand(again.revision, 'wait', 'wait-again'))).rejects.toMatchObject({ code: 'RUN_QUOTA_WAIT_LIMIT' });
  expect(await g.read()).toEqual(again);
  const next = await g.lifecycle.execute(quotaCommand(again.revision, 'next-candidate'));
  expect(next.snapshot.state).toEqual({ kind: 'running' }); expect(next.snapshot.previousBindings).toHaveLength(1);
  expect(g.audits[0]).toMatchObject({ subject: { action: 'quota-answer', deciderClass: 'human-tty' } });
});
it('a lifecycle built without a quota policy refuses the answer', async () => {
  const ask = asked(), f = await fixture(ask, false); f.as(human, true);
  await expect(f.lifecycle.execute(quotaCommand(ask.revision, 'wait'))).rejects.toThrow();
  expect(await f.read()).toEqual(ask);
});
