import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { encodeModelInvocationProfile, encodeModelInvocationRequest, MODEL_INVOCATION_NATIVE_JSON_LIMITS,
  modelInvocationRequestEvidence, parseModelInvocationCommand, parseModelInvocationProfile,
  parseModelInvocationPurgeCommand, parseModelInvocationPurgeReceipt, parseModelInvocationReceipt } from '#domain/core/model-invocation/index.js';

const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };
const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'p', version: 1,
  models: [{ id: 'm', version: 1, nativeId: 'native', protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] }] }, reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const command = { schemaVersion: 1 as const, commandId: 'c', scopeId: 's', reference, catalogRevision: 'catalog',
  expectedBinding: binding, nativeRequest: { messages: [{ content: 'hello', role: 'user' }] } };
const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 's', reference, bindingDigest: binding.digest,
  protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: { origin: 'http://127.0.0.1:1' } },
  allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 1 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 2048, timeoutMs: 1000 } };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('model invocation domain contract', () => {
  it('copies bounded commands and profiles without invoking getters and encodes them deterministically', () => {
    const parsed = parseModelInvocationCommand(command), parsedProfile = parseModelInvocationProfile(profile);
    expect(Object.isFrozen(parsed.nativeRequest)).toBe(true); expect(Object.isFrozen(parsedProfile.adapter.definition)).toBe(true);
    expect(encodeModelInvocationRequest({ ...command, nativeRequest: { b: 2, a: 1 } }))
      .toBe(encodeModelInvocationRequest({ ...command, nativeRequest: { a: 1, b: 2 } }));
    expect(encodeModelInvocationProfile(profile)).toContain('deckent.model-invocation-profile.v1');
    const getter = Object.defineProperty({}, 'messages', { enumerable: true, get() { throw new Error('CALLED'); } });
    expect(() => parseModelInvocationCommand({ ...command, nativeRequest: getter })).toThrow('MODEL_INVOCATION_INVALID');
    const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
    expect(() => parseModelInvocationCommand({ ...command, nativeRequest: cyclic })).toThrow('MODEL_INVOCATION_INVALID');
    expect(() => parseModelInvocationCommand({ ...command,
      nativeRequest: { value: 'x'.repeat(MODEL_INVOCATION_NATIVE_JSON_LIMITS.maxCodeUnits + 1) } })).toThrow('MODEL_INVOCATION_INVALID');
  });

  it('retains only request evidence and rejects profile protocols outside the exact definition', () => {
    const requestDigest = sha(encodeModelInvocationRequest(command)), profileDigest = sha(encodeModelInvocationProfile(profile));
    const request = modelInvocationRequestEvidence(command, requestDigest);
    expect(request).not.toHaveProperty('nativeRequest');
    const receipt = { schemaVersion: 4, request, actor: { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user' },
      authorization: { revision: 'policy', ruleId: 'rule' }, definition, activationRevision: 1, profile, profileDigest,
      claim: { scopeId: 's', commandId: 'c', invocationId: 'i', requestDigest, profileDigest }, claimedAtMs: 1, outcome: null };
    expect(parseModelInvocationReceipt(receipt).request).toEqual(request);
    expect(() => parseModelInvocationReceipt({ ...receipt, schemaVersion: 3 })).toThrow('MODEL_INVOCATION_INVALID');
    expect(() => parseModelInvocationReceipt({ ...receipt, profile: { ...profile, protocol: { family: 'other', version: '1' } } }))
      .toThrow('MODEL_INVOCATION_INVALID');
  });

  it('validates immutable purge commands and audit receipts through descriptor-safe ingress', () => {
    const purgeCommand = { schemaVersion: 1 as const, commandId: 'purge', scopeId: 's', invocationId: 'i', reference,
      expectedContentDigest: 'a'.repeat(64) };
    const purgeReceipt = { schemaVersion: 1 as const, command: purgeCommand,
      actor: { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user' as const },
      authorization: { revision: 'policy', ruleId: 'purge-content' }, purgedAtMs: 3 };
    expect(parseModelInvocationPurgeCommand(purgeCommand)).toEqual(purgeCommand);
    expect(parseModelInvocationPurgeReceipt(purgeReceipt)).toEqual(purgeReceipt);
    expect(() => parseModelInvocationPurgeCommand({ ...purgeCommand, extra: true })).toThrow('MODEL_INVOCATION_INVALID');
    const getter = Object.defineProperty({}, 'commandId', { enumerable: true, get() { throw new Error('CALLED'); } });
    expect(() => parseModelInvocationPurgeCommand(getter)).toThrow('MODEL_INVOCATION_INVALID');
  });
});
