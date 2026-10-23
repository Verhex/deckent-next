import { expect, it } from 'vitest';
import { advanceRunLifecycle, answerRunQuota, createRun, parkRunProgression, runSnapshotSchema, type RunSnapshot } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';

// S9 (owner L-A 2026-10-14): a quota wait that runs out asks a person; it never cancels. Existing parks keep their sealed deadline.
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['ok'] }],
  criterionDefinitions: [{ id: 'ok', version: 1, description: 'ok', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const policy = { maxWaitMs: 5000, maxRewaits: 2 };
function quotaRun(resetsAtMs: number | null = null, extra: object = {}): RunSnapshot {
  const run = createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph)), identity = { ...run.identity, taskId: 't', attemptId: 'quota-a', generation: 1 };
  return runSnapshotSchema.parse({ ...run,
    execution: { ...run.execution, tasks: run.execution.tasks.map(task => ({ ...task, profile: { ...task.profile, parameters: { ...task.profile.parameters,
      nativeSubscription: { schemaVersion: 2, provider: 'codex', model: { channelId: 'channel', modelId: 'fixture-model', auxiliaryModelIds: [] }, modelUsageEvidence: 'none' } } } })) },
    state: { kind: 'parked', reason: 'quota-exhausted', since: 10, deadline: 1010 },
    bindings: [{ identity, observedKind: 'quota-exhausted', observedRevision: 1 }],
    quotaWaits: [{ identity, channelId: 'channel', quota: { source: 'codex-text', resetsAtMs }, evidenceDigest: 'a'.repeat(64), since: 10, deadline: 1010, maxResumes: 1, ...extra }] });
}
const asked = (run = quotaRun()) => advanceRunLifecycle(run, run.revision, 1010, 1000);

it('an expiring quota park asks a person instead of cancelling, and the ask never expires', () => {
  const run = quotaRun(), next = asked(run);
  expect(next.state).toMatchObject({ kind: 'parked', reason: 'quota-ask', since: 10 });
  expect(next.progress.map(task => task.phase)).toEqual(['pending']);
  const later = advanceRunLifecycle(next, next.revision, 10 ** 15, 1000);
  expect(later).toEqual(next);
});
it('before its deadline the quota park is untouched; an operator-held park keeps the hold timing', () => {
  const run = quotaRun();
  expect(advanceRunLifecycle(run, run.revision, 1009, 1000)).toEqual(run);
});
it('a non-quota park still ends in park-timeout (unchanged behavior)', () => {
  const run = parkRunProgression(createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph)), 0, 'FAILED', 10, 1000);
  expect(advanceRunLifecycle(run, run.revision, 1010, 1000).state).toMatchObject({ kind: 'terminal', reason: 'park-timeout' });
});
it('wait re-arms until the known reset, else a fresh maxWaitMs; each re-wait is counted and bounded, never cancelling', () => {
  const ask = asked(quotaRun(8000));
  const known = answerRunQuota(ask, ask.revision, 'wait', 2000, policy);
  expect(known.state).toMatchObject({ kind: 'parked', reason: 'quota-exhausted', deadline: 8000 });
  expect(known.quotaWaits![0]).toMatchObject({ rewaits: 1, deadline: 8000 });
  const unknownAsk = asked(), unknown = answerRunQuota(unknownAsk, unknownAsk.revision, 'wait', 2000, policy);
  expect(unknown.state).toMatchObject({ reason: 'quota-exhausted', deadline: 7000 });
  const again = advanceRunLifecycle(unknown, unknown.revision, 7000, 1000);
  expect(again.state).toMatchObject({ reason: 'quota-ask' });
  const twice = answerRunQuota(again, again.revision, 'wait', 7000, policy), third = advanceRunLifecycle(twice, twice.revision, 12000, 1000);
  expect(third.state).toMatchObject({ reason: 'quota-ask' });
  expect(() => answerRunQuota(third, third.revision, 'wait', 12000, policy)).toThrow('RUN_QUOTA_WAIT_LIMIT');
  expect(advanceRunLifecycle(third, third.revision, 99999999, 1000).state).toMatchObject({ reason: 'quota-ask' });
});
it('next-candidate releases the quota wait and frees the task for a new attempt; keep leaves the ask as it is', () => {
  const ask = asked(), next = answerRunQuota(ask, ask.revision, 'next-candidate', 2000, policy);
  expect(next.state).toEqual({ kind: 'running' });
  expect(next.bindings).toHaveLength(0); expect(next.previousBindings).toHaveLength(1);
  expect(next.quotaWaits![0]).toMatchObject({ releasedAtMs: 2000 });
  expect(next.progress.map(task => task.phase)).toEqual(['pending']);
});
it('only a Run that is asking can be answered', () => {
  const run = quotaRun();
  expect(() => answerRunQuota(run, run.revision, 'wait', 2000, policy)).toThrow('RUN_NOT_PARKED');
  const base = createRun({ scopeId: 's', runId: 'r', layoutRevision: 'l' }, graph, 0, fixtureExecution(graph));
  expect(() => answerRunQuota(base, 0, 'wait', 2000, policy)).toThrow('RUN_NOT_PARKED');
});
it('a pre-alpha.55 quota park (no rewaits field) still parses and keeps its sealed deadline', () => {
  const run = quotaRun();
  expect(JSON.parse(JSON.stringify(run)).quotaWaits[0]).not.toHaveProperty('rewaits');
  expect(runSnapshotSchema.parse(run).state).toMatchObject({ reason: 'quota-exhausted', deadline: 1010 });
});
