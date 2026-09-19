import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema, identitySchema } from '#domain/core/primitives/index.js';
import { verifiedPrincipalSchema } from '#domain/core/principal/index.js';
import { PROVIDER_CATALOG_WIRE_LIMITS, modelReferenceSchema, parseModelBindingDefinition,
  type ModelBindingDefinition, type ModelReference } from '#domain/core/provider-catalog/index.js';

export const MODEL_ACTIVATION_SCHEMA_VERSION = 1;
export const MODEL_ACTIVATION_TARGET_ENCODING_VERSION = 1;
export const MODEL_ACTIVATION_TARGET_PREFIX = 'deckent.model-activation-target.v1\n';

export const modelActivationBindingSchema = z.object({ encodingVersion: z.literal(1), algorithm: z.literal('sha256'),
  digest: z.string().regex(/^[a-f0-9]{64}$/), }).strict().readonly();
export const modelActivationActorSchema = verifiedPrincipalSchema.unwrap()
  .pick({ id: true, issuer: true, subject: true, assurance: true }).strict().readonly();

const baseCommand = z.object({ schemaVersion: z.literal(MODEL_ACTIVATION_SCHEMA_VERSION), commandId: identitySchema,
  scopeId: identitySchema, reference: modelReferenceSchema, expectedRevision: counterSchema,
  expectedBinding: modelActivationBindingSchema });
export const modelActivationCommandSchema = z.discriminatedUnion('action', [
  baseCommand.extend({ action: z.literal('activate'), catalogRevision: identitySchema }).strict(),
  baseCommand.extend({ action: z.literal('deactivate'), expectedRevision: counterSchema.positive() }).strict(),
]).readonly();

const definitionSchema = z.unknown().transform((input, context): ModelBindingDefinition => {
  try {
    return parseModelBindingDefinition(input);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_ACTIVATION_DEFINITION_INVALID' });
    return z.NEVER;
  }
});
export const modelActivationRecordSchema = z.object({ schemaVersion: z.literal(MODEL_ACTIVATION_SCHEMA_VERSION),
  scopeId: identitySchema, reference: modelReferenceSchema, revision: counterSchema.positive(), state: z.enum(['active', 'inactive']),
  catalogRevision: identitySchema, definition: definitionSchema, binding: modelActivationBindingSchema,
}).strict().superRefine((record, context) => {
  if (record.definition.provider.id !== record.reference.providerId || record.definition.provider.version !== record.reference.providerVersion
    || record.definition.model.id !== record.reference.modelId || record.definition.model.version !== record.reference.modelVersion) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_ACTIVATION_REFERENCE_MISMATCH' });
  }
}).readonly();

export const modelActivationAuthorizationSchema = z.object({ revision: identitySchema, ruleId: identitySchema }).strict().readonly();
export const modelActivationReceiptSchema = z.object({ schemaVersion: z.literal(MODEL_ACTIVATION_SCHEMA_VERSION),
  command: modelActivationCommandSchema, actor: modelActivationActorSchema, authorization: modelActivationAuthorizationSchema,
  previousRevision: counterSchema.positive().nullable(), record: modelActivationRecordSchema, admittedAtMs: counterSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.command.scopeId !== receipt.record.scopeId || JSON.stringify(receipt.command.reference) !== JSON.stringify(receipt.record.reference)
    || receipt.command.expectedBinding.digest !== receipt.record.binding.digest
    || receipt.command.expectedBinding.algorithm !== receipt.record.binding.algorithm
    || receipt.command.expectedBinding.encodingVersion !== receipt.record.binding.encodingVersion
    || receipt.record.revision !== receipt.command.expectedRevision + 1
    || receipt.previousRevision !== (receipt.command.expectedRevision === 0 ? null : receipt.command.expectedRevision)
    || (receipt.command.action === 'activate' && (receipt.record.state !== 'active' || receipt.command.catalogRevision !== receipt.record.catalogRevision))
    || (receipt.command.action === 'deactivate' && receipt.record.state !== 'inactive')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MODEL_ACTIVATION_RECEIPT_INCONSISTENT' });
  }
}).readonly();

export type ModelActivationBinding = Readonly<z.infer<typeof modelActivationBindingSchema>>;
export type ModelActivationActor = Readonly<z.infer<typeof modelActivationActorSchema>>;
export type ModelActivationCommand = Readonly<z.infer<typeof modelActivationCommandSchema>>;
export type ModelActivationRecord = Readonly<z.infer<typeof modelActivationRecordSchema>>;
export type ModelActivationAuthorization = Readonly<z.infer<typeof modelActivationAuthorizationSchema>>;
export type ModelActivationReceipt = Readonly<z.infer<typeof modelActivationReceiptSchema>>;

const boundedObject = createImmutableJsonObjectSchema(PROVIDER_CATALOG_WIRE_LIMITS);
function copied(input: unknown): Readonly<Record<string, unknown>> {
  const parsed = boundedObject.safeParse(input);
  if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  return parsed.data;
}
export type ModelActivationErrorCode = 'MODEL_ACTIVATION_INVALID' | 'MODEL_ACTIVATION_REVISION_CONFLICT'
  | 'MODEL_ACTIVATION_NOT_FOUND' | 'MODEL_ACTIVATION_NOT_ACTIVE' | 'MODEL_ACTIVATION_BINDING_CONFLICT';
export class ModelActivationError extends Error {
  constructor(readonly code: ModelActivationErrorCode) { super(code); this.name = 'ModelActivationError'; }
}
export function parseModelActivationCommand(input: unknown): ModelActivationCommand {
  const parsed = modelActivationCommandSchema.safeParse(copied(input));
  if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  return Object.freeze({ ...parsed.data, reference: Object.freeze({ ...parsed.data.reference }),
    expectedBinding: Object.freeze({ ...parsed.data.expectedBinding }) });
}
export function parseModelActivationRecord(input: unknown): ModelActivationRecord {
  const parsed = modelActivationRecordSchema.safeParse(copied(input));
  if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  return Object.freeze({ ...parsed.data, reference: Object.freeze({ ...parsed.data.reference }),
    binding: Object.freeze({ ...parsed.data.binding }) });
}
export function parseModelActivationReceipt(input: unknown): ModelActivationReceipt {
  const parsed = modelActivationReceiptSchema.safeParse(copied(input));
  if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  return Object.freeze({ ...parsed.data, command: parseModelActivationCommand(parsed.data.command),
    record: parseModelActivationRecord(parsed.data.record) });
}

/** Stable policy-target bytes for an exact reference. Native declaration content is deliberately excluded. */
export function encodeModelActivationTarget(referenceInput: unknown): string {
  const reference: ModelReference = parseModelActivationReference(referenceInput);
  return `${MODEL_ACTIVATION_TARGET_PREFIX}${JSON.stringify({ modelId: reference.modelId, modelVersion: reference.modelVersion,
    providerId: reference.providerId, providerVersion: reference.providerVersion })}`;
}
export function parseModelActivationReference(input: unknown): ModelReference {
  const parsed = modelReferenceSchema.safeParse(copied(input));
  if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  return Object.freeze({ ...parsed.data });
}
