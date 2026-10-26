import { z } from 'zod';
import { HUB_LIMITS, HUB_REVIEW_LEVELS } from './registry.js';
import { hubDigestSchema, hubSignatureValueSchema, hubTimeSchema } from './fields.js';

export const hubPackageSignatureSchema = z.object({ keyId: hubDigestSchema, algorithm: z.literal('ed25519'), role: z.enum(['publisher', 'hub', 'reviewer']),
  reviewLevel: z.string().refine(level => HUB_REVIEW_LEVELS.levels.some(row => row.id === level)).optional(), signedAtMs: hubTimeSchema,
  moderatorKeyIds: z.array(hubDigestSchema).min(1).max(HUB_LIMITS.reviewerSignaturesMax).refine(ids => new Set(ids).size === ids.length).readonly().optional(),
  value: hubSignatureValueSchema }).strict().refine(sig => (sig.role !== 'publisher' || sig.reviewLevel === undefined)
    && (sig.moderatorKeyIds === undefined || sig.role === 'hub')).readonly();
/** A publish envelope has no hub attestation yet; an accepted envelope requires exactly one (checked by the verifier). */
export const hubEnvelopeSchema = z.object({ schemaVersion: z.literal(1), payloadType: z.literal('deckent-package/1'), payloadDigest: hubDigestSchema,
  signatures: z.array(hubPackageSignatureSchema).min(1).max(HUB_LIMITS.reviewerSignaturesMax + 2).readonly() }).strict()
  .refine(row => row.signatures.filter(s => s.role === 'publisher').length === 1 && row.signatures.filter(s => s.role === 'hub').length <= 1
    && row.signatures.filter(s => s.role === 'reviewer').length <= HUB_LIMITS.reviewerSignaturesMax
    && new Set(row.signatures.map(s => `${s.role}/${s.keyId}`)).size === row.signatures.length).readonly();
export type HubPackageSignature = z.infer<typeof hubPackageSignatureSchema>;
export type HubEnvelope = z.infer<typeof hubEnvelopeSchema>;
