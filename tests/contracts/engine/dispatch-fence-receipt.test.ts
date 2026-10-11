import { expect, it } from 'vitest';
import { applyAttemptObservation, createAttempt, type AttemptIdentity } from '#domain/index.js';
import { encodeLostDispatchWrite, assertDispatchNotFenced, dispatchFenceReceiptId, type DispatchRecord } from '#engine/core/dispatch/index.js';
import { sealAuditRecord } from '#engine/core/audit/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { createHash } from 'node:crypto';
import { custodyPrincipal, custodyProfile } from '../support/custody.js';

const identity: AttemptIdentity = { runId: 'run', taskId: 'task', attemptId: 'attempt', scopeId: 's', layoutRevision: 'layout', generation: 1 };
const record: DispatchRecord = { schemaVersion: 2, owner: 'owner', request: { protocolVersion: 1, identity, workspace: '/workspace', argv: ['fixture'] },
  profile: custodyProfile, launch: 'granted', grant: { generation: 1, grantedAt: 1, principal: { id: 'actor', issuer: 'test', subject: 'actor' } }, terminal: null };
const commandId = dispatchFenceReceiptId(identity, record.owner);
const unknown = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1, identity, sequence: 1,
  eventId: commandId, result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }, 0);

const { write, command } = encodeLostDispatchWrite({ schemaVersion: 1, identity, owner: record.owner, actor: custodyPrincipal, reasonCode: 'WORKER_LOST', now: 10, expectedRunRevision: 0, expectedAttemptRevision: 0 });
const audit = sealAuditRecord({ schemaVersion: 1, eventId: commandId, scopeId: 's', principal: { issuer: write.actor.issuer, subject: write.actor.subject }, policyRevision: 'fixture', atMs: 10, subject: { kind: 'run-lifecycle', action: 'hold', runId: 'run', taskId: 'task', commandId, revision: 1, evidence: null, inputDigest: createHash('sha256').update(command).digest('hex') } }, 1, createHmacIntegrity('fixture', Buffer.alloc(32, 7)));
const sealed = JSON.stringify(audit);
it('rejects a late write only after validating the full immutable receipt and audit', () => {
  expect(() => assertDispatchNotFenced(record, { command, snapshot: JSON.stringify(unknown) }, sealed)).toThrow('DISPATCH_FENCED');
});

it.each(['runId', 'taskId', 'attemptId', 'scopeId', 'layoutRevision', 'generation'] as const)('fails closed when receipt %s differs', key => {
  const foreign = { ...identity, [key]: key === 'generation' ? 2 : 'foreign' };
  const snapshot = { ...unknown, identity: foreign, lastObservation: { ...unknown.lastObservation!, identity: foreign } };
  expect(() => assertDispatchNotFenced(record, { command, snapshot: JSON.stringify(snapshot) }, sealed)).toThrow('DISPATCH_CORRUPT');
});

it.each(['{', 'null', JSON.stringify({ ...unknown, lastObservation: null }), JSON.stringify({ ...unknown, lastObservation: { ...unknown.lastObservation!, eventId: 'foreign' } }),
  JSON.stringify({ ...unknown, lastObservation: { ...unknown.lastObservation!, result: { kind: 'exited', exitCode: 0 } } })])('fails closed on malformed or non-fence snapshot %s', snapshot => {
  expect(() => assertDispatchNotFenced(record, { command, snapshot }, sealed)).toThrow('DISPATCH_CORRUPT');
});

it('does not use an unknown receipt for another custody owner', () => {
  expect(() => assertDispatchNotFenced({ ...record, owner: 'other-owner' }, { command, snapshot: JSON.stringify(unknown) }, sealed)).toThrow('DISPATCH_FENCE_CONFLICT');
});
