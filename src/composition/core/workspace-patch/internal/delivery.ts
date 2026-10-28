import { resolve } from 'node:path';
import { SystemTrustedClock, ErrorRegistry, getConfigKnownSecrets, inspectProductDirectory, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { GitIntegrationTarget, GitIntegrationDelivery, GitQueueTarget, GitWorkspaceBroker, LocalOsSessionAuthority, openSqliteAttemptStore, openSqliteInventoryReader, resolveGitWorkTarget, validateDockerSupervisorProfile, attestLocalInteractiveTerminal, localPrincipalChannel } from '#adapters/index.js';
import { assertAuthorityWitness, deliveryDismissalEvent, dismissedDeliveries, WorkspacePatchApplication, WorkspaceIntegrationInspection, WorkspaceDeliveryApplication, integrationDeliveryCommandSchema, type IntegrationDeliveryCommand, type EffectConfirmation } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import { workspacePatchContext } from './configured.js';
/**
 * BeUser D-03: a candidate `execution.workTargets` gets the work path's own typed refusal before `/config` writes it.
 * BeUser DR2-05/06 (warnings, never blocks): a move of the work source counts the `open` results (newest, owing delivery or adoption) made
 * from the current source (their custody), and the chosen branch is judged by the delivery queue's own branch rules.
 */
export async function checkConfiguredWorkTarget(root: string, workTargets: unknown, options: ConfigLoadOptions, open: readonly Readonly<{ scopeId: string; runId: string }>[] = []) {
  const config = await loadConfig(root, { ...options, heal: false }), execution = config.execution;
  if (!execution) throw ErrorRegistry.createError('WORK_TARGET_EXECUTION_MISSING');
  const next = await resolveGitWorkTarget(resolve(root), { ...execution, workTargets } as never, config.productLayout).catch(error => { throw queryFailure(error); });
  const workspaceRoot = await inspectProductDirectory(config.productLayout, 'workspaces').catch(() => null); // none yet: no warnings
  const queueRefusal = (error: { code?: unknown; params?: Readonly<Record<string, string>> } | null) => error?.code === 'QUEUE_AUTHORITY_REQUIRED' ? error.params : undefined;
  const branch = workspaceRoot && next.id && next.git.baseRef
    ? await new GitQueueTarget({ ...execution.git, ...next.git, workspaceRoot }, next.id, next.id, [next.git.baseRef], execution.adoption.protectedTargets)
      .binding(next.git.baseRef).then(() => undefined, queueRefusal)
    : undefined;
  const now = await resolveGitWorkTarget(resolve(root), execution, config.productLayout).then(value => value.git.sourceRoot, () => null);
  let count = 0;
  if (workspaceRoot && now && next.git.sourceRoot !== now && open.length) {
    const source = (await new GitWorkspaceBroker({ ...execution.git, sourceRoot: now, workspaceRoot }).captureSourceBase()).sourceFingerprint;
    for (const scopeId of new Set(open.map(run => run.scopeId))) {
      const c = await loadConfiguredScopeContext(root, scopeId, options, 'read');
      const store = await openSqliteInventoryReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
      try {
        for (const run of open) if (run.scopeId === scopeId && (await store.loadRunWorkspaceCustody(scopeId, run.runId))?.source.sourceFingerprint === source) count++;
      } finally { store.close(); }
    }
  }
  return count || branch ? Object.freeze({ ...(count && now ? { open: count, now } : {}), ...(branch ? { branch } : {}) }) : null;
}
/** BeUser M-33 (owner 2026-10-28): a person sets a task's undelivered result aside or brings it back (terminal witness, sealed audit; patch and custody untouched). */
export async function changeConfiguredDeliveryDismissal(root: string, input: { readonly scopeId: string; readonly runId: string; readonly taskId: string; readonly attemptId: string; readonly action: 'dismiss' | 'restore' },
  options: ConfigLoadOptions) { try { await assertAuthorityWitness(`delivery-${input.action}`, localPrincipalChannel(), { attest: () => attestLocalInteractiveTerminal() });
  const c = await loadConfiguredScopeContext(root, input.scopeId, options, 'write');
  await withScopeAudit(c, audit => audit.record(deliveryDismissalEvent({ ...input, principal: c.principal, policyRevision: c.document.revision, atMs: Date.now() }))); } catch (error) { throw queryFailure(error); } }
/** The scope's dismissed tasks (none without an integrity key yet: recording one creates it); any other failure is the caller's to show. `limit` bounds the records read. */
export const inspectConfiguredDismissedDeliveries = (root: string, scopeId: string, limit: number, options: ConfigLoadOptions) => loadConfiguredScopeContext(root, scopeId, options, 'read')
  .then(c => withScopeAudit(c, audit => dismissedDeliveries(audit, scopeId, limit), false)).catch((error: unknown) => { if ((error as { code?: unknown } | null)?.code === 'INTEGRITY_KEY_UNAVAILABLE') return [] as ReturnType<typeof dismissedDeliveries>; throw queryFailure(error); });
/** Local SDK/CLI producer; paths, principal, session and Git options never come from the wire. */
export async function deliverWorkspaceIntegrationWithConfirmation(root: string, input: IntegrationDeliveryCommand, options: ConfigLoadOptions, confirmation?: EffectConfirmation) {
  try {
    const command = integrationDeliveryCommandSchema.parse(input);
    const c = await workspacePatchContext(root, command.identity, options, false, 'write');
    await c.authorization.authorizeIdentity('deliver-integration', command.identity, c.principal);
    if (!c.config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    const git = { ...c.config.execution.git, ...(await resolveGitWorkTarget(resolve(root), c.config.execution, c.layout)).git, workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') };
    const target = new GitIntegrationTarget(git, { ...c.config.artifacts.patchPreview, maxBytes: c.config.artifacts.maxBytes });
    const clock = new SystemTrustedClock();
    const sessions = await LocalOsSessionAuthority.create(c.principal.scopeIds, c.config.approvals.sessionTtlMs, clock);
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, { now: Date.now, timeoutMs: c.config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateDockerSupervisorProfile });
    try { await c.sameWorkSource(store);
      const patches = new WorkspacePatchApplication(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes, c.scopeMode);
      const inspection = new WorkspaceIntegrationInspection(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes);
      return await new WorkspaceDeliveryApplication(patches, inspection, target, new GitIntegrationDelivery(git), store,
        sessions, c.authorization, clock, confirmation, getConfigKnownSecrets(c.config)).deliver(command);
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
export const deliverConfiguredWorkspaceIntegration = (root: string, input: IntegrationDeliveryCommand, options: ConfigLoadOptions = {}) => deliverWorkspaceIntegrationWithConfirmation(root, input, options);
