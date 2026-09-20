import { z } from 'zod';
import { modelInvocationResponseEvidenceSchema } from './response-evidence.js';
import { counterSchema, createImmutableJsonObjectSchema, identitySchema,
  type JsonObject } from '#domain/core/primitives/index.js';
import { modelActivationActorSchema, modelActivationAuthorizationSchema, modelActivationBindingSchema,
  type ModelActivationActor, type ModelActivationAuthorization, type ModelActivationBinding } from '#domain/core/model-activation/index.js';
import { modelReferenceSchema, parseModelBindingDefinition,
  type ModelBindingDefinition, type ModelReference } from '#domain/core/provider-catalog/index.js';

export const MODEL_INVOCATION_SCHEMA_VERSION = 1;
export const MODEL_INVOCATION_RECEIPT_VERSION = 2;
export const MODEL_INVOCATION_REQUEST_PREFIX = 'deckent.model-invocation-request.v1\n';
export const MODEL_INVOCATION_PROFILE_PREFIX = 'deckent.model-invocation-profile.v1\n';
export const MODEL_INVOCATION_NATIVE_JSON_LIMITS = Object.freeze({ maxDepth: 16, maxNodes: 262_144,
  maxCodeUnits: 8 * 1024 * 1024 });
// A receipt composes three independently bounded fragments: static receipt, outcome metadata,
// and native response/evidence payload. The payload is nested two levels below the receipt root.
export const MODEL_INVOCATION_RECEIPT_JSON_LIMITS = Object.freeze({
  maxDepth: MODEL_INVOCATION_NATIVE_JSON_LIMITS.maxDepth + 2,
  maxNodes: MODEL_INVOCATION_NATIVE_JSON_LIMITS.maxNodes * 3,
  maxCodeUnits: MODEL_INVOCATION_NATIVE_JSON_LIMITS.maxCodeUnits * 3,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestJsonSchema = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
const invocationEnvelopeSchema = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
const receiptEnvelopeSchema = createImmutableJsonObjectSchema(MODEL_INVOCATION_RECEIPT_JSON_LIMITS);
const definitionSchema = z.unknown().transform((input, context): ModelBindingDefinition => {
  try { return parseModelBindingDefinition(input); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_DEFINITION_INVALID' }); return z.NEVER; }
});

export const modelInvocationCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema,
  scopeId: identitySchema, reference: modelReferenceSchema, catalogRevision: identitySchema,
  expectedBinding: modelActivationBindingSchema, nativeRequest: requestJsonSchema }).strict().readonly();
export const modelInvocationQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  invocationId: identitySchema, reference: modelReferenceSchema, includeResponseEvidence: z.boolean().optional() }).strict().readonly();
/** Descriptor-safe wire ingress. Raw object schemas remain available for closed-world JSON-schema generation. */
export const modelInvocationCommandInputSchema = invocationEnvelopeSchema.pipe(modelInvocationCommandSchema);
export const modelInvocationQueryInputSchema = invocationEnvelopeSchema.pipe(modelInvocationQuerySchema);
export const modelInvocationProfileSchema = z.object({ schemaVersion: z.literal(1), id: identitySchema,
  version: counterSchema.positive(), scopeId: identitySchema, reference: modelReferenceSchema, bindingDigest: digest,
  protocol: z.object({ family: identitySchema, version: identitySchema }).strict().readonly(),
  adapter: z.object({ id: identitySchema, version: counterSchema.positive(), definition: invocationEnvelopeSchema }).strict().readonly(),
  allocation: z.object({ id: identitySchema, maxCalls: counterSchema.positive(), maxInFlight: counterSchema.positive() }).strict().readonly(),
  limits: z.object({ requestMaxBytes: counterSchema.positive(), responseMaxBytes: counterSchema.positive(),
    timeoutMs: counterSchema.positive() }).strict().readonly(),
}).strict().readonly();
export const modelInvocationRequestEvidenceSchema = modelInvocationCommandSchema.unwrap().omit({ nativeRequest: true })
  .extend({ requestDigest: digest }).strict().readonly();
