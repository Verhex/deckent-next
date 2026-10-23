import { expect, it } from 'vitest';
import { applyAttemptObservation, createAttempt, createRun, observeRunAttempt, reserveRunTasks } from '#domain/index.js';
import { projectRunView } from '#engine/index.js';
import { renderRunInspect } from '#surfaces/core/cli-run/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
// BETA-RAKIP-3 (alpha.54 br3): a lost worker (the supervisor cannot tell whether it stopped) is shown as it is today: held, nothing retried,
// released or accepted, and who acts next. Automatic recovery is a later slice (S6R); this text must not promise it.
const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l' }, attemptIdentity = { ...identity, taskId: 'a', attemptId: 'a1', generation: 1 };
const graph = { schemaVersion: 4, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const reserved = () => reserveRunTasks(createRun(identity, graph, 1, fixtureExecution(graph)), 0, [attemptIdentity], 1);
const inspect = (run: unknown, locale: 'en' | 'tr' = 'en') => renderRunInspect({ run: projectRunView(run), models: [] }, locale, false);
const observe = (attempt: ReturnType<typeof createAttempt>, sequence: number, result: Record<string, unknown>) =>
  applyAttemptObservation(attempt, { protocolVersion: 1, identity: attemptIdentity, sequence, eventId: `e${sequence}`, result } as never, sequence - 1);

it('a lost worker says the task is held, nothing is retried or released, and the service keeps checking (EN/TR)', () => {
  const started = observe(createAttempt(attemptIdentity), 1, { kind: 'started' });
  const lost = observe(started, 2, { kind: 'unknown', reasonCode: 'SUPERVISOR_OUTCOME_UNRESOLVED' });
  const run = observeRunAttempt(observeRunAttempt(reserved(), 1, started), 2, lost);
  expect(run.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  const en = inspect(run), tr = inspect(run, 'tr');
  expect(en).toContain('could not confirm whether the worker stopped');
  expect(en).toContain('nothing is retried, released or accepted');
  expect(en).toContain('runtime service checks the worker again');
  expect(en).not.toContain('reconciliation required');
  expect(tr).toContain('worker\'ın durup durmadığını');
  expect(tr).toContain('hiçbir şey yeniden denenmez, serbest bırakılmaz ya da kabul edilmez');
  // Honest about the release: no automatic recovery is promised in this release.
  expect(en).toContain('no automatic recovery in this release'); expect(tr).toContain('bu sürümde otomatik kurtarma yok');
});
it('negative: a running worker with no loss shows no held-worker line', () => {
  const started = observe(createAttempt(attemptIdentity), 1, { kind: 'started' });
  const run = observeRunAttempt(reserved(), 1, started);
  expect(inspect(run)).not.toContain('could not confirm whether the worker stopped');
});
