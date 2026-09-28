import { describe, expect, it } from 'vitest';
import { endedRuntimeServiceModelOwner, ModelInvocationControllers, runtimeServiceModelOwnerId } from '#engine/core/model-invocation/index.js';

const digest = (value: string) => value.repeat(64);
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const claim = { scopeId: 'scope', commandId: 'command', invocationId: 'invocation', requestDigest: digest('a'), profileDigest: digest('b') };
const cancellation = { schemaVersion: 1 as const,
  command: { schemaVersion: 1 as const, commandId: 'cancel', scopeId: claim.scopeId,
    targetCommandId: claim.commandId, reference, expectedRequestDigest: claim.requestDigest }, claim,
  actor: { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user' as const },
  authorization: { revision: 'policy', ruleId: 'cancel' }, requestedAtMs: 2, disposition: 'requested' as const };
const control = { schemaVersion: 1 as const, claim, reference,
  send: { state: 'permitted' as const, ownerId: 'owner', permittedAtMs: 1 }, cancellation };

describe('live model invocation controllers', () => {
  it('validates capacity and identities without allocating a reusable controller', () => {
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new ModelInvocationControllers(invalid)).toThrow('MODEL_INVOCATION_CONTROLLERS_INVALID');
    }
    const controllers = new ModelInvocationControllers(1), first = controllers.register(claim, 'owner');
    expect(() => controllers.register(claim, 'owner')).toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
    expect(() => controllers.register({ ...claim, invocationId: 'other' }, 'owner'))
      .toThrow('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
    expect(() => controllers.register({ ...claim, requestDigest: 'invalid' }, 'owner')).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(() => controllers.register({ ...claim, invocationId: 'other' }, ' ')).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(first.signal.aborted).toBe(false);
  });

  it('keys scope and invocation independently and requires the complete claim and owner to abort', () => {
    const controllers = new ModelInvocationControllers(3);
    const primary = controllers.register(claim, 'owner');
    const otherScope = controllers.register({ ...claim, scopeId: 'other-scope' }, 'other-owner');
    const otherInvocation = controllers.register({ ...claim, invocationId: 'other-invocation' }, 'third-owner');
    expect(() => controllers.requestAbort({ ...control, claim: { ...claim, commandId: 'foreign' },
      cancellation: { ...cancellation, claim: { ...claim, commandId: 'foreign' },
        command: { ...cancellation.command, targetCommandId: 'foreign' } } })).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(() => controllers.requestAbort({ ...control,
      send: { ...control.send, ownerId: 'foreign' } })).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(controllers.requestAbort(control)).toBe('abort-requested');
    expect(primary.signal.aborted).toBe(true); expect(otherScope.signal.aborted).toBe(false);
    expect(otherInvocation.signal.aborted).toBe(false);
  });

  it('aborts once only for a live exact permitted requested cancellation', () => {
    const controllers = new ModelInvocationControllers(1), handle = controllers.register(claim, 'owner');
    expect(controllers.requestAbort(control)).toBe('abort-requested');
    expect(handle.signal.aborted).toBe(true);
    expect(controllers.requestAbort(control)).toBe('already-requested');
    handle.release(); handle.release();
    expect(controllers.requestAbort(control)).toBe('not-live');
  });

  it('does not treat prevention, absence, terminal intent, or release as a remote abort', () => {
    const controllers = new ModelInvocationControllers(1), handle = controllers.register(claim, 'owner');
    expect(controllers.requestAbort({ ...control, cancellation: null })).toBe('not-needed');
    expect(controllers.requestAbort({ ...control, send: { state: 'prevented' },
      cancellation: { ...cancellation, disposition: 'prevented' } })).toBe('not-needed');
    expect(controllers.requestAbort({ ...control,
      cancellation: { ...cancellation, disposition: 'already-terminal' } })).toBe('not-needed');
    handle.release(); expect(handle.signal.aborted).toBe(false);
    expect(controllers.requestAbort(control)).toBe('not-live');
  });

  it('does not let a stale release remove a later registration for the same identity', () => {
    const controllers = new ModelInvocationControllers(1), stale = controllers.register(claim, 'owner');
    stale.release();
    const current = controllers.register(claim, 'owner');
    stale.release();
    expect(controllers.requestAbort(control)).toBe('abort-requested');
    expect(stale.signal.aborted).toBe(false); expect(current.signal.aborted).toBe(true);
  });
});

// Astra 2145 R1: holding one endpoint's custody proves only that no service is alive on THAT endpoint. A service's send owner names the
// custody it was minted under, and a start proves ended only owners of the custody it holds now; no prefix-only match is expressible.
it('proves a service owner ended only under the very custody it was minted with (Astra 2145 R1)', () => {
  const custody = digest('c'), other = digest('d'), instance = '5b0f7c1e-2d3a-4e5f-8a9b-0c1d2e3f4a5b';
  const owner = runtimeServiceModelOwnerId(custody, instance);
  expect(owner).toBe(`runtime-service:${custody}:${instance}`);
  const ended = endedRuntimeServiceModelOwner(custody);
  expect(ended(owner)).toBe(true);
  expect(endedRuntimeServiceModelOwner(other)(owner)).toBe(false);
  // The earlier, unpublished shape (no custody), a host-less direct call's bare id and malformed owners stay unproven.
  for (const unproven of [`runtime-service:${instance}`, instance, `runtime-service:${custody}:`, `runtime-service:${custody}`,
    `runtime-service:${custody.toUpperCase()}:${instance}`, ` runtime-service:${custody}:${instance}`]) expect(ended(unproven)).toBe(false);
  expect(() => runtimeServiceModelOwnerId('not-a-digest', instance)).toThrow();
  expect(() => endedRuntimeServiceModelOwner(custody.slice(1))).toThrow();
});
