import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FilePolicySource, openSqliteApprovalStore, openSqliteAttemptStore } from '#adapters/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { createRun, getPolicyVocabulary, installationOwnerPermissions, verifiedSessionSchema, type VerifiedPrincipal, type AuditEvent } from '#domain/index.js';
import { DecisionDelegations, PolicyAdministrationApplication, ApprovalApplication, RunDecisionApprovalBroker, RunLifecycleApplication,
  RunPolicyAuthorization, DispatchPolicyAuthorization, AuditApplication } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

const human: VerifiedPrincipal = { id: 'owner', issuer: 'host', subject: 'person', assurance: 'os-user', scopeIds: ['scope'] };
const ai: VerifiedPrincipal = { ...human, id: 'ai', issuer: 'host/mcp', assurance: 'workload-verified' };
const ref = (actor: VerifiedPrincipal) => ({ issuer: actor.issuer, subject: actor.subject });
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it.skipIf(process.platform === 'win32')('approve-card-then-assert: governed grant → MCP progression-failed resume ai-policy → governed revoke → refusal, with human granter audit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'decision-delegation-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), sqlite, { now: () => 100, timeoutMs: 1000 }); cleanup.push(() => store.close());
  const journal = openSqliteApprovalStore(join(root, 'ledger.db'), sqlite); cleanup.push(() => journal.close());
  const policyPath = join(root, 'policy.json'), bindingsPath = join(root, 'bindings.json');
  const rule = (id: string, kind: string, actions: string[]) => ({ id, effect: 'allow', principals: [ref(ai)], scopes: ['scope'], actions, resource: { kind, ids: 'all' } });
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 2, revision: 'p', grants: [rule('run', 'run', ['inspect', 'reserve', 'cancel']), rule('attempt', 'attempt', ['evaluate']), rule('observe', 'scope', ['inspect'])],
    restrictions: [], separationOfDuties: [], roles: [{ id: 'owner', permissions: installationOwnerPermissions(getPolicyVocabulary().resources.map(r => r.kind)) }] }), { mode: 0o600 });
  await writeFile(bindingsPath, JSON.stringify({ schemaVersion: 2, revision: 'b', modes: [], bindings: [{ id: 'owner', principals: [ref(human)], roles: ['owner'], scopes: 'all' }] }), { mode: 0o600 });
  const source = new FilePolicySource({ path: policyPath, bindingsPath, archivePath: join(root, 'history'), ownerUid: process.getuid!(), maxBytes: 65536 });
  const clock = { sample: () => ({ wallMs: 100, monotonicMs: 100 }) }, integrity = createHmacIntegrity('fixture', randomBytes(32));
  const session = verifiedSessionSchema.parse({ schemaVersion: 1, sessionId: 'session', authorityRef: 'authority', kind: 'os-user', principalRef: { id: human.id, ...ref(human) },
    scopeIds: ['scope'], authenticatedAt: 0, expiresAt: 100000 });
  const sessions = { verifySession: async () => ({ principal: human, session }), isSessionActive: async () => true, revoke: async () => {} };
  const events: AuditEvent[] = [];
  const administration = new PolicyAdministrationApplication({ authority: source, policy: source, effects: store, approvals: journal.store, sessions, integrity, clock,
    requestTtlMs: 1000, audit: event => { events.push(event); } });
  let answered = 0;
  const approve = async (approval: { approvalId: string; revision: number }, commandId: string, reason: string) => {
    expect(journal.store.load('scope', approval.approvalId)?.status).toBe('pending'); answered++;
    return new ApprovalApplication(journal.store, { verify: async () => human }, sessions, source, integrity, clock, 'local-runtime', 10, undefined, undefined,
      { interactive: async () => true }).decide({ schemaVersion: 1, scopeId: 'scope', approvalId: approval.approvalId, expectedRevision: approval.revision, commandId, decision: 'allow', reason });
  };
  const app = new DecisionDelegations({ administration, approve, policy: source }, async () => true);
  const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['ok'] }],
    criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  const created = createRun({ scopeId: 'scope', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
  await store.createRun({ commandId: 'create', actor: { id: human.id, ...ref(human) }, identity: created.identity, graph, execution: created.execution!, now: 0,
    policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
  const broker = new RunDecisionApprovalBroker(journal.store, integrity, source, async () => false, () => 100, 1000, 1000, 'en');
  const audits: AuditEvent[] = [];
  const lifecycle = new RunLifecycleApplication(store, { verify: async () => ai }, new RunPolicyAuthorization(source),
    { authorize: (identity, principal) => new DispatchPolicyAuthorization(source).authorizeIdentity('evaluate', identity, principal) },
    audit => ({ record(event) { audits.push(event); return new AuditApplication(audit, integrity).record(event); } }), () => 100, 1000, 'p', broker);
  // Create the non-operator park through the same durable CAS port used by progression.
  const parked = (await lifecycle.parkProgression({ schemaVersion: 1, scopeId: 'scope', runId: 'r', commandId: 'park', expectedRevision: created.revision, failureCode: 'PROGRESSION_FAILED' })).snapshot;
  const resume = { schemaVersion: 1, scopeId: 'scope', runId: 'r', action: 'resume', commandId: 'resume', expectedRevision: parked.revision };
  await expect(lifecycle.execute(resume)).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  const selection = { schemaVersion: 1 as const, scopeId: 'scope', step: 'run-resume', resourceId: 'r' };
  await app.change({ ...selection, action: 'grant', expectedRevision: (await source.load() as { revision: string }).revision }, human);
  expect(answered).toBe(1);
  await expect(app.change({ ...selection, action: 'revoke', expectedRevision: 'p+b' }, human)).rejects.toMatchObject({ code: 'POLICY_DELEGATION_CONFLICT' });
  expect((await app.change({ ...selection, action: 'grant', expectedRevision: (await source.load() as { revision: string }).revision }, human)).status).toBe('current');
  expect(answered).toBe(1);
  const resumed = await lifecycle.execute(resume); expect(resumed.snapshot.state.kind).toBe('running');
  expect(audits.at(-1)).toMatchObject({ subject: { action: 'resume', deciderClass: 'ai-policy', decisionRuleId: expect.stringMatching(/^ai-step-/u) } });
  await app.change({ ...selection, action: 'revoke', expectedRevision: (await source.load() as { revision: string }).revision }, human);
  expect(answered).toBe(2);
  await expect(lifecycle.execute(resume)).rejects.toMatchObject({ code: 'TASK_DECISION_HUMAN_REQUIRED' });
  expect((await app.inspect({ schemaVersion: 1, scopeId: 'scope', resourceId: 'r' }, human)).steps[0]).toMatchObject({ managed: 'none', effective: 'denied' });
  expect(events.filter(event => event.subject.kind === 'authority-change')).toHaveLength(2);
  expect(events.filter(event => event.subject.kind === 'authority-change').every(event => event.subject.kind === 'authority-change' && event.subject.decider.issuer === human.issuer && event.subject.decider.subject === human.subject)).toBe(true);
});
