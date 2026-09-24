import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/core/primitives/index.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Effect class of a catalog operation. `read` never changes the target; `write` is a conditional, compensable-or-not change;
 * `irreversible` cannot be undone even by compensation (it must be approval-gated by catalog data). */
export const effectClassSchema = z.enum(['read', 'write', 'irreversible']);
export const operationRefSchema = z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict().readonly();
export type OperationRef = z.infer<typeof operationRefSchema>;
/** Catalog data (registry/config), not code: what an operation does and which guarantees its target must offer. */
export const operationDescriptorSchema = z.object({
  schemaVersion: z.literal(1), operation: operationRefSchema, targetKind: identitySchema, effectClass: effectClassSchema,
  approval: z.enum(['policy', 'required']),
  precondition: z.enum(['record-version', 'none']),
  compensation: operationRefSchema.nullable(),
  inputMaxBytes: z.number().int().positive().max(1_048_576),
}).strict().superRefine((value, context) => {
  if (value.effectClass === 'irreversible' && value.approval !== 'required') context.addIssue({ code: 'custom', message: 'EFFECT_IRREVERSIBLE_REQUIRES_APPROVAL' });
  if (value.effectClass === 'irreversible' && value.compensation) context.addIssue({ code: 'custom', message: 'EFFECT_IRREVERSIBLE_NOT_COMPENSABLE' });
  if (value.effectClass === 'read' && value.compensation) context.addIssue({ code: 'custom', message: 'EFFECT_READ_NOT_COMPENSABLE' });
}).readonly();
export type OperationDescriptor = z.infer<typeof operationDescriptorSchema>;
/** Opaque, adapter-interpreted record address (ERP entity key, Git ref, ...). Never a path, URL or credential. */
export const effectTargetRefSchema = z.object({ kind: identitySchema, id: z.string().min(1).max(512)
  .refine(value => ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) }).strict().readonly();
export type EffectTargetRef = z.infer<typeof effectTargetRefSchema>;
export const effectCommandSchema = z.object({
  schemaVersion: z.literal(1), commandId: identitySchema, scopeId: identitySchema, operation: operationRefSchema,
  target: effectTargetRefSchema, idempotencyKey: identitySchema, input: z.unknown(),
  /** The record version the caller based its decision on; required when the catalog demands a record-version precondition. */
  expectedVersion: z.string().min(1).max(256).nullable(),
  /** Set only by a compensation command: the settled command it compensates. */
  compensates: identitySchema.optional(),
}).strict().readonly();
export type EffectCommand = z.infer<typeof effectCommandSchema>;
const actorSchema = z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly();
/** claimed: intent recorded, effect may be pending; settled: target evidence of the effect; unknown: outcome cannot be
 * established from the target (never retried blindly); refused: the target refused before any effect (terminal, no effect). */
export const effectStateSchema = z.enum(['claimed', 'settled', 'unknown', 'refused']);
export const effectRefusalSchema = z.enum(['EFFECT_PRECONDITION_CHANGED', 'EFFECT_REJECTED']);
export type EffectState = z.infer<typeof effectStateSchema>;
/** Durable intent recorded before any effect; `inputDigest` binds the canonical payload and `idempotencyKeyHash` the scoped key. */
export const effectIntentSchema = z.object({
  schemaVersion: z.literal(1), command: effectCommandSchema, descriptor: operationDescriptorSchema, actor: actorSchema,
  idempotencyKeyHash: digest, inputDigest: digest,
  /** The only idempotency key the target ever sees: namespaced by scope, target and operation, so two scopes (or two
   * operations) reusing a caller key can never settle each other's records (Astra 2041). Absent only on older intents. */
  wireKey: digest.optional(),
  /** Descriptor + target endpoint identity at claim time; a resume against a changed binding never sends or looks up. */
  targetBinding: digest.optional(),
}).strict().readonly();
export type EffectIntent = z.infer<typeof effectIntentSchema>;
/** Target evidence that this intent's effect happened (idempotency record, fence). `version` is the record version after it. */
export const effectEvidenceSchema = z.object({ kind: z.enum(['idempotency-record', 'fence']), version: z.string().min(1).max(256).nullable(),
  observedAt: counterSchema }).strict().readonly();
export type EffectEvidence = z.infer<typeof effectEvidenceSchema>;
export const effectRecordSchema = z.object({ intent: effectIntentSchema, sequence: z.number().int().positive().safe(), state: effectStateSchema,
  evidence: effectEvidenceSchema.nullable(), refusal: effectRefusalSchema.nullable() }).strict().readonly()
  .refine(record => (record.state === 'settled') === (record.evidence !== null) && (record.state === 'refused') === (record.refusal !== null));
export type EffectRecord = z.infer<typeof effectRecordSchema>;

export class EffectError extends Error {
  constructor(readonly code: 'EFFECT_INVALID' | 'EFFECT_OPERATION_UNKNOWN' | 'EFFECT_APPROVAL_REQUIRED' | 'EFFECT_PRECONDITION_CHANGED'
    | 'EFFECT_TARGET_BUSY' | 'EFFECT_CONFLICT' | 'EFFECT_OUTCOME_UNKNOWN' | 'EFFECT_NOT_COMPENSABLE' | 'EFFECT_REJECTED' | 'EFFECT_CORRUPT' | 'EFFECT_TARGET_UNAVAILABLE'
    | 'EFFECT_TARGET_CHANGED',
    options?: ErrorOptions) { super(code, options); this.name = 'EffectError'; }
}

const open = (record: EffectRecord) => { if (record.state === 'settled' || record.state === 'refused') throw new EffectError('EFFECT_CONFLICT'); };
/** Pure settlement of a claimed/unknown record from target evidence. Terminal records never change. */
export function settleEffect(record: EffectRecord, evidence: EffectEvidence): EffectRecord {
  open(record); return effectRecordSchema.parse({ ...record, state: 'settled', evidence, refusal: null });
}
/** Pure transition to unknown: the effect may or may not have happened and the target offers no evidence either way. */
export function markEffectUnknown(record: EffectRecord): EffectRecord {
  open(record); return effectRecordSchema.parse({ ...record, state: 'unknown', evidence: null, refusal: null });
}
/** Pure terminal refusal: the target refused before any effect (changed precondition or rejected request). Only a claimed record,
 * never an unknown one, may be refused: an unknown effect might already exist. */
export function refuseEffect(record: EffectRecord, refusal: z.infer<typeof effectRefusalSchema>): EffectRecord {
  if (record.state !== 'claimed') throw new EffectError('EFFECT_CONFLICT');
  return effectRecordSchema.parse({ ...record, state: 'refused', evidence: null, refusal });
}
/** A compensation command must name a settled, compensable original on the same target with the catalog's compensation operation. */
export function assertCompensation(original: EffectRecord, command: EffectCommand) {
  const compensation = original.intent.descriptor.compensation;
  if (original.state !== 'settled' || !compensation) throw new EffectError('EFFECT_NOT_COMPENSABLE');
  if (command.compensates !== original.intent.command.commandId || command.scopeId !== original.intent.command.scopeId
    || compensation.id !== command.operation.id || compensation.version !== command.operation.version
    || JSON.stringify(command.target) !== JSON.stringify(original.intent.command.target)) throw new EffectError('EFFECT_NOT_COMPENSABLE');
}
