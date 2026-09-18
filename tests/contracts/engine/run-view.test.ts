import { expect, it } from 'vitest';
import { createRun } from '#domain/index.js';
import { projectRunView, RunInspectionApplication } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const graph = { schemaVersion: 2, revision: 1,
  tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['private-criterion'] }],
  criterionDefinitions: [{ id: 'private-criterion', version: 1, description: 'Private verification details',
    evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const run = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
it('projects explicit public registry bindings without storage bindings or private profile parameters', () => {
  const view = projectRunView(run);
  expect(view).toEqual({ schemaVersion: 2, runId: 'r', scopeId: 's', layoutRevision: 'l', revision: 0, cancellationRequested: false,
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
