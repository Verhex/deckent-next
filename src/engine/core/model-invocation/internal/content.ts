import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { counterSchema, createImmutableJsonObjectSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS, MODEL_INVOCATION_RECEIPT_JSON_LIMITS,
  modelActivationActorSchema, modelActivationAuthorizationSchema, modelInvocationPurgeCommandSchema,
  modelInvocationResponseContentSchema, parseModelInvocationNativeResponse, type ModelInvocationContentDescriptor,
  parseModelInvocationPurgeReceipt, type ModelInvocationNativeResponse, type ModelInvocationPurgeReceipt, type ModelInvocationReceipt,
  type ModelInvocationResponseEvidence } from '#domain/index.js';
import { verifyModelInvocationReceipt } from './evidence.js';
import { modelInvocationResponseBodyDigest, verifyModelInvocationResponseEvidence } from './response-evidence.js';
import { ModelInvocationStoreError, type ModelInvocationPurgeAdmission, type ModelInvocationRecord } from './port.js';
import { z } from 'zod';

const nativePrefix = 'deckent.model-invocation-native-response.v1\n';
const recordEnvelope = createImmutableJsonObjectSchema({ maxDepth: MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxDepth + 2,
  maxNodes: MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxNodes * 3, maxCodeUnits: MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxCodeUnits * 3 });
const payloadEnvelope = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
const purgeAdmissionSchema = z.object({ command: modelInvocationPurgeCommandSchema, actor: modelActivationActorSchema,
  authorization: modelActivationAuthorizationSchema, purgedAtMs: counterSchema }).strict();
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
function nativeDescriptor(response: ModelInvocationNativeResponse): ModelInvocationContentDescriptor {
  const encoded = canonical(response);
  return Object.freeze({ schemaVersion: 1, kind: 'native-response', encoding: 'canonical-json',
    digest: createHash('sha256').update(nativePrefix, 'utf8').update(encoded, 'utf8').digest('hex'),
    byteLength: Buffer.byteLength(encoded, 'utf8') });
}
const bodyDescriptor = (evidence: ModelInvocationResponseEvidence): ModelInvocationContentDescriptor => Object.freeze({
  schemaVersion: 1, kind: 'response-body', encoding: 'base64', digest: evidence.body.digest, byteLength: evidence.body.byteLength,
});
const summarize = (evidence: ModelInvocationResponseEvidence) => {
  const body = { encoding: evidence.body.encoding, byteLength: evidence.body.byteLength,
    observedBytes: evidence.body.observedBytes, complete: evidence.body.complete, digest: evidence.body.digest };
  return Object.freeze({ ...evidence, body: Object.freeze(body) });
};
function claimReceipt(input: unknown): ModelInvocationReceipt {
  const receipt = verifyModelInvocationReceipt(input);
  if (receipt.outcome !== null) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  return receipt;
}
export function createModelInvocationResponseRecord(claimInput: unknown, responseInput: unknown,
  observedAtMs: number): ModelInvocationRecord {
  const claim = claimReceipt(claimInput), response = parseModelInvocationNativeResponse(responseInput);
  const descriptor = nativeDescriptor(response);
  return verifyModelInvocationRecord({ receipt: { ...claim, outcome: { schemaVersion: 3, state: 'responded', content: descriptor, observedAtMs } },
    content: { schemaVersion: 1, kind: 'native-response', descriptor, response }, purge: null });
}
export function createModelInvocationEvidenceRecord(claimInput: unknown, evidenceInput: unknown,
  observedAtMs: number): ModelInvocationRecord {
  const claim = claimReceipt(claimInput);
  const evidence = verifyModelInvocationResponseEvidence(evidenceInput, claim.profile), descriptor = bodyDescriptor(evidence);
  return verifyModelInvocationRecord({ receipt: { ...claim, outcome: evidence.body.complete
    ? { schemaVersion: 3, state: 'rejected', evidence: summarize(evidence), content: descriptor, observedAtMs }
    : { schemaVersion: 3, state: 'unknown', reason: 'transport-error', evidence: summarize(evidence), content: descriptor, observedAtMs } },
  content: { schemaVersion: 1, kind: 'response-body', descriptor, data: evidence.body.data }, purge: null });
}
export function createModelInvocationUnknownRecord(claimInput: unknown, observedAtMs: number): ModelInvocationRecord {
  const claim = claimReceipt(claimInput);
  return verifyModelInvocationRecord({ receipt: { ...claim, outcome: { schemaVersion: 3, state: 'unknown', reason: 'transport-error',
    evidence: null, content: null, observedAtMs } }, content: null, purge: null });
}
export function verifyModelInvocationPurgeReceipt(input: unknown): ModelInvocationPurgeReceipt {
  try { return parseModelInvocationPurgeReceipt(input); }
  catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
export function parseModelInvocationPurgeAdmission(input: unknown): ModelInvocationPurgeAdmission {
  try {
    const copied = payloadEnvelope.parse(input), parsed = purgeAdmissionSchema.parse(copied);
    return Object.freeze(parsed);
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
export function verifyModelInvocationRecord(input: unknown): ModelInvocationRecord {
  try {
    const copied = recordEnvelope.parse(input);
    if (!copied || typeof copied !== 'object' || Array.isArray(copied)) throw new Error();
    const value = copied as Readonly<Record<string, unknown>>;
    if (Object.keys(value).sort().join(',') !== 'content,purge,receipt') throw new Error();
    const receipt = verifyModelInvocationReceipt(value['receipt']), outcome = receipt.outcome;
    const parsed = value['content'] === null ? null : modelInvocationResponseContentSchema.parse(value['content']);
    const purge = value['purge'] === null ? null : verifyModelInvocationPurgeReceipt(value['purge']);
    if (!outcome) { if (parsed !== null || purge !== null) throw new Error(); return Object.freeze({ receipt, content: null, purge: null }); }
    if (outcome.content === null) {
      if (parsed !== null || purge !== null || outcome.state !== 'unknown' || outcome.evidence !== null) throw new Error();
      return Object.freeze({ receipt, content: null, purge: null });
    }
    if (purge) {
      const command = purge.command;
      if (parsed !== null || command.scopeId !== receipt.claim.scopeId || command.invocationId !== receipt.claim.invocationId
        || !isDeepStrictEqual(command.reference, receipt.request.reference)
        || command.expectedContentDigest !== outcome.content.digest) throw new Error();
      return Object.freeze({ receipt, content: null, purge });
    }
    if (!parsed || !isDeepStrictEqual(parsed.descriptor, outcome.content)) throw new Error();
    if (parsed.kind === 'native-response') {
      const response = parseModelInvocationNativeResponse(parsed.response);
      if (outcome.state !== 'responded' || !isDeepStrictEqual(nativeDescriptor(response), parsed.descriptor)
        || Buffer.byteLength(JSON.stringify(parsed.response.native), 'utf8') > receipt.profile.limits.responseMaxBytes) throw new Error();
    } else {
      if (outcome.state === 'responded' || !outcome.evidence) throw new Error();
      const body = Buffer.from(parsed.data, 'base64');
      if (!payloadEnvelope.safeParse({ data: parsed.data }).success || body.toString('base64') !== parsed.data
        || modelInvocationResponseBodyDigest(body) !== parsed.descriptor.digest
        || outcome.evidence.body.digest !== parsed.descriptor.digest || outcome.evidence.body.byteLength !== parsed.descriptor.byteLength) throw new Error();
    }
    return Object.freeze({ receipt, content: parsed, purge: null });
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
