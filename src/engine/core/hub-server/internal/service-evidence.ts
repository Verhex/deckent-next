import { canonicalHubJson, type HubEnvelope, type HubPackage } from '#domain/index.js';
import { signatureMessage } from '#platform/index.js';
import { requireHubSignature, verifyHubPackage, type HubPackageFile, type HubVerificationKey } from '#engine/core/hub/index.js';
import { HubServerError } from './ports.js';
import { hubProfileSchema, hubRosterSchema } from './service-contract.js';
import { hubRosterMessage } from './profiles.js';

/** A resolver for the existing client trust port: the caller verifies the online key's root delegation and revocation first (H9). */
export function verifyHubModerationEvidence(input: { readonly profile: unknown; readonly roster: unknown }, bundle: {
  readonly manifest: HubPackage; readonly envelope: HubEnvelope; readonly files: readonly HubPackageFile[];
}, anchors: { readonly hubId: string; readonly rootPublicKey: string; readonly attestationKey: HubVerificationKey; readonly minimumModerators?: number; readonly previousProfileSequence?: number; readonly previousRosterSequence?: number }) {
  const profile = hubProfileSchema.parse(input.profile), roster = hubRosterSchema.parse(input.roster), { signature, ...payload } = profile;
  if (profile.sequence < (anchors.previousProfileSequence ?? 0) || roster.sequence < (anchors.previousRosterSequence ?? 0) || roster.hubId !== anchors.hubId || profile.status !== 'active' || bundle.manifest.packageId.split('/')[0] !== `@${profile.handle}`
    || anchors.attestationKey.role !== 'hub') throw new HubServerError('HUB_PROFILE_REFUSED');
  requireHubSignature({ keyId: anchors.hubId, publicKey: anchors.rootPublicKey, role: 'hub', active: true }, roster.signature.keyId, hubRosterMessage(roster), roster.signature.value);
  requireHubSignature(anchors.attestationKey, signature.keyId, signatureMessage('hub-profile:1', canonicalHubJson({ hubId: anchors.hubId, ...payload })), signature.value);
  const publisherSignature = bundle.envelope.signatures.find(s => s.role === 'publisher'), hubSignature = bundle.envelope.signatures.find(s => s.role === 'hub');
  const binding = profile.keys.find(key => key.keyId === publisherSignature?.keyId && key.state === 'active');
  if (!binding || !hubSignature || hubSignature.reviewLevel !== 'moderated') throw new HubServerError('HUB_REVIEW_REFUSED');
  const reviews = bundle.envelope.signatures.filter(s => s.role === 'reviewer'), accounts = new Set<string>();
  const reviewers = reviews.map(review => {
    const entry = roster.entries.find(e => e.keyId === review.keyId && e.notBefore <= review.signedAtMs && review.signedAtMs < e.notAfter);
    if (!entry || review.reviewLevel !== 'moderated' || accounts.has(entry.accountRef) || profile.members.some(m => m.accountId === entry.accountRef)) throw new HubServerError('HUB_REVIEW_REFUSED');
    accounts.add(entry.accountRef); return { keyId: entry.keyId, publicKey: entry.publicKey, role: 'reviewer' as const, active: true };
  });
  const minimum = anchors.minimumModerators ?? 1;
  if (!Number.isSafeInteger(minimum) || minimum < 1 || reviewers.length < minimum || hubSignature.moderatorKeyIds?.length !== reviewers.length
    || reviewers.some(key => !hubSignature.moderatorKeyIds!.includes(key.keyId))) throw new HubServerError('HUB_REVIEW_REFUSED');
  // Publisher public key is carried in the signed profile's key binding, never accepted from unsigned package metadata.
  const key = profile.keys.find(k => k.keyId === binding.keyId)!;
  const publisher = { keyId: key.keyId, publicKey: key.publicKey, role: 'publisher' as const, active: true };
  const trust = { publisher, hub: anchors.attestationKey, reviewers, publisherKind: binding.principalKind };
  verifyHubPackage(bundle.manifest, bundle.envelope, bundle.files, trust); return trust;
}
