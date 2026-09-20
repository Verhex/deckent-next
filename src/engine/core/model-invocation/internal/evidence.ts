import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema, encodeModelBindingDefinition, encodeModelInvocationProfile, encodeModelInvocationRequest,
  identitySchema, modelActivationActorSchema, modelActivationAuthorizationSchema, modelInvocationCommandSchema,
  MODEL_INVOCATION_NATIVE_JSON_LIMITS, modelInvocationProfileSchema, parseModelActivationRecord,
  parseModelBindingDefinition, parseModelInvocationCommand, parseModelInvocationReceipt, parseModelReference,
  modelInvocationRequestEvidence, providerSpendBudgetSchema, providerSpendQuoteSchema, type ModelInvocationActor, type ModelInvocationReceipt } from '#domain/index.js';
import { ModelInvocationStoreError, type ModelInvocationAdmission } from './port.js';
import { verifyModelActivationRecord } from '#engine/core/model-activation/index.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const admissionSchema = z.object({ command: modelInvocationCommandSchema, requestDigest: hex,
  actor: modelActivationActorSchema, authorization: modelActivationAuthorizationSchema, definition: z.unknown(),
  activation: z.unknown(), profile: modelInvocationProfileSchema, profileDigest: hex,
  invocationId: identitySchema, claimedAtMs: counterSchema,
  spending: z.object({ budget: providerSpendBudgetSchema, quote: providerSpendQuoteSchema }).strict().readonly().optional() }).strict();
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
    || JSON.stringify(parsed.data.profile.reference) !== JSON.stringify(command.reference)
    || (parsed.data.spending && (parsed.data.spending.budget.scopeId !== command.scopeId
      || parsed.data.spending.quote.scopeId !== command.scopeId
      || parsed.data.spending.budget.currency !== parsed.data.spending.quote.currency
      || parsed.data.spending.quote.requestDigest !== parsed.data.requestDigest
      || parsed.data.spending.quote.profileDigest !== profileDigest))) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
  return Object.freeze({ command, requestDigest: parsed.data.requestDigest, actor: parsed.data.actor,
    authorization: parsed.data.authorization, definition, activation, profile: parsed.data.profile,
    profileDigest: parsed.data.profileDigest, invocationId: parsed.data.invocationId, claimedAtMs: parsed.data.claimedAtMs,
    ...(parsed.data.spending ? { spending: parsed.data.spending } : {}) });
}
export function verifyModelInvocationReceipt(input: unknown): ModelInvocationReceipt {
  try {
    const receipt = parseModelInvocationReceipt(input);
    if (modelInvocationProfileDigest(receipt.profile) !== receipt.profileDigest) throw new Error('PROFILE');
    const definitionDigest = createHash('sha256').update(encodeModelBindingDefinition(receipt.definition), 'utf8').digest('hex');
    if (definitionDigest !== receipt.request.expectedBinding.digest) throw new Error('BINDING');
    const outcome = receipt.outcome;
    if (outcome && (outcome.state === 'unknown' || outcome.state === 'rejected') && outcome.evidence) {
      const summary = outcome.evidence, descriptor = outcome.content;
      if (!descriptor || summary.adapter.id !== receipt.profile.adapter.id
        || summary.adapter.version !== receipt.profile.adapter.version
        || summary.body.byteLength > receipt.profile.limits.responseMaxBytes
        || summary.body.digest !== descriptor.digest || summary.body.byteLength !== descriptor.byteLength) {
        throw new Error('RESPONSE_CONTENT');
      }
    }
    return receipt;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
/** One receipt shape for pre-effect delivery admission and durable claim writers. */
export function createModelInvocationClaimReceipt(admission: ModelInvocationAdmission): ModelInvocationReceipt {
  return verifyModelInvocationReceipt({ schemaVersion: 4,
    request: modelInvocationRequestEvidence(admission.command, admission.requestDigest), actor: admission.actor,
    authorization: admission.authorization, definition: admission.definition, activationRevision: admission.activation.revision,
    profile: admission.profile, profileDigest: admission.profileDigest,
    claim: { scopeId: admission.command.scopeId, commandId: admission.command.commandId, invocationId: admission.invocationId,
      requestDigest: admission.requestDigest, profileDigest: admission.profileDigest },
    claimedAtMs: admission.claimedAtMs, outcome: null });
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
