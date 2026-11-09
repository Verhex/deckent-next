import { resolve } from 'node:path';
import { isCodedError, SystemTrustedClock, ErrorRegistry, getConfigKnownSecrets, inspectProductDirectory, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { GitIntegrationTarget, GitIntegrationDelivery, GitWorkingTreeDelivery, removeRunBase, GitQueueTarget, GitWorkspaceBroker, LocalOsSessionAuthority, openSqliteAttemptStore, openSqliteInventoryReader, resolveGitWorkTarget, validateExecutionSupervisorProfile, attestLocalInteractiveTerminal, localPrincipalChannel } from '#adapters/index.js';
import { assertAuthorityWitness, workingTreeDeliveryAuthorization, workingTreeSource, deliveryDismissalEvent, deliveryRollbackEvent, workingTreeRollbackCommandSchema, WorkingTreeRollbackApplication, WorkspacePatchError, type WorkingTreeRollbackCommand, dismissedDeliveries, WorkspacePatchApplication, WorkspaceIntegrationInspection, WorkspaceDeliveryApplication, integrationDeliveryCommandSchema, type IntegrationDeliveryCommand, type EffectConfirmation } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import type { AttemptIdentity } from '#domain/index.js';
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
/** L1c: a finished working-tree Run's private base goes right after a delivery when nothing else of it can still be delivered: every other accepted task with
 * work input has no retained patch (conservative: a set-aside one keeps it for its M-33 return window, an earlier delivered one until the start sweep). Best effort. */
async function releaseSettledRunBase(root: string, run: Readonly<{ scopeId: string; runId: string }>, options: ConfigLoadOptions, delivered: string) {
  try {
    const c = await loadConfiguredScopeContext(root, run.scopeId, options, 'read'), store = await openSqliteInventoryReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
    try {
      const snapshot = await store.loadRun(run.scopeId, run.runId);
      if (snapshot?.state.kind !== 'terminal' || !workingTreeSource((await store.loadRunWorkspaceCustody(run.scopeId, run.runId))?.source)) return;
      for (const task of snapshot.graph.tasks) {
        const binding = snapshot.bindings.find(row => row.identity.taskId === task.id);
        if (task.workInput && task.id !== delivered && snapshot.progress.find(row => row.taskId === task.id)?.phase === 'accepted' && (!binding || (await store.loadBoundDispatch(binding.identity))?.patch)) return;
      }
      await removeRunBase(await inspectProductDirectory(c.layout, 'workspaces'), run);
    } finally { store.close(); }
  } catch { /* kept: the start sweep tries again */ }
}
/** The scope's dismissed tasks (none without an integrity key yet: recording one creates it); any other failure is the caller's to show. `limit` bounds the records read. */
export const inspectConfiguredDismissedDeliveries = (root: string, scopeId: string, limit: number, options: ConfigLoadOptions) => loadConfiguredScopeContext(root, scopeId, options, 'read')
  .then(c => withScopeAudit(c, audit => dismissedDeliveries(audit, scopeId, limit), false, 'read')).catch((error: unknown) => { if (isCodedError(error, 'INTEGRITY_KEY_UNAVAILABLE')) return [] as ReturnType<typeof dismissedDeliveries>; throw queryFailure(error); });
/** Local SDK/CLI producer; paths, principal, session and Git options never come from the wire. */
type DeliveryApplications = Readonly<{ deliver: () => WorkspaceDeliveryApplication; rollback: () => WorkingTreeRollbackApplication }>;
async function withDelivery<T>(root: string, identity: AttemptIdentity, options: ConfigLoadOptions, confirmation: EffectConfirmation | undefined, use: (applications: DeliveryApplications) => Promise<T>) {
  const c = await workspacePatchContext(root, identity, options, false, 'write');
  await c.authorization.authorizeIdentity('deliver-integration', identity, c.principal);
  if (!c.config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
  const git = { ...c.config.execution.git, ...(await resolveGitWorkTarget(resolve(root), c.config.execution, c.layout)).git, workspaceRoot: await inspectProductDirectory(c.layout, 'workspaces') };
  const limits = { ...c.config.artifacts.patchPreview, maxBytes: c.config.artifacts.maxBytes }, target = new GitIntegrationTarget(git, limits);
  const clock = new SystemTrustedClock();
  const sessions = await LocalOsSessionAuthority.create(c.principal.scopeIds, c.config.approvals.sessionTtlMs, clock);
  const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, { now: Date.now, timeoutMs: c.config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateExecutionSupervisorProfile });
  try { await c.sameWorkSource(store);
    const patches = new WorkspacePatchApplication(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes, c.scopeMode);
    const inspection = new WorkspaceIntegrationInspection(store, c.artifacts, c.verifier, c.authorization, c.config.artifacts.maxBytes);
    // Mode pinning (R9n): the Run's custody, not today's config, decides whether the yes writes the files (a company deny closes that path).
    const files = workingTreeSource((await store.loadRunWorkspaceCustody(identity.scopeId, identity.runId))?.source);
    const authorization = files ? workingTreeDeliveryAuthorization(c.authorization, c.policy) : c.authorization, known = getConfigKnownSecrets(c.config), writer = new GitWorkingTreeDelivery(git, limits);
    return await use({ deliver: () => new WorkspaceDeliveryApplication(patches, inspection, target, files ? writer : new GitIntegrationDelivery(git), store, sessions, authorization, clock, confirmation, known),
      rollback: () => { if (!files) throw new WorkspacePatchError('PATCH_WORKING_TREE_NOT_WRITTEN'); return new WorkingTreeRollbackApplication(patches, writer, store, sessions, authorization, clock, confirmation, known); } });
  } finally { store.close(); }
}
export async function deliverWorkspaceIntegrationWithConfirmation(root: string, input: IntegrationDeliveryCommand, options: ConfigLoadOptions, confirmation?: EffectConfirmation) {
  try { const command = integrationDeliveryCommandSchema.parse(input), result = await withDelivery(root, command.identity, options, confirmation, applications => applications.deliver().deliver(command));
    if (result.status === 'working-tree-delivered') await releaseSettledRunBase(root, command.identity, options, command.identity.taskId);
    return result; }
  catch (error) { throw queryFailure(error); }
}
/** L1c: put back the files a working-tree delivery wrote (same authority and card as that delivery); the result is sealed in the scope's audit. */
export async function rollbackWorkingTreeDeliveryWithConfirmation(root: string, input: WorkingTreeRollbackCommand, options: ConfigLoadOptions, confirmation?: EffectConfirmation) {
  try {
    const command = workingTreeRollbackCommandSchema.parse(input), result = await withDelivery(root, command.identity, options, confirmation, applications => applications.rollback().rollback(command));
    const c = await loadConfiguredScopeContext(root, command.identity.scopeId, options, 'write');
    await withScopeAudit(c, audit => audit.record(deliveryRollbackEvent({ scopeId: command.identity.scopeId, principal: c.principal, policyRevision: c.document.revision, atMs: Date.now(),
      identity: command.identity, deliveryCommandId: command.deliveryCommandId, commandId: command.commandId, paths: result.paths.length })));
    return result;
  } catch (error) { throw queryFailure(error); }
}
export const deliverConfiguredWorkspaceIntegration = (root: string, input: IntegrationDeliveryCommand, options: ConfigLoadOptions = {}) => deliverWorkspaceIntegrationWithConfirmation(root, input, options);
