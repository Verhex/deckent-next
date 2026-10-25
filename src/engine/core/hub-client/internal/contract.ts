import { z } from 'zod';
import { HUB_LIMITS, HUB_TRUST_POLICIES, counterSchema, identitySchema, hubDigestSchema, hubPackageIdSchema, hubVersionSchema,
  type AuditEvent, type HubRevocationFeed, type VerifiedPrincipal } from '#domain/index.js';
import { artifactReceiptSchema, type ArtifactStore } from '#capabilities/index.js';
import type { AgentCatalogDependencies, AgentCatalogStore } from '#engine/core/agent-catalog/index.js';
import type { HubPackageVerification, HubPackageFile, HubVerificationKey } from '#engine/core/hub/index.js';
import type { HubEnvelope, HubPackage } from '#domain/index.js';

export const hubSourceSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, hubId: hubDigestSchema, publicKey: z.string().min(1),
  endpoint: z.string().min(1).max(2048), local: z.boolean(), label: z.string().min(1).max(256),
  trustPolicy: z.string().refine(id => HUB_TRUST_POLICIES.policies.some(p => p.id === id)), revision: counterSchema.positive(),
  state: z.enum(['active', 'removed']), addedBy: z.object({ issuer: identitySchema, subject: identitySchema }).strict() }).strict().readonly();
export type HubSource = z.infer<typeof hubSourceSchema>;
export type HubClientTrust = HubPackageVerification & { readonly publisherKind?: 'person' | 'ai' | 'system' };
export interface HubBundle { readonly manifest: HubPackage; readonly envelope: HubEnvelope; readonly files: readonly HubPackageFile[] }
const item = z.object({ kind: z.enum(['agent', 'skill']), id: identitySchema, revision: counterSchema.positive(), digest: hubDigestSchema }).strict().readonly();
export const hubInstallSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, hubId: hubDigestSchema,
  packageId: hubPackageIdSchema, version: hubVersionSchema, manifestDigest: hubDigestSchema, publisherKeyId: hubDigestSchema,
  publisherKind: z.enum(['person', 'ai', 'system', 'unknown']), state: z.enum(['installed', 'retired']), revision: counterSchema.positive(),
  items: z.array(item).max(HUB_LIMITS.itemsMax).readonly(), bundle: artifactReceiptSchema, atMs: counterSchema,
  sourceRevision: counterSchema.positive() }).strict().readonly();
export type HubInstall = z.infer<typeof hubInstallSchema>;
export interface HubReceipt { readonly scopeId: string; readonly commandId: string; readonly digest: string; readonly result: HubSource | readonly HubInstall[] }
/** Same ledger and transaction as the catalog; no SQL crosses this port. A borrowed catalog's close is a no-op. */
export interface HubClientStore extends AgentCatalogStore {
  atomic<T>(work: () => Promise<T>): Promise<T>;
  borrowCatalog(anchor?: { readonly scopeId: string; readonly key: HubVerificationKey }): AgentCatalogStore;
  sources(scopeId: string): Promise<readonly HubSource[]>;
  source(scopeId: string, hubId: string): Promise<HubSource | null>;
  saveSource(previous: HubSource | null, next: HubSource): Promise<void>;
  install(scopeId: string, hubId: string, packageId: string, version?: string): Promise<HubInstall | null>;
  saveInstall(previous: HubInstall | null, next: HubInstall): Promise<void>;
  feed(scopeId: string, hubId: string): Promise<HubRevocationFeed | null>;
  revocations(scopeId: string, hubId: string, targets: readonly Pick<HubRevocationFeed['entries'][number], 'kind' | 'id'>[]): Promise<HubRevocationFeed['entries']>;
  saveFeed(scopeId: string, feed: HubRevocationFeed): Promise<void>;
  hubReceipt(scopeId: string, commandId: string): Promise<HubReceipt | null>;
  finish(receipt: HubReceipt, event: AuditEvent): Promise<void>;
}
export type HubClientAction = 'inspect' | 'sources.add' | 'sources.remove' | 'install' | 'update' | 'uninstall' | 'export';
export interface HubClientDependencies {
  readonly catalog: AgentCatalogDependencies;
  readonly openStore: (access: 'read' | 'write') => Promise<HubClientStore>;
  readonly artifacts: ArtifactStore;
  /** H7 binds the common policy/card path; absent grants never become authority. */
  readonly authorize: (action: HubClientAction, scopeId: string, principal: VerifiedPrincipal) => Promise<{ revision: string; ruleId: string }>;
  /** H8/H9 resolve signed profiles, moderator rosters and delegation for non-pinned policies. No resolver = refused. */
  readonly resolveTrust?: (source: HubSource, bundle: HubBundle, principal: VerifiedPrincipal, store: AgentCatalogStore, nowMs: number) => Promise<HubClientTrust>;
}
export class HubClientError extends Error {
  constructor(readonly code: 'HUB_SOURCE_INVALID' | 'HUB_SOURCE_NOT_FOUND' | 'HUB_AUTHORITY_REFUSED' | 'HUB_INSTALL_CONFLICT' | 'HUB_DEPENDENCY_REFUSED'
    | 'HUB_FILE_UNSUPPORTED' | 'HUB_DOWNGRADE_REFUSED' | 'HUB_PACKAGE_REVOKED' | 'HUB_STORE_CORRUPT' | 'HUB_STORE_UNAVAILABLE' | 'HUB_OUTCOME_UNKNOWN') { super(code); this.name = 'HubClientError'; }
}
export const hubClientCommandSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, commandId: identitySchema, hubId: hubDigestSchema }).strict();
export const hubInstallCommandSchema = hubClientCommandSchema.extend({ bundles: z.array(z.unknown()).min(1).max(HUB_LIMITS.dependenciesMax + 1),
  feed: z.unknown(), feeds: z.record(z.string(), z.unknown()).default({}), workClassMapping: z.record(z.string(), identitySchema).default({}) }).strict();
