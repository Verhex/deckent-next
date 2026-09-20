import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { createImmutableJsonObjectSchema, MODEL_INVOCATION_RECEIPT_JSON_LIMITS,
  modelInvocationRequestEvidence, modelInvocationResponseContentSchema, parseModelInvocationCommand, parseModelInvocationNativeResponse, parseModelInvocationQuery,
  type ModelInvocationResponseContent } from '#domain/index.js';
import type { ModelInvocationResult } from './application.js';
import type { ModelInvocationInspection } from './inspection.js';
import { modelInvocationRequestDigest, verifyModelInvocationReceipt } from './evidence.js';
import { verifyModelInvocationRecord } from './content.js';
import { ModelInvocationStoreError } from './port.js';
const envelope = createImmutableJsonObjectSchema({ maxDepth: MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxDepth + 1,
  maxNodes: MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxNodes * 2, maxCodeUnits: MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxCodeUnits * 2 });
const statusSchema = z.enum(['retained', 'not-captured']);
const resultSchema = z.object({ replayed: z.boolean(), receipt: z.unknown(), response: z.unknown().nullable(), contentStatus: statusSchema }).strict();
const inspectionSchema = z.object({ schemaVersion: z.literal(2), scopeId: z.string(), invocationId: z.string(), reference: z.unknown(),
  invocation: z.unknown().nullable(), contentStatus: statusSchema.nullable(), responseContent: z.unknown().optional() }).strict();
const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);
function corrupt(): never { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
function expectedStatus(receipt: ReturnType<typeof verifyModelInvocationReceipt>) {
  return receipt.outcome === null || (receipt.outcome.state === 'unknown' && receipt.outcome.content === null) ? 'not-captured' : 'retained';
}
export function parseModelInvocationResultForCommand(commandInput: unknown, input: unknown): ModelInvocationResult {
  try {
    const command = parseModelInvocationCommand(commandInput), copied = envelope.safeParse(input);
    const parsed = copied.success ? resultSchema.safeParse(copied.data) : undefined;
    if (!parsed?.success) return corrupt();
    const receipt = verifyModelInvocationReceipt(parsed.data.receipt), expected = modelInvocationRequestEvidence(command, modelInvocationRequestDigest(command));
    if (!same(receipt.request, expected) || parsed.data.contentStatus !== expectedStatus(receipt)) return corrupt();
    let response = null;
    if (parsed.data.response !== null) {
      response = parseModelInvocationNativeResponse(parsed.data.response);
      if (receipt.outcome?.state !== 'responded') return corrupt();
      verifyModelInvocationRecord({ receipt, content: { schemaVersion: 1, kind: 'native-response', descriptor: receipt.outcome.content, response } });
    } else if (receipt.outcome?.state === 'responded') return corrupt();
    return Object.freeze({ replayed: parsed.data.replayed, receipt, response, contentStatus: parsed.data.contentStatus });
  } catch (error) { if (error instanceof ModelInvocationStoreError) throw error; return corrupt(); }
}
export function parseModelInvocationInspectionForQuery(queryInput: unknown, input: unknown): ModelInvocationInspection {
  try {
    const query = parseModelInvocationQuery(queryInput), copied = envelope.safeParse(input);
    const parsed = copied.success ? inspectionSchema.safeParse(copied.data) : undefined;
    if (!parsed?.success || parsed.data.scopeId !== query.scopeId || parsed.data.invocationId !== query.invocationId || !same(parsed.data.reference, query.reference)) return corrupt();
    const wantsContent = query.includeResponseContent === true;
    if (Object.hasOwn(parsed.data, 'responseContent') !== wantsContent) return corrupt();
    const identity = { schemaVersion: query.schemaVersion, scopeId: query.scopeId, invocationId: query.invocationId, reference: query.reference };
    if (parsed.data.invocation === null) {
      if (parsed.data.contentStatus !== null || (wantsContent && parsed.data.responseContent !== null)) return corrupt();
      return Object.freeze({ ...identity, invocation: null, contentStatus: null, ...(wantsContent ? { responseContent: null } : {}) });
    }
    const receipt = verifyModelInvocationReceipt(parsed.data.invocation);
    if (receipt.claim.scopeId !== query.scopeId || receipt.claim.invocationId !== query.invocationId
      || !same(receipt.request.reference, query.reference) || parsed.data.contentStatus !== expectedStatus(receipt)) return corrupt();
    let responseContent: ModelInvocationResponseContent | null = null;
    if (wantsContent) {
      responseContent = parsed.data.responseContent === null ? null : modelInvocationResponseContentSchema.parse(parsed.data.responseContent);
      verifyModelInvocationRecord({ receipt, content: responseContent });
    }
    return Object.freeze({ ...identity, invocation: receipt, contentStatus: parsed.data.contentStatus, ...(wantsContent ? { responseContent } : {}) });
  } catch (error) { if (error instanceof ModelInvocationStoreError) throw error; return corrupt(); }
}
