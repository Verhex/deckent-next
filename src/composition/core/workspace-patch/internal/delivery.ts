import { resolve } from 'node:path';
import { SystemTrustedClock, ErrorRegistry, getConfigKnownSecrets, inspectProductDirectory, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { GitIntegrationTarget, GitIntegrationDelivery, LocalOsSessionAuthority, openSqliteAttemptStore, resolveGitWorkTarget, validateDockerSupervisorProfile, attestLocalInteractiveTerminal, localPrincipalChannel } from '#adapters/index.js';
import { assertAuthorityWitness, deliveryDismissalEvent, dismissedDeliveries, WorkspacePatchApplication, WorkspaceIntegrationInspection, WorkspaceDeliveryApplication, integrationDeliveryCommandSchema, type IntegrationDeliveryCommand, type EffectConfirmation } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import { workspacePatchContext } from './configured.js';
/** BeUser D-03: a candidate `execution.workTargets` gets the work path's own typed refusal before `/config` writes it. */
export async function checkConfiguredWorkTarget(root: string, workTargets: unknown, options: ConfigLoadOptions): Promise<void> { const config = await loadConfig(root, { ...options, heal: false });
  if (!config.execution) throw ErrorRegistry.createError('WORK_TARGET_EXECUTION_MISSING');
  await resolveGitWorkTarget(resolve(root), { ...config.execution, workTargets } as never, config.productLayout).catch(error => { throw queryFailure(error); }); }
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
    try {
      const patches = new WorkspacePatchApplication(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes, c.scopeMode);
      const inspection = new WorkspaceIntegrationInspection(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes);
      return await new WorkspaceDeliveryApplication(patches, inspection, target, new GitIntegrationDelivery(git), store,
        sessions, c.authorization, clock, confirmation, getConfigKnownSecrets(c.config)).deliver(command);
    } finally { store.close(); }
  } catch (error) { throw queryFailure(error); }
}
export const deliverConfiguredWorkspaceIntegration = (root: string, input: IntegrationDeliveryCommand, options: ConfigLoadOptions = {}) => deliverWorkspaceIntegrationWithConfirmation(root, input, options);
