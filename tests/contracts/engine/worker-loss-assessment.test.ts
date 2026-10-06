import { expect, it } from 'vitest';
import { createAttempt, createRun, reserveRunTasks, applyAttemptObservation, observeRunAttempt } from '#domain/index.js';
import { assessWorkerLoss, classifyLaunchRefusal, DispatchError, type DispatchRecord } from '#engine/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfile } from '../support/custody.js';

const identity = { runId: 'r', taskId: 'a', attemptId: 'a1', scopeId: 's', generation: 1, layoutRevision: 'l' };
const graph = { schemaVersion: 4, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
const run = reserveRunTasks(createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 1, fixtureExecution(graph)), 0, [identity], 1);
const attempt = createAttempt(identity);
const actor = { id: 'op', issuer: 'test', subject: 'op' };
const dispatch = { schemaVersion: 2, request: { protocolVersion: 1, identity, workspace: '/w/workspace', argv: ['x'] }, owner: 'op', profile: custodyProfile,
  launch: 'granted', grant: { generation: 1, grantedAt: 1000, principal: actor }, terminal: null } as unknown as DispatchRecord;
const live = (container: string, state: string, freshness: 'fresh' | 'stale' | 'future' | 'unknown', now = 1500) => ({ container, heartbeat: { state, freshness }, now, staleMs: 10000 });

it('marks loss only for a granted, non-terminal, active attempt with no recorded outcome, an absent container and an inactive executor', () => {
  expect(assessWorkerLoss({ identity, run, attempt, dispatch })).toEqual({ kind: 'candidate' });
  expect(assessWorkerLoss({ identity, run, attempt, dispatch }, live('missing', 'available', 'stale'))).toEqual({ kind: 'lost', heartbeat: 'stale', grantedAt: 1000 });
  expect(assessWorkerLoss({ identity, run, attempt, dispatch }, live('missing', 'missing', 'unknown', 20000))).toEqual({ kind: 'lost', heartbeat: 'missing', grantedAt: 1000 });
});

it('negative: every unproven condition refuses with its reason', () => {
  const refused = (reason: string) => ({ kind: 'refused', reason });
  expect(assessWorkerLoss({ identity, run, attempt, dispatch }, live('missing', 'available', 'fresh'))).toEqual(refused('executor-live'));
  expect(assessWorkerLoss({ identity, run, attempt, dispatch }, live('missing', 'available', 'future'))).toEqual(refused('executor-live'));
  // No heartbeat yet inside the stale window: the executor may still be about to start the container.
  expect(assessWorkerLoss({ identity, run, attempt, dispatch }, live('missing', 'missing', 'unknown', 5000))).toEqual(refused('executor-live'));
  expect(assessWorkerLoss({ identity, run, attempt, dispatch }, live('missing', 'unavailable', 'unknown', 20000))).toEqual(refused('executor-live'));
  for (const container of ['running', 'created', 'exited', 'unknown']) expect(assessWorkerLoss({ identity, run, attempt, dispatch }, live(container, 'available', 'stale'))).toEqual(refused('container-present'));
  expect(assessWorkerLoss({ identity, run, attempt, dispatch: null }, live('missing', 'available', 'stale'))).toEqual(refused('not-launched'));
  expect(assessWorkerLoss({ identity, run, attempt, dispatch: { ...dispatch, launch: 'pending', grant: undefined } as unknown as DispatchRecord })).toEqual(refused('not-launched'));
  expect(assessWorkerLoss({ identity, run, attempt, dispatch: { ...dispatch, terminal: { handle: 'h', exitCode: 0, interrupted: false } } as DispatchRecord })).toEqual(refused('terminal'));
  const unknown = applyAttemptObservation(attempt, { protocolVersion: 1, identity, sequence: 1, eventId: 'u', result: { kind: 'unknown', reasonCode: 'LOST' } }, 0);
  expect(assessWorkerLoss({ identity, run: observeRunAttempt(run, 1, unknown), attempt: unknown, dispatch }, live('missing', 'available', 'stale'))).toEqual(refused('effects-unresolved'));
});

it('classifies only deterministic pre-launch codes as permanent; everything else keeps the transient retry', () => {
  expect(classifyLaunchRefusal(ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED'))).toEqual({ disposition: 'permanent', code: 'EXECUTION_NOT_CONFIGURED' });
  expect(classifyLaunchRefusal(new DispatchError('DISPATCH_ARTIFACT_REQUIRED'))).toEqual({ disposition: 'permanent', code: 'DISPATCH_ARTIFACT_REQUIRED' });
  for (const error of [ErrorRegistry.createError('POLICY_DENIED'), new DispatchError('DISPATCH_CONFLICT'), new Error('boom'), 'text', null]) expect(classifyLaunchRefusal(error)).toEqual({ disposition: 'transient' });
});
