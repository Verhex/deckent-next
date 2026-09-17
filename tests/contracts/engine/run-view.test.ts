import { expect, it } from 'vitest';
import { createRun } from '#domain/index.js';
import { projectRunView, RunInspectionApplication } from '#engine/index.js';
const run = createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, { schemaVersion: 1, revision: 1,
  tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['private-criterion'] }] }, 0);
it('projects explicit public fields without storage bindings, graph or private acceptance criteria', () => {
  const view = projectRunView(run);
  expect(view).toEqual({ schemaVersion: 1, runId: 'r', scopeId: 's', layoutRevision: 'l', revision: 0, cancellationRequested: false,
    tasks: [{ id: 't', kind: 'custom', dependencies: [], phase: 'pending', unresolvedEffects: false }] });
  expect(JSON.stringify(view)).not.toContain('private-criterion'); expect(view).not.toHaveProperty('bindings'); expect(view).not.toHaveProperty('graph');
  expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(view.tasks[0]!.dependencies)).toBe(true);
});
it('rejects malformed storage and refuses a reader that returns another scope or Run', async () => {
  expect(() => projectRunView({ ...run, progress: [] })).toThrow('RUN_STORE_CORRUPT');
  const app = new RunInspectionApplication({ async loadRun() { return run; } },
    { async verify() { return { id: 'u', issuer: 'host', subject: '1', assurance: 'os-user', scopeIds: ['s', 'other'] }; } }, { async authorize() {} });
  await expect(app.inspect({ schemaVersion: 1, scopeId: 'other', runId: 'r' })).rejects.toThrow('RUN_STORE_CORRUPT');
  await expect(app.inspect({ schemaVersion: 1, scopeId: 's', runId: 'other' })).rejects.toThrow('RUN_STORE_CORRUPT');
});
