import { z } from 'zod';

const text = z.string().min(1).max(256), counter = z.number().int().nonnegative().safe(), digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const personalCustodyOwnerSchema = z.object({ installationId: text, companyId: text, scopeId: text,
  principal: z.object({ issuer: text, subject: text }).strict().readonly() }).strict().readonly();
export type PersonalCustodyOwner = z.infer<typeof personalCustodyOwnerSchema>;
/** Named host contract v1. Never serialized to an application surface or accepted from a request. */
export const personalCustodyEvidenceSchema = z.object({ schemaVersion: z.literal(1), producer: z.literal('local-os-store'), owner: personalCustodyOwnerSchema,
  os: z.object({ uid: counter, assurance: z.enum(['os-user', 'linux-so-peercred']), peerPid: counter.nullable(), connectionWitness: text.nullable() }).strict().refine(value => value.assurance === 'os-user' ? value.peerPid === null && value.connectionWitness === null : value.peerPid !== null && value.peerPid > 0 && value.connectionWitness !== null).readonly(),
  profile: z.object({ id: text, version: z.number().int().positive().safe(), digest }).strict().readonly(),
  store: z.object({ backendId: text, instanceBindingId: z.string().uuid(), generation: counter, role: z.literal('personal-main'), selectionDigest: digest.nullable() }).strict().readonly(),
  host: z.object({ locationDigest: digest, keyIdentityDigest: digest.nullable(), mountEvidenceDigest: digest,
    locality: z.literal('local'), control: z.literal('os-account-exclusive') }).strict().readonly(),
  cleanup: z.object({ state: z.literal('complete'), revision: counter }).strict().readonly(), observedAtMs: counter }).strict().readonly();
export type PersonalCustodyEvidence = z.infer<typeof personalCustodyEvidenceSchema>;
export type PersonalCustodyRefusal = 'shared-store' | 'foreign-os-owner' | 'non-person-owner' | 'remote-store' | 'unknown-locality'
  | 'unbound-store' | 'profile-unresolved' | 'binding-changed' | 'cleanup-pending' | 'unsafe-root';
/** Safe reason only; no filesystem metadata or nested host error. */
export class PersonalCustodyError extends Error {
  readonly code = 'SIWC_STORE_NOT_PERSONAL';
  constructor(readonly reason: PersonalCustodyRefusal) { super('SIWC_STORE_NOT_PERSONAL'); }
}