export const modelInvocationClaimSchema = z.object({ scopeId: identitySchema, commandId: identitySchema,
  invocationId: identitySchema, requestDigest: digest, profileDigest: digest }).strict().readonly();
export const modelInvocationNativeResponseSchema = z.object({ schemaVersion: z.literal(1), native: requestJsonSchema,
  usage: requestJsonSchema.nullable() }).strict().readonly();
export const modelInvocationNativeResultSchema = z.union([modelInvocationNativeResponseSchema,
  z.object({ kind: z.literal('rejected'), evidence: modelInvocationResponseEvidenceSchema }).strict().readonly()]);
export type ModelInvocationNativeResult = z.infer<typeof modelInvocationNativeResultSchema>;
export const modelInvocationOutcomeSchema = z.discriminatedUnion('state', [
  z.object({ schemaVersion: z.literal(2), state: z.literal('responded'), response: modelInvocationNativeResponseSchema,
    observedAtMs: counterSchema }).strict(),
  z.object({ schemaVersion: z.literal(2), state: z.literal('unknown'), reason: z.literal('transport-error'),
    evidence: modelInvocationResponseEvidenceSchema.nullable(), observedAtMs: counterSchema }).strict(),
  z.object({ schemaVersion: z.literal(2), state: z.literal('rejected'),
    evidence: modelInvocationResponseEvidenceSchema, observedAtMs: counterSchema }).strict(),
]).superRefine((outcome, context) => {
  if ((outcome.state === 'rejected' && !outcome.evidence.body.complete)
    || (outcome.state === 'unknown' && outcome.evidence?.body.complete)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_RESPONSE_COMPLETENESS_INVALID' });
  }
}).readonly();
export const modelInvocationReceiptSchema = z.object({ schemaVersion: z.literal(2), request: modelInvocationRequestEvidenceSchema,
  actor: modelActivationActorSchema, authorization: modelActivationAuthorizationSchema, definition: definitionSchema,
  activationRevision: counterSchema.positive(), profile: modelInvocationProfileSchema, profileDigest: digest,
  claim: modelInvocationClaimSchema, claimedAtMs: counterSchema, outcome: modelInvocationOutcomeSchema.nullable(),
}).strict().superRefine((receipt, context) => {
  const reference = receipt.request.reference, profile = receipt.profile, definition = receipt.definition;
  const mismatch = receipt.request.scopeId !== profile.scopeId || receipt.request.commandId !== receipt.claim.commandId
    || receipt.request.scopeId !== receipt.claim.scopeId || receipt.request.requestDigest !== receipt.claim.requestDigest
    || receipt.profileDigest !== receipt.claim.profileDigest || receipt.request.expectedBinding.digest !== profile.bindingDigest
    || profile.reference.providerId !== reference.providerId || profile.reference.providerVersion !== reference.providerVersion
    || profile.reference.modelId !== reference.modelId || profile.reference.modelVersion !== reference.modelVersion
    || definition.provider.id !== reference.providerId || definition.provider.version !== reference.providerVersion
    || definition.model.id !== reference.modelId || definition.model.version !== reference.modelVersion
    || !definition.model.protocols.some(protocol => protocol.family === profile.protocol.family
      && protocol.version === profile.protocol.version);
  if (mismatch) context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_INVOCATION_RECEIPT_INCONSISTENT' });
}).readonly();

export type ModelInvocationCommand = Readonly<z.infer<typeof modelInvocationCommandSchema>>;
export type ModelInvocationQuery = Readonly<z.infer<typeof modelInvocationQuerySchema>>;
export type ModelInvocationProfile = Readonly<z.infer<typeof modelInvocationProfileSchema>>;
export type ModelInvocationRequestEvidence = Readonly<z.infer<typeof modelInvocationRequestEvidenceSchema>>;
export type ModelInvocationClaim = Readonly<z.infer<typeof modelInvocationClaimSchema>>;
export type ModelInvocationNativeResponse = Readonly<z.infer<typeof modelInvocationNativeResponseSchema>>;
export type ModelInvocationOutcome = Readonly<z.infer<typeof modelInvocationOutcomeSchema>>;
export type ModelInvocationReceipt = Readonly<z.infer<typeof modelInvocationReceiptSchema>>;
export type ModelInvocationActor = ModelActivationActor;
export type ModelInvocationAuthorization = ModelActivationAuthorization;
export type ModelInvocationBinding = ModelActivationBinding;
export type ModelInvocationUnknownReason = 'transport-error';
export type { JsonObject, ModelBindingDefinition, ModelReference };

