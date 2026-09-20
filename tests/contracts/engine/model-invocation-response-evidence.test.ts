import { describe, expect, it } from 'vitest';
import { modelInvocationRejectionReasonSchema, modelInvocationOutcomeSchema, type ModelInvocationProfile } from '#domain/core/model-invocation/index.js';
import { createModelInvocationResponseEvidence, verifyModelInvocationResponseEvidence,
  modelInvocationResponseEvidenceUpperBound } from '#engine/core/model-invocation/index.js';
const profile: ModelInvocationProfile = { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope',
  reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 }, bindingDigest: 'a'.repeat(64),
  protocol: { family: 'protocol', version: '1' }, adapter: { id: 'adapter', version: 1, definition: {} },
  allocation: { id: 'allocation', maxCalls: 10, maxInFlight: 2 },
  limits: { requestMaxBytes: 4096, responseMaxBytes: 1024, timeoutMs: 1000 } };
const body = Buffer.from([0xff, 0, 34, 92, 10, 0xc3, 0xa7]);
const evidence = () => createModelInvocationResponseEvidence(profile.adapter, 'invalid-response', 200, body, true);

describe('private native response evidence', () => {
  it('retains exact arbitrary response bytes without interpreting them as text or executable data', () => {
    const saved = evidence();
    expect(Buffer.from(saved.body.data, 'base64')).toEqual(body);
    expect(saved.body).toMatchObject({ byteLength: body.length, observedBytes: body.length, complete: true });
    expect(Object.isFrozen(saved.body)).toBe(true);
    expect(verifyModelInvocationResponseEvidence(saved, profile)).toEqual(saved);
  });
  it('rejects altered bytes, digest, adapter, retained byte count, noncanonical padding and leaked headers', () => {
    const saved = evidence();
    for (const invalid of [
      { ...saved, body: { ...saved.body, digest: '0'.repeat(64) } },
      { ...saved, body: { ...saved.body, byteLength: body.length + 1 } },
      { ...saved, body: { ...saved.body, data: 'Zh==', byteLength: 1, observedBytes: 1 } },
      { ...saved, body: { ...saved.body, observedBytes: body.length - 1 } },
      { ...saved, adapter: { ...saved.adapter, version: 2 } },
      { ...saved, headers: { authorization: 'must-not-be-stored' } },
    ]) expect(() => verifyModelInvocationResponseEvidence(invalid, profile)).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(() => verifyModelInvocationResponseEvidence(saved, { ...profile, limits: { ...profile.limits, responseMaxBytes: body.length - 1 } }))
      .toThrow('MODEL_INVOCATION_CORRUPT');
    let reads = 0;
    const getter = Object.defineProperty({ ...saved }, 'body', { enumerable: true, get() { reads++; return saved.body; } });
    expect(() => verifyModelInvocationResponseEvidence(getter)).toThrow('MODEL_INVOCATION_CORRUPT'); expect(reads).toBe(0);
  });
  it('does not turn a retained prefix into complete evidence or release-worthy rejection', () => {
    const prefix = createModelInvocationResponseEvidence(profile.adapter, 'response-limit', 200, body, false, 4096);
    const prefixBody = { encoding: prefix.body.encoding, byteLength: prefix.body.byteLength,
      observedBytes: prefix.body.observedBytes, complete: prefix.body.complete, digest: prefix.body.digest };
    const summary = { ...prefix, body: prefixBody };
    const content = { schemaVersion: 1, kind: 'response-body', encoding: 'base64', digest: prefix.body.digest, byteLength: body.length };
    expect(prefix.body).toMatchObject({ complete: false, byteLength: body.length, observedBytes: 4096 });
    expect(modelInvocationOutcomeSchema.safeParse({ schemaVersion: 3, state: 'rejected', evidence: summary, content, observedAtMs: 1 }).success).toBe(false);
    expect(modelInvocationOutcomeSchema.safeParse({ schemaVersion: 3, state: 'unknown', reason: 'transport-error', evidence: summary, content, observedAtMs: 1 }).success).toBe(true);
    expect(modelInvocationOutcomeSchema.safeParse({ schemaVersion: 3, state: 'unknown', reason: 'transport-error', evidence: null, content, observedAtMs: 1 }).success).toBe(false);
    expect(() => createModelInvocationResponseEvidence(profile.adapter, 'interrupted', null, body, true)).toThrow('MODEL_INVOCATION_CORRUPT');
    expect(createModelInvocationResponseEvidence(profile.adapter, 'invalid-response', null, body, true).httpStatus).toBeNull();
  });
  it('bounds base64 expansion and every evidence variant without allocating the configured maximum', () => {
    const bound = modelInvocationResponseEvidenceUpperBound(profile);
    for (const length of [0, 1, 2, 3, 100, 1024]) for (const reason of modelInvocationRejectionReasonSchema.options) {
      const bytes = Buffer.alloc(length, 0xff);
      for (const complete of [true, false]) {
        if ((complete && reason === 'interrupted') || (!complete && reason !== 'interrupted' && reason !== 'response-limit')) continue;
        const saved = createModelInvocationResponseEvidence(profile.adapter, reason, complete ? 599 : null,
          bytes, complete, complete ? length : Number.MAX_SAFE_INTEGER);
        expect(BigInt(Buffer.byteLength(JSON.stringify(saved), 'utf8'))).toBeLessThanOrEqual(bound);
      }
    }
    expect(modelInvocationResponseEvidenceUpperBound({ ...profile,
      limits: { ...profile.limits, responseMaxBytes: Number.MAX_SAFE_INTEGER } })).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
});
