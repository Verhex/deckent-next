import { z } from 'zod';
import { counterSchema } from '#domain/core/primitives/index.js';
import { modelInvocationNativeResponseSchema, modelInvocationReceiptSchema } from './contract.js';
import { modelInvocationResponseEvidenceSchema } from './response-evidence.js';

/** Public observation metadata; raw rejected bytes are a separately authorized read, never a default field. */
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
export const modelInvocationOutcomeViewSchema = z.discriminatedUnion('state', [
  z.object({ schemaVersion: z.literal(2), state: z.literal('responded'), response: modelInvocationNativeResponseSchema,
    observedAtMs: counterSchema }).strict(),
  z.object({ schemaVersion: z.literal(2), state: z.literal('unknown'), reason: z.literal('transport-error'),
    evidence: modelInvocationResponseSummarySchema.nullable(), observedAtMs: counterSchema }).strict(),
  z.object({ schemaVersion: z.literal(2), state: z.literal('rejected'),
    evidence: modelInvocationResponseSummarySchema, observedAtMs: counterSchema }).strict(),
]).superRefine((value, context) => {
  if ((value.state === 'rejected' && !value.evidence.body.complete)
    || (value.state === 'unknown' && value.evidence?.body.complete)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_RESPONSE_COMPLETENESS_INVALID' });
  }
}).readonly();
/** Shares receipt identities; this projection is not a persisted receipt or a replacement for its byte verification. */
export const modelInvocationReceiptViewSchema = modelInvocationReceiptSchema.unwrap().innerType()
  .omit({ outcome: true }).extend({ outcome: modelInvocationOutcomeViewSchema.nullable() }).strict().readonly();
export type ModelInvocationReceiptView = z.infer<typeof modelInvocationReceiptViewSchema>;
export type ModelInvocationResponseSummary = z.infer<typeof modelInvocationResponseSummarySchema>;
