import { z } from 'zod';
import { identitySchema, immutableJsonObjectSchema } from '#domain/index.js';
import type { PreparedInstallation } from './application.js';
import { createInstallationEvidencePreview, type InstallationEvidencePreview } from './evidence.js';

const consentSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal('operator-custom'),
  id: identitySchema, atMs: z.number().int().nonnegative().safe(),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  principal: z.object({ issuer: identitySchema, subject: identitySchema }).strict().readonly(),
}).strict().readonly();
export type InstallationConsent = z.infer<typeof consentSchema>;
export class InstallationRecoveryError extends Error {
  constructor(readonly code: 'INSTALLATION_RECOVERY_INVALID' | 'INSTALLATION_RECOVERY_CONSENT'
    | 'INSTALLATION_RECOVERY_CHANGED') { super(code); this.name = 'InstallationRecoveryError'; }
}
function canonical(value: unknown): string {
  const parsed = immutableJsonObjectSchema.safeParse(value);
  if (!parsed.success) throw new InstallationRecoveryError('INSTALLATION_RECOVERY_INVALID');
  return JSON.stringify(parsed.data);
}

/** Composition supplies a validated preparation and freshly observed evidence. Consent is
 * an explicit operator action attributed by that boundary, never a claim from the profile.
 * It accepts these exact local bytes; it does not establish publisher authenticity.
 */
export function createInstallationRecovery(prepared: PreparedInstallation,
  evidence: InstallationEvidencePreview, inputConsent: unknown) {
  const safeConsent = immutableJsonObjectSchema.safeParse(inputConsent);
  const consent = safeConsent.success ? consentSchema.safeParse(safeConsent.data) : null;
  if (!consent?.success) throw new InstallationRecoveryError('INSTALLATION_RECOVERY_INVALID');
  const verifiedEvidence = createInstallationEvidencePreview(prepared.preview, evidence.package, evidence.images);
  if (canonical(evidence) !== canonical(verifiedEvidence)
    || prepared.material.planDigest !== prepared.preview.planDigest
    || prepared.material.authoredProfile.profile.digest !== prepared.preview.profile.digest) {
    throw new InstallationRecoveryError('INSTALLATION_RECOVERY_CHANGED');
  }
  if (consent.data.proposalDigest !== verifiedEvidence.proposalDigest
    || consent.data.principal.issuer !== prepared.preview.principal.issuer
    || consent.data.principal.subject !== prepared.preview.principal.subject) {
    throw new InstallationRecoveryError('INSTALLATION_RECOVERY_CONSENT');
  }
  return Object.freeze({ schemaVersion: 1 as const, material: prepared.material,
    evidence: Object.freeze({ proposalDigest: verifiedEvidence.proposalDigest, package: verifiedEvidence.package,
      images: verifiedEvidence.images, publisherVerification: verifiedEvidence.publisherVerification }),
    consent: consent.data });
}
export type InstallationRecovery = ReturnType<typeof createInstallationRecovery>;

/** Validate stored material against preparation recreated from its exact configuration
 * snapshot and freshly resolved paths. The caller must also remeasure live artifacts
 * before publication; this function does not turn historical evidence into live proof.
 */
export function validateInstallationRecovery(input: unknown, prepared: PreparedInstallation): InstallationRecovery {
  const safe = immutableJsonObjectSchema.safeParse(input);
  if (!safe.success) throw new InstallationRecoveryError('INSTALLATION_RECOVERY_INVALID');
  const shape = z.object({ schemaVersion: z.literal(1), material: z.unknown(),
    evidence: z.object({ proposalDigest: z.string(), package: z.unknown(), images: z.array(z.unknown()),
      publisherVerification: z.literal('unverified') }).strict(), consent: consentSchema,
  }).strict().safeParse(safe.data);
  if (!shape.success) throw new InstallationRecoveryError('INSTALLATION_RECOVERY_INVALID');
  const evidence = createInstallationEvidencePreview(prepared.preview,
    shape.data.evidence.package as InstallationEvidencePreview['package'],
    shape.data.evidence.images as InstallationEvidencePreview['images']);
  const expected = createInstallationRecovery(prepared, evidence, shape.data.consent);
  if (canonical(safe.data) !== canonical(expected)) throw new InstallationRecoveryError('INSTALLATION_RECOVERY_CHANGED');
  return expected;
}
