import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteApprovalStore, LocalOsSessionAuthority } from '#adapters/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { samePrincipalRef } from '#domain/index.js';
import { RunReservationApplication, ApprovalApplication, TaskApprovalAdmission, assertApprovalPolicyCurrent } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

it.skipIf(process.platform !== 'linux')('[requires Linux live OS session /proc identity] pending approval occupies no candidate slot; allow requires a fresh reservation and replay cannot expand', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-approval-reserve-')); const path = join(root, 'ledger.db');
  const options = { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' } as const;
  const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 }); const journal = openSqliteApprovalStore(path, options);
  try {
    let now = 1000;
    const clock = { sample: () => ({ wallMs: now, monotonicMs: now - 900 }) };
    const sessions = await LocalOsSessionAuthority.create(['scope'], 10000, clock); const { principal, session } = await sessions.verifySession(undefined);
    const actor = session.principalRef;
    const graph = { schemaVersion: 2 as const, revision: 1, tasks: ['a', 'b'].map(id => ({ id, kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] })),
      criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
    await store.createRun({ commandId: 'create', actor, identity: { scopeId: 'scope', runId: 'run', layoutRevision: 'layout' },
      graph, execution: fixtureExecution(graph), now: 1000,
      policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['a', 'b'] } });
    const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [
      { id: 'wait', effect: 'require-approval', principals: 'all', scopes: ['scope'], actions: ['execute'], resource: { kind: 'task', ids: ['a'] } },
      { id: 'decide', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } },
    ] };
    const integrity = createHmacIntegrity('key', randomBytes(32));
    const gate = new TaskApprovalAdmission(policy, principal, journal.store, integrity, 1000, 1000); store.setRunAdmissionFilter(gate);
    let generated = 0;
    const app = new RunReservationApplication(store, { verify: async () => principal }, { authorize: async () => undefined },
      { authorize: async () => undefined }, { now: () => now, attemptId: () => `attempt-${++generated}` }, gate);
    const command = { schemaVersion: 1, scopeId: 'scope', runId: 'run', expectedRevision: 0, commandId: 'reserve-before' };
    const first = await app.reserve(command); expect(first.identities.map(v => v.taskId)).toEqual(['b']);
    const pending = journal.store.list('scope', null, 10); expect(pending).toHaveLength(1); expect(pending[0]!.request.taskId).toBe('a');
    const approvals = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, { load: async () => policy }, integrity, clock, 'sdk', 10, undefined, undefined, { interactive: async () => true });
    await approvals.decide({ schemaVersion: 1, scopeId: 'scope', approvalId: pending[0]!.request.approvalId,
      commandId: 'approve-a', expectedRevision: 0, decision: 'allow', reason: 'Reviewed action' });
    const changedPolicy = { ...policy, grants: [...policy.grants, { ...policy.grants[0]!, id: 'another-task', resource: { kind: 'task', ids: ['unrelated'] } }] };
    const changedGate = new TaskApprovalAdmission(changedPolicy, principal, journal.store, integrity, 1000, 1000);
    const current = (await store.loadRun('scope', 'run'))!;
    expect(changedGate.excluded(current, actor, 1000)).toEqual(['a']);
    expect(() => assertApprovalPolicyCurrent(policy, changedPolicy)).toThrow('APPROVAL_STALE');
    expect(gate.excluded(current, actor, 1000)).toEqual([]);
    // S1-e5, owner B1-16: an allow is usable within the admission window after its decision (1000 + 1000), not after it.
    expect([gate.excluded(current, actor, 2000), gate.excluded(current, actor, 2001)]).toEqual([[], ['a']]);
    // S1-D4 (A39): the same actor written in another key order is refused today, and the shared comparison keeps that meaning.
    const reordered = { subject: actor.subject, issuer: actor.issuer, id: actor.id };
    expect(() => gate.excluded(current, reordered, 1000)).toThrow('APPROVAL_DENIED');
    expect([samePrincipalRef(actor, reordered), samePrincipalRef(actor, { ...actor })]).toEqual([false, true]);
    expect(await app.reserve(command)).toEqual(first); expect(generated).toBe(1);
    now = 1500;
    await expect(app.reserve({ ...command, commandId: 'reserve-capacity-wait', expectedRevision: 1 })).rejects.toThrow('RUN_POOL_FULL');
    expect((await store.loadRun('scope', 'run'))!.progress.find(task => task.taskId === 'a')?.phase).toBe('pending');
    now = 2000;
    await gate.prepare(current, principal, now);
    expect(journal.store.find('scope', 'run', 'a', pending[0]!.request.actionDigest)?.request.approvalId).toBe(pending[0]!.request.approvalId);
    now = 2001;
    await expect(app.reserve({ ...command, commandId: 'reserve-aged-allow', expectedRevision: 1 })).rejects.toThrow('RUN_CAPACITY_OR_ORDER');
    const replacement = journal.store.find('scope', 'run', 'a', pending[0]!.request.actionDigest)!;
    expect(replacement).toMatchObject({ status: 'pending', revision: 0, decision: null,
      request: { createdAt: 2001, expiresAt: 3001, renewal: { previousApprovalId: pending[0]!.request.approvalId } } });
    expect(replacement.request.approvalId).not.toBe(pending[0]!.request.approvalId);
    expect(journal.store.load('scope', pending[0]!.request.approvalId)?.decision?.decision).toBe('allow');
    await gate.prepare(current, principal, now);
    expect(journal.store.find('scope', 'run', 'a', pending[0]!.request.actionDigest)).toEqual(replacement);
    expect((await approvals.list({ schemaVersion: 1, scopeId: 'scope', afterId: null, limit: 10 })).filter(card => card.status === 'pending')).toEqual([replacement]);
    const renewal = replacement.request.renewal!;
    expect(journal.store.receipt('scope', renewal.commandId)?.record).toEqual(replacement);
    await approvals.decide({ schemaVersion: 1, scopeId: 'scope', approvalId: replacement.request.approvalId,
      commandId: 'approve-new-a', expectedRevision: 0, decision: 'allow', reason: 'Reviewed action again' });
    await store.applyPoolCapacity({ command: { schemaVersion: 1, scopeId: 'scope', commandId: 'capacity-available', poolId: 'pool',
      capacity: { executionSlots: 2, inFlightSlots: 2 } }, actor: { issuer: actor.issuer, subject: actor.subject }, atMs: now }, () => undefined);
    const next = await app.reserve({ ...command, commandId: 'reserve-after', expectedRevision: 1 });
    expect(next.identities.map(v => v.taskId)).toEqual(['a']); expect(generated).toBe(3);
  } finally { journal.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
