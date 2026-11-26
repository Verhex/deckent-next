import type { AttemptIdentity, ExecutionProfileDefinition, NativeNodeDependencyParameters, NativeNodeDependencyReference, RunSnapshot, VerifiedPrincipal } from '#domain/index.js';
import type { DeckentConfig, IntegrityAuthority, KnownSecretSnapshot, ProductLayout } from '#platform/index.js';
import type { ApprovalCommand, ApprovalStore } from '#engine/core/approval/index.js';
import type { AuditApplication } from '#engine/core/audit/index.js';
import type { ConfigDocumentPort, ConfigSnapshot } from '#engine/core/config/index.js';
import type { PolicySource, ScopeAccess } from '#engine/core/policy/index.js';
import type { SecretStore } from '#engine/core/secret-store/index.js';

export interface PackageContext {
  readonly config: DeckentConfig;
  readonly layout: ProductLayout;
  readonly installationLayout: ProductLayout;
  readonly installationId: string | null;
  readonly projectId: string | null;
  readonly principal: VerifiedPrincipal;
  readonly document: Awaited<ReturnType<PolicySource['load']>>;
}

export type PackageProfile = Readonly<{ id: string; version: number }>;
export type PackageBinding = Readonly<{ reference: NativeNodeDependencyReference; profile: PackageProfile }>;
export type PackageKnownSecrets = KnownSecretSnapshot & Readonly<{
  matchesPackageValue?: (texts: readonly string[], bytes?: Buffer, checkTime?: () => void) => boolean;
}>;
type RegisteredPackageSecrets = Readonly<{ backend: string; values: readonly string[] }>;
export interface PackageSecretSnapshot {
  readonly registered: RegisteredPackageSecrets;
  readonly known: PackageKnownSecrets;
}
export interface PackageSecretPort {
  configuredStore(config: DeckentConfig): string;
  open(config: DeckentConfig): Pick<SecretStore, 'descriptor' | 'get' | 'listNames'>;
  exclusive<T>(work: (selected: () => Promise<string>) => Promise<T>): Promise<T>;
}
type PackageManifestEntry = Readonly<{ path: string; kind: 'directory' | 'file' | 'link'; size: number; mode: number; digest: string | null;
  target?: string; rules: readonly string[] }>;
export interface PreparedPackageInput {
  readonly project: string;
  readonly workTarget: string;
  readonly lockfileDigest: string;
  readonly platform: string;
  readonly known: PackageKnownSecrets;
  review(): Promise<{ digest: string; manifest: { schemaVersion: 2; entries: readonly PackageManifestEntry[] } }>;
  withCurrentSecrets<T>(work: () => Promise<T>): Promise<T>;
  assertCurrent(): Promise<void>;
  seal(reference: Omit<NativeNodeDependencyReference, 'state' | 'approval'> & { approval: { scopeId: string } }): Promise<unknown>;
}
export interface WorkerPackagePorts<C extends PackageContext> {
  loadScope(scopeId: string, access: ScopeAccess): Promise<C>;
  policySource(context: C, pinned?: C['document']): PolicySource;
  snapshotConfig(): Promise<Pick<ConfigSnapshot, 'document' | 'digest'>>;
  rowsArePrivate(context: C): Promise<boolean>;
  configDocuments(): ConfigDocumentPort;
  selectedTarget(context: C): string | null;
  resolveTarget(context: C, canonicalProject?: true): Promise<{ project: string; workTarget: string; id: string | null }>;
  targetIdentity(path: string): Promise<{ isDirectory: boolean; device: string; inode: string }>;
  readonly platform: string;
  lockPartition<T>(context: C, partition: string, work: () => Promise<T>): Promise<T>;
  withAudit<T>(context: C, work: (audit: AuditApplication) => Promise<T>, createKey?: boolean, access?: ScopeAccess): Promise<T>;
  lockPolicy<T>(context: C, work: () => Promise<T>): Promise<T>;
  withApprovals<T>(context: C, createKey: boolean, work: (store: ApprovalStore, integrity: IntegrityAuthority) => T | Promise<T>): Promise<T>;
  witness(operation: string): Promise<void>;
  decideApproval(input: ApprovalCommand): Promise<unknown>;
  readonly secrets: PackageSecretPort;
  prepare(context: C, scopeId: string, pinnedCommit?: string, known?: PackageKnownSecrets): Promise<PreparedPackageInput>;
  verifyObject(context: C, reference: NativeNodeDependencyReference, known: PackageKnownSecrets): Promise<() => Promise<void>>;
}

export type NativePackageProfile = Readonly<{
  dependencies?: NativeNodeDependencyParameters;
  bind(reference: NativeNodeDependencyReference): ExecutionProfileDefinition;
}>;
export type NativePackageProfileSelector = (profile: ExecutionProfileDefinition) => NativePackageProfile | null;
export interface PackageRunReader {
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
  loadBoundDispatch(identity: AttemptIdentity): Promise<{ request: { workspace: string } } | null>;
  close(): void;
}
