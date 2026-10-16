import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/core/attempt/index.js';
import { identitySchema } from '#domain/core/primitives/index.js';
import { encodeCommandProjection } from '#domain/core/command/index.js';
import { effectTargetRefSchema, operationRefSchema } from './contract.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().min(1).max(512);
/** Physical resource identity comes from a trusted adapter, never a client path or scope. Scopes sharing a resource share its queue. */
export const targetBindingSchema = z.object({ schemaVersion: z.literal(1), installationId: identitySchema,
  adapter: operationRefSchema, resourceBinding: digest, target: effectTargetRefSchema }).strict().readonly();
export type TargetBinding = z.infer<typeof targetBindingSchema>;
/** Immutable adapter custody. Neither a filesystem path nor a freely chosen revision admits a verification Run. */
export const candidateBindingSchema = z.object({ schemaVersion: z.literal(1), target: targetBindingSchema,
  identity: attemptIdentitySchema, sourceBinding: digest, outputDigest: digest,
  observedVersion: version, effectiveVersion: version, candidateVersion: version, candidateDigest: digest,
  custodyReceipt: digest, criteria: z.array(digest).min(1), profileFingerprint: digest,
  replacesCommandId: identitySchema.nullable() }).strict().readonly();
export type CandidateBinding = z.infer<typeof candidateBindingSchema>;
export const candidateEvidenceSchema = z.object({ schemaVersion: z.literal(1), candidateDigest: digest, custodyReceipt: digest,
  sourceBinding: digest, candidateVersion: version, profileFingerprint: digest, criteria: z.array(digest).min(1),
  identity: attemptIdentitySchema, evidenceReceipt: digest,
  phase: z.enum(['accepted', 'failed', 'pending', 'cancelled', 'unknown']) }).strict().readonly();
export type CandidateEvidence = z.infer<typeof candidateEvidenceSchema>;
export class CandidateBindingError extends Error {
  constructor(readonly code: 'CANDIDATE_MISMATCH' | 'CANDIDATE_NOT_ACCEPTED') { super(code); this.name = 'CandidateBindingError'; }
}
/** A result on another source, Attempt, profile or criterion is never evidence for this candidate, even if accepted. */
export function assertCandidateEvidence(input: CandidateBinding, proof: CandidateEvidence): void {
  const candidate = candidateBindingSchema.parse(input), evidence = candidateEvidenceSchema.parse(proof);
  for (const key of ['candidateDigest', 'custodyReceipt', 'sourceBinding', 'candidateVersion', 'profileFingerprint', 'criteria', 'identity'] as const) {
    if (encodeCommandProjection('candidate-evidence:1', candidate[key]) !== encodeCommandProjection('candidate-evidence:1', evidence[key]))
      throw new CandidateBindingError('CANDIDATE_MISMATCH');
  }
  if (evidence.phase !== 'accepted') throw new CandidateBindingError('CANDIDATE_NOT_ACCEPTED');
}
/** Catalog keys are adapter-owned display data. Generic surfaces never infer Git/ERP terminology from an address. */
export const targetDisplaySchema = z.object({ schemaVersion: z.literal(1), labelKey: identitySchema, basisKey: identitySchema,
  versionKey: identitySchema, prepareActionKey: identitySchema }).strict().readonly();
export type TargetDisplay = z.infer<typeof targetDisplaySchema>;
