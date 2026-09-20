import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';

/** Bounded private response content. Transport headers/credentials are not collected; body content may echo sensitive input; complete is a body observation, not billing or task success. */
export const modelInvocationRejectionReasonSchema = z.enum(['http-status', 'redirect', 'invalid-response', 'model-mismatch', 'response-limit', 'interrupted']);
export const modelInvocationResponseEvidenceSchema = z.object({ schemaVersion: z.literal(1),
  adapter: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(),
  reason: modelInvocationRejectionReasonSchema,
  // Optional transport diagnostic, never the authority for completion or billing; non-HTTP adapters leave it null.
  httpStatus: z.number().int().min(100).max(599).nullable(),
  body: z.object({ encoding: z.literal('base64'), data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    byteLength: counterSchema, observedBytes: counterSchema, complete: z.boolean(),
    digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly(),
}).strict().superRefine((value, context) => {
  const body = value.body;
  const padding = body.data.endsWith('==') ? 2 : body.data.endsWith('=') ? 1 : 0;
  if (body.data.length / 4 * 3 - padding !== body.byteLength || body.observedBytes < body.byteLength
    || (body.complete && (body.observedBytes !== body.byteLength || value.reason === 'interrupted'))
    || (!body.complete && value.reason !== 'interrupted' && value.reason !== 'response-limit')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_RESPONSE_EVIDENCE_INVALID' });
  }
}).readonly();
export type ModelInvocationResponseEvidence = z.infer<typeof modelInvocationResponseEvidenceSchema>;
export type ModelInvocationRejectionReason = z.infer<typeof modelInvocationRejectionReasonSchema>;
/** Durable/public evidence metadata. Raw bytes live in the separately verified response content record. */
export const modelInvocationResponseSummarySchema = modelInvocationResponseEvidenceSchema.unwrap().innerType()
  .omit({ body: true }).extend({ body: modelInvocationResponseEvidenceSchema.unwrap().innerType().shape.body
    .unwrap().omit({ data: true }).strict().readonly() }).strict().superRefine((value, context) => {
    const body = value.body;
    if (body.observedBytes < body.byteLength
      || (body.complete && (body.observedBytes !== body.byteLength || value.reason === 'interrupted'))
      || (!body.complete && value.reason !== 'interrupted' && value.reason !== 'response-limit')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_RESPONSE_EVIDENCE_INVALID' });
    }
  }).readonly();
export type ModelInvocationResponseSummary = z.infer<typeof modelInvocationResponseSummarySchema>;
