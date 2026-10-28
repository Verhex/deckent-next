import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { policySchema } from '#domain/index.js';
import { UninstallRecovery, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, readLocalOsIdentity, readTerminalConfig, FileInstallationIdentityStore, openLocalIntegrityAuthority,
  uninstallRecoveryDirectory, readUninstallTombstone, completedUninstallPreview, resumeUninstallFinalTail, observeUninstallInventory, nativeServiceExec, nativeUserUnitLinks, acquireLedgerLock, type LedgerLock, selectWorkTarget, resolveGitWorkTarget, querySystemdMainPid, installationScopes, completeUninstall } from '#adapters/index.js';
import { UninstallApplication, uninstallApplySchema, authorizeUninstall, authorizeUninstallSteps, uninstallAffectedScopes, uninstallManagedScopes, uninstallLauncherResource, DispatchPolicyAuthorization, workTargetAttemptAuthorization, resolvePolicyScopeMembership, type UninstallInteraction } from '#engine/index.js';
import { ErrorRegistry, automationMarker, productResourcePath, handMadeLaunchers, detectServiceManager, observeUserUnit, disableUserUnit, SERVICE_MANAGER_QUERY_BOUNDS, prepareProductCompanionPath, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createConfiguredRuntimeClient, withQueueContext, assertQueueWorkTarget } from '#composition/core/runtime-service/index.js';
import { requestConfiguredRunCancellation } from '#composition/core/runs/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { withUninstallAdmission } from './uninstall-admission.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
const load = (root: string, options: ConfigLoadOptions) => loadComposedConfig(root, { ...options, heal: false, secretResolver: async () => undefined, uninstallHold: 'admit' });
const marked = (env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>, names: readonly string[]) => automationMarker(process.env, names) ?? automationMarker(env, names);
/** Trusted local composition: read-only previews and witnessed application admission use the same owned inventory. */
async function configuredUninstall(root: string, options: ConfigLoadOptions) {
  const config = await load(root, options), layout = config.productLayout, terminal = readTerminalConfig(config as Record<string, unknown>), scopeId = terminal.scopeId, env = options.env ?? process.env;
  if (!scopeId) throw ErrorRegistry.createError('CLI_SCOPE_REQUIRED');
  const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes), client = createConfiguredRuntimeClient(root, options);
  const scopes = (document: unknown) => uninstallAffectedScopes(document, [scopeId,
    ...(config.service.identity ? [config.service.identity.scopeId] : []), ...(config.cancellationRuntime?.scopeIds ?? []), ...(config.reconciliationRuntime?.scopeIds ?? [])]);
  const installationId = async () => { const identity = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
    if (identity.status !== 'available') throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE'); return identity.value.installationId; };
  const person = async () => ({ ...readLocalOsIdentity(), scopeIds: scopes(await source.load()) }), exec = nativeServiceExec(config.installation.identityProbe, env);
  const links = nativeUserUnitLinks(config.installation.identityProbe, env);
  let stoppedLock: LedgerLock | undefined;
  return new UninstallApplication({
    channel: localPrincipalChannel(), witness: { attest: async () => { const peer = localPrincipalPeer(); return !marked(env, config.cli.agentEnvironment) && attestLocalInteractiveTerminal(peer?.pid, peer?.uid); } }, principal: person,
    // M14, R8: every tier's own decision covers every ledger-recorded scope too (as again under custody), before any card.
    async authorize(action, principal) { const document = policySchema.parse(await source.load()), affected = action === 'inspect' ? scopes(document)
      : installationScopes(productResourcePath(layout, 'ledger'), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs, maxScopes: config.audit.maxRecords }, scopes(document));
      authorizeUninstall(document, { ...principal, scopeIds: affected }, await installationId(), affected, action); },
    async inventory() { const document = policySchema.parse(await source.load()), inventory = (await observeUninstallInventory(config, document.revision, scopes(document), options)).inventory;
      // R13: each unknown result's own (ledger-recorded) scope is checked against company control too.
      return { ...inventory, managedScopes: uninstallManagedScopes(document, [...scopes(document), ...inventory.work.uncertain.map(item => item.scopeId)]), resources: [...inventory.resources, ...handMadeLaunchers(root, env).map(uninstallLauncherResource)] };
    },
    async retainedPlan(digest) { return new UninstallRecovery(layout.root, await installationId(), await person(), await openLocalIntegrityAuthority(layout, config.approvals.keyFile),
      config.installation.profileMaxBytes, uninstallRecoveryDirectory(config, env)).retained(digest); },
    async withAdmission(plan, approved, work) { const principal = await person(); return withUninstallAdmission(config, plan, approved, principal, scopeId, principal.scopeIds, options, work, stoppedLock); },
    // K3: the person's own authority through the existing owners; a cancellation is a durable intent, a rejection the person's decision.
    force: { cancelRun: async ref => { await requestConfiguredRunCancellation(root, { schemaVersion: 1, scopeId: ref.scopeId, runId: ref.id, commandId: randomUUID(), action: 'cancel', expectedRevision: ref.revision }, options); },
      rejectApproval: async ref => { await configuredApproval(root, 'decide', { schemaVersion: 1, scopeId: ref.scopeId, approvalId: ref.id, commandId: randomUUID(), expectedRevision: ref.revision,
        decision: 'deny', reason: 'uninstall --force', channel: 'local-cli' }, options); },
      withdrawDelivery: ref => withQueueContext(root, ref.scopeId, options, undefined, false, async queue => { const record = await queue.app.inspect(ref.scopeId, ref.id, queue.principal); if (!record || record.revision !== ref.revision || record.state !== ref.state || JSON.stringify(record.request.identity) !== JSON.stringify(ref.identity)) throw ErrorRegistry.createError('UNINSTALL_PLAN_CHANGED'); await queue.app.cancel(record, queue.principal); }) },
    // F6: queue authority is decided from the owner's typed observation bound into D0; no queue context or SQLite is opened before the card.
    async preflight(plan, principal) { const document = await source.load(); await authorizeUninstallSteps(document, plan, principal, scopeId);
      if (plan.steps.withdrawDeliveries.length && !config.execution) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
      const delivery = plan.steps.withdrawDeliveries[0];
      if (delivery) try { assertQueueWorkTarget(config.execution ? selectWorkTarget(config.execution) : null, await resolveGitWorkTarget(root, config.execution, layout)); }
      catch { throw ErrorRegistry.createError('UNINSTALL_DELIVERY_TARGET_REQUIRED', { params: { delivery: delivery.id, owner: delivery.scopeId } }); }
      const authorization = workTargetAttemptAuthorization(new DispatchPolicyAuthorization(source), source, config.execution ? selectWorkTarget(config.execution)?.id ?? null : null);
      for (const ref of plan.steps.withdrawDeliveries) {
        if (!ref.identity || !ref.state || (!ref.company || ref.company === 'foreign') || ref.identity.scopeId !== ref.scopeId) throw ErrorRegistry.createError('UNINSTALL_DELIVERY_QUEUED', { params: { count: '1', list: ref.id, owner: ref.scopeId } });
        try { await resolvePolicyScopeMembership(document, principal, [ref.scopeId], config.company.id, {
          pinnedCompanies: async () => new Map(ref.company === 'current' ? [[ref.scopeId, config.company.id]] : []), pinDeclared: async () => { throw ErrorRegistry.createError('UNINSTALL_UNSUPPORTED'); } }, 'read');
          await authorization.authorizeIdentity('read-output', ref.identity, principal);
          await authorization.authorizeIdentity('prepare-integration', ref.identity, principal);
        } catch { throw ErrorRegistry.createError('UNINSTALL_DELIVERY_QUEUED', { params: { count: '1', list: ref.id, owner: ref.scopeId } }); }
      }
    },
    // Waits are bounded by their owners' configuration: the cancellation claim lifetime, else the service lifecycle budget.
    settle: { budgetMs: config.cancellation?.claimTtlMs ?? terminal.serviceStartTimeoutMs, wait: delay },
    service: { async withStoppedCustody(confirmed, work) {
      const path = await prepareProductCompanionPath(layout, 'ledger', '-lock');
      try { stoppedLock = acquireLedgerLock(path); } catch (error) {
        if ((error as { code?: string }).code !== 'LOCAL_RUNTIME_ALREADY_RUNNING') throw error;
        throw ErrorRegistry.createError('UNINSTALL_SERVICE_RUNNING', { params: { unit: confirmed.unit ?? '', command: confirmed.command ?? '', reason: 'new-instance-holds-ledger' } });
      }
      try { return await work(); } finally { stoppedLock.release(); stoppedLock = undefined; }
    }, budgetMs: terminal.serviceStartTimeoutMs, describe: signal => client.describeService(signal),
      async unit(pid) { const found = await detectServiceManager(pid, unit => querySystemdMainPid(unit, SERVICE_MANAGER_QUERY_BOUNDS, env));
        return found && { unit: found.unit, ...await observeUserUnit(found, pid, exec, links) }; },
      async shutdown() { const live = await client.describeService(AbortSignal.timeout(terminal.serviceStartTimeoutMs));
        if (!live.identity) throw ErrorRegistry.createError('RUNTIME_SHUTDOWN_UNAVAILABLE');
        return client.shutdownService({ schemaVersion: 1, commandId: randomUUID(), serviceId: live.identity.serviceId, instanceId: live.instanceId, reason: 'uninstall' }, AbortSignal.timeout(terminal.serviceStartTimeoutMs)); },
      disable: confirmed => disableUserUnit(confirmed, exec, uninstallRecoveryDirectory(config, env), links, { async assert() { if (!stoppedLock) throw ErrorRegistry.createError('UNINSTALL_UNSUPPORTED'); } }) } });
}
async function completed(root: string, options: ConfigLoadOptions, settle = false) { // R11: an already-absent tail completes through the same owner
  const config = await load(root, options), env = options.env ?? process.env, directory = uninstallRecoveryDirectory(config, env);
  return { directory, previous: await readUninstallTombstone(directory, config.productLayout.root, { ...readLocalOsIdentity(), scopeIds: [] }, config.installation.profileMaxBytes,
    productResourcePath(config.productLayout, 'installationIdentity'), settle ? (plan, release) => completeUninstall(config, plan, env, release) : undefined) };
}
export async function previewConfiguredUninstall(root: string, query: unknown, options: ConfigLoadOptions = {}) {
  const { previous } = await completed(root, options); if (previous) return completedUninstallPreview(previous.plan, previous.remaining);
  return (await configuredUninstall(root, options)).preview(query);
}
export async function applyConfiguredUninstall(root: string, input: unknown, interaction: UninstallInteraction, options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  const { previous, directory } = await completed(root, options);
  if (!previous) return (await configuredUninstall(root, options)).apply(input, interaction, signal);
  const witnessed = async () => { const peer = localPrincipalPeer();
    if (localPrincipalChannel() || marked(options.env ?? {}, (await load(root, options)).cli.agentEnvironment) || !await attestLocalInteractiveTerminal(peer?.pid, peer?.uid)) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'uninstall' } }); };
  await witnessed();
  const plan = completedUninstallPreview(previous.plan, previous.remaining);
  const command = uninstallApplySchema.safeParse(input); if (!command.success) throw ErrorRegistry.createError('UNINSTALL_INVALID');
  if (command.data.planDigest !== plan.planDigest) throw ErrorRegistry.createError('UNINSTALL_PLAN_CHANGED');
  // The second card resumes an interrupted tail; its answer grants no authority (decided again in the owner, under custody).
  if (!previous.remaining) return { ...((await completed(root, options, true)).previous ?? previous).result, status: 'noop' as const, planDigest: plan.planDigest };
  if (!await interaction.confirm(plan)) return { ...previous.result, status: 'cancelled' as const, items: [], planDigest: plan.planDigest };
  await witnessed();
  return { ...await resumeUninstallFinalTail(await load(root, options), directory, { ...readLocalOsIdentity(), scopeIds: [] }, await interaction.backupPassphrase?.() ?? '', options.env), planDigest: plan.planDigest };
}
