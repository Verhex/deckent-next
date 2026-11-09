import { CodedError } from '#platform/index.js';
import { z } from 'zod';
import { persistedString, HUB_LIMITS, HUB_TRUST_POLICIES, counterSchema, identitySchema, hubDigestSchema, hubPackageIdSchema, hubVersionSchema,
  type AuditEvent, type HubRevocationFeed, type HubRevocationCursor, type VerifiedPrincipal } from '#domain/index.js';
import { artifactReceiptSchema, type ArtifactReceipt, type ArtifactStore } from '#capabilities/index.js';
import type { AgentCatalogDependencies, AgentCatalogStore, CatalogUpstream } from '#engine/core/agent-catalog/index.js';
import type { HubPackageVerification, HubPackageFile, HubVerificationKey } from '#engine/core/hub/index.js';
import type { HubEnvelope, HubKeyDelegation, HubPackage } from '#domain/index.js';

export const hubSourceSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, hubId: hubDigestSchema, publicKey: persistedString(z.string().min(1)),
  endpoint: persistedString(z.string().min(1).max(2048)), local: z.boolean(), label: persistedString(z.string().min(1).max(256)),
  trustPolicy: z.string().refine(id => HUB_TRUST_POLICIES.policies.some(p => p.id === id)), revision: counterSchema.positive(),
  state: z.enum(['active', 'removed']), addedBy: z.strictObject({ issuer: identitySchema, subject: identitySchema }) }).readonly();
export type HubSource = z.infer<typeof hubSourceSchema>;
export type HubClientTrust = HubPackageVerification & { readonly publisherKind?: 'person' | 'ai' | 'system' };
/** `delegation`: the pinned root's delegation of the online key that made the hub signature; absent when the root itself signed. */
export interface HubBundle { readonly manifest: HubPackage; readonly envelope: HubEnvelope; readonly files: readonly HubPackageFile[]; readonly delegation?: HubKeyDelegation }
const item = z.strictObject({ kind: z.enum(['agent', 'skill']), id: identitySchema, revision: counterSchema.positive(), digest: hubDigestSchema }).readonly();
export const hubInstallSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, hubId: hubDigestSchema,
  packageId: hubPackageIdSchema, version: hubVersionSchema, manifestDigest: hubDigestSchema, publisherKeyId: hubDigestSchema,
  signerKeyIds: z.array(hubDigestSchema).max(HUB_LIMITS.reviewerSignaturesMax + 2).readonly().optional(),
  publisherKind: z.enum(['person', 'ai', 'system', 'unknown']), state: z.enum(['installed', 'retired']), revision: counterSchema.positive(),
  items: z.array(item).max(HUB_LIMITS.itemsMax).readonly(), bundle: artifactReceiptSchema, atMs: counterSchema,
  sourceRevision: counterSchema.positive() }).readonly();
export type HubInstall = z.infer<typeof hubInstallSchema>;
export const hubRefreshResultSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('revocations'), hubId: hubDigestSchema, verified: z.boolean().prefault(true),
  sequence: counterSchema, packages: z.array(z.strictObject({ packageId: hubPackageIdSchema, version: hubVersionSchema,
    signerKeyIds: z.array(hubDigestSchema).max(HUB_LIMITS.reviewerSignaturesMax + 2) })).prefault([]), items: z.array(z.strictObject({ kind: z.enum(['agent', 'skill']), id: identitySchema, revision: counterSchema.positive(),
    upstream: z.enum(['clear', 'withdrawn', 'revoked', 'yanked']) })),
  cards: z.array(z.strictObject({ event: z.enum(['withdrawn', 'restored', 'revoked', 'yanked']), hubId: hubDigestSchema, sequence: counterSchema,
    atMs: counterSchema })) });
