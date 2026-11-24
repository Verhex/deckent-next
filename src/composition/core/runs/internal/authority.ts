import type { ApprovalRecord } from '#domain/index.js';
import { DeckentError, ErrorRegistry, isCodedError, resolveProductLayout, uninstallHoldPath, withConfigLayersLocked, withConfigWriteLock, SystemTrustedClock, getConfigKnownSecrets, resolveLocale, type ConfigLoadOptions, type IntegrityAuthority } from '#platform/index.js';
import { FileInstallationIdentityStore, localPrincipalChannel, openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAuditStore } from '#adapters/index.js';
import { configuredProposalRegistry, createRunCreationAuthority, verifyApproval, type AuditStore, type RunCreationAuthority } from '#engine/index.js';
import { contextPolicySource, withLayoutPolicyLock } from '#composition/core/policy/index.js';
import { configuredAttachmentStore, loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;

export function runControlContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions) {
  return async (expected?: string) => {
    const changed = () => ErrorRegistry.createError('RUN_CONTROL_BINDING_CHANGED');
    const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'read', undefined,
      expected === undefined ? undefined : location => { if (expected.split(':')[0] !== location) throw changed(); })
      .catch((error: unknown) => {
        if (expected !== undefined && (isCodedError(error, 'PROJECT_ATTACHMENT_REVOKED') || isCodedError(error, 'PROJECT_ATTACHMENT_CHANGED')
          || isCodedError(error, 'PROJECT_ATTACHMENT_PERSON_MISMATCH'))) throw changed();
        throw error;
      });
    if (expected !== undefined && expected !== context.runControlBinding()) throw changed();
    return context;
  };
}

export function runControlFailure(error: unknown) {
  return localPrincipalChannel() && isCodedError(error, 'RUN_CONTROL_BINDING_CHANGED') ? ErrorRegistry.createError('POLICY_DENIED') : error;
}

/** Order the registry, bootstrap, lifecycle holds, policy and identity before write admission. */
export async function withRunControlBindingLocks<T>(context: ScopeContext, options: ConfigLoadOptions,
  work: (admitWrite: (admitted: ScopeContext) => Promise<void>) => Promise<T>, lockPolicy = false): Promise<T> {
  const { config, layout, runControlSource: source } = context;
  const projectIdentity = (projectRoot: string) => ({ layout: resolveProductLayout({ projectRoot, platform: layout.platform }), resource: 'projectIdentity' as const });
  const identities = [projectIdentity(config.projectRoot), { layout: source?.layout ?? layout, resource: 'installationIdentity' as const }];
  if (source) identities.push(projectIdentity(source.root));
  let entered = false;
  const commit = () => FileInstallationIdentityStore.holdWrites(identities, config.configFile.writeLockTimeoutMs, custody => {
    entered = true;
    return work(admitted => admitted.admitWrite(custody));
  });
  const lifecycleHolds = [...new Set([layout.root, ...(source ? [source.layout.root] : [])])].sort().map(uninstallHoldPath);
  const underLifecycleHolds = lifecycleHolds.reduceRight<() => Promise<T>>((next, path) => () =>
    withConfigWriteLock(path, next, config.configFile.writeLockTimeoutMs), () => lockPolicy ? withLayoutPolicyLock(layout, commit) : commit());
  try {
    return await configuredAttachmentStore(config, options).hold(() =>
      withConfigLayersLocked(config.projectRoot, options, underLifecycleHolds, source?.root));
  } catch (error) {
    throw entered || error instanceof DeckentError ? error : ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: error });
  }
}
/** Connections live through the Run's last in-transaction authority check; no caller-supplied keys, clocks or policies. */
/** `sealing` (S4B-5): the same audit store and integrity key, for the admission's own sealed `memory-context` events. */
export async function withRunCreationAuthority<T>(context: ScopeContext,
  work: (authority: RunCreationAuthority, sealing: { readonly audit: AuditStore; readonly integrity: IntegrityAuthority }) => Promise<T>, onRequest?: (record: ApprovalRecord) => void): Promise<T> {
  const { config, layout } = context, clock = new SystemTrustedClock();
  const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
  const path = await context.path(), audit = await openSqliteAuditStore(path, config.storage.sqlite, 'forbid');
  try {
    const journal = openSqliteApprovalStore(path, config.storage.sqlite, 'forbid', (record, kind) => { if (kind !== 'transition') onRequest?.(verifyApproval(record, integrity)); });
    try {
      return await work(createRunCreationAuthority(contextPolicySource({ layout, config }), audit, journal.store, integrity, clock, config.approvals.requestTtlMs, { locale: resolveLocale(undefined, {}, config.language), known: getConfigKnownSecrets(config), registry: configuredProposalRegistry(config.admission) }), { audit, integrity });
    } finally { journal.close(); }
  } finally { audit.close(); }
}
