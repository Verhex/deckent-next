import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, createModelInvocationClaimReceipt,
  createModelInvocationEvidenceRecord, createModelInvocationResponseEvidence, createModelInvocationResponseRecord,
  createModelInvocationUnknownRecord, parseModelInvocationInspectionForQuery, parseModelInvocationResultForCommand,
  verifyModelInvocationRecord } from '#engine/core/model-invocation/index.js';
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native/model', protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] }] }, reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const command = { schemaVersion: 1 as const, commandId: 'command', scopeId: 'scope', reference,
  catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: { prompt: 'private' } };
const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
  bindingDigest: binding.digest, protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: {} },
  allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 1 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
const receipt = createModelInvocationClaimReceipt({ command, requestDigest: modelInvocationRequestDigest(command),
  actor: { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user' }, authorization: { revision: 'policy', ruleId: 'invoke' }, definition,
  activation: { schemaVersion: 1, scopeId: 'scope', reference, revision: 1, state: 'active', catalogRevision: 'catalog', definition, binding },
  profile, profileDigest: modelInvocationProfileDigest(profile), invocationId: 'invocation', claimedAtMs: 1 });
const query = { schemaVersion: 2 as const, scopeId: 'scope', invocationId: 'invocation', reference };

describe('model invocation runtime result correlation', () => {
  it('correlates retained native content outside the immutable settlement receipt', () => {
    const response = { schemaVersion: 1 as const, native: { id: 'response' }, usage: { total_tokens: 2 } };
    const record = createModelInvocationResponseRecord(receipt, response, 2);
    const result = { replayed: false, receipt: record.receipt, response, contentStatus: 'retained' as const };
    expect(parseModelInvocationResultForCommand(command, result)).toEqual(result);
    expect(() => parseModelInvocationResultForCommand(command, { ...result, response: { ...response, native: { id: 'foreign' } } }))
      .toThrow('MODEL_INVOCATION_CORRUPT');
    expect(() => parseModelInvocationResultForCommand(command, { ...result, response: null })).toThrow('MODEL_INVOCATION_CORRUPT');
    let reads = 0;
    const getter = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { reads++; return 1; } });
    expect(() => createModelInvocationResponseRecord(receipt, getter, 2)).toThrow(); expect(reads).toBe(0);
  });

  it('preserves the native response depth budget through result and inspection wrappers', () => {
    let native: unknown = 'leaf';
    for (let depth = 0; depth < 13; depth++) native = { next: native };
    const response = { schemaVersion: 1 as const, native, usage: null };
    const record = createModelInvocationResponseRecord(receipt, response, 2);
    const result = { replayed: false, receipt: record.receipt, response, contentStatus: 'retained' as const };
    const inspection = { ...query, invocation: record.receipt, contentStatus: 'retained' as const };
    expect(parseModelInvocationResultForCommand(command, result)).toEqual(result);
    expect(parseModelInvocationInspectionForQuery(query, inspection)).toEqual(inspection);
    expect(parseModelInvocationInspectionForQuery({ ...query, includeResponseContent: true },
      { ...inspection, responseContent: record.content })).toEqual({ ...inspection, responseContent: record.content });
  });

  it('withholds rejected bytes by default and accepts only exact explicitly requested content', () => {
    const evidence = createModelInvocationResponseEvidence(profile.adapter, 'invalid-response', 200, Buffer.from('private echoed input'), true);
    const record = createModelInvocationEvidenceRecord(receipt, evidence, 2);
    const ordinary = { ...query, invocation: record.receipt, contentStatus: 'retained' as const };
    expect(parseModelInvocationInspectionForQuery(query, ordinary)).toEqual(ordinary);
    const explicitQuery = { ...query, includeResponseContent: true };
    const explicit = { ...ordinary, responseContent: record.content };
    expect(parseModelInvocationInspectionForQuery(explicitQuery, explicit)).toEqual(explicit);
    expect(() => parseModelInvocationInspectionForQuery(query, explicit)).toThrow('MODEL_INVOCATION_CORRUPT');
    const altered = { ...record.content!, data: Buffer.from('foreign').toString('base64') };
    expect(() => parseModelInvocationInspectionForQuery(explicitQuery, { ...explicit, responseContent: altered }))
      .toThrow('MODEL_INVOCATION_CORRUPT');
    const oneByte = createModelInvocationEvidenceRecord(receipt,
      createModelInvocationResponseEvidence(profile.adapter, 'invalid-response', 200, Buffer.from('f'), true), 2);
    expect(() => verifyModelInvocationRecord({ receipt: oneByte.receipt, content: { ...oneByte.content!, data: 'Zh==' } }))
      .toThrow('MODEL_INVOCATION_CORRUPT');
  });

  it('rejects forged rejected-response summary metadata at every read boundary', () => {
    const evidence = createModelInvocationResponseEvidence(profile.adapter, 'invalid-response', 200,
      Buffer.from('private echoed input'), true);
    const record = createModelInvocationEvidenceRecord(receipt, evidence, 2);
    if (record.receipt.outcome?.state !== 'rejected' || !record.receipt.outcome.evidence) throw new Error('FIXTURE');
    const summary = record.receipt.outcome.evidence;
    const forgedSummaries = [
      { ...summary, adapter: { ...summary.adapter, id: 'foreign-adapter' } },
      { ...summary, adapter: { ...summary.adapter, version: summary.adapter.version + 1 } },
      { ...summary, body: { ...summary.body, digest: '0'.repeat(64) } },
      { ...summary, body: { ...summary.body, byteLength: summary.body.byteLength + 1 } },
      { ...summary, body: { ...summary.body, byteLength: profile.limits.responseMaxBytes + 1 } },
    ];
    for (const forgedSummary of forgedSummaries) {
      const forgedReceipt = { ...record.receipt,
        outcome: { ...record.receipt.outcome, evidence: forgedSummary } };
      expect(() => parseModelInvocationResultForCommand(command,
        { replayed: false, receipt: forgedReceipt, response: null, contentStatus: 'retained' }))
        .toThrow('MODEL_INVOCATION_CORRUPT');
      expect(() => parseModelInvocationInspectionForQuery(query,
        { ...query, invocation: forgedReceipt, contentStatus: 'retained' }))
        .toThrow('MODEL_INVOCATION_CORRUPT');
      expect(() => verifyModelInvocationRecord({ receipt: forgedReceipt, content: record.content }))
        .toThrow('MODEL_INVOCATION_CORRUPT');
    }
  });

  it('distinguishes not-captured from retained content and rejects unsolicited content', () => {
    const unknown = createModelInvocationUnknownRecord(receipt, 2);
    const inspection = { ...query, invocation: unknown.receipt, contentStatus: 'not-captured' as const };
    expect(parseModelInvocationInspectionForQuery(query, inspection)).toEqual(inspection);
    expect(parseModelInvocationInspectionForQuery({ ...query, includeResponseContent: true }, { ...inspection, responseContent: null }))
      .toEqual({ ...inspection, responseContent: null });
    expect(() => verifyModelInvocationRecord({ receipt: unknown.receipt, content: { unexpected: true } })).toThrow('MODEL_INVOCATION_CORRUPT');
  });

  it('rejects query1, identity mismatches, hostile descriptors and command evidence mismatches', () => {
    const absent = { ...query, invocation: null, contentStatus: null };
    expect(parseModelInvocationInspectionForQuery(query, absent)).toEqual(absent);
    expect(() => parseModelInvocationInspectionForQuery({ ...query, schemaVersion: 1 }, absent)).toThrow();
    for (const value of [{ ...absent, extra: true }, { ...absent, scopeId: 'foreign' }, { ...absent, invocationId: 'foreign' }]) {
      expect(() => parseModelInvocationInspectionForQuery(query, value)).toThrow('MODEL_INVOCATION_CORRUPT');
    }
    const getter = Object.defineProperty({}, 'receipt', { enumerable: true, get() { throw new Error('getter'); } });
    expect(() => parseModelInvocationResultForCommand(command, getter)).toThrow('MODEL_INVOCATION_CORRUPT');
    const response = { schemaVersion: 1 as const, native: { id: 'response' }, usage: null };
    const record = createModelInvocationResponseRecord(receipt, response, 2);
    const result = { replayed: false, receipt: record.receipt, response, contentStatus: 'retained' as const };
    for (const value of [{ ...result, extra: true }, { ...result, replayed: 'false' },
      { ...result, receipt: { ...record.receipt, extra: true } },
      { ...result, response: { ...response, native: { value: Number.NaN } } }]) {
      expect(() => parseModelInvocationResultForCommand(command, value)).toThrow('MODEL_INVOCATION_CORRUPT');
    }
    const cycle: Record<string, unknown> = { replayed: false }; cycle['receipt'] = cycle;
    expect(() => parseModelInvocationResultForCommand(command, cycle)).toThrow('MODEL_INVOCATION_CORRUPT');
    const changed = { ...command, nativeRequest: { prompt: 'changed' } };
    expect(() => parseModelInvocationResultForCommand(changed, result)).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(() => parseModelInvocationResultForCommand({ ...command, commandId: 'foreign' }, result))
      .toThrow('MODEL_INVOCATION_CORRUPT');
    const foreignDigest = modelInvocationRequestDigest(changed);
    const forgedReceipt = { ...record.receipt,
      request: { ...record.receipt.request, requestDigest: foreignDigest },
      claim: { ...record.receipt.claim, requestDigest: foreignDigest } };
    expect(() => parseModelInvocationResultForCommand(command, { ...result, receipt: forgedReceipt }))
      .toThrow('MODEL_INVOCATION_CORRUPT');
    const inspection = { ...query, invocation: record.receipt, contentStatus: 'retained' as const };
    for (const value of [
      { ...inspection, reference: { ...reference, modelVersion: 2 } },
      { ...inspection, invocation: { ...record.receipt,
        claim: { ...record.receipt.claim, invocationId: 'foreign' } } },
      { ...inspection, invocation: { ...record.receipt,
        request: { ...record.receipt.request, reference: { ...reference, modelId: 'foreign' } } } },
    ]) expect(() => parseModelInvocationInspectionForQuery(query, value)).toThrow('MODEL_INVOCATION_CORRUPT');
  });
});