export type HubRefreshResult = z.infer<typeof hubRefreshResultSchema>;
export interface HubReceipt { readonly scopeId: string; readonly commandId: string; readonly digest: string; readonly result: HubSource | readonly HubInstall[] | HubRefreshResult }
/** Same ledger and transaction as the catalog; no SQL crosses this port. A borrowed catalog's close is a no-op. */
export interface HubClientStore extends AgentCatalogStore {
  upstream(scopeId: string, kind: 'agent' | 'skill', id: string, revision: number, nowMs?: number, verifiedKeyIds?: readonly string[], revokedKeyIds?: readonly string[]): Promise<CatalogUpstream>;
  atomic<T>(work: () => Promise<T>): Promise<T>;
  borrowCatalog(anchor?: { readonly scopeId: string; readonly key: HubVerificationKey }): AgentCatalogStore;
  sources(scopeId: string): Promise<readonly HubSource[]>;
  source(scopeId: string, hubId: string): Promise<HubSource | null>;
  saveSource(previous: HubSource | null, next: HubSource): Promise<void>;
  install(scopeId: string, hubId: string, packageId: string, version?: string): Promise<HubInstall | null>;
  saveInstall(previous: HubInstall | null, next: HubInstall): Promise<void>;
  /** Retained revisions include retired packages: admitted Runs may still pin them. */
  retainedArtifacts(): Promise<readonly ArtifactReceipt[]>;
  skillBundle(scopeId: string, skillId: string, revision: number, digest: string): Promise<ArtifactReceipt | null>;
  feed(scopeId: string, hubId: string): Promise<HubRevocationFeed | null>;
  revocations(scopeId: string, hubId: string, targets: readonly Pick<HubRevocationFeed['entries'][number], 'kind' | 'id'>[]): Promise<HubRevocationFeed['entries']>;
  installations(scopeId: string, hubId: string): Promise<readonly HubInstall[]>;
  refreshResult(scopeId: string, hubId: string): Promise<HubRefreshResult | null>;
  revocationCards(scopeId: string, after: number, limit: number): Promise<readonly { after: number; result: HubRefreshResult }[]>;
  saveFeed(scopeId: string, feed: HubRevocationFeed): Promise<void>;
  hubReceipt(scopeId: string, commandId: string): Promise<HubReceipt | null>;
  finish(receipt: HubReceipt, event: AuditEvent): Promise<void>;
}
export type HubClientAction = 'inspect' | 'sources.add' | 'sources.remove' | 'install' | 'update' | 'uninstall' | 'export' | 'refresh' | 'search' | 'publish' | 'yank' | 'revoke';
export interface HubClientDependencies {
  readonly catalog: AgentCatalogDependencies;
  readonly openStore: (access: 'read' | 'write') => Promise<HubClientStore>;
  readonly artifacts: ArtifactStore;
  /** H7 binds the common policy/card path; absent grants never become authority. */
  readonly authorize: (action: HubClientAction, scopeId: string, principal: VerifiedPrincipal) => Promise<{ revision: string; ruleId: string }>;
  /** H8/H9 resolve signed profiles, moderator rosters and delegation for non-pinned policies. No resolver = refused. */
  /** H4's governed transport (including first-use card) or an offline signed-file reader; never a raw fetch. */
  readonly fetchRevocations?: (source: HubSource, afterSequence: number, signal: AbortSignal, cursor?: HubRevocationCursor) => Promise<unknown>;
  readonly resolveTrust?: (source: HubSource, bundle: HubBundle, principal: VerifiedPrincipal, store: AgentCatalogStore, nowMs: number) => Promise<HubClientTrust>;
}
export class HubClientError extends CodedError {
  constructor(override readonly code: 'HUB_SOURCE_INVALID' | 'HUB_SOURCE_NOT_FOUND' | 'HUB_AUTHORITY_REFUSED' | 'HUB_INSTALL_CONFLICT' | 'HUB_DEPENDENCY_REFUSED'
    | 'HUB_FILE_UNSUPPORTED' | 'HUB_DOWNGRADE_REFUSED' | 'HUB_PACKAGE_REVOKED' | 'HUB_STORE_CORRUPT' | 'HUB_STORE_UNAVAILABLE' | 'HUB_OUTCOME_UNKNOWN') { super(code); this.name = 'HubClientError'; }
}
export const hubClientCommandSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, commandId: identitySchema, hubId: hubDigestSchema });
export const hubInstallCommandSchema = hubClientCommandSchema.extend({ bundles: z.array(z.unknown().optional()).min(1).max(HUB_LIMITS.dependenciesMax + 1),
  feed: z.unknown().optional(), feeds: z.record(z.string(), z.unknown().optional()).prefault({}), workClassMapping: z.record(z.string(), identitySchema).prefault({}) }).strict();
