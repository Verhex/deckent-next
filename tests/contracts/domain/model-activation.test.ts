import { describe, expect, it } from 'vitest';
import { parseProviderCatalog, resolveModelBindingDefinition } from '../../../src/domain/core/provider-catalog/index.js';
import { MODEL_ACTIVATION_TARGET_PREFIX, encodeModelActivationTarget, modelActivationActorSchema,
  parseModelActivationCommand, parseModelActivationReceipt, parseModelActivationRecord,
  transitionModelActivation } from '../../../src/domain/core/model-activation/index.js';

const reference = { providerId: 'provider-a', providerVersion: 2, modelId: 'model-a', modelVersion: 3 };
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'a'.repeat(64) };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog-a', providers: [
  { id: 'provider-a', version: 2, models: [{ id: 'model-a', version: 3, nativeId: 'vendor/model-a',
    protocols: [{ family: 'responses', version: '1', capabilities: [{ id: 'text', version: 1, state: 'supported' }] }] }] },
] }), reference)!;
const activate = { schemaVersion: 1 as const, action: 'activate' as const, commandId: 'activate-a', scopeId: 'scope-a', reference,
  expectedRevision: 0, catalogRevision: 'catalog-a', expectedBinding: binding };
const deactivate = (revision = 1) => ({ schemaVersion: 1 as const, action: 'deactivate' as const, commandId: 'deactivate-a',
  scopeId: 'scope-a', reference, expectedRevision: revision, expectedBinding: binding });

describe('model activation domain', () => {
  it('encodes an exact reference with stable versioned bytes independent of object key order', () => {
    const golden = MODEL_ACTIVATION_TARGET_PREFIX +
      '{"modelId":"model-a","modelVersion":3,"providerId":"provider-a","providerVersion":2}';
    expect(encodeModelActivationTarget(reference)).toBe(golden);
    expect(encodeModelActivationTarget({ modelVersion: 3, providerVersion: 2, modelId: 'model-a', providerId: 'provider-a' })).toBe(golden);
    expect(encodeModelActivationTarget({ ...reference, modelVersion: 4 })).not.toBe(golden);
  });

  it('strictly parses commands and the stable actor without accepting mutable membership', () => {
    const parsed = parseModelActivationCommand(activate); expect(parsed).toEqual(activate);
    expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.reference)).toBe(true);
    expect(Object.isFrozen(parsed.expectedBinding)).toBe(true);
    expect(parseModelActivationCommand(deactivate())).toEqual(deactivate());
    for (const invalid of [{ ...activate, extra: true }, { ...activate, expectedRevision: -1 },
      { ...activate, expectedBinding: { ...binding, digest: 'A'.repeat(64) } }, { ...deactivate(), expectedRevision: 0 },
      { ...deactivate(), catalogRevision: 'forged' }]) {
      expect(() => parseModelActivationCommand(invalid)).toThrow('MODEL_ACTIVATION_INVALID');
    }
    expect(modelActivationActorSchema.parse({ id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' })).toEqual(
      { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' });
    expect(() => modelActivationActorSchema.parse({ id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['scope-a'] })).toThrow();
  });

  it('rejects getters and cycles before command or target schema traversal', () => {
    let calls = 0;
    const getter = Object.defineProperty({}, 'providerId', { enumerable: true, get() { calls++; return 'provider-a'; } });
    expect(() => encodeModelActivationTarget(getter)).toThrow('MODEL_ACTIVATION_INVALID'); expect(calls).toBe(0);
    const cyclic: Record<string, unknown> = { ...activate }; cyclic['cycle'] = cyclic;
    expect(() => parseModelActivationCommand(cyclic)).toThrow('MODEL_ACTIVATION_INVALID');
  });

  it('activates, re-attests with CAS, deactivates without catalog input, and retains pinned evidence', () => {
    const active = transitionModelActivation(null, activate, definition);
    expect(active).toMatchObject({ schemaVersion: 1, revision: 1, state: 'active', definition, binding, catalogRevision: 'catalog-a' });
    const reattested = transitionModelActivation(active, { ...activate, commandId: 'activate-b', expectedRevision: 1 }, definition);
    expect(reattested).toMatchObject({ revision: 2, state: 'active' });
    const inactive = transitionModelActivation(reattested, deactivate(2));
    expect(inactive).toMatchObject({ revision: 3, state: 'inactive', definition, binding, catalogRevision: 'catalog-a' });
    expect(() => transitionModelActivation(inactive, deactivate(3))).toThrow('MODEL_ACTIVATION_NOT_ACTIVE');
  });

  it('fails closed on absent deactivation, revision/binding mismatch, and definition/reference mismatch', () => {
    expect(() => transitionModelActivation(null, deactivate())).toThrow('MODEL_ACTIVATION_NOT_FOUND');
    const active = transitionModelActivation(null, activate, definition);
    expect(() => transitionModelActivation(active, { ...deactivate(), expectedRevision: 2 })).toThrow('MODEL_ACTIVATION_REVISION_CONFLICT');
    expect(() => transitionModelActivation(active, { ...deactivate(), expectedBinding: { ...binding, digest: 'b'.repeat(64) } })).toThrow('MODEL_ACTIVATION_BINDING_CONFLICT');
    expect(() => transitionModelActivation(null, activate, { ...definition, model: { ...definition.model, id: 'other' } })).toThrow('MODEL_ACTIVATION_INVALID');
  });

  it('validates stored records and internally consistent immutable receipts', () => {
    const record = transitionModelActivation(null, activate, definition);
    const receipt = { schemaVersion: 1, command: activate, actor: { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' },
      authorization: { revision: 'policy-a', ruleId: 'activate-rule' }, previousRevision: null, record, admittedAtMs: 1000 };
    expect(parseModelActivationRecord(record)).toEqual(record);
    expect(parseModelActivationReceipt(receipt)).toEqual(receipt);
    expect(() => parseModelActivationReceipt({ ...receipt, previousRevision: 1 })).toThrow('MODEL_ACTIVATION_INVALID');
    expect(() => parseModelActivationRecord({ ...record, reference: { ...reference, modelVersion: 4 } })).toThrow('MODEL_ACTIVATION_INVALID');
  });
});
