import { summarizeModelInvocationResponse, verifyModelInvocationReceiptView } from './projection.js';
import { verifyModelInvocationResponseEvidence } from './response-evidence.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { createImmutableJsonObjectSchema, MODEL_INVOCATION_RECEIPT_JSON_LIMITS,
  modelInvocationRequestEvidence, parseModelInvocationCommand, parseModelInvocationQuery,
  type ModelInvocationReceiptView } from '#domain/index.js';
import type { ModelInvocationResult } from './application.js';
import type { ModelInvocationInspection } from './inspection.js';
import { modelInvocationRequestDigest } from './evidence.js';
import { ModelInvocationStoreError } from './port.js';

// The transport wrapper contains a receipt that may itself use the full receipt boundary.
// Headroom applies only to the descriptor-safe outer copy; the view verifier independently
// checks the receipt fragments and explicitly requested evidence has its own payload bound.
const envelope = createImmutableJsonObjectSchema({
  maxDepth: MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxDepth + 1,
  maxNodes: MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxNodes * 2,
  maxCodeUnits: MODEL_INVOCATION_RECEIPT_JSON_LIMITS.maxCodeUnits * 2,
});
const resultSchema = z.object({ replayed: z.boolean(), receipt: z.unknown() }).strict();
const inspectionSchema = z.object({ schemaVersion: z.literal(1), scopeId: z.string(), invocationId: z.string(),
  reference: z.unknown(), invocation: z.unknown().nullable(), responseEvidence: z.unknown().optional() }).strict();
const same = (left: unknown, right: unknown) => isDeepStrictEqual(left, right);
function corrupt(): never { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }

/** Validates an untrusted runtime result and binds it to the caller's exact command evidence. */
export function parseModelInvocationResultForCommand(commandInput: unknown, input: unknown): ModelInvocationResult {
  try {
    const command = parseModelInvocationCommand(commandInput), copied = envelope.safeParse(input);
    const parsed = copied.success ? resultSchema.safeParse(copied.data) : undefined;
    if (!parsed?.success) return corrupt();
    const receipt = verifyModelInvocationReceiptView(parsed.data.receipt);
    const expected = modelInvocationRequestEvidence(command, modelInvocationRequestDigest(command));
    if (!same(receipt.request, expected)) return corrupt();
    return Object.freeze({ replayed: parsed.data.replayed, receipt });
  } catch (error) {
    if (error instanceof ModelInvocationStoreError) throw error;
    return corrupt();
  }
}

/** Validates an untrusted runtime inspection and binds nullable evidence to the exact query. */
export function parseModelInvocationInspectionForQuery(queryInput: unknown, input: unknown): ModelInvocationInspection {
  try {
    const query = parseModelInvocationQuery(queryInput), copied = envelope.safeParse(input);
    const parsed = copied.success ? inspectionSchema.safeParse(copied.data) : undefined;
    if (!parsed?.success || parsed.data.scopeId !== query.scopeId || parsed.data.invocationId !== query.invocationId
      || !same(parsed.data.reference, query.reference)) return corrupt();
    const wantsEvidence = query.includeResponseEvidence === true;
    if (Object.hasOwn(parsed.data, 'responseEvidence') !== wantsEvidence) return corrupt();
    const identity = { schemaVersion: query.schemaVersion, scopeId: query.scopeId, invocationId: query.invocationId, reference: query.reference };
    if (parsed.data.invocation === null) {
      if (wantsEvidence && parsed.data.responseEvidence !== null) return corrupt();
      return Object.freeze({ ...identity, invocation: null, ...(wantsEvidence ? { responseEvidence: null } : {}) });
    }
    const receipt: ModelInvocationReceiptView = verifyModelInvocationReceiptView(parsed.data.invocation);
    if (receipt.claim.scopeId !== query.scopeId || receipt.claim.invocationId !== query.invocationId
      || !same(receipt.request.reference, query.reference)) return corrupt();
    let responseEvidence = null;
    if (wantsEvidence) {
      const summary = receipt.outcome && receipt.outcome.state !== 'responded' ? receipt.outcome.evidence : null;
      if (summary === null) { if (parsed.data.responseEvidence !== null) return corrupt(); }
      else {
        responseEvidence = verifyModelInvocationResponseEvidence(parsed.data.responseEvidence, receipt.profile);
        if (!same(summarizeModelInvocationResponse(responseEvidence), summary)) return corrupt();
      }
    }
    return Object.freeze({ ...identity, invocation: receipt, ...(wantsEvidence ? { responseEvidence } : {}) });
  } catch (error) {
    if (error instanceof ModelInvocationStoreError) throw error;
    return corrupt();
  }
}
