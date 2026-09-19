import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema, encodeModelBindingDefinition, encodeModelInvocationProfile, encodeModelInvocationRequest,
  identitySchema, modelActivationActorSchema, modelActivationAuthorizationSchema, modelInvocationCommandSchema,
  MODEL_INVOCATION_NATIVE_JSON_LIMITS, modelInvocationProfileSchema, parseModelActivationRecord,
  parseModelBindingDefinition, parseModelInvocationCommand, parseModelInvocationReceipt, parseModelReference,
  type ModelInvocationActor, type ModelInvocationReceipt } from '#domain/index.js';
import { ModelInvocationStoreError, type ModelInvocationAdmission } from './port.js';
import { verifyModelActivationRecord } from '#engine/core/model-activation/index.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const admissionSchema = z.object({ command: modelInvocationCommandSchema, requestDigest: hex,
  actor: modelActivationActorSchema, authorization: modelActivationAuthorizationSchema, definition: z.unknown(),
  activation: z.unknown(), profile: modelInvocationProfileSchema, profileDigest: hex,
  invocationId: identitySchema, claimedAtMs: counterSchema }).strict();
const admissionEnvelope = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
export function modelInvocationRequestDigest(input: unknown): string {
  return createHash('sha256').update(encodeModelInvocationRequest(input), 'utf8').digest('hex');
}
export function modelInvocationProfileDigest(input: unknown): string {
  return createHash('sha256').update(encodeModelInvocationProfile(input), 'utf8').digest('hex');
}
export function modelInvocationTargetId(reference: unknown): string {
  const parsed = parseModelReference(reference);
  const bytes = `deckent.model-invocation-target.v1\n${JSON.stringify({ modelId: parsed.modelId, modelVersion: parsed.modelVersion,
    providerId: parsed.providerId, providerVersion: parsed.providerVersion })}`;
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}
export function parseModelInvocationAdmission(input: unknown): ModelInvocationAdmission {
  const copied = admissionEnvelope.safeParse(input), parsed = copied.success ? admissionSchema.safeParse(copied.data) : undefined;
  if (!parsed?.success) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  const command = parseModelInvocationCommand(parsed.data.command), profileDigest = modelInvocationProfileDigest(parsed.data.profile);
  let definitionDigest: string; let definition;
  try {
    definition = parseModelBindingDefinition(parsed.data.definition);
    definitionDigest = createHash('sha256').update(encodeModelBindingDefinition(definition), 'utf8').digest('hex');
  }
  catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
  let activation;
  try { activation = verifyModelActivationRecord(parseModelActivationRecord(parsed.data.activation)); }
  catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
  if (parsed.data.requestDigest !== modelInvocationRequestDigest(command) || parsed.data.profileDigest !== profileDigest
    || definitionDigest !== command.expectedBinding.digest || activation.scopeId !== command.scopeId
    || activation.state !== 'active' || activation.catalogRevision !== command.catalogRevision
    || activation.binding.digest !== command.expectedBinding.digest || profileDigest !== parsed.data.profileDigest
    || JSON.stringify(activation.reference) !== JSON.stringify(command.reference)
    || parsed.data.profile.scopeId !== command.scopeId || parsed.data.profile.bindingDigest !== command.expectedBinding.digest
    || JSON.stringify(parsed.data.profile.reference) !== JSON.stringify(command.reference)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
  return Object.freeze({ command, requestDigest: parsed.data.requestDigest, actor: parsed.data.actor,
    authorization: parsed.data.authorization, definition, activation, profile: parsed.data.profile,
    profileDigest: parsed.data.profileDigest, invocationId: parsed.data.invocationId, claimedAtMs: parsed.data.claimedAtMs });
}
export function verifyModelInvocationReceipt(input: unknown): ModelInvocationReceipt {
  try {
    const receipt = parseModelInvocationReceipt(input);
    if (modelInvocationProfileDigest(receipt.profile) !== receipt.profileDigest) throw new Error('PROFILE');
    const definitionDigest = createHash('sha256').update(encodeModelBindingDefinition(receipt.definition), 'utf8').digest('hex');
    if (definitionDigest !== receipt.request.expectedBinding.digest) throw new Error('BINDING');
    if (receipt.outcome?.state === 'responded'
      && Buffer.byteLength(JSON.stringify(receipt.outcome.response.native), 'utf8') > receipt.profile.limits.responseMaxBytes) {
      throw new Error('RESPONSE_LIMIT');
    }
    return receipt;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
export function sameModelInvocationRequest(receiptInput: unknown, commandInput: unknown, requestDigest: string,
  actor: ModelInvocationActor): boolean {
  const receipt = verifyModelInvocationReceipt(receiptInput), command = parseModelInvocationCommand(commandInput);
  return receipt.request.requestDigest === hex.parse(requestDigest)
    && JSON.stringify({ schemaVersion: command.schemaVersion, commandId: command.commandId, scopeId: command.scopeId,
      reference: command.reference, catalogRevision: command.catalogRevision, expectedBinding: command.expectedBinding,
      requestDigest }) === JSON.stringify(receipt.request)
    && JSON.stringify(modelActivationActorSchema.parse(actor)) === JSON.stringify(receipt.actor);
}
