import { IDENTITY_MAX_LENGTH, identitySchema, type ModelBindingDefinition, type ModelInvocationProfile, type ModelReference } from '#domain/index.js';
import { modelInvocationDeliveryFits, modelInvocationNativeResponseUpperBound, modelInvocationProfileDeliveryRequirement,
  type ModelInvocationDelivery } from './delivery.js';
import { createModelInvocationClaimReceipt, modelInvocationProfileDigest } from './evidence.js';
import type { ModelInvocationAdmission } from './port.js';

// Lone UTF-16 surrogates are accepted identity code units and JSON escapes each as six ASCII bytes: a conservative
// stand-in for any real actor/authorization/claim identity this profile could ever be invoked under.
const WORST_CASE_IDENTITY = identitySchema.parse(String.fromCharCode(0xd800).repeat(IDENTITY_MAX_LENGTH));
const WORST_CASE_DIGEST = 'f'.repeat(64);

export interface ModelInvocationProfileDeliveryAssessment {
  readonly fits: boolean;
  readonly requiredBytes: number;
  readonly availableBytes: number;
}
/** A transport a declared profile's worst-case result must fit: the runtime-service wire frame (CLI/SDK line mode,
 * `terminal session`), or the MCP tool-result envelope (`invoke_model`). */
export type ModelInvocationDeliverySurface = 'runtime-service' | 'mcp';
/** One declared profile that cannot deliver its worst-case result on a given surface, ever, regardless of who
 * invokes it or what they ask — a typed doctor/activation finding, not a per-call transport failure. */
export interface ModelInvocationDeliveryFinding {
  readonly scopeId: string;
  readonly profileId: string;
  readonly reference: ModelReference;
  readonly surface: ModelInvocationDeliverySurface;
  readonly requiredBytes: number;
  readonly availableBytes: number;
}

/**
 * Predicts whether ANY future invocation of a declared profile could ever pass `assertInvocationDeliveryFit` for a
 * given surface capacity — before any claim, spend or send (SESSION-RESULT-LIMIT-2026-09-28). Builds a synthetic
 * worst-case-identity admission and reuses `createModelInvocationClaimReceipt`, the exact function the real
 * `invoke()` path uses to build its prospective receipt; the per-invocation-variable fields (actor, authorization,
 * claim/command/invocation identities) are worst-case placeholders, the profile/definition/catalogRevision are the
 * real declared values. Callers pass a `definition` and `catalogRevision` already proven to belong to `profile`
 * (e.g. from `ModelBindingApplication.inspect(profile.reference)` with `status: 'declared'`); an inconsistent pair
 * throws `MODEL_INVOCATION_CORRUPT` (via `createModelInvocationClaimReceipt`'s own receipt verification), which the
 * caller should treat as a distinct "stale binding" condition, not a delivery-fitness answer.
 */
export function assessModelInvocationProfileDelivery(profile: ModelInvocationProfile, definition: ModelBindingDefinition,
  catalogRevision: string, delivery: ModelInvocationDelivery): ModelInvocationProfileDeliveryAssessment {
  const profileDigest = modelInvocationProfileDigest(profile);
  const admission: ModelInvocationAdmission = {
    command: { schemaVersion: 1, commandId: WORST_CASE_IDENTITY, scopeId: profile.scopeId, reference: profile.reference,
      catalogRevision, expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: profile.bindingDigest }, nativeRequest: {} },
    requestDigest: WORST_CASE_DIGEST,
    actor: { id: WORST_CASE_IDENTITY, issuer: WORST_CASE_IDENTITY, subject: WORST_CASE_IDENTITY, assurance: 'os-user' },
    authorization: { revision: WORST_CASE_IDENTITY, ruleId: WORST_CASE_IDENTITY },
    definition,
    activation: { schemaVersion: 1, scopeId: profile.scopeId, reference: profile.reference, revision: 1, state: 'active',
      catalogRevision, definition, binding: { encodingVersion: 1, algorithm: 'sha256', digest: profile.bindingDigest } },
    profile, profileDigest, invocationId: WORST_CASE_IDENTITY, claimedAtMs: 1,
  };
  const receipt = createModelInvocationClaimReceipt(admission);
  const responseBytes = modelInvocationNativeResponseUpperBound(profile.limits.responseMaxBytes);
  return Object.freeze({ fits: modelInvocationDeliveryFits(receipt, responseBytes, delivery),
    requiredBytes: Number(modelInvocationProfileDeliveryRequirement(receipt, responseBytes)), availableBytes: delivery.maxResultBytes });
}
