import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteApprovalStore, LocalOsSessionAuthority } from '#adapters/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { RunReservationApplication, ApprovalApplication, TaskApprovalAdmission, assertApprovalPolicyCurrent } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

it('pending approval occupies no candidate slot; allow requires a fresh reservation and replay cannot expand', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-approval-reserve-')); const path = join(root, 'ledger.db');
  const options = { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' } as const;
  const store = await openSqliteAttemptStore(path, options); const journal = openSqliteApprovalStore(path, options);
  try {
    const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 100 }) };
    const sessions = await LocalOsSessionAuthority.create(['scope'], 10000, clock); const { principal, session } = await sessions.verifySession(undefined);
    const actor = session.principalRef;
    const graph = { schemaVersion: 2 as const, revision: 1, tasks: ['a', 'b'].map(id => ({ id, kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] })),
      criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 } });
    await store.createRun({ commandId: 'create', actor, identity: { scopeId: 'scope', runId: 'run', layoutRevision: 'layout' },
      graph, execution: fixtureExecution(graph), now: 1000,
      policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['a', 'b'] } });
    const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [
      { id: 'wait', effect: 'require-approval', principals: 'all', scopes: ['scope'], actions: ['execute'], resource: { kind: 'task', ids: ['a'] } },
      { id: 'decide', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } },
    ] };
    const integrity = createHmacIntegrity('key', randomBytes(32));
    const gate = new TaskApprovalAdmission(policy, principal, journal.store, integrity, 1000); store.setRunAdmissionFilter(gate);
    let generated = 0;
    const app = new RunReservationApplication(store, { verify: async () => principal }, { authorize: async () => undefined },
      { authorize: async () => undefined }, { now: () => 1000, attemptId: () => `attempt-${++generated}` }, gate);
    const command = { schemaVersion: 1, scopeId: 'scope', runId: 'run', expectedRevision: 0, commandId: 'reserve-before' };
    const first = await app.reserve(command); expect(first.identities.map(v => v.taskId)).toEqual(['b']);
    const pending = journal.store.list('scope', null, 10); expect(pending).toHaveLength(1); expect(pending[0]!.request.taskId).toBe('a');
    const approvals = new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, { load: async () => policy }, integrity, clock, 'sdk', 10);
    await approvals.decide({ schemaVersion: 1, scopeId: 'scope', approvalId: pending[0]!.request.approvalId,
      commandId: 'approve-a', expectedRevision: 0, decision: 'allow', reason: 'Reviewed action' });
    const changedPolicy = { ...policy, grants: [...policy.grants, { ...policy.grants[0]!, id: 'another-task', resource: { kind: 'task', ids: ['unrelated'] } }] };
    const changedGate = new TaskApprovalAdmission(changedPolicy, principal, journal.store, integrity, 1000);
    const current = (await store.loadRun('scope', 'run'))!;
    expect(changedGate.excluded(current, actor, 1000)).toEqual(['a']);
    expect(() => assertApprovalPolicyCurrent(policy, changedPolicy)).toThrow('APPROVAL_STALE');
    expect(gate.excluded(current, actor, 1000)).toEqual([]);
    expect(await app.reserve(command)).toEqual(first); expect(generated).toBe(1);
    const next = await app.reserve({ ...command, commandId: 'reserve-after', expectedRevision: 1 });
    expect(next.identities.map(v => v.taskId)).toEqual(['a']); expect(generated).toBe(2);
  } finally { journal.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
