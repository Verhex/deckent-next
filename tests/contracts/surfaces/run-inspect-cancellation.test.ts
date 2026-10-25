import { expect, it } from 'vitest';
import { applyAttemptObservation, createAttempt, createRun, observeRunAttempt, preventRunAttempt, requestAttemptCancellation, requestRunCancellation, reserveRunTasks,
  settleCancelledRunAttempt } from '#domain/index.js';
import { projectRunView } from '#engine/index.js';
import { renderRunInspect } from '#surfaces/core/cli-run/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
// alpha.51 PRE7FU (c): `run inspect` tells the truth about a cancelled Run whose only attempt was never dispatched (e.g. cancelled during its
// environment probe): no worker was started, so "worker termination is not confirmed" would send the operator after a process that never ran.
const identity = { runId: 'r', scopeId: 's', layoutRevision: 'l' }, attemptIdentity = { ...identity, taskId: 'a', attemptId: 'a1', generation: 1 };
const graph = { schemaVersion: 4, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const timing = { now: 10, timeoutMs: 100 };
const reserved = () => reserveRunTasks(createRun(identity, graph, 1, fixtureExecution(graph)), 0, [attemptIdentity], 1);
const inspect = (run: unknown, locale: 'en' | 'tr' = 'en') => renderRunInspect({ run: projectRunView(run), models: [] }, locale, false);
const NOT_CONFIRMED = 'worker termination is not confirmed';

it('a Run cancelled before its only attempt was dispatched says no worker was started (EN/TR), not "termination not confirmed"', () => {
  const cancelling = requestRunCancellation(reserved(), 1, timing);
  const prevented = preventRunAttempt(cancelling, cancelling.revision, requestAttemptCancellation(createAttempt(attemptIdentity), 0), timing);
  expect(prevented.state).toMatchObject({ kind: 'terminal', reason: 'cancelled' });
  const en = inspect(prevented), tr = inspect(prevented, 'tr');
  expect(en).not.toContain(NOT_CONFIRMED); expect(en).toContain('Cancellation: request recorded; no worker was started');
  expect(tr).not.toContain('worker sonlanması doğrulanmadı'); expect(tr).toContain('hiçbir worker başlatılmadı');
});
it('negative: a worker in flight or one that ran under the cancellation keeps the unconfirmed-termination line', () => {
  // A dispatched, running worker (started observation) with cancellation requested.
  const started = applyAttemptObservation(createAttempt(attemptIdentity), { protocolVersion: 1, identity: attemptIdentity, sequence: 1, eventId: 's', result: { kind: 'started' } }, 0);
  const running = requestRunCancellation(observeRunAttempt(reserved(), 1, started), 2, timing);
  expect(inspect(running)).toContain(NOT_CONFIRMED);
  // A worker that exited and was settled under the cancellation.
  const attempt = applyAttemptObservation(requestAttemptCancellation(createAttempt(attemptIdentity), 0), { protocolVersion: 1, identity: attemptIdentity, sequence: 1, eventId: 'x', result: { kind: 'exited', exitCode: 137 } }, 1);
  const observed = observeRunAttempt(requestRunCancellation(reserved(), 1, timing), 2, attempt), settled = settleCancelledRunAttempt(observed, 3, attempt, timing);
  expect(settled.progress[0]!.phase).toBe('cancelled'); expect(inspect(settled)).toContain(NOT_CONFIRMED);
  // No cancellation: unchanged.
  expect(inspect(reserved())).toContain('Cancellation: no request recorded.');
});

it('ISY-14/16: Run status and park deadlines use human local words and dates without altering JSON state', () => {
  const run = projectRunView(createRun(identity, graph, 1, fixtureExecution(graph)));
  const parked = { ...run, state: { kind: 'parked' as const, reason: 'operator-hold' as const, since: 1_760_000_000_000, deadline: 1_760_000_060_000 } };
  const text = renderRunInspect({ run: parked, models: [] }, 'tr', false);
  expect(text).toContain('Durum:'); expect(text).not.toContain('operator-hold'); expect(text).not.toContain('parked');
  expect(text).not.toContain('epoch'); expect(text).not.toContain('1760000060000'); expect(text).toContain('2025');
  expect(parked.state.deadline).toBe(1_760_000_060_000);
});
