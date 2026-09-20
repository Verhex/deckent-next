import { expect, it } from 'vitest';
import { parseModelInvocationCancellationCommand, parseModelInvocationCancellationReceipt, parseModelInvocationControlRecord,
  proposeModelInvocationSendPermission } from '#domain/core/model-invocation/index.js';

const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };
const claim = { scopeId: 'scope', commandId: 'invoke', invocationId: 'generated', requestDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64) };
const command = { schemaVersion: 1, commandId: 'cancel', scopeId: 'scope', targetCommandId: 'invoke', reference, expectedRequestDigest: claim.requestDigest };
const receipt = { schemaVersion: 1, command, claim, actor: { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' },
  authorization: { revision: 'policy', ruleId: 'cancel' }, requestedAtMs: 10, disposition: 'prevented' };
const pending = { schemaVersion: 1, claim, reference, send: { state: 'pending' }, cancellation: null };

it('binds caller-known command identity without allowing a client-supplied actor or invoking accessors', () => {
  expect(parseModelInvocationCancellationCommand(command)).toEqual(command);
  expect(command).not.toHaveProperty('invocationId');
  expect(() => parseModelInvocationCancellationCommand({ ...command, actor: receipt.actor })).toThrow('MODEL_INVOCATION_INVALID');
  let calls = 0;
  const accessor = Object.defineProperty({ ...command }, 'reference', { enumerable: true, get() { calls++; return reference; } });
  expect(() => parseModelInvocationCancellationCommand(accessor)).toThrow('MODEL_INVOCATION_INVALID'); expect(calls).toBe(0);
  for (const patch of [{ scopeId: 'other' }, { commandId: 'other' }, { requestDigest: 'c'.repeat(64) }]) {
    expect(() => parseModelInvocationCancellationReceipt({ ...receipt, claim: { ...claim, ...patch } })).toThrow('MODEL_INVOCATION_INVALID');
  }
});

it('allows a single pending-to-permitted candidate and never reissues permission from existing or unobserved custody', () => {
  const first = proposeModelInvocationSendPermission(pending, 'runtime-a', 2);
  expect(first).toMatchObject({ granted: true, record: { send: { state: 'permitted', ownerId: 'runtime-a', permittedAtMs: 2 } } });
  expect(pending.send.state).toBe('pending');
  expect(proposeModelInvocationSendPermission(first.record, 'runtime-a', 3)).toEqual({ granted: false, record: first.record });
  expect(proposeModelInvocationSendPermission(first.record, 'runtime-b', 4)).toEqual({ granted: false, record: first.record });
  expect(proposeModelInvocationSendPermission({ ...pending, send: { state: 'unobserved' } }, 'runtime-b', 5).granted).toBe(false);
  const prevented = { ...pending, send: { state: 'prevented' }, cancellation: receipt };
  expect(proposeModelInvocationSendPermission(prevented, 'runtime-a', 6)).toEqual({ granted: false, record: prevented });
});

it('rejects contradictory prevention or foreign cancellation evidence while permitting honest post-permission uncertainty', () => {
  expect(() => parseModelInvocationControlRecord({ ...pending, send: { state: 'prevented' } })).toThrow('MODEL_INVOCATION_INVALID');
  expect(() => parseModelInvocationControlRecord({ ...pending, cancellation: receipt })).toThrow('MODEL_INVOCATION_INVALID');
  const permitted = proposeModelInvocationSendPermission(pending, 'runtime', 20).record;
  expect(() => parseModelInvocationControlRecord({ ...permitted, cancellation: receipt })).toThrow('MODEL_INVOCATION_INVALID');
  const requested = { ...receipt, disposition: 'requested' };
  expect(parseModelInvocationControlRecord({ ...permitted, cancellation: requested })).toMatchObject({ cancellation: { disposition: 'requested' } });
  expect(() => parseModelInvocationControlRecord({ ...permitted, cancellation: { ...requested,
    command: { ...command, reference: { ...reference, modelId: 'other' } } } })).toThrow('MODEL_INVOCATION_INVALID');
  expect(() => parseModelInvocationControlRecord({ ...permitted, cancellation: { ...requested,
    claim: { ...claim, invocationId: 'other' } } })).toThrow('MODEL_INVOCATION_INVALID');
});
