import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ModelActivationStoreError, modelActivationTargetId, verifyModelActivationReceipt } from '../../../src/engine/core/model-activation/index.js';
import { parseModelActivationReceipt, transitionModelActivation } from '../../../src/domain/core/model-activation/index.js';

const reference = Object.freeze({ providerId: 'provider', providerVersion: 2, modelId: 'model', modelVersion: 3 });
const definition = Object.freeze({ encodingVersion: 1 as const, provider: Object.freeze({ id: 'provider', version: 2 }), model: Object.freeze({
  id: 'model', version: 3, nativeId: 'native/model', protocols: Object.freeze([{ family: 'native', version: 'v1', capabilities: Object.freeze([]) }]),
}) });
const binding = Object.freeze({ encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: 'b0dc8a5d82596ec1d603579543466573753a50d72d47809e6a90bbb3a3add243' });
const command = Object.freeze({ schemaVersion: 1 as const, commandId: 'activation-1', scopeId: 'scope-a', action: 'activate' as const,
  reference, expectedRevision: 0, catalogRevision: 'catalog-1', expectedBinding: binding });
const actor = Object.freeze({ id: 'operator', issuer: 'host', subject: '1000', assurance: 'os-user' as const });
const authorization = Object.freeze({ revision: 'policy-1', ruleId: 'activate-model' });

function receipt() {
  const record = transitionModelActivation(null, command, definition);
  return parseModelActivationReceipt({ schemaVersion: 1, command, actor, authorization, previousRevision: null, record, admittedAtMs: 10 });
}

it('derives a domain-separated target id from exact reference bytes, independent of object insertion order', () => {
  const expectedBytes = 'deckent.model-activation-target.v1\n{"modelId":"model","modelVersion":3,"providerId":"provider","providerVersion":2}';
  const expected = createHash('sha256').update(expectedBytes, 'utf8').digest('hex');
  expect(expected).toBe('1f42eb8632630b66ef3889989408333975a6152ceb77ce29209960e4bbe1227f');
  expect(modelActivationTargetId(reference)).toBe(expected);
  expect(modelActivationTargetId({ modelVersion: 3, providerVersion: 2, modelId: 'model', providerId: 'provider' })).toBe(expected);
});

it('keeps policy targets exact at provider/model version boundaries and rejects ambiguous references', () => {
  const target = modelActivationTargetId(reference);
  expect(modelActivationTargetId({ ...reference, providerVersion: 3 })).not.toBe(target);
  expect(modelActivationTargetId({ ...reference, modelVersion: 4 })).not.toBe(target);
  expect(() => modelActivationTargetId({ providerId: 'provider', modelId: 'model', modelVersion: 3 })).toThrow('MODEL_ACTIVATION_INVALID');
  expect(() => modelActivationTargetId({ ...reference, providerId: ' provider' })).toThrow('MODEL_ACTIVATION_INVALID');
});

it('rejects a stored receipt whose declared binding digest does not authenticate its exact definition', () => {
  const stored = receipt();
  const tampered = { ...stored, record: { ...stored.record, binding: { ...stored.record.binding, digest: 'f'.repeat(64) } } };
  expect(() => verifyModelActivationReceipt(tampered)).toThrow(expect.objectContaining({ code: 'MODEL_ACTIVATION_CORRUPT' } satisfies Partial<ModelActivationStoreError>));
});
