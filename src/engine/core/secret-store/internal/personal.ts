import { persistedString, persistedInteger, persistedUuid } from '#domain/index.js';
import { z } from 'zod';

const text = persistedString(z.string().min(1).max(256)), counter = persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const personalCustodyOwnerSchema = z.strictObject({ installationId: text, companyId: text, scopeId: text,
  principal: z.strictObject({ issuer: text, subject: text }).readonly() }).readonly();
export type PersonalCustodyOwner = z.infer<typeof personalCustodyOwnerSchema>;
/** Named host contract v1. Never serialized to an application surface or accepted from a request. */
export const personalCustodyEvidenceSchema = z.strictObject({ schemaVersion: z.literal(1), producer: z.literal('local-os-store'), owner: personalCustodyOwnerSchema,
  os: z.strictObject({ uid: counter, assurance: z.enum(['os-user', 'linux-so-peercred']), peerPid: counter.nullable(), connectionWitness: text.nullable() }).refine(value => value.assurance === 'os-user' ? value.peerPid === null && value.connectionWitness === null : value.peerPid !== null && value.peerPid > 0 && value.connectionWitness !== null).readonly(),
  profile: z.strictObject({ id: text, version: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), digest }).readonly(),
  store: z.strictObject({ backendId: text, instanceBindingId: persistedUuid(), generation: counter, role: z.literal('personal-main'), selectionDigest: digest.nullable() }).readonly(),
  host: z.strictObject({ locationDigest: digest, keyIdentityDigest: digest.nullable(), mountEvidenceDigest: digest,
    locality: z.literal('local'), control: z.literal('os-account-exclusive') }).readonly(),
  cleanup: z.strictObject({ state: z.literal('complete'), revision: counter }).readonly(), observedAtMs: counter }).readonly();
export type PersonalCustodyEvidence = z.infer<typeof personalCustodyEvidenceSchema>;
export type PersonalCustodyRefusal = 'shared-store' | 'foreign-os-owner' | 'non-person-owner' | 'remote-store' | 'unknown-locality'
  | 'unbound-store' | 'profile-unresolved' | 'binding-changed' | 'cleanup-pending' | 'unsafe-root';
/** Safe reason only; no filesystem metadata or nested host error. */
export class PersonalCustodyError extends Error {
  readonly code = 'SIWC_STORE_NOT_PERSONAL';
  constructor(readonly reason: PersonalCustodyRefusal) { super('SIWC_STORE_NOT_PERSONAL'); }
}
