import { expect, it } from 'vitest';
import { applyAttemptObservation, createAttempt, createRun, freezeRecoveryPolicy, loadRecoveryPolicy, observeRunAttempt, RECOVERY_POLICY_SEED, reserveRunTasks, type RecoveryRunMode } from '#domain/index.js';
import { projectRunView } from '#engine/index.js';
import { renderRunInspect } from '#surfaces/core/cli-run/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
// BETA-RAKIP-3 (alpha.54 br3): a lost worker (the supervisor cannot tell whether it stopped) is shown as it is: held, nothing accepted on its
// word, and who acts next. f3 item 2 (alpha.55): the text follows the recovery mode the Run froze at admission (RunView.recoveryMode) — off says
// nothing continues on its own, shadow says a decision is only recorded, live says a continuation may follow within the Run's limits.
const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l' }, attemptIdentity = { ...identity, taskId: 'a', attemptId: 'a1', generation: 1 };
const graph = { schemaVersion: 4, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const execution = (mode?: RecoveryRunMode) => mode ? { ...fixtureExecution(graph), recovery: freezeRecoveryPolicy(loadRecoveryPolicy(RECOVERY_POLICY_SEED), mode) } : fixtureExecution(graph);
const reserved = (mode?: RecoveryRunMode) => reserveRunTasks(createRun(identity, graph, 1, execution(mode)), 0, [attemptIdentity], 1);
const inspect = (run: unknown, locale: 'en' | 'tr' = 'en') => renderRunInspect({ run: projectRunView(run), models: [] }, locale, false);
const observe = (attempt: ReturnType<typeof createAttempt>, sequence: number, result: Record<string, unknown>) =>
  applyAttemptObservation(attempt, { protocolVersion: 1, identity: attemptIdentity, sequence, eventId: `e${sequence}`, result } as never, sequence - 1);

const lostRun = (mode?: RecoveryRunMode) => {
  const started = observe(createAttempt(attemptIdentity), 1, { kind: 'started' });
  const lost = observe(started, 2, { kind: 'unknown', reasonCode: 'SUPERVISOR_OUTCOME_UNRESOLVED' });
  return observeRunAttempt(observeRunAttempt(reserved(mode), 1, started), 2, lost);
};
it('a lost worker says the task is held and nothing is accepted on its word; recovery off (no frozen mode) says nothing continues on its own (EN/TR)', () => {
  const run = lostRun();
  expect(run.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  expect(projectRunView(run).recoveryMode).toBeUndefined();
  const en = inspect(run), tr = inspect(run, 'tr');
  expect(en).toContain('could not confirm whether the worker stopped');
  expect(en).toContain('nothing is accepted or released on its word');
  expect(en).not.toContain('reconciliation required');
  expect(tr).toContain('worker\'ın durup durmadığını');
  expect(en).toContain('Automatic recovery was off when this Run was admitted'); expect(en).toContain('nothing is retried and no new attempt starts on its own');
  expect(tr).toContain('Bu Run kabul edildiğinde otomatik kurtarma kapalıydı');
  // Never the old release-wide claim: the mode decides.
  expect(en).not.toContain('in this release'); expect(tr).not.toContain('bu sürümde');
});
it('shadow: a recovery decision is only recorded; live: a continuation may follow within the frozen limits, otherwise a person decides (EN/TR)', () => {
  const shadow = lostRun('shadow'), live = lostRun('live');
  expect(projectRunView(shadow).recoveryMode).toBe('shadow'); expect(projectRunView(live).recoveryMode).toBe('live');
  expect(inspect(shadow)).toContain('shadow mode'); expect(inspect(shadow)).toContain('nothing continues on its own');
  expect(inspect(shadow, 'tr')).toContain('gölge kipinde');
  expect(inspect(live)).toContain('may continue this task with a new attempt'); expect(inspect(live)).not.toContain('nothing is retried');
  expect(inspect(live, 'tr')).toContain('yeni bir denemeyle');
  for (const run of [shadow, live]) expect(inspect(run)).not.toContain('Automatic recovery was off');
});
it('negative: a running worker with no loss shows no held-worker line', () => {
  const started = observe(createAttempt(attemptIdentity), 1, { kind: 'started' });
  const run = observeRunAttempt(reserved(), 1, started);
  expect(inspect(run)).not.toContain('could not confirm whether the worker stopped');
});
