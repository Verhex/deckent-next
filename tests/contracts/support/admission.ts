import type { SqliteAttemptStore } from '#adapters/index.js';
import type { AttemptIdentity } from '#domain/index.js';
/** Real ledger admission for execution fixtures; no schema writes or synthetic Run snapshots. */
export async function admitRunAttempts(store: SqliteAttemptStore, identities: readonly AttemptIdentity[]) {
  const first = identities[0]!; const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'fixture-pool', capacity: { executionSlots: 100, inFlightSlots: 100 } });
  await store.createRun({ commandId: 'create-run:' + first.runId, actor, identity: { runId: first.runId, scopeId: first.scopeId, layoutRevision: first.layoutRevision }, now: 0,
    graph: { schemaVersion: 2, revision: 1, tasks: identities.map(identity => ({ id: identity.taskId, kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] })),
      criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify fixture task', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] },
    policy: { schemaVersion: 2, poolId: 'fixture-pool', capacity: { executionSlots: identities.length, inFlightSlots: identities.length }, ordering: identities.map(identity => identity.taskId) } });
  await store.reserveRunTasks({ commandId: 'reserve:' + first.runId, actor, scopeId: first.scopeId, runId: first.runId, expectedRevision: 0, now: 0, identities: [...identities] });
}
