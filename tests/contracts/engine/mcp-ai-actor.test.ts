import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteApprovalStore, readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { createRun, holdRun, parkRunProgression, policySchema, evaluatePolicy, explicitDecisionGrant, approvalDecisionClass,
  POLICY_ADMINISTER_OPERATION, AUTHORITY_DOCUMENT_TARGET_KIND, verifiedSessionSchema, type VerifiedPrincipal, type RunSnapshot } from '#domain/index.js';
import { RunLifecycleApplication, RunDecisionApprovalBroker, RunPolicyAuthorization, DispatchPolicyAuthorization, AuditApplication,
  OperationApprovalBroker, OperationPolicyAuthorization, requestAgentToolApproval, requestTaskApproval, ApprovalApplication, decideAgentToolCall } from '#engine/index.js';
import { sha256, createHmacIntegrity } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const roots: string[] = [], closers: (() => void)[] = [];
afterEach(async () => { closers.splice(0).forEach(close => close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const human: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['s'] };
const ai: VerifiedPrincipal = { ...human, id: 'ai', issuer: 'host/mcp', assurance: 'workload-verified' };
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['ok'] }],
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const command = (action: string, revision: number, extra = {}) => ({ schemaVersion: 1, scopeId: 's', runId: 'r', expectedRevision: revision, commandId: `cmd-${action}`, action, ...extra });
const grant = (kind: string, actions: string[] | 'all', person = ai, ids: string[] | 'all' = 'all') => ({ id: `${kind}-${typeof actions === 'string' ? actions : actions.join('-')}-${person.id}`,
  effect: 'allow' as const, principals: [{ issuer: person.issuer, subject: person.subject }], scopes: ['s'], actions, resource: { kind, ids } });
