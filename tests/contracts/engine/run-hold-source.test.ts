import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteApprovalStore } from '#adapters/index.js';
import { createRun, holdRun, parkRunProgression, releaseRunQuota, runSnapshotSchema, policySchema, aiAuthorityFloor, evaluatePolicy, type VerifiedPrincipal, type RunSnapshot } from '#domain/index.js';
import { RunLifecycleApplication, RunDecisionApprovalBroker, RunPolicyAuthorization, DispatchPolicyAuthorization, AuditApplication, proposeRunLifecycleWrite } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

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
async function fixture(snapshot: RunSnapshot) {
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
    audit => ({ record(event) { audits.push(event); return new AuditApplication(audit, integrity).record(event); } }), () => 100, 1000, 'p', broker);
  const raw = () => { const read = new DatabaseSync(path, { readOnly: true }); try { return String(read.prepare('SELECT snapshot FROM runs WHERE run_id=?').get('r')!.snapshot); } finally { read.close(); } };
  const read = async () => (await store.loadRun('s', 'r'))!;
  return { lifecycle, store, audits, raw, read,
    as(value: VerifiedPrincipal, tty = true) { person = value; witness = tty; }, delegate() { delegated = true; } };
}

it.each(['nervous', 'auditor'] as const)('a %s hold is resumed only by a person at a terminal; AI, MCP and scripts are refused even with the resume cell', async holdSource => {
  const f = await fixture(baseRun()); f.delegate(); f.as(ai);
  const held = await f.lifecycle.holdFrom(holdSource, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'safety-hold', expectedRevision: 0, holdReason: 'Out-of-scope write seen' });
  expect(held.snapshot.state).toMatchObject({ kind: 'parked', reason: 'operator-hold', holdSource, note: 'Out-of-scope write seen' });
  expect(f.audits[0]).toMatchObject({ subject: { action: 'hold', deciderClass: 'system', holdSource } });
  for (const [actor, tty] of [[ai, true], [ai, false], [human, false]] as const) {
    f.as(actor, tty);
    await expect(f.lifecycle.execute(command('resume', held.snapshot.revision, { commandId: `resume-${actor.id}-${tty}` }))).rejects.toMatchObject({ code: 'RUN_HOLD_PERSON_REQUIRED' });
  }
  // The public control can neither replace nor downgrade the safety hold.
  await expect(f.lifecycle.execute(command('hold', held.snapshot.revision, { holdReason: 'replace it' }))).rejects.toMatchObject({ code: 'RUN_PARKED' });
  expect(await f.read()).toEqual(held.snapshot); expect(f.audits).toHaveLength(1);
  f.as(human, true);
  const resume = command('resume', held.snapshot.revision), resumed = await f.lifecycle.execute(resume);
  expect(resumed.snapshot.state).toEqual({ kind: 'running' });
  expect(f.audits[1]).toMatchObject({ subject: { action: 'resume', deciderClass: 'human-tty', holdSource } });
  // Double resume is idempotent: the same command returns its receipt; a new one finds nothing held and writes nothing.
  expect(await f.lifecycle.execute(resume)).toEqual(resumed);
  await expect(f.lifecycle.execute({ ...resume, commandId: 'resume-again', expectedRevision: resumed.snapshot.revision })).rejects.toMatchObject({ code: 'RUN_NOT_PARKED' });
  expect(f.audits).toHaveLength(2); expect((await f.read()).revision).toBe(resumed.snapshot.revision);
});

