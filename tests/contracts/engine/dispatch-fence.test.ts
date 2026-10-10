import { describe, expect, it } from 'vitest';
import { createAttempt, applyAttemptObservation, decideDispatchLoss, type AttemptIdentity,
  type DispatchLossRecord, type DispatchFence, type DispatchTerminationProof, type WorkerIncarnation } from '#domain/index.js';
import { assessLostDispatch, dispatchFenceReceiptId, type DispatchRecord } from '#engine/core/dispatch/index.js';
import { custodyProfile } from '../support/custody.js';

const identity: AttemptIdentity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 };
const worker: WorkerIncarnation = { kind: 'process', pid: 42, startedAt: 'incarnation-a' };
const record: DispatchLossRecord = { identity, owner: 'owner-a', launch: 'granted', lost: true, worker };
const fence: DispatchFence = { identity, owner: record.owner, receiptId: 'fence-receipt' };
const proof: DispatchTerminationProof = { kind: 'supervisor-exit', identity, owner: record.owner, worker,
  receiptId: 'termination-receipt', result: { exitCode: 0 } };
const hold = (reason: string) => ({ kind: 'hold-manual', reason });

describe('lost dispatch capacity assessment', () => {
  it('derives receipt keys from the complete token independently of object property order', () => {
    const reversed = Object.fromEntries(Object.entries(identity).reverse()) as AttemptIdentity;
    expect(dispatchFenceReceiptId(reversed, record.owner)).toBe(dispatchFenceReceiptId(identity, record.owner));
    expect(dispatchFenceReceiptId(identity, 'other')).not.toBe(dispatchFenceReceiptId(identity, record.owner));
    for (const key of Object.keys(identity) as (keyof AttemptIdentity)[]) {
      expect(dispatchFenceReceiptId({ ...identity, [key]: key === 'generation' ? 2 : 'other' }, record.owner)).not.toBe(dispatchFenceReceiptId(identity, record.owner));
    }
  });
  it('requires a committed fence before considering termination', () => {
    expect(decideDispatchLoss(record, null, proof, 'release-slot')).toEqual(hold('fence-required'));
  });
  it('holds without termination; heartbeat age supplies no termination proof', () => {
    const suspected = { ...record, heartbeatExpired: true };
    expect(decideDispatchLoss(suspected, fence, null, 'release-slot')).toEqual(hold('termination-required'));
  });
  it('rejects a bare PID as incarnation evidence', () => {
    expect(decideDispatchLoss({ ...record, worker: null }, fence, proof, 'release-slot')).toEqual(hold('termination-mismatch'));
    expect(decideDispatchLoss(record, fence, { ...proof, worker: { ...worker, startedAt: '' } }, 'release-slot')).toEqual(hold('termination-mismatch'));
  });
  it('does not mistake a reused PID for the terminated worker', () => {
    expect(decideDispatchLoss(record, fence, { ...proof, worker: { ...worker, startedAt: 'incarnation-b' } }, 'release-slot')).toEqual(hold('termination-mismatch'));
  });
  it('refuses an exit without a code or signal, and contradictory exit causes', () => {
    expect(decideDispatchLoss(record, fence, { ...proof, kind: 'supervisor-exit', result: { exitCode: null } }, 'release-slot')).toEqual(hold('termination-mismatch'));
    expect(decideDispatchLoss(record, fence, { ...proof, kind: 'supervisor-exit', result: { exitCode: 0, signal: 'SIGTERM' } }, 'release-slot')).toEqual(hold('termination-mismatch'));
  });
  it.each(['runId', 'taskId', 'attemptId', 'scopeId', 'layoutRevision', 'generation'] as const)('binds fence and termination to %s', key => {
    const foreign = { ...identity, [key]: key === 'generation' ? 2 : 'foreign' };
    expect(decideDispatchLoss(record, { ...fence, identity: foreign }, proof, 'release-slot')).toEqual(hold('fence-mismatch'));
    expect(decideDispatchLoss(record, fence, { ...proof, identity: foreign }, 'release-slot')).toEqual(hold('termination-mismatch'));
  });
  it('requires matching custody owner and nonempty durable receipts', () => {
    expect(decideDispatchLoss(record, { ...fence, owner: 'other' }, proof, 'release-slot')).toEqual(hold('fence-mismatch'));
    expect(decideDispatchLoss(record, { ...fence, receiptId: '' }, proof, 'release-slot')).toEqual(hold('fence-mismatch'));
    expect(decideDispatchLoss(record, fence, { ...proof, owner: 'other' }, 'release-slot')).toEqual(hold('termination-mismatch'));
    expect(decideDispatchLoss(record, fence, { ...proof, receiptId: '' }, 'release-slot')).toEqual(hold('termination-mismatch'));
  });
  it.each(['finish-dispatch', 'result', 'effect'] as const)('rejects late %s even when termination is unavailable', action => {
    expect(decideDispatchLoss(record, fence, null, action)).toEqual({ kind: 'reject-late-write', code: 'DISPATCH_FENCED' });
  });
  it('does not release pending, prevented or non-lost dispatches', () => {
    expect(decideDispatchLoss({ ...record, lost: false }, fence, proof, 'release-slot')).toEqual(hold('not-lost'));
    for (const launch of ['pending', 'prevented-before-launch'] as const) {
      expect(decideDispatchLoss({ ...record, launch }, fence, proof, 'release-slot')).toEqual(hold('not-granted'));
    }
  });
  it('releases only exact proven custody and returns no acceptance, retry or effect decision', () => {
    const before = JSON.stringify({ record, fence, proof });
    const first = decideDispatchLoss(record, fence, proof, 'release-slot');
    expect(first).toEqual({ kind: 'release', fenceReceiptId: fence.receiptId, terminationReceiptId: proof.receiptId });
    expect(decideDispatchLoss(record, fence, proof, 'release-slot')).toEqual(first);
    expect(JSON.stringify({ record, fence, proof })).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
  });
  it('accepts retained container absence but refuses a different container incarnation', () => {
    const container: WorkerIncarnation = { kind: 'container', id: 'container-a', startedAt: 'incarnation-a' };
    const absent: DispatchTerminationProof = { kind: 'worker-absent', identity, owner: record.owner, receiptId: 'absence-receipt', worker: container };
    expect(decideDispatchLoss({ ...record, worker: container }, fence, absent, 'release-slot').kind).toBe('release');
    expect(decideDispatchLoss({ ...record, worker: container }, fence, { ...absent, worker: { ...container, id: 'container-b' } }, 'release-slot')).toEqual(hold('termination-mismatch'));
    expect(decideDispatchLoss(record, fence, absent, 'release-slot')).toEqual(hold('termination-mismatch'));
  });
  it('binds engine assessment to real record schemas and authoritative unknown observation', () => {
    const dispatch: DispatchRecord = { schemaVersion: 2, request: { protocolVersion: 1, identity, workspace: '/workspace', argv: ['fixture'] },
      owner: record.owner, profile: custodyProfile, launch: 'granted', terminal: null,
      grant: { generation: 1, grantedAt: 1, principal: { id: 'actor', issuer: 'test', subject: 'actor' } } };
    const attempt = createAttempt(identity);
    expect(assessLostDispatch(dispatch, attempt, worker, fence, proof)).toEqual(hold('not-lost'));
    const unknown = applyAttemptObservation(attempt, { protocolVersion: 1, identity, sequence: 1, eventId: 'lost', result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }, 0);
    expect(assessLostDispatch(dispatch, unknown, worker, fence, proof).kind).toBe('release');
    expect(unknown.lastObservation?.result.kind).toBe('unknown');
    expect(assessLostDispatch(dispatch, unknown, worker, fence, null, 'effect')).toEqual({ kind: 'reject-late-write', code: 'DISPATCH_FENCED' });
    expect(() => assessLostDispatch(dispatch, createAttempt({ ...identity, generation: 2 }), worker, fence, proof)).toThrow('DISPATCH_CONFLICT');
  });
});