function baseRun() { return createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph)); }
function quotaRun(): RunSnapshot {
  const run = baseRun(), identity = { ...run.identity, taskId: 't', attemptId: 'quota-a', generation: 1 };
  return { ...run, state: { kind: 'parked', reason: 'quota-exhausted', since: 10, deadline: 1010 },
    execution: { ...run.execution, tasks: run.execution.tasks.map(task => ({ ...task, profile: { ...task.profile, parameters: { ...task.profile.parameters,
      nativeSubscription: { schemaVersion: 2, provider: 'codex', model: { channelId: 'channel', modelId: 'fixture-model', auxiliaryModelIds: [] }, modelUsageEvidence: 'none' } } } })) },
    bindings: [{ identity, observedKind: 'quota-exhausted', observedRevision: 1 }],
    quotaWaits: [{ identity, channelId: 'channel', quota: { source: 'codex-text', resetsAtMs: null }, evidenceDigest: 'a'.repeat(64), since: 10, deadline: 1010, maxResumes: 1 }] };
}
async function fixture(snapshot: RunSnapshot, grants: unknown[] = [], person = ai, tty = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-ai-')); roots.push(root);
  const path = join(root, 'ledger.db'), store = await openSqliteAttemptStore(path, options, { now: () => 100, timeoutMs: 1000 }); closers.push(() => store.close());
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await store.createRun({ commandId: 'create', actor: { id: human.id, issuer: human.issuer, subject: human.subject }, identity: snapshot.identity,
    graph, execution: snapshot.execution!, now: 0, policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
  const db = new DatabaseSync(path);
  try { db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=?').run(snapshot.revision, JSON.stringify(snapshot), 's', 'r'); } finally { db.close(); }
  const approvals = openSqliteApprovalStore(path, options); closers.push(() => approvals.close());
  let now = 100, witness = tty;
  let policy = policySchema.parse({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [grant('run', ['reserve', 'cancel', 'inspect'], person),
    grant('attempt', ['evaluate'], person), grant('approval', ['inspect', 'decide'], person), ...grants] });
  const source = { async load() { return policy; } }, verifier = { async verify() { return person; } }, integrity = createHmacIntegrity('test', new Uint8Array(32).fill(1));
  const broker = new RunDecisionApprovalBroker(approvals.store, integrity, source, async () => witness, () => now, 1000, 1000, 'en');
  const audits: unknown[] = [];
  const lifecycle = new RunLifecycleApplication(store, verifier, new RunPolicyAuthorization(source),
    { authorize: (identity, principal) => new DispatchPolicyAuthorization(source).authorizeIdentity('evaluate', identity, principal) },
    audit => ({ record(event) { audits.push(event); return new AuditApplication(audit, integrity).record(event); } }), () => now, 1000, 'p', broker);
  const session = verifiedSessionSchema.parse({ schemaVersion: 1, sessionId: 'session', authorityRef: 'authority', kind: person.assurance,
    principalRef: { id: person.id, issuer: person.issuer, subject: person.subject }, scopeIds: ['s'], authenticatedAt: 0, expiresAt: 100000 });
  const sessions = { async verifySession() { return { principal: person, session }; }, async isSessionActive() { return true; }, async revoke() {} };
  const approvalApp = new ApprovalApplication(approvals.store, verifier, sessions, source, integrity, { sample: () => ({ wallMs: now, monotonicMs: now }) },
    'local-sdk', 20, undefined, undefined, { interactive: async () => witness });
  return { lifecycle, approvals, approvalApp, audits, store, source, broker, integrity,
    witness(value: boolean) { witness = value; }, time(value: number) { now = value; }, policy(value: typeof policy) { policy = value; } };
}

it('MCP is workload identity, including legacy/forged os-user assurance', () => {
  // Native Windows has no OS-user identity to derive the MCP workload identity from: the read refuses, never a weaker identity.
  if (process.platform === 'win32') expect(() => withMcpPrincipal(() => readLocalOsIdentity())).toThrow('AUTHENTICATION_REQUIRED');
  else {
    const identity = withMcpPrincipal(() => readLocalOsIdentity());
    expect(identity.issuer.endsWith('/mcp')).toBe(true); expect(identity.assurance).toBe('workload-verified');
  }
  expect(explicitDecisionGrant({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [grant('run', ['reserve'])] }, { ...ai, assurance: 'os-user' }, 's', 'run-decision', 'r', 'resume')).toBeNull();
});
it.each(['workload-verified', 'os-user'] as const)('MCP %s cannot resume progression failure via reserve permission', async assurance => {
  const run = parkRunProgression(baseRun(), 0, 'PROGRESSION_FAILED', 10, 1000), f = await fixture(run, [], { ...ai, assurance }, true);
  await expect(f.lifecycle.execute(command('resume', run.revision))).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  expect(await f.store.loadRun('s', 'r')).toEqual(run); expect(f.audits).toEqual([]);
});
it.each(['progression-failed', 'quota-exhausted', 'needs-input'] as const)('hold then resume cannot launder %s; original timing and reason survive in SQLite', async reason => {
  const run = reason === 'progression-failed' ? parkRunProgression(baseRun(), 0, 'PROGRESSION_FAILED', 10, 1000)
    : reason === 'quota-exhausted' ? quotaRun() : { ...baseRun(), state: { kind: 'parked' as const, reason, since: 10, deadline: 1010 } };
  const f = await fixture(run), held = await f.lifecycle.execute(command('hold', run.revision, { holdReason: 'attempt to turn this into operator hold' }));
  expect(held.snapshot.state).toMatchObject({ reason, since: 10, deadline: 1010 });
  await expect(f.lifecycle.execute(command('resume', held.snapshot.revision))).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  expect((await f.store.loadRun('s', 'r'))!.state).toEqual(held.snapshot.state); expect(f.audits).toHaveLength(1);
});
// PRE-7: an environment park is resumed like a progression failure: a decision, never a workload-identity side effect.
function environmentRun(): RunSnapshot {
  const run = baseRun(), identity = { ...run.identity, taskId: 't', attemptId: 'env-a', generation: 1 };
  return { ...run, state: { kind: 'parked', reason: 'environment-not-ready', failureCode: 'typescript', since: 10, deadline: 1010 }, bindings: [{ identity, observedKind: 'launch-refused', observedRevision: 1 }] };
}
it.each(['workload-verified', 'os-user'] as const)('MCP %s cannot resume an environment park, nor launder it through a hold, without the explicit decision cell', async assurance => {
  const run = environmentRun(), f = await fixture(run, [], { ...ai, assurance }, true);
  await expect(f.lifecycle.execute(command('resume', run.revision))).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  const held = await f.lifecycle.execute(command('hold', run.revision, { holdReason: 'attempt to turn this into operator hold' }));
  expect(held.snapshot.state).toMatchObject({ reason: 'environment-not-ready', failureCode: 'typescript', since: 10, deadline: 1010 });
  await expect(f.lifecycle.execute(command('resume', held.snapshot.revision))).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
});
it('the explicit resume cell resumes an environment park as an ai-policy decision; the refused attempt moves aside', async () => {
  const run = environmentRun(), f = await fixture(run, [grant('run-decision', ['resume'])]);
  const resumed = await f.lifecycle.execute(command('resume', run.revision));
  expect(resumed.snapshot.state.kind).toBe('running'); expect(resumed.snapshot.previousBindings).toEqual([expect.objectContaining({ observedKind: 'launch-refused' })]);
  expect(f.audits[0]).toMatchObject({ subject: { action: 'resume', deciderClass: 'ai-policy' } });
});
it('explicit resume cell permits the step and records ai-policy; revocation denies replay', async () => {
  const run = parkRunProgression(baseRun(), 0, 'PROGRESSION_FAILED', 10, 1000), f = await fixture(run, [grant('run-decision', ['resume'])]);
  const resumed = await f.lifecycle.execute(command('resume', run.revision));
  expect(resumed.snapshot.state.kind).toBe('running');
  expect(f.audits[0]).toMatchObject({ subject: { action: 'resume', deciderClass: 'ai-policy', decisionRuleId: 'run-decision-resume-ai' } });
  f.policy(policySchema.parse({ schemaVersion: 1, revision: 'p2', restrictions: [], grants: [grant('run', ['reserve'])] }));
  await expect(f.lifecycle.execute(command('resume', run.revision))).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
});
it('all actions and all principals do not delegate an AI decision step', () => {
  for (const row of [grant('run-decision', 'all'), { ...grant('run-decision', ['resume']), principals: 'all' }])
    expect(explicitDecisionGrant({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [row] }, ai, 's', 'run-decision', 'r', 'resume')).toBeNull();
});
it.each([
  ['operation', 'policy.administer', 'execute'], ['authority-document', 'installation', 'write'], ['secret', 'NAME', 'read'],
  ['approval-assurance', 'level', 'write'], ['authenticator', 'owner', 'write'], ['permission-mode', 'full-access', 'set'],
  ['config', 'project:approvals.keyFile', 'write'], ['config', 'project:enforce_principal_assurance', 'write'], ['config', 'project:layout.root', 'write'],
])('AI hard floor denies %s/%s:%s even with an explicit allow', (kind, id, action) => {
  expect(evaluatePolicy({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [grant(kind!, [action!])] },
    { principal: ai, scopeId: 's', action, resource: { kind, id } })).toMatchObject({ decision: 'deny', reason: 'AI_NON_DELEGABLE' });
});
it.each(['edit-floor', 'edit-authority', 'mcp-floor'] as const)('full-access and explicit allows cannot open AI %s', cell => {
  const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [grant('agent-tool', ['invoke']), grant('operation', ['execute'])] };
  expect(decideAgentToolCall(policy, { principal: ai, scopeId: 's', tool: { name: 'write_file' }, operation: { id: 'workspace.file.write' }, cell, fullAccess: true }).decision).toBe('deny');
});
function awaiting() {
  const run = baseRun(), identity = { ...run.identity, taskId: 't', attemptId: 'a', generation: 1 };
  return { ...run, state: { kind: 'parked' as const, reason: 'awaiting-decision' as const, since: 10, deadline: 1010 },
    progress: [{ ...run.progress[0]!, phase: 'awaiting-decision' as const, decision: { reason: 'evaluation-unknown' as const, since: 10, deadline: 1010 } }],
    bindings: [{ identity, observedKind: 'exited' as const, observedRevision: 1 }] };
}
it.each(['accept', 'reject'])('SDK/script %s opens one real approval; no decision or task mutation occurs', async action => {
  const run = awaiting(), f = await fixture(run, [], human, false), input = command(action, 0, { taskId: 't' });
  for (let i = 0; i < 2; i++) await expect(f.lifecycle.execute(input)).rejects.toMatchObject({ code: 'TASK_DECISION_APPROVAL_REQUIRED' });
  const requests = f.approvals.store.list('s', null, 10); expect(requests).toHaveLength(1); expect(requests[0]!.status).toBe('pending');
  expect(await f.store.loadRun('s', 'r')).toEqual(run); expect(f.audits).toEqual([]);
  await expect(f.approvalApp.decide({ schemaVersion: 1, scopeId: 's', approvalId: requests[0]!.request.approvalId,
    commandId: 'unwitnessed', expectedRevision: 0, decision: 'allow', reason: 'pretend to be human', channel: 'local-terminal-card' })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
});
it('AI accepts only after its explicit step cell decides the routed card; wrong step cannot decide it', async () => {
  const run = awaiting(), wrong = await fixture(run, [grant('task-decision', ['reject'])]), input = command('accept', 0, { taskId: 't' });
  await expect(wrong.lifecycle.execute(input)).rejects.toMatchObject({ code: 'TASK_DECISION_APPROVAL_REQUIRED' });
  const wrongRequest = wrong.approvals.store.list('s', null, 10)[0]!;
  await expect(wrong.approvalApp.decide({ schemaVersion: 1, scopeId: 's', approvalId: wrongRequest.request.approvalId,
    commandId: 'wrong-step', expectedRevision: 0, decision: 'allow', reason: 'wrong delegated step' })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  const f = await fixture(run, [grant('task-decision', ['accept'])]);
  await expect(f.lifecycle.execute(input)).rejects.toMatchObject({ code: 'TASK_DECISION_APPROVAL_REQUIRED' });
  const request = f.approvals.store.list('s', null, 10)[0]!;
  const allow = { schemaVersion: 1, scopeId: 's', approvalId: request.request.approvalId, commandId: 'card-decision', expectedRevision: 0, decision: 'allow', reason: 'delegated task decision' };
  const decided = await f.approvalApp.decide(allow);
  expect(approvalDecisionClass(decided.decision!)).toBe('ai-policy'); expect(decided.decision).toMatchObject({ schemaVersion: 4, assurance: 'ai-policy' });
  const accepted = await f.lifecycle.execute(input); expect(accepted.snapshot.progress[0]!.phase).toBe('accepted');
  expect(f.audits[0]).toMatchObject({ subject: { deciderClass: 'ai-policy', approvalId: request.request.approvalId } });
  expect(await f.lifecycle.execute(input)).toEqual(accepted);
});
it('interactive owner path stays one step and records terminal evidence; human can decide a script card then resubmit', async () => {
  const run = awaiting(), f = await fixture(run, [], human, true);
  const result = await f.lifecycle.execute(command('accept', 0, { taskId: 't' }));
  expect(result.snapshot.progress[0]!.phase).toBe('accepted'); expect(f.audits[0]).toMatchObject({ subject: { deciderClass: 'human-tty' } });
  expect(f.approvals.store.list('s', null, 10)).toEqual([]);
});
it('pure hold preserves progression failure even when the actor is unknown', () => {
  const run = parkRunProgression(baseRun(), 0, 'PROGRESSION_FAILED', 10, 1000);
  expect(holdRun(run, run.revision, 'hold', 50, 5000).state).toMatchObject({ reason: 'progression-failed', since: 10, deadline: 1010 });
});

it.each(['edit-floor', 'edit-authority', 'mcp-floor'])('the approval card itself refuses AI %s even with decide permission', async cell => {
  const f = await fixture(baseRun());
  const card = requestAgentToolApproval(f.approvals.store, f.integrity, { scopeId: 's', requester: { id: ai.id, issuer: ai.issuer, subject: ai.subject },
    subject: { kind: 'agent-tool-call', turnId: 'turn', round: 1, index: 0, tool: 'write_file', toolVersion: 1, resource: 'protected-file', argsDigest: 'a'.repeat(64) },
    policyRevision: 'p', summary: 'Risky protected write', createdAt: 10, expiresAt: 1010,
    facts: { risk: { source: 'cell', cell }, reversibility: null, onExpiry: 'nothing-runs', requiredAssurance: 'turn-bound' } });
  await expect(f.approvalApp.decide({ schemaVersion: 1, scopeId: 's', approvalId: card.request.approvalId, commandId: 'risky-approval',
    expectedRevision: 0, decision: 'allow', reason: 'explicit policy says allow' })).rejects.toMatchObject({ code: 'AI_AUTHORITY_NON_DELEGABLE' });
  expect(f.approvals.store.load('s', card.request.approvalId)).toEqual(card); expect(f.approvals.store.receipt('s', 'risky-approval')).toBeNull();
});
it('script card waits for a witnessed decision, admits only its bound command and refuses expiry', async () => {
  const f = await fixture(awaiting(), [], human, false), input = command('reject', 0, { taskId: 't' });
  await expect(f.lifecycle.execute(input)).rejects.toMatchObject({ code: 'TASK_DECISION_APPROVAL_REQUIRED' });
  const record = f.approvals.store.list('s', null, 10)[0]!;
  f.witness(true);
  const decided = await f.approvalApp.decide({ schemaVersion: 1, scopeId: 's', approvalId: record.request.approvalId,
    commandId: 'witnessed', expectedRevision: 0, decision: 'allow', reason: 'reviewed this rejection' });
  expect(decided.decision).toMatchObject({ deciderClass: 'human-tty', schemaVersion: 4 });
  f.witness(false);
  await expect(f.lifecycle.execute({ ...input, commandId: 'other-command' })).rejects.toMatchObject({ code: 'TASK_DECISION_APPROVAL_REQUIRED' });
  const result = await f.lifecycle.execute(input); expect(result.snapshot.progress[0]!.phase).toBe('failed');
  expect(f.audits[0]).toMatchObject({ subject: { deciderClass: 'human-tty', approvalId: record.request.approvalId } });
  f.time(10000); expect(await f.lifecycle.execute(input)).toEqual(result);
  await expect(f.lifecycle.execute({ ...input, commandId: 'other-command' })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
});

it('authorized resume removes the overlay first and returns to the original progression failure', async () => {
  const run = parkRunProgression(baseRun(), 0, 'PROGRESSION_FAILED', 10, 1000), f = await fixture(run, [grant('run-decision', ['resume'])]);
  const held = await f.lifecycle.execute(command('hold', run.revision, { holdReason: 'original cause must survive' }));
  const restored = await f.lifecycle.execute(command('resume', held.snapshot.revision));
  expect(restored.snapshot.state).toEqual(run.state);
  const resumed = await f.lifecycle.execute(command('resume', restored.snapshot.revision, { commandId: 'resume-underlying' }));
  expect(resumed.snapshot.state.kind).toBe('running');
  expect(f.audits.slice(1).every(event => (event as { subject: { deciderClass: string } }).subject.deciderClass === 'ai-policy')).toBe(true);
});

it('fresh cancellation deny wins after initial authorization; its rule id is never treated as a grant', async () => {
  const run = baseRun(), f = await fixture(run), allowed = await f.source.load(); let reads = 0;
  const denied = policySchema.parse({ ...allowed, revision: 'p2', grants: [...allowed.grants,
    { ...grant('run', ['cancel']), id: 'fresh-deny', effect: 'deny' }] });
  f.source.load = async () => ++reads === 1 ? allowed : denied;
  await expect(f.lifecycle.execute(command('hold', 0, { holdReason: 'must remain unperformed' }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(await f.store.loadRun('s', 'r')).toEqual(run); expect(f.audits).toEqual([]);
});
it('approve-card-then-assert: a witnessed policy card still cannot grant AI authority writing', async () => {
  const f = await fixture(baseRun(), [grant('operation', ['execute'], ai)], human, true);
  const input = { schemaVersion: 1, changes: [{ kind: 'grant.add', grant: grant('authority-document', ['write'], ai) }] };
  const risky = { schemaVersion: 1 as const, commandId: 'risky-policy-change', scopeId: 's', operation: POLICY_ADMINISTER_OPERATION.operation,
    target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: 'risky-policy-change', input, expectedVersion: 'p' };
  const broker = new OperationApprovalBroker(f.approvals.store, f.integrity, f.source, { sample: () => ({ wallMs: 100, monotonicMs: 100 }) },
    { requestTtlMs: 1000, defaultAdmitWithinMs: 1000 });
  const context = { record: null, targetBinding: 'b'.repeat(64), inputDigest: sha256(JSON.stringify(input)) };
  const pending = await broker.admit(POLICY_ADMINISTER_OPERATION, 'require-approval', risky, ai, context);
  if (!pending || !('pending' in pending)) throw new Error('FIXTURE_APPROVAL_REQUIRED');
  const card = await f.approvalApp.decide({ schemaVersion: 1, scopeId: 's', approvalId: pending.pending.approvalId,
    commandId: 'human-policy-card', expectedRevision: 0, decision: 'allow', reason: 'approve this exact risky command' });
  expect(card.decision).toMatchObject({ decision: 'allow', deciderClass: 'human-tty' });
  expect(await broker.admit(POLICY_ADMINISTER_OPERATION, 'require-approval', risky, ai, context)).toHaveProperty('approval');
  await expect(new OperationPolicyAuthorization(f.source).authorize('execute', 's', risky.operation, ai)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.approvals.store.load('s', card.request.approvalId)).toEqual(card);
});

it('a legacy-shaped card (no facts, no class) is never read as human: AI and unwitnessed callers cannot allow it, a witnessed human can', async () => {
  for (const [person, tty, expected] of [[ai, true, 'AI_AUTHORITY_NON_DELEGABLE'], [human, false, 'AI_AUTHORITY_NON_DELEGABLE'], [human, true, null]] as const) {
    const f = await fixture(baseRun(), [], person, tty);
    const legacy = requestTaskApproval(f.approvals.store, f.integrity, { scopeId: 's', runId: 'r', taskId: 't', requester: { id: 'old', issuer: 'host', subject: '1000' },
      actionDigest: sha256('legacy-task-decision'), policyRevision: 'p', summary: 'legacy accept', createdAt: 100, expiresAt: 900 });
    expect(legacy.request.schemaVersion).toBe(1);
    const decide = () => f.approvalApp.decide({ schemaVersion: 1, scopeId: 's', approvalId: legacy.request.approvalId, commandId: `legacy-${person.id}-${tty}`,
      expectedRevision: 0, decision: 'allow', reason: 'legacy' });
    if (expected) {
      await expect(decide()).rejects.toMatchObject({ code: expected });
      expect(f.approvals.store.load('s', legacy.request.approvalId)?.status).toBe('pending');
    } else expect((await decide()).decision).toMatchObject({ deciderClass: 'human-tty' });
  }
});

it('AI never records a session standing approval (self-widening), even with an approval decide grant', async () => {
  const f = await fixture(baseRun());
  const record = requestAgentToolApproval(f.approvals.store, f.integrity, { scopeId: 's', requester: { id: ai.id, issuer: ai.issuer, subject: ai.subject },
    subject: { kind: 'agent-tool-call', turnId: 'turn', round: 1, index: 0, tool: 'shell', toolVersion: 1, resource: 'ls', argsDigest: 'b'.repeat(64) },
    policyRevision: 'p', summary: 'shell', createdAt: 100, expiresAt: 900, facts: { risk: { source: 'cell', cell: 'shell-read-low' }, reversibility: null, onExpiry: 'nothing-runs', requiredAssurance: 'peer-session' } });
  await expect(f.approvalApp.decide({ schemaVersion: 1, scopeId: 's', approvalId: record.request.approvalId, commandId: 'standing', expectedRevision: 0,
    decision: 'allow', standing: 'session', reason: 'remember' })).rejects.toMatchObject({ code: 'AI_AUTHORITY_NON_DELEGABLE' });
});
