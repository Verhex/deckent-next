import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, readMonitorLedger, type SqliteAttemptStore } from '#adapters/index.js';
import { ApprovalApplication, approvalSubjectsHiddenFromProtocol, RunAdmissionApplication, sealApproval, type RunCreate } from '#engine/index.js';
import { mcpPrincipalRef, type VerifiedPrincipal } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { fixtureRunAuthority } from '../support/run-authority.js';
import { createWorklineLedgerPorts } from '#surfaces/core/cli-terminal/index.js';
const fixtures: { close(): void; root: string }[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { f.close(); await rm(f.root, { recursive: true, force: true }); } });
const actor: VerifiedPrincipal = { id: 'owner', issuer: 'local-test', subject: 'owner', assurance: 'os-user', scopeIds: ['s'] };
const command = { schemaVersion: 1, scopeId: 's', commandId: 'create', runId: 'r', graph: { schemaVersion: 2, revision: 1,
  tasks: [{ id: 'task', kind: 'business-process', dependencies: [], acceptanceCriteria: ['accepted'] }],
  criterionDefinitions: [{ id: 'accepted', version: 1, description: 'Business evidence', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] } };
async function fixture(effect: 'allow' | 'deny' | 'require-approval' = 'require-approval') {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-authority-')), path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 1000 });
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 } });
  const state = { now: 100, principal: actor, effect, revision: 'p1', layout: 'layout', changeDuringResolution: false };
  const source = { async load() { return { schemaVersion: 1, revision: state.revision, restrictions: [], grants: [
    { id: 'run-rule', effect: state.effect, actions: ['create'], scopes: ['s'], principals: 'all', resource: { kind: 'run', ids: 'all' } },
    { id: 'approval-rule', effect: 'allow', actions: 'all', scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind: 'approval', ids: 'all' } },
  ] }; } };
  const f = fixtureRunAuthority(path, source, () => state.now);
  const context = { async resolve(admitted: typeof command) {
    if (state.changeDuringResolution) state.revision = 'p2';
    return { now: state.now, layoutRevision: state.layout, execution: fixtureExecution(admitted.graph),
      policy: { schemaVersion: 2 as const, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['task'] } };
  } };
  const app = (port: Pick<SqliteAttemptStore, 'createRun' | 'loadRunReceipt' | 'loadRunWorkspaceCustody'> = store) => new RunAdmissionApplication(port,
    { verify: async () => state.principal }, f.authority, { authorize: async () => {} }, context);
  const sessions = { verifySession: async () => ({ principal: actor, session: { schemaVersion: 1, sessionId: 'human-session', authorityRef: 'test-human-authority', kind: 'os-user',
    principalRef: { id: actor.id, issuer: actor.issuer, subject: actor.subject }, scopeIds: ['s'], authenticatedAt: 0, expiresAt: 10000 } }),
    isSessionActive: async () => true, revoke: async () => {} };
  const approval = (principal: VerifiedPrincipal = actor) => new ApprovalApplication(f.approvals, { verify: async () => principal }, sessions, source,
    f.integrity, f.clock, 'local-terminal-card', 100);
  const decide = async (decision: 'allow' | 'deny' = 'allow') => {
    const pending = f.approvals.findRunCreate('s', 'create')!;
    return approval().decide({ schemaVersion: 1, scopeId: 's', approvalId: pending.request.approvalId, commandId: `decide-${decision}`,
      expectedRevision: 0, decision, reason: 'Reviewed this exact business-process graph' });
  };
  fixtures.push({ root, close: () => { f.close(); store.close(); } });
  return { ...f, root, path, state, source, store, app, approval, decide };
}
async function pending(f: Awaited<ReturnType<typeof fixture>>) {
  await expect(f.app().create(command)).rejects.toMatchObject({ code: 'RUN_APPROVAL_REQUIRED', params: { approvalId: expect.any(String), decisionRecordId: expect.any(String) } });
  expect(await f.store.loadRun('s', 'r')).toBeNull();
  const request = f.approvals.findRunCreate('s', 'create')!;
  expect(request.status).toBe('pending'); return request;
}
function noEffects(f: Awaited<ReturnType<typeof fixture>>) {
  for (const table of ['runs', 'run_receipts', 'run_execution_intents', 'attempts']) expect(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n).toBe(0);
}
it('seals an allow before the Run and exposes the identical durable reference in its view and receipt', async () => {
  const f = await fixture('allow'), result = await f.app().create(command), receipt = (await f.store.loadRunReceipt('s', 'create'))!;
  expect(result.run.authority).toEqual(receipt.snapshot.authority);
  const record = f.audit.load('s', result.run.authority!.decision.eventId)!;
  expect(record.event.subject).toMatchObject({ kind: 'authority-decision', envelope: { principalRef: { id: 'owner' } }, verdict: { decision: 'allow', revision: 'p1', ruleId: 'run-rule' } });
  expect(record.sequence).toBe(result.run.authority!.decision.sequence);
  expect(f.audit.load('other-scope', record.event.eventId)).toBeNull();
});
it('seals deny with the actual rule and preserves POLICY_DENIED without any Run effect', async () => {
  const f = await fixture('deny'); await expect(f.app().create(command)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(f.audit.list('s', 0, 10)[0]!.event.subject).toMatchObject({ verdict: { decision: 'deny', reason: 'DENIED', ruleId: 'run-rule' }, basisDigest: null }); noEffects(f);
});
it.each(['context', 'pool'] as const)('retains the evaluated Run decision when %s refuses the admission, without any effect', async failed => {
  const f = await fixture('allow'), refusal = new Error(`Refused ${failed} prerequisite`);
  const app = new RunAdmissionApplication(f.store, { verify: async () => actor }, f.authority,
    { authorize: async () => { if (failed === 'pool') throw refusal; } },
    { resolve: async () => {
      if (failed === 'context') throw refusal;
      return { now: f.state.now, layoutRevision: 'layout', execution: fixtureExecution(command.graph),
        policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['task'] } };
    } });
  await expect(app.create(command)).rejects.toBe(refusal); noEffects(f);
  expect(f.audit.list('s', 0, 10)).toMatchObject([{ event: { subject: { basisDigest: null, verdict: { decision: 'allow', ruleId: 'run-rule' } } } }]);
  expect(f.approvals.list('s', null, 10)).toEqual([]);
});
it.each(['allow', 'deny', 'require-approval'] as const)('audit write failure for %s admits no Run, receipt, intent or approval', async effect => {
  const f = await fixture(effect);
  f.db.exec("CREATE TRIGGER fail_decision BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'injected decision write failure'); END;");
  await expect(f.app().create(command)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' }); noEffects(f);
  expect(f.approvals.list('s', null, 10)).toEqual([]);
});
it('opens one pending request, visible to shared approval inspection, with no Run before a human decision', async () => {
  const f = await fixture(), first = await pending(f); f.state.now++;
  await pending(f); expect(f.approvals.list('s', null, 10)).toHaveLength(1); noEffects(f);
  expect(await f.approval().inspect({ schemaVersion: 1, scopeId: 's', approvalId: first.request.approvalId })).toEqual(first);
  expect(await f.approval().list({ schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 })).toEqual([first]);
  expect(f.audit.list('s', 0, 10)).toHaveLength(1);
  expect(first.request.summary).toContain('Plan · tasks: 1'); expect(first.request.summary).toContain('business-process');
  expect(first.request.summary).toContain('run-rule'); expect(first.request.summary).toContain('not declared');
  const monitor = await readMonitorLedger(f.path, { busyTimeoutMs: 100, maxRuns: 10 });
  expect(monitor.runs).toEqual([]);
  expect(monitor.approvals).toMatchObject([{ runId: 'r', taskId: null, approvalId: first.request.approvalId, summary: first.request.summary }]);
  const terminal = createWorklineLedgerPorts({ root: f.root, scopeId: 's', options: {},
    inspectWorkers: async () => ({ workers: [] }) as never, inspectRun: async () => ({ run: null }) as never,
    listApprovals: input => f.approval().list(input), decideApproval: input => f.approval().decide(input),
    renderRunCancellation: () => '' });
  expect((await terminal!.listApprovalPage!(null)).items).toMatchObject([{ runId: 'r', taskId: '-', approvalId: first.request.approvalId, status: 'pending', summary: first.request.summary }]);
});
it('a forged display summary cannot pass the original approval MAC or consume its decision', async () => {
  const f = await fixture(), request = await pending(f); await f.decide();
  const approved = f.approvals.load('s', request.request.approvalId)!;
  f.db.prepare('UPDATE approvals SET snapshot=? WHERE approval_id=? AND current=1').run(JSON.stringify({ ...approved,
    request: { ...approved.request, summary: 'A different display plan' } }), request.request.approvalId);
  await expect(f.app().create(command)).rejects.toMatchObject({ code: 'APPROVAL_INTEGRITY' }); noEffects(f);
});
it('approve-card-then-assert: an older sealed summary stays byte-exact and only authorizes its original input', async () => {
  const f = await fixture(), current = await pending(f);
  const legacy = sealApproval({ ...current, request: { ...current.request, summary: 'Historical binding-only summary' } }, f.integrity);
  f.db.prepare('UPDATE approvals SET snapshot=? WHERE approval_id=? AND current=1').run(JSON.stringify(legacy), legacy.request.approvalId);
  await pending(f); expect(f.approvals.load('s', legacy.request.approvalId)).toEqual(legacy);
  await f.decide();
  await expect(f.app().create({ ...command, graph: { ...command.graph, revision: 2 } })).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' }); noEffects(f);
  const created = await f.app().create(command);
  expect(created.run.authority!.approval!.approvalId).toBe(legacy.request.approvalId);
  expect(f.approvals.load('s', legacy.request.approvalId)!.request).toEqual(legacy.request);
});
it('approve-card-then-assert: creates one Run bound to that decision and approval receipt, replaying even after expiry', async () => {
  const f = await fixture(), request = await pending(f); const decision = await f.decide();
  const [first, second] = await Promise.all([f.app().create(command), f.app().create(command)]); expect(first).toEqual(second);
  expect(first.run.authority).toMatchObject({ decision: { eventId: request.request.schemaVersion === 1 ? '' : request.request.subject.kind === 'run-create' ? request.request.subject.decisionRecordId : '' },
    approval: { approvalId: request.request.approvalId, commandId: decision.decision!.commandId, requestDigest: decision.decision!.requestDigest } });
  expect(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(1);
  expect(f.db.prepare('SELECT count(*) AS n FROM run_execution_intents').get()!.n).toBe(1);
  f.state.now = 9000; expect(await f.app().create(command)).toEqual(first);
});
it.each(['graph', 'run', 'actor', 'layout', 'policy'] as const)('approve-card-then-assert: changed %s cannot consume the old approval', async changed => {
  const f = await fixture(); await pending(f); await f.decide(); let altered = command;
  if (changed === 'graph') altered = { ...command, graph: { ...command.graph, revision: 2 } };
  if (changed === 'run') altered = { ...command, runId: 'another' };
  if (changed === 'actor') f.state.principal = { ...actor, id: 'another', subject: 'another' };
  if (changed === 'layout') f.state.layout = 'another-layout';
  if (changed === 'policy') f.state.revision = 'p2';
  await expect(f.app().create(altered)).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' }); noEffects(f);
  expect(f.approvals.list('s', null, 10)).toHaveLength(1);
});
it('deny-card-then-assert: a denied request creates no Run', async () => {
  const f = await fixture(); await pending(f); await f.decide('deny');
  await expect(f.app().create(command)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' }); noEffects(f);
});
it('a changed policy allow cannot replace a command that already required approval', async () => {
  const f = await fixture(); await pending(f); await f.decide('deny'); f.state.effect = 'allow'; f.state.revision = 'p2';
  await expect(f.app().create(command)).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' }); noEffects(f);
});
it('an expired pending request is not reopened by command replay', async () => {
  const f = await fixture(), request = await pending(f); f.state.now = request.request.expiresAt;
  await expect(f.app().create(command)).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' }); noEffects(f);
  expect(f.approvals.list('s', null, 10)).toHaveLength(1); expect(f.approvals.findRunCreate('s', 'create')!.status).toBe('expired');
});
it('approve-card-then-assert: an unused allow outside its admission window creates no Run', async () => {
  const f = await fixture(); await pending(f); await f.decide(); f.state.now += 1001;
  await expect(f.app().create(command)).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' }); noEffects(f);
});
it('MCP as a separate principal cannot decide either allow or deny', async () => {
  const f = await fixture(), request = await pending(f);
  const mcp: VerifiedPrincipal = { ...actor, ...mcpPrincipalRef(actor), id: 'mcp-actor' };
  for (const decision of ['allow', 'deny']) await expect(f.approval(mcp).decide({ schemaVersion: 1, scopeId: 's', approvalId: request.request.approvalId,
    commandId: `mcp-${decision}`, expectedRevision: 0, decision, reason: 'Attempted MCP decision' })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  expect(f.approvals.findRunCreate('s', 'create')!.status).toBe('pending'); noEffects(f);
});
it('approve-card-then-assert: the final transaction gate refuses an allow that expired while the writer was opening', async () => {
  const f = await fixture(); await pending(f); await f.decide();
  const port = { loadRunReceipt: f.store.loadRunReceipt.bind(f.store), loadRunWorkspaceCustody: f.store.loadRunWorkspaceCustody.bind(f.store),
    async createRun(input: RunCreate, workspace?: Parameters<SqliteAttemptStore['createRun']>[1], check?: () => void) {
      f.state.now += 1001; return f.store.createRun(input, workspace, check);
    } };
  await expect(f.app(port).create(command)).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' }); noEffects(f);
});
it('refuses stale policy sampled before asynchronous admission without an approval or Run', async () => {
  const f = await fixture(); f.state.changeDuringResolution = true;
  await expect(f.app().create(command)).rejects.toMatchObject({ code: 'APPROVAL_STALE' }); noEffects(f); expect(f.approvals.list('s', null, 10)).toEqual([]);
});
it('retains the immutable audit record when Run insertion fails and reuses the same sealed decision on retry', async () => {
  const f = await fixture('allow'); f.db.exec("CREATE TRIGGER fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT,'injected Run failure'); END;");
  await expect(f.app().create(command)).rejects.toThrow('injected Run failure'); noEffects(f);
  const before = f.audit.list('s', 0, 10); expect(before).toHaveLength(1); f.state.now++;
  f.db.exec('DROP TRIGGER fail_run'); await f.app().create(command); expect(f.audit.list('s', 0, 10)).toEqual(before);
});
it('rejects missing or corrupt authority records on a Run replay and never substitutes another decision', async () => {
  const f = await fixture('allow'); await f.app().create(command);
  f.db.exec("DROP TRIGGER audit_events_no_update; UPDATE audit_events SET mac='corrupt' WHERE scope_id='s';");
  await expect(f.app().create(command)).rejects.toMatchObject({ code: 'AUDIT_INTEGRITY' });
  expect(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(1);
});
it('hides run-create subjects from old protocols, exposing them in v27', () => {
  expect(approvalSubjectsHiddenFromProtocol(26)).toEqual(['run-create']); expect(approvalSubjectsHiddenFromProtocol(27)).toEqual([]);
});
