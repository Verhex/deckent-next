import { expect, it } from 'vitest';
import { createRun } from '#domain/index.js';
import { projectRunView, RunInspectionApplication, type RunPoolEvidence } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const graph = { schemaVersion: 2, revision: 1,
  tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['private-criterion'] }],
  criterionDefinitions: [{ id: 'private-criterion', version: 1, description: 'Private verification details',
    evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const run = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
it('projects explicit public registry bindings without storage bindings or private profile parameters', () => {
  const view = projectRunView(run);
  expect(view).toEqual({ schemaVersion: 3, state: { kind: 'running' }, runId: 'r', scopeId: 's', layoutRevision: 'l', revision: 0, cancellationRequested: false,
    registryRevision: 'fixture-registry', criteria: [{ id: 'private-criterion', version: 1, description: 'Private verification details',
      evaluator: { id: 'test-evaluator', version: 1 }, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['private-criterion'],
      profile: { id: 'fixture-profile', version: 1 }, phase: 'pending', unresolvedEffects: false }] });
  expect(JSON.stringify(view)).not.toContain('"parameters"'); expect(JSON.stringify(view)).not.toContain('argv');
  expect(view).not.toHaveProperty('bindings'); expect(view).not.toHaveProperty('graph'); expect(view).not.toHaveProperty('execution');
  expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(view.tasks[0]!.dependencies)).toBe(true);
});
it('rejects malformed storage and refuses a reader that returns another scope or Run', async () => {
  expect(() => projectRunView({ ...run, progress: [] })).toThrow('RUN_STORE_CORRUPT');
  const app = new RunInspectionApplication({ async loadRun() { return run; } },
    { async verify() { return { id: 'u', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s', 'other'] }; } }, { async authorize() {} });
  await expect(app.inspect({ schemaVersion: 1, scopeId: 'other', runId: 'r' })).rejects.toThrow('RUN_STORE_CORRUPT');
  await expect(app.inspect({ schemaVersion: 1, scopeId: 's', runId: 'other' })).rejects.toThrow('RUN_STORE_CORRUPT');
});
it.each([
  { admissionPool: 'q', pinnedSlots: 2, sources: [] },
  { admissionPool: 'p', pinnedSlots: 2, sources: ['admission'] },
  { admissionPool: 'q', pinnedSlots: 8, sources: ['run'] },
  { admissionPool: 'p', pinnedSlots: 8, sources: ['run', 'admission'] },
])('binds admission drift to $admissionPool with pinned slots=$pinnedSlots, retaining real pool waits without mutations', async ({ admissionPool, pinnedSlots, sources }) => {
  const capacity = { executionSlots: 2, inFlightSlots: 2 };
  const evidence: RunPoolEvidence = { snapshot: run, pool: { poolId: 'p', capacity,
    runCapacity: { executionSlots: pinnedSlots, inFlightSlots: pinnedSlots }, occupancy: { execution: 2, inFlight: 2 }, hold: null, admitted: true } };
  const before = JSON.stringify(evidence);
  const app = new RunInspectionApplication({ async loadRun() { throw new Error('must use pool evidence snapshot'); }, async loadRunPoolEvidence() { return evidence; } },
    { async verify() { return { id: 'u', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s'] }; } }, { async authorize() {} }, undefined,
    { admission: { poolId: admissionPool, executionSlots: 8, inFlightSlots: 8 }, ceiling: Infinity });
  for (let i = 0; i < 3; i++) {
    const pool = (await app.inspect({ schemaVersion: 1, scopeId: 's', runId: 'r' }))!.pool!;
    expect(pool.drift.map(value => value.source)).toEqual(sources);
    for (const drift of pool.drift) expect(drift).toEqual({ code: 'POOL_ADMISSION_CAPACITY_DRIFT', poolId: 'p', source: drift.source,
      requested: { executionSlots: 8, inFlightSlots: 8 }, capacity });
    expect(pool.waiting).toEqual([{ taskId: 't', reason: { code: 'waiting-pool-slot', poolId: 'p', capacity, effectiveCapacity: capacity,
      occupancy: { execution: 2, inFlight: 2 }, sinceMs: null } }]);
  }
  expect(JSON.stringify(evidence)).toBe(before);
});
