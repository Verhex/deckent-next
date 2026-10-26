import { z } from 'zod';
import { identitySchema, type HubPackage, type HubEnvelope } from '#domain/index.js';
import { type ArtifactReceipt, type ArtifactStore } from '#capabilities/index.js';
import { ErrorRegistry, type KnownSecretSnapshot, type Ed25519Signer } from '#platform/index.js';
import type { HubVerificationKey } from '#engine/core/hub/index.js';

export const hubActorSchema = z.object({ id: identitySchema, kind: z.enum(['person', 'ai', 'system']) }).strict().readonly();
export type HubActor = z.infer<typeof hubActorSchema>;
export interface HubServerContext { readonly scopeId: string; readonly principal: HubActor }
export type HubServerAction = 'publish' | 'review' | 'read' | 'register';
/** Trusted transport supplies identity; the installation's existing policy owner checks scope/action/resource/digest. No default grant. */
export interface HubServerAuthority {
  require(context: HubServerContext, action: HubServerAction, resource: string, digest: string): HubAwaitable<void>;
}
export const hubRegisteredKeySchema = z.object({ keyId: z.string().regex(/^[a-f0-9]{64}$/), publicKey: z.string(),
  role: z.enum(['publisher', 'reviewer']), active: z.boolean(), principal: hubActorSchema,
  publisherId: identitySchema.optional(), trustedAiReviewer: z.boolean() }).strict().readonly();
export type HubRegisteredKey = z.infer<typeof hubRegisteredKeySchema>;
export interface HubStoredVersion {
  readonly manifest: HubPackage; readonly envelope: HubEnvelope; readonly revision: number;
  readonly files: readonly { readonly path: string; readonly artifact: ArtifactReceipt }[];
}
export interface HubSkillRef { readonly key: string; readonly packageId: string; readonly version: string; readonly skillId: string }
export interface HubServerReceipt {
  readonly sequence: number; readonly previous: string | null; readonly digest: string; readonly keyId: string; readonly signature: string;
}
export interface HubReceiptEvent {
  readonly action: HubServerAction; readonly context: HubServerContext; readonly resource: string; readonly digest: string; readonly atMs: number;
}
/** Store mutations occur through the transaction view; artifact writes finish before it. No installation ledger dependency. */
export type HubAwaitable<T> = T | Promise<T>;
export type HubServerSigner = Omit<Ed25519Signer, 'sign'> & { sign(message: Uint8Array): HubAwaitable<Uint8Array> };
export interface HubServerTransaction {
  key(keyId: string, role: HubRegisteredKey['role']): HubAwaitable<HubRegisteredKey | null>;
  putKey(key: HubRegisteredKey): HubAwaitable<void>;
  get(packageId: string, version: string): HubAwaitable<HubStoredVersion | null>;
  latest(packageId: string): HubAwaitable<HubStoredVersion | null>;
  insert(row: HubStoredVersion, atMs: number, publisherId: string): HubAwaitable<void>;
  replaceEnvelope(packageId: string, version: string, expectedRevision: number, envelope: HubEnvelope): HubAwaitable<void>;
  publishesSince(publisherId: string, atMs: number): HubAwaitable<number>;
  skills(after: string, limit: number): HubAwaitable<readonly HubSkillRef[]>;
  packages(after: string, limit: number): HubAwaitable<readonly { readonly key: string; readonly packageId: string; readonly version: string }[]>;
  appendReceipt(event: HubReceiptEvent, signer: HubServerSigner): Promise<HubServerReceipt>;
}
export interface HubServerStore extends Pick<HubServerTransaction, 'key' | 'get' | 'latest' | 'publishesSince' | 'skills' | 'packages'> {
  transaction<T>(work: (transaction: HubServerTransaction) => Promise<T>): Promise<T>;
}
export interface HubServerPorts {
  readonly hubId: string; readonly scopeId: string; readonly store: HubServerStore; readonly artifacts: ArtifactStore;
  readonly authority: HubServerAuthority; readonly knownSecrets: () => KnownSecretSnapshot; readonly now: () => number;
  /** Resolve an active, purpose-bound online key after delegation-window/revocation checks. H8/H9 own custody and root trust. */
  readonly attestor: (atMs: number) => HubAwaitable<{ readonly signer: HubServerSigner; readonly key: HubVerificationKey }>;
}
export const HUB_SERVER_ERROR_CODES = ['HUB_SERVER_DENIED', 'HUB_VERSION_CONFLICT', 'HUB_DEPENDENCY_INVALID', 'HUB_SECRET_REFUSED',
  'HUB_REVIEW_REFUSED', 'HUB_STORE_UNSAFE', 'HUB_STORE_CONFLICT', 'HUB_RESOURCE_UNKNOWN', 'HUB_STORE_UNSUPPORTED', 'HUB_STORE_OUTCOME_UNKNOWN'] as const;
export class HubServerError extends Error {
  constructor(readonly code: typeof HUB_SERVER_ERROR_CODES[number]) { super(ErrorRegistry.get(code)!.message); this.name = 'HubServerError'; }
}
