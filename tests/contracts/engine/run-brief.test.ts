import { expect, it } from 'vitest';
import { createRun } from '#domain/index.js';
import { projectTaskBrief, projectResultBrief, taskBriefSchema, resultBriefSchema } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const graph = { schemaVersion: 3 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['ok'] }],
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'result evidence', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const base = createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
it('keeps absent legacy fields unknown and rejects unsupported brief versions', () => {
  expect(projectTaskBrief(base, 't')).toMatchObject({ schemaVersion: 1, task: null, scopePaths: null, acceptance: null, model: null, effort: null, contextRefs: [] });
  expect(projectResultBrief(null, { verdict: null })).toMatchObject({ report: null, openIssues: null, runDelivery: null });
  expect(taskBriefSchema.safeParse({ ...projectTaskBrief(base, 't'), schemaVersion: 2 }).success).toBe(false);
  expect(resultBriefSchema.safeParse({ ...projectResultBrief(null, { verdict: null }), schemaVersion: 2 }).success).toBe(false);
});
it('reads frozen profile pins and explicit context references without raw prompt text or invented purpose', () => {
  const run = { ...base, execution: { ...base.execution, tasks: [{ ...base.execution.tasks[0]!, profile: { ...base.execution.tasks[0]!.profile,
    parameters: { nativeSubscription: { provider: 'codex', model: { channelId: 'frozen', modelId: 'recorded-model', auxiliaryModelIds: [] },
      promptDelivery: { schemaVersion: 1, segments: [{ kind: 'context', id: 'source-guide', version: 2, sha256: 'a'.repeat(64), text: 'private prompt text' }] } } } } }] } };
  const before = JSON.stringify(run), brief = projectTaskBrief(run, 't');
  expect(brief).toMatchObject({ model: { modelId: 'recorded-model' }, contextRefs: [{ id: 'source-guide', version: 2, sha256: 'a'.repeat(64) }] });
  expect(JSON.stringify(brief)).not.toContain('private prompt text'); expect(brief).not.toHaveProperty('why'); expect(JSON.stringify(run)).toBe(before);
});
it('keeps reported success and open issues as redacted claims beside a rejected no-change evaluation and a pending Run landing', () => {
  const brief = projectResultBrief('a', { verdict: 'rejected', reason: 'no-change-produced' }, { schemaVersion: 1, kind: 'native-worker-report', status: 'reported',
    report: { schemaVersion: 1, summary: 'tests passed secret=private-value', changedFiles: ['src/a.ts'], checks: [{ command: 'check', outcome: 'passed' }], openIssues: ['still pending'] } },
    { state: 'adopting', commit: 'b'.repeat(40), targetRef: 'refs/heads/main', commandId: 'landing' });
  expect(brief).toMatchObject({ claimLabel: 'CLAIM', evaluation: { verdict: 'rejected', reason: 'no-change-produced' }, openIssues: ['still pending'], runDelivery: { state: 'adopting' } });
  expect(JSON.stringify(brief)).not.toContain('private-value'); expect(brief).not.toHaveProperty('workerPatchLanded');
});
