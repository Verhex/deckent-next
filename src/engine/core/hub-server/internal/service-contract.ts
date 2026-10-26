import { z } from 'zod';
import { HUB_LIMITS, identitySchema, hubPackageSignatureSchema } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
import type { HubAwaitable, HubServerContext, HubServerSigner } from './ports.js';

const id = identitySchema, time = z.number().int().safe().nonnegative(), positive = time.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(HUB_LIMITS.skillReadMaxBytes);
export const hubServicePolicySchema = z.object({ schemaVersion: z.literal(1),
  identityProviders: z.array(z.object({ id, issuer: z.string().url(), audience: text }).strict()).min(1),
  admins: z.array(id), reservedHandles: z.array(text), confusables: z.record(z.string(), z.string()),
  highRiskWorkClasses: z.array(id), maliciousReasons: z.array(id), reasons: z.record(id, time),
  minAccountAgeMs: time, challengeTtlMs: positive, sessionTtlMs: positive, deletionDelayMs: time, emergencyConfirmMs: positive,
  publishWindowMs: positive, publishesPerProfile: positive, dayWindowMs: positive, newPackagesPerProfile: positive,
  versionsPerPackage: positive, reportsPerAccount: positive, readWindowMs: positive, readsPerAddress: positive,
  searchesPerAddress: positive, maxMembers: positive, maxKeys: positive, maxChallenges: positive,
}).strict().readonly();
export type HubServicePolicy = z.infer<typeof hubServicePolicySchema>;
export const hubAccountSchema = z.object({ schemaVersion: z.literal(1), id, createdAtMs: time,
  status: z.enum(['active', 'suspended', 'banned', 'deleted']), deleteAfterMs: time.nullable() }).strict();
export const hubPersonalSchema = z.object({ accountId: id, providerId: id, subject: text, email: text, displayName: text }).strict();
export const hubProfileSchema = z.object({ schemaVersion: z.literal(1), id, handle: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  kind: z.enum(['person', 'organisation']), displayName: text, verifiedDomains: z.array(z.string().max(253)),
  members: z.array(z.object({ accountId: id, role: z.enum(['owner', 'maintainer', 'publisher']) }).strict()),
  keys: z.array(z.object({ keyId: digest, publicKey: text, principalId: id, principalKind: z.enum(['person', 'ai', 'system']), memberAccountId: id.nullable(),
    addedAtMs: time, state: z.enum(['active', 'revoked']) }).strict()), status: z.enum(['active', 'suspended', 'banned']),
  sequence: positive, recoveryReview: z.boolean(), signature: z.object({ keyId: digest, value: text }).strict(),
}).strict();
export type HubProfile = z.infer<typeof hubProfileSchema>;
export const hubQueueSchema = z.object({ schemaVersion: z.literal(1), id, profileId: id, packageId: text, version: text, digest,
  state: z.enum(['received', 'scanned', 'pending-review', 'approved', 'rejected', 'changes-requested']),
  required: z.number().int().min(1).max(HUB_LIMITS.reviewerSignaturesMax), hidden: z.boolean(),
  signals: z.array(id), previousDigest: digest.nullable(), approvals: z.array(z.object({ accountId: id, signature: hubPackageSignatureSchema }).strict()),
  receivedAtMs: time }).strict();
export type HubQueue = z.infer<typeof hubQueueSchema>;
export const hubRosterSchema = z.object({ schemaVersion: z.literal(1), hubId: digest, sequence: positive,
  entries: z.array(z.object({ keyId: digest, publicKey: text, role: z.enum(['moderator', 'senior-moderator']), accountRef: id,
    notBefore: time, notAfter: positive }).strict()).max(HUB_LIMITS.searchPageMax),
  signature: z.object({ keyId: digest, value: text }).strict() }).strict();
export type HubRoster = z.infer<typeof hubRosterSchema>;
export const hubModerationCommandSchema = z.object({ schemaVersion: z.literal(1), commandId: id,
  action: z.enum(['approve', 'reject', 'request-changes', 'yank', 'revoke', 'hide', 'restore', 'suspend', 'ban', 'unban', 'recover-key']),
  targetKind: z.enum(['version', 'profile', 'account']), targetId: id, reason: id, emergency: z.boolean(),
  keyId: digest, signedAtMs: time, signature: text, review: hubPackageSignatureSchema.optional(), appealId: id.optional(), recoveryId: id.optional() }).strict();
export type HubModerationCommand = z.infer<typeof hubModerationCommandSchema>;
export const hubCaseSchema = z.object({ id, command: hubModerationCommandSchema, accounts: z.array(id), keyIds: z.array(digest),
  votes: z.array(hubModerationCommandSchema), applied: z.boolean(), confirmByMs: time.nullable(), escalated: z.boolean() }).strict();
export const hubReportSchema = z.object({ id, accountId: id, targetId: id, reason: id, severity: time,
  appealOf: id.nullable(), assignedTo: id.nullable(), resolved: z.boolean(), createdAtMs: time }).strict();
export const hubRecoverySchema = z.object({ id, profileId: id, accountId: id, lostKeyId: digest,
  key: z.object({ keyId: digest, publicKey: text, role: z.literal('publisher'), active: z.literal(true), trustedAiReviewer: z.literal(false),
    publisherId: text, principal: z.object({ id, kind: z.enum(['person', 'ai', 'system']) }).strict() }).strict(), approved: z.boolean() }).strict();
export const hubSessionSchema = z.object({ id, accountId: id, expiresAtMs: time }).strict();
export const hubChallengeSchema = z.object({ id, accountId: id.nullable(), purpose: z.enum(['login', 'key', 'domain']),
  binding: text, expiresAtMs: time }).strict();
export type HubServiceArea = 'accounts' | 'personal' | 'profiles' | 'queue' | 'roster' | 'cases' | 'reports' | 'sessions' | 'challenges' | 'rates' | 'recoveries';
export interface HubServiceTransaction {
  get(area: HubServiceArea, id: string): unknown | null;
  put(area: HubServiceArea, id: string, value: unknown): void;
  remove(area: HubServiceArea, id: string): void;
  list(area: HubServiceArea, after: string, limit: number): readonly { id: string; value: unknown }[];
  audit(event: { readonly actor: string; readonly action: string; readonly resource: string; readonly reason: string | null; readonly atMs: number },
    integrity: IntegrityAuthority, signer: HubServerSigner, publicEntry: boolean): Promise<unknown>;
  publicAuditPage(after: number, limit: number): readonly unknown[];
  auditPage(after: number, limit: number, integrity: IntegrityAuthority): readonly unknown[];
}
/** Trusted adapters verify tokens/code+PKCE/nonce, issuer/audience/expiry and WebAuthn challenge/RP/origin/UV/counter.
 * Raw client claims never satisfy this port; each deployment supplies its configured IdP and credential store. */
export interface HubIdentityVerifier {
  verify(input: unknown, expected: { readonly challenge: string; readonly issuer: string; readonly audience: string; readonly nowMs: number }):
    Promise<{ readonly subject: string; readonly email: string; readonly displayName: string; readonly emailVerified: boolean; readonly passkeyVerified: boolean }>;
}
export interface HubServiceDependencies {
  readonly policy: HubServicePolicy; readonly integrity: IntegrityAuthority; readonly rootPublicKey: string;
  readonly identity: HubIdentityVerifier;
  readonly verifyDomain: (domain: string, expectedTxt: string, signal?: AbortSignal) => HubAwaitable<boolean>;
}
export interface HubServiceContext extends HubServerContext { readonly sessionId?: string }
