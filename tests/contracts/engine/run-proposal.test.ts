import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteRunProposalStore, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { ApprovalApplication, RunAdmissionApplication, RunProposalApplication, RunProposalInspectionApplication,
  createProviderSpendAccount, createProviderSpendCheckpoint, validateRunProposal, type RunProposalStore } from '#engine/index.js';
import { mcpPrincipalRef, workClassRegistrySchema, type RunProposal, type VerifiedPrincipal, type WorkClassRegistry } from '#domain/index.js';
import { ErrorRegistry, sha256, type DeckentError } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { fixtureRunAuthority } from '../support/run-authority.js';
const fixtures: { root: string; close(): void }[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { f.close(); await rm(f.root, { recursive: true, force: true }); } });
const principal: VerifiedPrincipal = { id: 'owner', issuer: 'local-test', subject: 'owner', assurance: 'os-user', scopeIds: ['s'] };
const profile = { schemaVersion: 1, version: 1, criterionTypes: ['completion'], evidenceTypes: ['observed-readback'],
  rubric: [{ criterionType: 'completion', evidenceTypes: ['observed-readback'], weight: 1 }], ceilingRules: [], decisionThresholds: { rejectBelow: 0.2, acceptAt: 1 } };
function registry(standing = true): WorkClassRegistry { return workClassRegistrySchema.parse({ schemaVersion: 2, revision: 'business-v1',
  classes: [{ id: 'business', parentClassId: 'small', defaultEffort: 'high', acceptanceProfile: profile,
    proposalAdmission: { risk: 'low', standingAdmission: standing } }], bindings: [{ kind: 'business-process', classId: 'business' }] }); }