export type ModelInvocationErrorCode = 'MODEL_INVOCATION_INVALID' | 'MODEL_INVOCATION_BINDING_CONFLICT'
  | 'MODEL_INVOCATION_PROFILE_CONFLICT';
export class ModelInvocationError extends Error {
  constructor(readonly code: ModelInvocationErrorCode) { super(code); this.name = 'ModelInvocationError'; }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const copied = invocationEnvelopeSchema.safeParse(input), parsed = copied.success ? schema.safeParse(copied.data) : undefined;
  if (!parsed?.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  return parsed.data as unknown as T;
}
export const parseModelInvocationCommand = (input: unknown): ModelInvocationCommand => {
  const parsed = modelInvocationCommandInputSchema.safeParse(input);
  if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  return parsed.data as ModelInvocationCommand;
};
export const parseModelInvocationQuery = (input: unknown): ModelInvocationQuery => {
  const parsed = modelInvocationQueryInputSchema.safeParse(input);
  if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  return parsed.data as ModelInvocationQuery;
};
export const parseModelInvocationProfile = (input: unknown): ModelInvocationProfile =>
  parse(modelInvocationProfileSchema as unknown as z.ZodType<ModelInvocationProfile>, input);
export const parseModelInvocationReceipt = (input: unknown): ModelInvocationReceipt => {
  const copied = receiptEnvelopeSchema.safeParse(input), parsed = copied.success ? modelInvocationReceiptSchema.safeParse(copied.data) : undefined;
  if (!parsed?.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  const receipt = parsed.data, outcome = receipt.outcome;
  if (!invocationEnvelopeSchema.safeParse({ ...receipt, outcome: null }).success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  if (outcome) {
    const payloadKey = outcome.state === 'responded' ? 'response' : 'evidence';
    const payload = outcome.state === 'responded' ? outcome.response : outcome.evidence;
    if (!invocationEnvelopeSchema.safeParse({ ...outcome, [payloadKey]: null }).success
      || (payload !== null && !invocationEnvelopeSchema.safeParse(payload).success)) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
  }
  return receipt as ModelInvocationReceipt;
};
export const parseModelInvocationNativeResult = (input: unknown): ModelInvocationNativeResult =>
  parse(modelInvocationNativeResultSchema as unknown as z.ZodType<ModelInvocationNativeResult>, input);
export const parseModelInvocationNativeResponse = (input: unknown): ModelInvocationNativeResponse =>
  parse(modelInvocationNativeResponseSchema as unknown as z.ZodType<ModelInvocationNativeResponse>, input);

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
export function encodeModelInvocationRequest(commandInput: unknown): string {
  const command = parseModelInvocationCommand(commandInput);
  return `${MODEL_INVOCATION_REQUEST_PREFIX}${canonical(command.nativeRequest)}`;
}
export function encodeModelInvocationProfile(profileInput: unknown): string {
  return `${MODEL_INVOCATION_PROFILE_PREFIX}${canonical(parseModelInvocationProfile(profileInput))}`;
}
export function modelInvocationRequestEvidence(commandInput: unknown, requestDigest: string): ModelInvocationRequestEvidence {
  const command = parseModelInvocationCommand(commandInput), parsedDigest = digest.parse(requestDigest);
  return modelInvocationRequestEvidenceSchema.parse({ schemaVersion: command.schemaVersion, commandId: command.commandId,
    scopeId: command.scopeId, reference: command.reference, catalogRevision: command.catalogRevision,
    expectedBinding: command.expectedBinding, requestDigest: parsedDigest });
}
