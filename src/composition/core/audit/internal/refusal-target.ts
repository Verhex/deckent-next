import type { AuditEvent } from '#domain/index.js';

type Refusal = Extract<AuditEvent['subject'], { kind: 'access-refusal-summary' }>;
type Identity = NonNullable<Refusal['target']['identity']>;
type Location = { readonly installationId: string; readonly companyId: string; readonly scopeId: string };
type Reference = { readonly providerId: string; readonly providerVersion: number; readonly modelId: string; readonly modelVersion: number };
export type RefusalCandidate = { readonly invocationId: string; readonly reference: Reference };
export type VerifiedRefusalCandidate = RefusalCandidate & Location & { readonly descriptor: {
  readonly schemaVersion: 1; readonly kind: 'native-response' | 'response-body'; readonly encoding: 'canonical-json' | 'base64';
  readonly digest: string; readonly byteLength: number;
} };

const role = 'stored-invocation-response';
function projection(target: VerifiedRefusalCandidate): string {
  const { installationId, companyId, scopeId, invocationId, reference, descriptor } = target;
  return JSON.stringify(['audit-refusal-target:1', installationId, companyId, scopeId, role, invocationId,
    [reference.providerId, reference.providerVersion, reference.modelId, reference.modelVersion],
    [descriptor.schemaVersion, descriptor.kind, descriptor.encoding, descriptor.digest, descriptor.byteLength]]);
}

export function signRefusalTarget(target: VerifiedRefusalCandidate, authority: { readonly keyId: string; sign(bytes: string): string }): Identity {
  return { keyId: authority.keyId, digest: authority.sign(projection(target)) };
}

export function verifyRefusalTarget(subject: Refusal, candidate: VerifiedRefusalCandidate, authority: { verify(bytes: string, digest: string, keyId: string): boolean }): boolean {
  const identity = subject.target.identity;
  return subject.target.role === role && identity !== null && subject.invocationId === candidate.invocationId
    && authority.verify(projection(candidate), identity.digest, identity.keyId);
}
