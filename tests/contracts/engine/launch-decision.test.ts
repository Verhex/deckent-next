import { expect, it } from 'vitest';
import { createAttempt, createRun, requestAttemptCancellation, requestRunCancellation, reserveRunTasks } from '#domain/index.js';
import { decideDispatchLaunch } from '#engine/index.js';
import { custodyPrincipal, custodyProfile } from '../support/custody.js';

const identity = { runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
const request = { protocolVersion: 1 as const, identity, workspace: '/workspace', argv: ['tool'] };
const claim = { request, owner: 'worker' };
const graph = { schemaVersion: 2 as const, revision: 1,
  tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify result', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const active = reserveRunTasks(createRun({ runId: 'r', scopeId: 's', layoutRevision: 'l' }, graph, 0), 0, [identity], 0);
const pending = { schemaVersion: 2 as const, request, owner: 'worker', profile: custodyProfile, launch: 'pending' as const, terminal: null };
const cancellation = { id: 'canceller', issuer: 'test', subject: 'operator' };
const input = { claim, principal: custodyPrincipal, now: 42 };

it('grants exact generation, principal and injected time without projecting Run state', () => {
  const transition = decideDispatchLaunch(input, { run: active, attempt: createAttempt(identity), dispatch: pending });
  expect(transition.projectedRun).toBeNull();
  expect(transition.decision).toMatchObject({ kind: 'granted', record: { launch: 'granted',
    grant: { generation: 1, grantedAt: 42, principal: { id: custodyPrincipal.id, issuer: custodyPrincipal.issuer, subject: custodyPrincipal.subject } } } });
});

it.each([
  ['Run', requestRunCancellation(active, active.revision), requestAttemptCancellation(createAttempt(identity), 0)],
  ['Attempt', active, requestAttemptCancellation(createAttempt(identity), 0)],
  ['dispatch', active, requestAttemptCancellation(createAttempt(identity), 0)],
] as const)('prevents launch from %s cancellation and projects the active Task to cancelled', (_source, run, attempt) => {
  const transition = decideDispatchLaunch(input, { run, attempt, dispatch: { ...pending, cancellation } });
  expect(transition.decision).toMatchObject({ kind: 'prevented', record: { launch: 'prevented-before-launch',
    cancellation, prevention: { reason: 'cancel-requested' } } });
  expect(transition.projectedRun?.progress[0]!.phase).toBe('cancelled');
  expect(attempt.cancelRequested).toBe(true);
});

it('fails closed when cancellation state lacks durable actor attribution', () => {
  const attempt = requestAttemptCancellation(createAttempt(identity), 0);
  expect(() => decideDispatchLaunch(input, { run: active, attempt, dispatch: pending })).toThrow('DISPATCH_CORRUPT');
});

it('requires Attempt cancellation for Run or dispatch cancellation to prevent launch', () => {
  for (const state of [
    { run: requestRunCancellation(active, active.revision), dispatch: { ...pending, cancellation } },
    { run: active, dispatch: { ...pending, cancellation } },
  ]) expect(() => decideDispatchLaunch(input, { ...state, attempt: createAttempt(identity) })).toThrow('DISPATCH_CORRUPT');
});

it('rejects a foreign Run binding even when the Attempt and dispatch match', () => {
  const foreign = { ...active, identity: { ...active.identity, runId: 'foreign' } };
  expect(() => decideDispatchLaunch(input, { run: foreign, attempt: createAttempt(identity), dispatch: pending })).toThrow('DISPATCH_CONFLICT');
});
