import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema } from '#domain/index.js';
import { encodeModelBindingDefinition, parseModelBindingDefinition, PROVIDER_CATALOG_WIRE_LIMITS } from '#domain/index.js';
import { encodeModelActivationTarget, ModelActivationError, modelActivationActorSchema, modelActivationAuthorizationSchema,
  modelActivationCommandSchema, parseModelActivationCommand, parseModelActivationRecord, parseModelActivationReceipt,
  type ModelActivationActor, type ModelActivationCommand, type ModelActivationRecord, type ModelActivationReceipt } from '#domain/index.js';
import { ModelActivationStoreError, type ModelActivationAdmission } from './port.js';

const envelope = createImmutableJsonObjectSchema(PROVIDER_CATALOG_WIRE_LIMITS);
const admissionSchema = z.object({ command: modelActivationCommandSchema, actor: modelActivationActorSchema,
  authorization: modelActivationAuthorizationSchema, admittedAtMs: counterSchema, definition: z.unknown().optional() }).strict();
export function modelActivationTargetId(reference: unknown): string {
  return createHash('sha256').update(encodeModelActivationTarget(reference), 'utf8').digest('hex');
}
function definitionDigest(definition: unknown): string {
  return createHash('sha256').update(encodeModelBindingDefinition(definition), 'utf8').digest('hex');
}
export function parseModelActivationAdmission(input: unknown): ModelActivationAdmission {
  const copied = envelope.safeParse(input);
  if (!copied.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  const parsed = admissionSchema.safeParse(copied.data);
  if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
  const value = parsed.data, command = parseModelActivationCommand(value.command);
  if (command.action === 'deactivate') {
    if (Object.hasOwn(copied.data, 'definition')) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
    return Object.freeze({ command, actor: value.actor, authorization: value.authorization, admittedAtMs: value.admittedAtMs });
  }
  let definition;
  try { definition = parseModelBindingDefinition(value.definition); }
  catch { throw new ModelActivationError('MODEL_ACTIVATION_INVALID'); }
  if (definition.provider.id !== command.reference.providerId || definition.provider.version !== command.reference.providerVersion
    || definition.model.id !== command.reference.modelId || definition.model.version !== command.reference.modelVersion
    || definitionDigest(definition) !== command.expectedBinding.digest) throw new ModelActivationError('MODEL_ACTIVATION_BINDING_CONFLICT');
  return Object.freeze({ command, actor: value.actor, authorization: value.authorization, admittedAtMs: value.admittedAtMs, definition });
}
/** Stored semantic bindings are checked on every read, not trusted because their JSON parses. */
export function verifyModelActivationRecord(input: unknown): ModelActivationRecord {
  try {
    const record = parseModelActivationRecord(input);
    if (definitionDigest(record.definition) !== record.binding.digest) throw new Error('BINDING_MISMATCH');
    return record;
  } catch { throw new ModelActivationStoreError('MODEL_ACTIVATION_CORRUPT'); }
}
export function verifyModelActivationReceipt(input: unknown): ModelActivationReceipt {
  try {
    const receipt = parseModelActivationReceipt(input); verifyModelActivationRecord(receipt.record); return receipt;
  } catch { throw new ModelActivationStoreError('MODEL_ACTIVATION_CORRUPT'); }
}
/** Current policy/time/state never overwrite the historical decision on an exact replay. */
export function sameModelActivationRequest(receipt: ModelActivationReceipt, command: ModelActivationCommand, actor: ModelActivationActor): boolean {
  const checked = verifyModelActivationReceipt(receipt);
  return JSON.stringify(checked.command) === JSON.stringify(parseModelActivationCommand(command))
    && JSON.stringify(checked.actor) === JSON.stringify(modelActivationActorSchema.parse(actor));
}
