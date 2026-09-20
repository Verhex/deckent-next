import { createHash } from 'node:crypto';
import { createImmutableJsonObjectSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS, modelInvocationResponseEvidenceSchema,
  modelInvocationRejectionReasonSchema, type ModelInvocationResponseEvidence, type ModelInvocationProfile,
  type ModelInvocationRejectionReason } from '#domain/index.js';
import { ModelInvocationStoreError } from './port.js';
const envelope = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
const prefix = 'deckent.model-invocation-response-bytes.v1\n';
const digest = (body: Uint8Array) => createHash('sha256').update(prefix, 'utf8').update(body).digest('hex');

export function verifyModelInvocationResponseEvidence(input: unknown, profile?: ModelInvocationProfile): ModelInvocationResponseEvidence {
  try {
    const copied = envelope.safeParse(input), parsed = copied.success ? modelInvocationResponseEvidenceSchema.safeParse(copied.data) : undefined;
    if (!parsed?.success) throw new Error();
    const evidence = parsed.data, body = Buffer.from(evidence.body.data, 'base64');
    if (body.toString('base64') !== evidence.body.data || body.byteLength !== evidence.body.byteLength || digest(body) !== evidence.body.digest
      || (profile && (body.byteLength > profile.limits.responseMaxBytes || evidence.adapter.id !== profile.adapter.id
        || evidence.adapter.version !== profile.adapter.version))) throw new Error();
    return evidence;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
/** Full response bytes or an explicitly incomplete retained prefix; no headers or secrets from transport metadata. */
export function createModelInvocationResponseEvidence(adapter: ModelInvocationResponseEvidence['adapter'], reason: ModelInvocationRejectionReason,
  httpStatus: number | null, body: Uint8Array, complete: boolean, observedBytes = body.byteLength): ModelInvocationResponseEvidence {
  return verifyModelInvocationResponseEvidence({ schemaVersion: 1, adapter: { id: adapter.id, version: adapter.version }, reason, httpStatus,
    body: { encoding: 'base64', data: Buffer.from(body).toString('base64'), byteLength: body.byteLength,
      observedBytes, complete, digest: digest(body) } });
}
/** Encoded content is ASCII base64; use arithmetic, never allocate a configured maximum-sized payload. */
export function modelInvocationResponseEvidenceUpperBound(profile: ModelInvocationProfile): bigint {
  const encodedBytes = 4n * ((BigInt(profile.limits.responseMaxBytes) + 2n) / 3n);
  let maximum = 0n;
  for (const reason of modelInvocationRejectionReasonSchema.options) {
    const skeleton = { schemaVersion: 1, adapter: { id: profile.adapter.id, version: profile.adapter.version }, reason,
      httpStatus: null, body: { encoding: 'base64', data: '', byteLength: Number.MAX_SAFE_INTEGER,
        observedBytes: Number.MAX_SAFE_INTEGER, complete: false, digest: 'f'.repeat(64) } };
    const bytes = BigInt(Buffer.byteLength(JSON.stringify(skeleton), 'utf8')) + encodedBytes;
    if (bytes > maximum) maximum = bytes;
  }
  return maximum;
}
