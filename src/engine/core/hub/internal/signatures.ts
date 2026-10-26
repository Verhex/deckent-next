import { encodeCommandProjection, SIGNATURE_LABELS, HUB_LIMITS, HubError, canonicalHubJson, hubEnvelopeSchema, hubKeyDelegationSchema, parseHubContract,
  type HubEnvelope, type HubKeyDelegation, type HubPackage, type HubPackageSignature } from '#domain/index.js';
import { ed25519KeyId, sha256, signatureMessage, verifyEd25519 } from '#platform/index.js';
import { canonicalHubManifest, verifyHubPackageFiles, type HubPackageFile } from './package.js';
import { hubSkillDocumentBody, skillContentV2Digest, skillSignatureV2Message } from './skill.js';

/** The caller resolves active trust anchors in its scope, after policy/revocation/delegation checks. This verifier never discovers trust from an envelope. */
export interface HubVerificationKey { readonly keyId: string; readonly publicKey: string; readonly role: HubPackageSignature['role']; readonly active: boolean }
export interface HubPackageVerification { readonly publisher: HubVerificationKey; readonly hub?: HubVerificationKey; readonly reviewers: readonly HubVerificationKey[] }
export function hubPackageSignatureMessage(manifest: HubPackage, envelope: Pick<HubEnvelope, 'payloadType' | 'payloadDigest'>,
  signature: Omit<HubPackageSignature, 'value' | 'algorithm' | 'keyId'>): Uint8Array {
  return signatureMessage(SIGNATURE_LABELS.package, encodeCommandProjection(SIGNATURE_LABELS.package, {
    payloadType: envelope.payloadType, payloadDigest: envelope.payloadDigest, packageId: manifest.packageId, version: manifest.version,
    role: signature.role, ...(signature.reviewLevel !== undefined ? { reviewLevel: signature.reviewLevel } : {}), signedAtMs: signature.signedAtMs,
    ...(signature.moderatorKeyIds !== undefined ? { moderatorKeyIds: signature.moderatorKeyIds } : {}) }));
}
export function requireHubSignature(key: HubVerificationKey | undefined, keyId: string, message: Uint8Array, value: string): void {
  if (!key || !key.active || key.keyId !== keyId) throw new HubError('HUB_SIGNER_UNTRUSTED');
  if (!/^[A-Za-z0-9+/]{59}=$/.test(key.publicKey)) throw new HubError('HUB_SIGNER_UNTRUSTED');
  const spki = Buffer.from(key.publicKey, 'base64');
  try { if (ed25519KeyId(spki) !== keyId) throw new HubError('HUB_SIGNER_UNTRUSTED'); }
  catch { throw new HubError('HUB_SIGNER_UNTRUSTED'); }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || !verifyEd25519(spki, message, bytes)) throw new HubError('HUB_SIGNATURE_INVALID');
}
export const hubKeyDelegationMessage = (delegation: Omit<HubKeyDelegation, 'signature'>) =>
  signatureMessage(SIGNATURE_LABELS.hubKeyDelegation, encodeCommandProjection(SIGNATURE_LABELS.hubKeyDelegation, delegation));
/** The pinned hub identity: `hubId` is the fingerprint of the root key a person pinned (never served by the hub itself). */
export interface HubRoot { readonly hubId: string; readonly publicKey: string }
/**
 * The key allowed to make a hub signature of `purpose` signed at `atMs` (S8 §9A trust chain): the pinned root itself, or an online key the root
 * delegated for that purpose with `atMs` inside the delegation window. An undelegated, foreign-root, wrong-purpose or out-of-window key is
 * HUB_SIGNER_UNTRUSTED. Revocation of the online key stays with the caller (its revocation feed and local revocations).
 */
export function delegatedHubKey(root: HubRoot, signerKeyId: string, input: unknown, purpose: 'attestation' | 'feed', atMs: number): HubVerificationKey {
  const rootKey: HubVerificationKey = { keyId: root.hubId, publicKey: root.publicKey, role: 'hub', active: true };
  if (signerKeyId === root.hubId) return rootKey;
  const parsed = hubKeyDelegationSchema.safeParse(input);
  if (!parsed.success) throw new HubError('HUB_SIGNER_UNTRUSTED');
  const { signature, ...delegation } = parsed.data;
  if (delegation.hubId !== root.hubId || delegation.keyId !== signerKeyId || !delegation.purposes.includes(purpose)
    || !Number.isSafeInteger(atMs) || atMs < delegation.notBefore || atMs >= delegation.notAfter) throw new HubError('HUB_SIGNER_UNTRUSTED');
  requireHubSignature(rootKey, signature.keyId, hubKeyDelegationMessage(delegation), signature.value);
  return { keyId: delegation.keyId, publicKey: delegation.publicKey, role: 'hub', active: true };
}
/** Cryptographic verification only: install policy, source identity, moderator/profile/delegation evidence and freshness are owned by the calling application. */
export function verifyHubPackage(manifest: HubPackage, input: unknown, files: readonly HubPackageFile[], keys: HubPackageVerification): HubEnvelope {
  const canonical = canonicalHubManifest(manifest), envelope = parseHubContract(hubEnvelopeSchema, input, 'HUB_ENVELOPE_INVALID', 'HUB_ENVELOPE_SCHEMA_UNSUPPORTED');
  if (sha256(canonical) !== envelope.payloadDigest) throw new HubError('HUB_DIGEST_MISMATCH');
  verifyHubPackageFiles(manifest, files);
  const packageBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0) + Buffer.byteLength(canonical) + Buffer.byteLength(canonicalHubJson(envelope));
  if (packageBytes > HUB_LIMITS.packageMaxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
  if (keys.reviewers.length > HUB_LIMITS.reviewerSignaturesMax) throw new HubError('HUB_LIMIT_EXCEEDED');
  if (keys.publisher.role !== 'publisher' || keys.hub?.role && keys.hub.role !== 'hub' || keys.reviewers.some(key => key.role !== 'reviewer')) throw new HubError('HUB_SIGNER_UNTRUSTED');
  const hub = envelope.signatures.find(signature => signature.role === 'hub');
  if (keys.hub && !hub) throw new HubError('HUB_FOREIGN_PACKAGE');
  if (hub && hub.keyId !== keys.hub?.keyId) throw new HubError('HUB_FOREIGN_PACKAGE');
  for (const signature of envelope.signatures) {
    const key = signature.role === 'publisher' ? keys.publisher : signature.role === 'hub' ? keys.hub : keys.reviewers.find(key => key.keyId === signature.keyId);
    requireHubSignature(key, signature.keyId, hubPackageSignatureMessage(manifest, envelope, signature), signature.value);
  }
  for (const item of manifest.items) {
    if (item.kind !== 'skill') continue;
    const bytes = files.find(file => file.path === `skills/${item.name}/SKILL.md`)!.bytes;
    let document;
    try { document = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new HubError('HUB_SKILL_INVALID'); }
    const text = hubSkillDocumentBody(document, item.name, item.description);
    const contentDigest = skillContentV2Digest({ name: item.name, description: item.description, text, files: item.files });
    requireHubSignature(keys.publisher, item.signature.keyId, skillSignatureV2Message({ skillId: item.skillId, contentDigest }), item.signature.value);
  }
  return envelope;
}
