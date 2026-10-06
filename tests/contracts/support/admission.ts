import type { SqliteAttemptStore } from '#adapters/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { fixtureExecution } from './execution-registry.js';
/** Real ledger admission for execution fixtures; no schema writes or synthetic Run snapshots. `workInput`: every task carries typed work input (graph v4, coding delivery); the execution snapshot is resolved from the plain graph
 * as a trusted ledger fixture (admission compilation has its own tests). */
export async function admitRunAttempts(store: SqliteAttemptStore, identities: readonly AttemptIdentity[], options: { workInput?: boolean } = {}) {
  const first = identities[0]!; const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'fixture-pool', capacity: { executionSlots: 100, inFlightSlots: 100 } });
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: identities.map(identity => ({ id: identity.taskId, kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] })),
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify fixture task', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
  const workInput = { schemaVersion: 1, task: 'Change the fixture', scope: { paths: ['fixture.txt'] }, acceptance: 'Fixture changed',
    model: { channelId: 'test-channel', modelId: 'test-model', auxiliaryModelIds: [] } };
  const admitted = options.workInput ? { ...graph, schemaVersion: 4 as const, tasks: graph.tasks.map(task => ({ ...task, workInput })) } : graph;
  await store.createRun({ commandId: 'create-run:' + first.runId, actor, identity: { runId: first.runId, scopeId: first.scopeId, layoutRevision: first.layoutRevision }, now: 0,
    graph: admitted, execution: fixtureExecution(graph),
    policy: { schemaVersion: 2, poolId: 'fixture-pool', capacity: { executionSlots: identities.length, inFlightSlots: identities.length }, ordering: identities.map(identity => identity.taskId) } });
  await store.reserveRunTasks({ commandId: 'reserve:' + first.runId, actor, scopeId: first.scopeId, runId: first.runId, expectedRevision: 0, now: 0, identities: [...identities] });
}
