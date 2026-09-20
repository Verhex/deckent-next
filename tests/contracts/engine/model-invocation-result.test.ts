import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, createModelInvocationClaimReceipt,
  createModelInvocationResponseEvidence, projectModelInvocationReceipt, parseModelInvocationInspectionForQuery, parseModelInvocationResultForCommand } from '#engine/core/model-invocation/index.js';

const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] }] }, reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference,
  catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: { prompt: 'private' } };
const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
  bindingDigest: binding.digest, protocol: { family: 'chat', version: '1' },
  adapter: { id: 'adapter', version: 1, definition: { origin: 'loopback' } },
  allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 1 },
  limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
const admission = { command, requestDigest: modelInvocationRequestDigest(command),
  actor: { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user' as const },
  authorization: { revision: 'policy', ruleId: 'invoke' }, definition,
  activation: { schemaVersion: 1 as const, scopeId: 'scope', reference, revision: 1, state: 'active' as const,
    catalogRevision: 'catalog', definition, binding }, profile, profileDigest: modelInvocationProfileDigest(profile),
  invocationId: 'invocation', claimedAtMs: 1 };
const receipt = createModelInvocationClaimReceipt(admission);
const result = { replayed: false, receipt };
const query = { schemaVersion: 1 as const, scopeId: 'scope', invocationId: 'invocation', reference };
const inspection = { ...query, invocation: receipt };

describe('model invocation runtime result correlation', () => {
  it('accepts exact command results and nullable or exact query inspections', () => {
    expect(parseModelInvocationResultForCommand(command, result)).toEqual(result);
    expect(parseModelInvocationInspectionForQuery(query, inspection)).toEqual(inspection);
    expect(parseModelInvocationInspectionForQuery(query, { ...query, invocation: null })).toEqual({ ...query, invocation: null });
  });

  it('does not make a valid receipt boundary smaller by wrapping it in a runtime result', () => {
    let native: unknown = 'leaf';
    for (let depth = 0; depth < 13; depth++) native = { next: native };
    const boundaryReceipt = { ...receipt, outcome: { schemaVersion: 2 as const, state: 'responded' as const,
      response: { schemaVersion: 1 as const, native, usage: null }, observedAtMs: 2 } };
    const boundaryResult = { replayed: false, receipt: boundaryReceipt };
    expect(parseModelInvocationResultForCommand(command, boundaryResult)).toEqual(boundaryResult);
    expect(parseModelInvocationInspectionForQuery(query, { ...query, invocation: boundaryReceipt }))
      .toEqual({ ...query, invocation: boundaryReceipt });
  });

  it('rejects unsolicited raw bytes and verifies explicitly requested evidence against its projection', () => {
    const evidence = createModelInvocationResponseEvidence(profile.adapter, 'invalid-response', 200, Buffer.from('private echoed input'), true);
    const stored = { ...receipt, outcome: { schemaVersion: 2 as const, state: 'rejected' as const, evidence, observedAtMs: 2 } };
    const view = projectModelInvocationReceipt(stored);
    expect(() => parseModelInvocationResultForCommand(command, { replayed: false, receipt: stored })).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(parseModelInvocationResultForCommand(command, { replayed: false, receipt: view }).receipt).toEqual(view);
    const ordinary = { ...query, invocation: view }, explicitQuery = { ...query, includeResponseEvidence: true };
    const explicit = { ...ordinary, responseEvidence: evidence };
    expect(parseModelInvocationInspectionForQuery(query, ordinary)).toEqual(ordinary);
    expect(() => parseModelInvocationInspectionForQuery(query, explicit)).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(() => parseModelInvocationInspectionForQuery(explicitQuery, ordinary)).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(parseModelInvocationInspectionForQuery(explicitQuery, explicit)).toEqual(explicit);
    const foreign = createModelInvocationResponseEvidence(profile.adapter, 'invalid-response', 200, Buffer.from('foreign response'), true);
    for (const value of [foreign, { ...evidence, body: { ...evidence.body, data: foreign.body.data } }, null]) {
      expect(() => parseModelInvocationInspectionForQuery(explicitQuery, { ...explicit, responseEvidence: value })).toThrow('MODEL_INVOCATION_CORRUPT');
    }
    const unknown = { ...stored, outcome: { schemaVersion: 2 as const, state: 'unknown' as const, reason: 'transport-error' as const,
      evidence: null, observedAtMs: 2 } };
    expect(parseModelInvocationInspectionForQuery(explicitQuery, { ...ordinary, invocation: unknown, responseEvidence: null }))
      .toEqual({ ...ordinary, invocation: unknown, responseEvidence: null });
    expect(() => parseModelInvocationInspectionForQuery(query, { ...ordinary, invocation: stored })).toThrow('MODEL_INVOCATION_CORRUPT');
  });

  it('rejects extra keys, invalid replay flags, malformed receipts and hostile descriptors', () => {
    for (const value of [{ ...result, extra: true }, { ...result, replayed: 'false' },
      { ...result, receipt: { ...receipt, extra: true } }]) {
      expect(() => parseModelInvocationResultForCommand(command, value)).toThrow('MODEL_INVOCATION_CORRUPT');
    }
    const getter = Object.defineProperty({}, 'receipt', { enumerable: true, get() { throw new Error('getter'); } });
    expect(() => parseModelInvocationResultForCommand(command, getter)).toThrow('MODEL_INVOCATION_CORRUPT');
    const cycle: Record<string, unknown> = { replayed: false }; cycle['receipt'] = cycle;
    expect(() => parseModelInvocationResultForCommand(command, cycle)).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(() => parseModelInvocationResultForCommand(command, { replayed: false, receipt, value: Number.NaN }))
      .toThrow('MODEL_INVOCATION_CORRUPT');
  });

  it('rejects command evidence mismatches including a recomputed foreign digest', () => {
    const changed = { ...command, nativeRequest: { prompt: 'changed' } };
    expect(() => parseModelInvocationResultForCommand(changed, result)).toThrow('MODEL_INVOCATION_CORRUPT');
    const foreignCommand = { ...command, commandId: 'foreign' };
    expect(() => parseModelInvocationResultForCommand(foreignCommand, result)).toThrow('MODEL_INVOCATION_CORRUPT');
    const forgedRequest = { ...receipt.request, requestDigest: modelInvocationRequestDigest(changed) };
    expect(() => parseModelInvocationResultForCommand(command,
      { ...result, receipt: { ...receipt, request: forgedRequest } })).toThrow('MODEL_INVOCATION_CORRUPT');
  });

  it('rejects inspection envelope, query and stored receipt identity mismatches', () => {
    const cases = [
      { ...inspection, extra: true },
      { ...inspection, scopeId: 'foreign' },
      { ...inspection, invocationId: 'foreign' },
      { ...inspection, reference: { ...reference, modelVersion: 2 } },
      { ...inspection, invocation: { ...receipt, claim: { ...receipt.claim, invocationId: 'foreign' } } },
      { ...inspection, invocation: { ...receipt, request: { ...receipt.request,
        reference: { ...reference, modelId: 'foreign' } } } },
    ];
    for (const value of cases) expect(() => parseModelInvocationInspectionForQuery(query, value))
      .toThrow('MODEL_INVOCATION_CORRUPT');
  });
});