it('the ledger floor refuses an AI resume of a safety hold even when the write carries a forged ai-policy or human-tty decision', () => {
  const held = holdRun(baseRun(), 0, 'Nervous pause', 10, 1000, 'nervous');
  const write = { ...command('resume', held.revision), actor: { id: ai.id, issuer: ai.issuer, subject: ai.subject, assurance: ai.assurance }, now: 20, timeoutMs: 1000 };
  for (const decision of [{ deciderClass: 'ai-policy', ruleId: 'run-decision-resume-ai' }, { deciderClass: 'human-tty' }, { deciderClass: 'system' }])
    expect(() => proposeRunLifecycleWrite(held, { ...write, decision: { schemaVersion: 1, policyRevision: 'p', ...decision } } as never, true)).toThrow('RUN_HOLD_PERSON_REQUIRED');
  const person = { ...write, actor: { id: human.id, issuer: human.issuer, subject: human.subject, assurance: human.assurance } };
  expect(() => proposeRunLifecycleWrite(held, person as never, true)).toThrow('RUN_HOLD_PERSON_REQUIRED');
  expect(proposeRunLifecycleWrite(held, { ...person, decision: { schemaVersion: 1, deciderClass: 'human-tty', policyRevision: 'p' } } as never, true).state).toEqual({ kind: 'running' });
  for (const id of ['nervous', 'auditor']) {
    expect(aiAuthorityFloor(ai, { kind: 'run-hold', id }, 'resume')).toBe(true);
    expect(evaluatePolicy({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [grant('run-hold', ['resume'], ai)] },
      { principal: ai, scopeId: 's', action: 'resume', resource: { kind: 'run-hold', id } })).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
  }
  expect(aiAuthorityFloor(ai, { kind: 'run-hold', id: 'operator' }, 'resume')).toBe(false);
});

it('an operator hold keeps the earlier stored shape and resumes by a decision: AI needs the explicit cell, an unwitnessed script is refused', async () => {
  const f = await fixture(baseRun()); f.as(ai);
  const held = await f.lifecycle.execute(command('hold', 0, { holdReason: 'Release window' }));
  expect(JSON.parse(f.raw()).state).toEqual({ kind: 'parked', reason: 'operator-hold', note: 'Release window', since: 100, deadline: 1100 });
  await expect(f.lifecycle.execute(command('resume', held.snapshot.revision))).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  f.as(human, false);
  await expect(f.lifecycle.execute(command('resume', held.snapshot.revision, { commandId: 'script-resume' }))).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  expect(f.audits).toHaveLength(1);
  f.delegate(); f.as(ai);
  const resumed = await f.lifecycle.execute(command('resume', held.snapshot.revision));
  expect(resumed.snapshot.state).toEqual({ kind: 'running' });
  expect(f.audits[1]).toMatchObject({ subject: { action: 'resume', deciderClass: 'ai-policy', decisionRuleId: 'run-decision-resume-close-ai' } });
  expect((f.audits[1] as { subject: object }).subject).not.toHaveProperty('holdSource');
});

it('a safety hold upgrades an operator hold, survives an overlay round trip, and its overlay is lifted only by a person', async () => {
  const upgraded = holdRun(holdRun(baseRun(), 0, 'operator note', 10, 1000), 1, 'Auditor park', 20, 1000, 'auditor');
  expect(upgraded.state).toEqual({ kind: 'parked', reason: 'operator-hold', note: 'Auditor park', holdSource: 'auditor', since: 10, deadline: 1010 });
  expect(() => holdRun(upgraded, upgraded.revision, 'again', 30, 1000, 'nervous')).toThrow('RUN_PARKED');
  // Overlay on a quota park; when the quota is released the overlay becomes the Run's hold state with its source intact.
  const overlaid = holdRun(quotaRun(), 0, 'Nervous pause', 20, 1000, 'nervous');
  expect(overlaid.state).toMatchObject({ reason: 'quota-exhausted', operatorHold: { schemaVersion: 1, note: 'Nervous pause', source: 'nervous' } });
  expect(releaseRunQuota(overlaid, 'channel', 30)!.state).toEqual({ kind: 'parked', reason: 'operator-hold', note: 'Nervous pause', holdSource: 'nervous', since: 10, deadline: 1010 });
  // The source belongs to a hold only.
  expect(() => runSnapshotSchema.parse({ ...quotaRun(), state: { ...quotaRun().state, holdSource: 'nervous' } })).toThrow('RUN_SNAPSHOT_INCONSISTENT');
  const progression = parkRunProgression(baseRun(), 0, 'PROGRESSION_FAILED', 10, 1000), f = await fixture(progression); f.delegate(); f.as(ai);
  const held = await f.lifecycle.holdFrom('nervous', { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'pause', expectedRevision: progression.revision, holdReason: 'Nervous pause' });
  await expect(f.lifecycle.execute(command('resume', held.snapshot.revision))).rejects.toMatchObject({ code: 'RUN_HOLD_PERSON_REQUIRED' });
  f.as(human, true);
  expect((await f.lifecycle.execute(command('resume', held.snapshot.revision, { commandId: 'person' }))).snapshot.state).toEqual(progression.state);
});
