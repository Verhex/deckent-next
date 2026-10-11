import { expect, it } from 'vitest';
import { applyAttemptObservation, createAttempt, type AttemptIdentity } from '#domain/index.js';
import { assertDispatchNotFenced, dispatchFenceReceiptId, type DispatchRecord } from '#engine/core/dispatch/index.js';
import { custodyProfile } from '../support/custody.js';

const identity: AttemptIdentity = { runId: 'run', taskId: 'task', attemptId: 'attempt', scopeId: 's', layoutRevision: 'layout', generation: 1 };
const record: DispatchRecord = { schemaVersion: 2, owner: 'owner', request: { protocolVersion: 1, identity, workspace: '/workspace', argv: ['fixture'] },
  profile: custodyProfile, launch: 'granted', grant: { generation: 1, grantedAt: 1, principal: { id: 'actor', issuer: 'test', subject: 'actor' } }, terminal: null };
const commandId = dispatchFenceReceiptId(identity, record.owner);
const unknown = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1, identity, sequence: 1,
  eventId: commandId, result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }, 0);

it.each(['finish-dispatch', 'result', 'output', 'patch', 'effect'] as const)('returns typed rejection for a valid immutable receipt and late %s', action => {
  const before = JSON.stringify({ record, unknown });
  expect(() => assertDispatchNotFenced(record, JSON.stringify(unknown), action)).toThrow('DISPATCH_FENCED');
  expect(JSON.stringify({ record, unknown })).toBe(before);
});

it.each(['runId', 'taskId', 'attemptId', 'scopeId', 'layoutRevision', 'generation'] as const)('fails closed when receipt %s differs', key => {
  const foreign = { ...identity, [key]: key === 'generation' ? 2 : 'foreign' };
  const snapshot = { ...unknown, identity: foreign, lastObservation: { ...unknown.lastObservation!, identity: foreign } };
  expect(() => assertDispatchNotFenced(record, JSON.stringify(snapshot), 'finish-dispatch')).toThrow('DISPATCH_CORRUPT');
});

it.each(['{', 'null', JSON.stringify({ ...unknown, lastObservation: null }), JSON.stringify({ ...unknown, lastObservation: { ...unknown.lastObservation!, eventId: 'foreign' } }),
  JSON.stringify({ ...unknown, lastObservation: { ...unknown.lastObservation!, result: { kind: 'exited', exitCode: 0 } } })])('fails closed on malformed or non-fence snapshot %s', snapshot => {
  expect(() => assertDispatchNotFenced(record, snapshot, 'output')).toThrow('DISPATCH_CORRUPT');
});

it('does not use an unknown receipt for another custody owner', () => {
  expect(() => assertDispatchNotFenced({ ...record, owner: 'other-owner' }, JSON.stringify(unknown), 'patch')).toThrow('DISPATCH_CORRUPT');
});
