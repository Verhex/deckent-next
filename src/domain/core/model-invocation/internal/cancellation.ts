import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema, identitySchema } from '#domain/core/primitives/index.js';
import { modelReferenceSchema } from '#domain/core/provider-catalog/index.js';
import { modelActivationActorSchema, modelActivationAuthorizationSchema } from '#domain/core/model-activation/index.js';
import { MODEL_INVOCATION_NATIVE_JSON_LIMITS, ModelInvocationError, modelInvocationClaimSchema } from './contract.js';

const envelope = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
/** Target the caller-known original command, even before its generated invocation id has been delivered. */
export const modelInvocationCancellationCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema,
  scopeId: identitySchema, targetCommandId: identitySchema, reference: modelReferenceSchema,
  expectedRequestDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export const modelInvocationCancellationCommandInputSchema = envelope.pipe(modelInvocationCancellationCommandSchema);
export const modelInvocationCancellationReceiptSchema = z.object({ schemaVersion: z.literal(1),
  command: modelInvocationCancellationCommandSchema, claim: modelInvocationClaimSchema,
  actor: modelActivationActorSchema, authorization: modelActivationAuthorizationSchema, requestedAtMs: counterSchema,
  disposition: z.enum(['prevented', 'requested', 'already-terminal']),
}).strict().superRefine((receipt, context) => {
  if (receipt.command.scopeId !== receipt.claim.scopeId || receipt.command.targetCommandId !== receipt.claim.commandId
    || receipt.command.expectedRequestDigest !== receipt.claim.requestDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_CANCELLATION_TARGET_INVALID' });
  }
}).readonly();
/** Permission is an ambiguity boundary, never proof that the remote provider accepted or stopped work. */
export const modelInvocationSendStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending') }).strict(),
  z.object({ state: z.literal('permitted'), ownerId: identitySchema, permittedAtMs: counterSchema }).strict(),
  z.object({ state: z.literal('prevented') }).strict(),
  z.object({ state: z.literal('unobserved') }).strict(),
]).readonly();
export const modelInvocationControlRecordSchema = z.object({ schemaVersion: z.literal(1), claim: modelInvocationClaimSchema,
  reference: modelReferenceSchema, send: modelInvocationSendStateSchema, cancellation: modelInvocationCancellationReceiptSchema.nullable(),
}).strict().superRefine((record, context) => {
  const cancellation = record.cancellation;
  const prevented = cancellation?.disposition === 'prevented';
  if ((record.send.state === 'prevented') !== prevented || (record.send.state === 'pending' && cancellation !== null)
    || (cancellation && (JSON.stringify(cancellation.claim) !== JSON.stringify(record.claim)
      || JSON.stringify(cancellation.command.reference) !== JSON.stringify(record.reference)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_CONTROL_INCONSISTENT' });
  }
}).readonly();

export type ModelInvocationCancellationCommand = z.infer<typeof modelInvocationCancellationCommandSchema>;
export type ModelInvocationCancellationReceipt = z.infer<typeof modelInvocationCancellationReceiptSchema>;
export type ModelInvocationControlRecord = z.infer<typeof modelInvocationControlRecordSchema>;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const copied = envelope.safeParse(input), parsed = copied.success ? schema.safeParse(copied.data) : undefined;
  if (!parsed?.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  return parsed.data;
}
export const parseModelInvocationCancellationCommand = (input: unknown): ModelInvocationCancellationCommand =>
  parse(modelInvocationCancellationCommandSchema, input);
export const parseModelInvocationCancellationReceipt = (input: unknown): ModelInvocationCancellationReceipt =>
  parse(modelInvocationCancellationReceiptSchema, input);
export const parseModelInvocationControlRecord = (input: unknown): ModelInvocationControlRecord =>
  parse(modelInvocationControlRecordSchema, input);

/** Pure candidate transition. Only an atomic writer committing it may return an executable permission. */
export function proposeModelInvocationSendPermission(input: unknown, ownerInput: unknown, nowInput: unknown): Readonly<{
  granted: boolean; record: ModelInvocationControlRecord;
}> {
  const record = parseModelInvocationControlRecord(input), ownerId = identitySchema.safeParse(ownerInput), now = counterSchema.safeParse(nowInput);
  if (!ownerId.success || !now.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  if (record.send.state !== 'pending') return Object.freeze({ granted: false, record });
  return Object.freeze({ granted: true, record: parseModelInvocationControlRecord({ ...record,
    send: { state: 'permitted', ownerId: ownerId.data, permittedAtMs: now.data } }) });
}