const proposal: RunProposal = { schemaVersion: 1, commandId: 'propose', proposalId: 'plan', scopeId: 's', runId: 'r',
  proposer: { id: 'owner', issuer: 'local-test', subject: 'owner' }, source: { kind: 'human' }, budgetCeiling: { currency: 'USD', limitMinorUnits: 200 },
  requiredPermissions: [], graph: { schemaVersion: 4, revision: 1, tasks: [{ id: 'task', kind: 'business-process', workClass: 'business', dependencies: [], acceptanceCriteria: ['readback'] }],
    criterionDefinitions: [{ id: 'readback', version: 1, description: 'Durable business readback', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] } };
async function fixture(standing = true, effect: 'allow' | 'deny' | 'require-approval' = 'allow') {
  const root = await mkdtemp(join(tmpdir(), 'deckent-proposal-')), path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, { now: () => 100, timeoutMs: 1000 });
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } });
  const state = { now: 100, principal, registry: registry(standing), effect, permissionEffect: 'allow' as 'allow' | 'deny' | 'require-approval', inspect: true, samples: 0, spending: undefined as { semantics: 'metered' | 'not-metered'; digest: string } | undefined };
  const source = { async load() { state.samples++; return { schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
    { id: 'run-create', effect: state.effect, actions: ['create'], scopes: ['s'], principals: 'all', resource: { kind: 'run', ids: 'all' } },
    { id: 'permission', effect: state.permissionEffect, actions: ['execute'], scopes: ['s'], principals: 'all', resource: { kind: 'task', ids: 'all' } },
    { id: 'approve', effect: 'allow', actions: 'all', scopes: ['s'], principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'approval', ids: 'all' } },
  ] }; } };
  const f = fixtureRunAuthority(path, source, () => state.now);
  const proposals = await openSqliteRunProposalStore(path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' });
  let checkpoint = createProviderSpendCheckpoint(createProviderSpendAccount({ schemaVersion: 1, scopeId: 's', budgetId: 'scope-budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 }), 1, 0);
  function budget(value: typeof checkpoint | null) {
    checkpoint = value!;
    f.db.prepare('DELETE FROM provider_spend_accounts WHERE scope_id=?').run('s');
    if (value) f.db.prepare('INSERT INTO provider_spend_accounts(scope_id,revision,reservation_count,digest,record) VALUES(?,?,?,?,?)')
      .run('s', value.revision, value.reservationCount, value.digest, JSON.stringify(value.account));
  }
  budget(checkpoint);
  const runs = (port: Pick<SqliteAttemptStore, 'createRun' | 'loadRunReceipt' | 'loadRunWorkspaceCustody'> = store) => new RunAdmissionApplication(port, { verify: async () => state.principal }, f.authority,
    { authorize: async () => {} }, { async resolve(command) { return { now: state.now, layoutRevision: 'layout', execution: (() => { const value = fixtureExecution(command.graph, { workClasses: state.registry });
        return state.spending?.semantics === 'not-metered' ? { ...value, tasks: value.tasks.map(row => ({ ...row, profile: { ...row.profile,
          parameters: { ...row.profile.parameters, nativeSubscription: { schemaVersion: 2, provider: 'claude' } } } })) } : value; })(),
      policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: command.graph.tasks.map(t => t.id) } }; } });
  const app = (port: RunProposalStore = proposals, runPort?: Pick<SqliteAttemptStore, 'createRun' | 'loadRunReceipt' | 'loadRunWorkspaceCustody'>) => new RunProposalApplication(port,
    { verify: async () => state.principal }, f.authority, runs(runPort), { registry: state.registry, clock: f.clock,
      loadBudget: async () => checkpoint, ...(state.spending ? { classifySpending: async () => state.spending! } : {}), verifySource: async value => { if (value.source.kind === 'model') throw ErrorRegistry.createError('RUN_PROPOSAL_SOURCE_INVALID'); } });
  const inspect = () => new RunProposalInspectionApplication(proposals, { verify: async () => state.principal }, { authorize: async () => { if (!state.inspect) throw ErrorRegistry.createError('POLICY_DENIED'); } });
  const sessions = { verifySession: async () => ({ principal, session: { schemaVersion: 1, sessionId: 'human', authorityRef: 'verified-test-authority', kind: 'os-user', principalRef: proposal.proposer,
    scopeIds: ['s'], authenticatedAt: 0, expiresAt: 10000 } }), isSessionActive: async () => true, revoke: async () => {} };
  const approval = (actor = principal) => new ApprovalApplication(f.approvals, { verify: async () => actor }, sessions, source, f.integrity, f.clock, 'local-terminal-card', 100, undefined, undefined, { interactive: async () => true });
  async function decide(decision: 'allow' | 'deny' = 'allow') {
    const record = f.approvals.findRunCreate('s', 'propose')!;
    return approval().decide({ schemaVersion: 1, commandId: 'decision', scopeId: 's', approvalId: record.request.approvalId, expectedRevision: record.revision, decision, reason: 'Reviewed the exact proposed business process' });
  }
  fixtures.push({ root, close: () => { f.close(); store.close(); proposals.close(); } });
  return { ...f, source, state, store, proposals, app, runs, inspect, approval, decide, budget, checkpoint: () => checkpoint };
}
function noRun(f: Awaited<ReturnType<typeof fixture>>) { for (const name of ['runs', 'run_receipts', 'run_execution_intents', 'attempts']) expect(f.db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n).toBe(0); }
it('standing low-risk proposal commits one decision, one Run and an atomic acceptance receipt, with general business criteria', async () => {
  const f = await fixture(), first = await f.app().propose(proposal);
  expect(first).toMatchObject({ proposal: { status: 'accepted', revision: 1 }, run: { runId: 'r' }, runtimeTotalSpendEnforced: false, budgetSemantics: 'admission-check-only' });
  expect(first.run!.tasks[0]!.acceptance).toMatchObject({ workClass: 'business' });
  expect(first.run!.proposal).toEqual(first.proposal.binding);
  const sealed = f.audit.load('s', first.proposal.authority!.decision.eventId)!;
  const persisted = JSON.parse((await f.store.loadRunReceipt('s', 'propose'))!.command);
  const admission = { schemaVersion: 1, commandId: 'propose', scopeId: 's', runId: 'r', graph: proposal.graph, proposal: first.proposal.binding };
  const { encodeCommandProjection } = await import('#domain/index.js');
  expect(sealed.event.subject).toMatchObject({ inputDigest: sha256(encodeCommandProjection('run-admission:1', admission)), verdict: { decision: 'allow' } });
  expect(persisted.proposal.budgetCeiling).toEqual(proposal.budgetCeiling);
  expect(persisted.proposal.admission.budget.checkpointDigest).toBe(f.checkpoint().digest);
  expect(f.approvals.list('s', null, 10)).toEqual([]);
  expect(f.db.prepare('SELECT count(*) AS n FROM run_proposal_receipts').get()!.n).toBe(2);
  // Replay uses retained basis even after budget deletion, registry drift and expired admission windows.
  f.budget(null); f.state.registry = registry(false); f.state.now = 20000;
  expect(await f.app().propose(proposal)).toEqual(first);
  expect(f.audit.list('s', 0, 10)).toHaveLength(1);
  expect(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(1);
});
it.each([true, false])('concurrent identical submissions preserve one durable result and one admission chain (standing=%s)', async standing => {
  const f = await fixture(standing), [first, second] = await Promise.all([f.app().propose(proposal), f.app().propose(proposal)]);
  expect(second).toEqual(first); expect(first.proposal.status).toBe(standing ? 'accepted' : 'pending');
  expect(f.audit.list('s', 0, 10)).toHaveLength(1);
  expect(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(standing ? 1 : 0);
  expect(f.db.prepare('SELECT count(*) AS n FROM run_proposal_receipts').get()!.n).toBe(2);
});
it.each(['unmarked', 'no-metadata', 'high-risk'] as const)('%s proposals require the existing Run-create broker even under policy allow', async mode => {
  const f = await fixture(false);
  if (f.state.registry.schemaVersion !== 1) {
    const row = f.state.registry.classes[0]!;
    f.state.registry = workClassRegistrySchema.parse({ ...f.state.registry, classes: [{ ...row, proposalAdmission: mode === 'no-metadata' ? undefined : { risk: mode === 'high-risk' ? 'high' : 'low', standingAdmission: false } }] });
  }
  const first = await f.app().propose(proposal); expect(first.proposal.status).toBe('pending'); noRun(f);
  expect(await f.app().propose(proposal)).toEqual(first);
  expect(f.approvals.list('s', null, 10)).toHaveLength(1);
  await f.decide(); const accepted = await f.app().propose(proposal);
  expect(accepted.proposal.status).toBe('accepted'); expect(accepted.run!.authority!.approval).toBeDefined();
});
it('standing admission never lowers a policy require-approval', async () => {
  const f = await fixture(true, 'require-approval'); expect((await f.app().propose(proposal)).proposal.status).toBe('pending'); noRun(f);
});
it('a proposer cannot relabel an unbound task kind as the standing low-risk class to bypass approval', async () => {
  const f = await fixture(), task = proposal.graph.tasks[0]!;
  const input = { ...proposal, graph: { ...proposal.graph, tasks: [{ ...task, kind: 'unbound-business-process' }] } };
  expect((await f.app().propose(input)).proposal.status).toBe('pending'); noRun(f);
});
it('MCP cannot decide either allow or deny; the proposal remains pending and no Run exists', async () => {
  const f = await fixture(false), pending = await f.app().propose(proposal), ref = mcpPrincipalRef(principal);
  for (const decision of ['allow', 'deny'] as const) await expect(f.approval({ ...principal, ...ref }).decide({ schemaVersion: 1, commandId: 'mcp-' + decision,
    scopeId: 's', approvalId: pending.proposal.approval!.approvalId, expectedRevision: 0, decision, reason: 'MCP attempt' })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  expect((await f.app().propose(proposal)).proposal.status).toBe('pending'); noRun(f);
});
it('a verified MCP proposer produces the same durable plan for the authorized human inspection', async () => {
  const f = await fixture(false), ref = mcpPrincipalRef(principal);
  f.state.principal = { ...principal, ...ref, id: 'mcp-proposer' };
  const policy = await f.source.load();
  // MCP needs named grants; principals: all does not cover its separate actor.
  f.source.load = async () => ({ ...policy, grants: [...policy.grants, ...policy.grants.filter(row => ['run', 'task'].includes(row.resource.kind))
    .map(row => ({ ...row, id: 'mcp-' + row.id, principals: [{ issuer: ref.issuer, subject: ref.subject }] }))] });
  const input = { ...proposal, proposer: { id: f.state.principal.id, issuer: ref.issuer, subject: ref.subject },
    requiredPermissions: [{ kind: 'task', action: 'execute', resourceId: 'task' }] };
  const pending = await f.app().propose(input); expect(pending.proposal.status).toBe('pending'); noRun(f);
  const approval = await f.approval().inspect({ schemaVersion: 1, scopeId: 's', approvalId: pending.proposal.approval!.approvalId });
  expect(approval!.request.requester).toEqual(input.proposer);
  expect(approval!.request.summary).toContain('business-process'); expect(approval!.request.summary).toContain('business');
  // The declared task/execute/task is the derived requirement itself: shown as checked, not repeated as advisory.
  expect(approval!.request.summary).toContain('Checked by policy at admission: task / execute for each of the 1 tasks'); expect(approval!.request.summary).not.toContain('task / execute / task');
  expect(approval!.request.summary).toContain('$2.00');
  expect(approval!.request.summary).toContain('only at admission');
});
it('policy deny seals a denial and never persists an executable proposal or Run', async () => {
  const f = await fixture(true, 'deny'); await expect(f.app().propose(proposal)).rejects.toMatchObject({ code: 'POLICY_DENIED' }); noRun(f);
  expect(f.audit.list('s', 0, 10)[0]!.event.subject).toMatchObject({ verdict: { decision: 'deny' }, basisDigest: null });
});
it('registered permissions still pass current policy; deny cannot be bypassed by standing admission', async () => {
  const f = await fixture(); f.state.permissionEffect = 'deny';
  expect((await f.app().propose({ ...proposal, requiredPermissions: [{ kind: 'task', action: 'execute', resourceId: 'task' }] })).proposal).toMatchObject({ status: 'rejected', reason: 'POLICY_DENIED' }); noRun(f);
});
it('the proposer list is advisory: invented entries are not evaluated and an ungranted task restriction is not a refusal (live 2026-10-18)', async () => {
  const f = await fixture(); const policy = await f.source.load();
  // Only Run create is granted: no task, scope or model-invocation grant (the first-run template grants no task/execute either).
  f.source.load = async () => ({ ...policy, grants: policy.grants.filter(row => row.id !== 'permission') });
  const input = { ...proposal, requiredPermissions: [{ kind: 'task', action: 'execute', resourceId: 'task' }, { kind: 'scope', action: 'inspect', resourceId: 'live' },
    { kind: 'model-invocation', action: 'invoke', resourceId: 'gpt-6.1-sol' }, { kind: 'run', action: 'reserve', resourceId: 'elsewhere' }] };
  const accepted = await f.app().propose(input);
  expect(accepted.proposal).toMatchObject({ status: 'accepted', reason: null }); expect(accepted.proposal.binding.requiredPermissions).toEqual(input.requiredPermissions);
  expect(f.audit.list('s', 0, 10)[0]!.event.subject).toMatchObject({ verdict: { decision: 'allow' } });
});
it('the system-derived task restriction is evaluated even when the proposer lists nothing; require-approval still asks', async () => {
  const f = await fixture(); f.state.permissionEffect = 'deny';
  expect((await f.app().propose(proposal)).proposal).toMatchObject({ status: 'rejected', reason: 'POLICY_DENIED' }); noRun(f);
  expect(f.audit.list('s', 0, 10)[0]!.event.subject).toMatchObject({ verdict: { decision: 'deny', reason: 'DENIED', ruleId: 'permission' }, basisDigest: null });
  const asks = await fixture(); asks.state.permissionEffect = 'require-approval';
  expect((await asks.app().propose(proposal)).proposal.status).toBe('pending'); noRun(asks);
});
it('a plain Run create without a proposal keeps its single create decision (no derived proposal check)', async () => {
  const f = await fixture(); f.state.permissionEffect = 'deny';
  const created = await f.runs().create({ schemaVersion: 1, commandId: 'plain', scopeId: 's', runId: 'plain-run', graph: proposal.graph });
  expect(created.run.runId).toBe('plain-run');
});
it.each(['cycle', 'missing-criterion', 'unknown-class', 'unknown-permission', 'no-class'] as const)('retains a typed %s rejection and never admits a Run', async failure => {
  const f = await fixture(); let input: RunProposal = proposal;
  if (failure === 'cycle') input = { ...input, graph: { ...input.graph, tasks: [{ ...input.graph.tasks[0]!, dependencies: ['task'] }] } };
  if (failure === 'missing-criterion') input = { ...input, graph: { ...input.graph, criterionDefinitions: [] } };
  if (failure === 'unknown-class') input = { ...input, graph: { ...input.graph, tasks: [{ ...input.graph.tasks[0]!, workClass: 'unknown' }] } };
  if (failure === 'unknown-permission') input = { ...input, requiredPermissions: [{ kind: 'run', action: 'invented', resourceId: 'r' }] };
  if (failure === 'no-class') { const task = { ...input.graph.tasks[0]! }; delete task.workClass; input = { ...input, graph: { ...input.graph, tasks: [task] } }; }
  const rejected = await f.app().propose(input);
  expect(rejected.proposal.status).toBe('rejected'); expect(rejected.proposal.reason).toBeTruthy(); noRun(f);
  expect(await f.app().propose(input)).toEqual(rejected);
});
it.each(['missing', 'over-ceiling', 'currency', 'frozen'] as const)('budget %s refuses before Run creation', async failure => {
  const f = await fixture(); let input = proposal;
  if (failure === 'missing') f.budget(null);
  if (failure === 'over-ceiling') input = { ...proposal, budgetCeiling: { currency: 'USD', limitMinorUnits: 1001 } };
  if (failure === 'currency') input = { ...proposal, budgetCeiling: { currency: 'EUR', limitMinorUnits: 200 } };
  if (failure === 'frozen') f.budget(createProviderSpendCheckpoint({ ...f.checkpoint().account, frozen: true }, 2, 0));
  expect((await f.app().propose(input)).proposal.status).toBe('rejected'); noRun(f);
});
it('an over-ceiling refusal returns the remaining money with the rejected record, without storing it', async () => {
  const f = await fixture(), refused = await f.app().propose({ ...proposal, budgetCeiling: { currency: 'USD', limitMinorUnits: 1001 } });
  expect(refused).toMatchObject({ proposal: { status: 'rejected', reason: 'RUN_PROPOSAL_BUDGET_EXCEEDED' }, reasonParams: { remaining: 1000, ceiling: 1001, currency: 'USD' } });
  expect(refused.proposal).not.toHaveProperty('reasonParams'); noRun(f);
});
it('budget gates subtract reserved and settled money, accept equality using exact integer arithmetic', async () => {
  const f = await fixture(), account = { ...f.checkpoint().account, reservedMinorUnits: 700, settledMinorUnits: 100, settledExactMinorUnits: '100' };
  const cp = createProviderSpendCheckpoint(account, 2, 0);
  expect(validateRunProposal(proposal, f.state.registry, cp, 100).budget!.remainingMinorUnits).toBe(200);
  expect(() => validateRunProposal({ ...proposal, budgetCeiling: { currency: 'USD', limitMinorUnits: 201 } }, f.state.registry, cp, 100)).toThrow(expect.objectContaining({ code: 'RUN_PROPOSAL_BUDGET_EXCEEDED',
    params: { remaining: 200, ceiling: 201, currency: 'USD' } }));
  // The refusal names the remaining money in both languages (owner 2026-10-17: a refused plan says what is left).
  const refused = (() => { try { validateRunProposal({ ...proposal, budgetCeiling: { currency: 'USD', limitMinorUnits: 201 } }, f.state.registry, cp, 100); } catch (error) { return error as DeckentError; } throw new Error('NOT_REFUSED'); })();
  expect(refused.localize('en').message).toContain('$2.00'); expect(refused.localize('en').message).toContain('$2.01');
  expect(refused.localize('tr').message).toContain('2,00'); expect(refused.localize('tr').message).toContain('kalan');
});
it.each(['budget', 'registry'] as const)('a pending proposal parks after %s drift rather than consuming its old approval', async changed => {
  const f = await fixture(false); await f.app().propose(proposal); await f.decide();
  if (changed === 'budget') f.budget(createProviderSpendCheckpoint({ ...f.checkpoint().account, reservedMinorUnits: 1 }, 2, 0));
  else f.state.registry = workClassRegistrySchema.parse({ ...f.state.registry, revision: 'business-v2' });
  expect((await f.app().propose(proposal)).proposal).toMatchObject({ status: 'parked', reason: 'RUN_PROPOSAL_BASIS_STALE' }); noRun(f);
});
it('an expired approval is a durable typed park; repeated submission never creates a new approval', async () => {
  const f = await fixture(false); await f.app().propose(proposal); f.state.now = 1100;
  const parked = await f.app().propose(proposal); expect(parked.proposal).toMatchObject({ status: 'parked', reason: 'APPROVAL_EXPIRED' }); noRun(f);
  expect(await f.app().propose(proposal)).toEqual(parked); expect(f.approvals.list('s', null, 10)).toHaveLength(1);
});
it('changed input under the same command is a typed conflict, including changed ceilings and model attribution', async () => {
  const f = await fixture(); await f.app().propose(proposal);
  await expect(f.app().propose({ ...proposal, budgetCeiling: { currency: 'USD', limitMinorUnits: 199 } })).rejects.toMatchObject({ code: 'RUN_PROPOSAL_COMMAND_CONFLICT' });
  expect(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(1);
});
it('a proposal identity cannot be reused with a second command to create another Run', async () => {
  const f = await fixture(); await f.app().propose(proposal);
  await expect(f.app().propose({ ...proposal, commandId: 'second', runId: 'second-run' })).rejects.toMatchObject({ code: 'RUN_PROPOSAL_COMMAND_CONFLICT' });
  expect(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(1);
});
it('receipts are append-only and an accepted projection without its Run receipt is corrupt', async () => {
  const f = await fixture(); await f.app().propose(proposal);
  expect(() => f.db.exec('UPDATE run_proposal_receipts SET record=record')).toThrow('RUN_PROPOSAL_APPEND_ONLY');
  expect(() => f.db.exec('DELETE FROM run_proposal_receipts')).toThrow('RUN_PROPOSAL_APPEND_ONLY');
  f.db.exec('DELETE FROM run_receipts');
  await expect(f.proposals.loadProposal('s', 'propose')).rejects.toMatchObject({ code: 'RUN_PROPOSAL_CORRUPT' });
});
it.each(['proposal', 'decision', 'acceptance'] as const)('%s write failure leaves no Run, receipt, intent or attempt', async failed => {
  const f = await fixture();
  const table = failed === 'proposal' ? 'run_proposals' : failed === 'decision' ? 'audit_events' : 'run_proposal_receipts';
  const condition = failed === 'acceptance' ? 'WHEN NEW.revision=1' : '';
  f.db.exec(`CREATE TRIGGER failure BEFORE INSERT ON ${table} ${condition} BEGIN SELECT RAISE(ABORT,'injected write failure'); END;`);
  await expect(f.app().propose(proposal)).rejects.toBeDefined(); noRun(f);
  if (failed === 'acceptance') expect((await f.proposals.loadProposal('s', 'propose'))!.status).toBe('recorded');
});
it('a budget change during execution-registry resolution is refused inside the same Run transaction', async () => {
  const f = await fixture(); const original = f.store.createRun.bind(f.store);
  const port = { loadRunReceipt: f.store.loadRunReceipt.bind(f.store), loadRunWorkspaceCustody: f.store.loadRunWorkspaceCustody.bind(f.store),
    createRun: async (...args: Parameters<typeof original>) => { f.budget(createProviderSpendCheckpoint({ ...f.checkpoint().account, reservedMinorUnits: 1 }, 2, 0)); return original(...args); } };
  expect((await f.app(f.proposals, port).propose(proposal)).proposal.status).toBe('parked'); noRun(f);
});
it('inspect authorizes the exact Run before reading proposal content; spoofed attribution and wire authority are refused', async () => {
  const f = await fixture(); await f.app().propose(proposal); f.state.inspect = false;
  await expect(f.inspect().inspect({ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'propose' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  await expect(f.app().propose({ ...proposal, proposer: { ...proposal.proposer, subject: 'someone-else' } })).rejects.toMatchObject({ code: 'RUN_PROPOSAL_ACTOR_MISMATCH' });
  await expect(f.runs().create({ schemaVersion: 1, commandId: 'forged', scopeId: 's', runId: 'other', graph: proposal.graph, proposal: { standingAdmission: true } })).rejects.toBeDefined();
});

it('trusted subscription selection admits without budget; approval and policy remain binding', async () => {
  const f = await fixture(false); f.state.spending = { semantics: 'not-metered', digest: 'a'.repeat(64) }; f.budget(null);
  const pending = await f.app().propose(proposal);
  expect(pending).toMatchObject({ budgetSemantics: 'not-metered', proposal: { status: 'pending', binding: { admission: { budget: null } } } }); noRun(f);
  await f.decide(); const accepted = await f.app().propose(proposal);
  expect(accepted.proposal.status).toBe('accepted'); expect(accepted.run!.proposal).toEqual(accepted.proposal.binding);
  expect(await f.app().propose(proposal)).toEqual(accepted);
});
it('subscription selection never bypasses policy denial', async () => {
  const f = await fixture(false, 'deny'); f.state.spending = { semantics: 'not-metered', digest: 'a'.repeat(64) }; f.budget(null);
  await expect(f.app().propose(proposal)).rejects.toMatchObject({ code: 'POLICY_DENIED' }); noRun(f);
});
it('changed selected worker billing parks a previously approved non-metered proposal', async () => {
  const f = await fixture(false); f.state.spending = { semantics: 'not-metered', digest: 'a'.repeat(64) };
  await f.app().propose(proposal); await f.decide(); f.state.spending = { semantics: 'metered', digest: 'b'.repeat(64) };
  expect((await f.app().propose(proposal)).proposal).toMatchObject({ status: 'parked', reason: 'RUN_PROPOSAL_BASIS_STALE' }); noRun(f);
});
it('mixed/unknown selection still refuses missing API budget', async () => {
  const f = await fixture(); f.state.spending = { semantics: 'metered', digest: 'a'.repeat(64) }; f.budget(null);
  expect((await f.app().propose(proposal)).proposal).toMatchObject({ status: 'rejected', reason: 'RUN_PROPOSAL_BUDGET_MISSING' }); noRun(f);
});

it('non-metered proposal cannot admit an actual metered execution profile in the Run transaction', async () => {
  const f = await fixture(); f.state.spending = { semantics: 'not-metered', digest: 'a'.repeat(64) };
  const original = f.store.createRun.bind(f.store);
  const port = { loadRunReceipt: f.store.loadRunReceipt.bind(f.store), loadRunWorkspaceCustody: f.store.loadRunWorkspaceCustody.bind(f.store),
    createRun: async (...args: Parameters<typeof original>) => {
      const create = args[0];
      const execution = { ...create.execution, tasks: create.execution.tasks.map(row => ({ ...row,
        profile: { ...row.profile, parameters: { fixture: true } } })) };
      return original({ ...create, execution }, args[1], args[2]);
    } };
  expect((await f.app(f.proposals, port).propose(proposal)).proposal).toMatchObject({ status: 'parked', reason: 'RUN_PROPOSAL_BASIS_STALE' }); noRun(f);
});

// alpha.47 R4 (owner D7a + D2b): system order edges and a human's per-Run delivery intent ride the approved proposal.
const order = (id: string) => ({ ...proposal.graph.tasks[0]!, id, resources: [{ kind: 'erp.order', id: '42' }] });
const conflicting: RunProposal = { ...proposal, graph: { ...proposal.graph, schemaVersion: 5, tasks: [order('approve'), order('invoice')] } };
const intent = { target: { kind: 'git-ref', id: 'refs/heads/deckent/main' }, mode: 'enqueue-accepted' } as const;
it('D7a: the admitted Run carries the system order edge, the proposal keeps the authored graph and the sealed admission input binds the edge', async () => {
  const f = await fixture(), first = await f.app().propose(conflicting);
  expect(first.proposal.proposal.graph).toEqual(conflicting.graph);
  const run = await f.store.loadRun('s', 'r');
  expect(run!.graph.tasks[1]!.dependencies).toEqual([{ taskId: 'approve', startFrom: 'accepted-patch', origin: 'scope-conflict' }]);
  const { encodeCommandProjection } = await import('#domain/index.js');
  const sealed = f.audit.load('s', first.proposal.authority!.decision.eventId)!, admission = (graph: unknown) => sha256(encodeCommandProjection('run-admission:1',
    { schemaVersion: 1, commandId: 'propose', scopeId: 's', runId: 'r', graph, proposal: first.proposal.binding }));
  expect(sealed.event.subject).toMatchObject({ inputDigest: admission(run!.graph) });
  expect(admission(run!.graph)).not.toBe(admission(conflicting.graph)); // the order edge changes what the human's decision binds
  expect(await f.app().propose(conflicting)).toEqual(first); // replay meets the same ordered graph
});
it('D7a: an authored system edge is refused before any record', async () => {
  const f = await fixture(), task = order('invoice');
  const forged = { ...conflicting, graph: { ...conflicting.graph, tasks: [order('approve'), { ...task, dependencies: [{ taskId: 'approve', startFrom: 'accepted-patch', origin: 'scope-conflict' }] }] } } as RunProposal;
  await expect(f.app().propose(forged)).rejects.toMatchObject({ code: 'RUN_PROPOSAL_GRAPH_INVALID' }); noRun(f);
  expect(f.db.prepare('SELECT count(*) AS n FROM run_proposals').get()!.n).toBe(0);
});
it('D2b: a delivery intent is part of the digest, always asks the human on the card and binds the human proposer as grantor', async () => {
  const f = await fixture(true), { runProposalDigest } = await import('#engine/index.js');
  expect(runProposalDigest({ ...proposal, delivery: intent })).not.toBe(runProposalDigest(proposal));
  expect(runProposalDigest({ ...proposal, delivery: { ...intent, target: { ...intent.target, id: 'refs/heads/other' } } })).not.toBe(runProposalDigest({ ...proposal, delivery: intent }));
  const pending = await f.app().propose({ ...proposal, delivery: intent });
  // Standing low-risk admission would have created the Run at once; an intent never skips the human card.
  expect(pending.proposal).toMatchObject({ status: 'pending', binding: { delivery: { ...intent, grantedBy: proposal.proposer } } }); noRun(f);
  const card = await f.approval().inspect({ schemaVersion: 1, scopeId: 's', approvalId: pending.proposal.approval!.approvalId });
  expect(card!.request.summary).toContain('Delivery intent'); expect(card!.request.summary).toContain('refs/heads/deckent/main');
  await f.decide();
  const accepted = await f.app().propose({ ...proposal, delivery: intent });
  expect(accepted.proposal.status).toBe('accepted'); expect(accepted.run!.proposal).toMatchObject({ delivery: { ...intent, grantedBy: proposal.proposer } });
  expect((await f.store.loadRun('s', 'r'))!.authority!.approval).toBeDefined();
});
it('D2b: an MCP (AI) proposer can never obtain a delivery intent, even before any card', async () => {
  const f = await fixture(false), ref = mcpPrincipalRef(principal);
  f.state.principal = { ...principal, ...ref, id: 'mcp-proposer' };
  await expect(f.app().propose({ ...proposal, delivery: intent, proposer: { id: 'mcp-proposer', issuer: ref.issuer, subject: ref.subject } }))
    .rejects.toMatchObject({ code: 'DELIVERY_INTENT_NOT_ADMITTED' });
  noRun(f); expect(f.approvals.list('s', null, 10)).toEqual([]);
});
it('D2b: a stored binding whose intent differs from the approved proposal is corrupt', async () => {
  const f = await fixture(true); await f.app().propose({ ...proposal, delivery: intent });
  const { parseRunProposalRecord } = await import('#engine/index.js'), record = (await f.proposals.loadProposal('s', 'propose'))!;
  const code = (input: unknown) => { try { parseRunProposalRecord(input); return null; } catch (error) { return (error as DeckentError).code; } };
  expect(code(record)).toBeNull();
  expect(code({ ...record, binding: { ...record.binding, delivery: { ...record.binding.delivery!, grantedBy: { id: 'other', issuer: 'os', subject: '2' } } } })).toBe('RUN_PROPOSAL_CORRUPT');
  expect(code({ ...record, binding: { ...record.binding, delivery: undefined } })).toBe('RUN_PROPOSAL_CORRUPT');
  expect(code({ ...record, proposal: { ...record.proposal, delivery: undefined } })).toBe('RUN_PROPOSAL_CORRUPT');
});
