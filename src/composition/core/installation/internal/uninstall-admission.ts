import { createHash } from 'node:crypto';
import { UninstallRecovery, FileEffectStore, acquireLedgerLock, LocalOsSessionAuthority, openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAuditStore,
  localPrincipalPeer, attestLocalInteractiveTerminal } from '#adapters/index.js';
import { ApprovalApplication, AuditApplication, EffectApplication, OperationApprovalBroker, OperationPolicyAuthorization, uninstallOperationDescriptors,
  UninstallError, resolveAuditedApprovalAssurance, approvedUninstallEffects, authorizeUninstall, type UninstallAdmission, type UninstallPlan } from '#engine/index.js';
import { PRINCIPAL_EFFECT_PRODUCER, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry, prepareProductCompanionPath, inspectProductFile, SystemTrustedClock, type ConfigLoadOptions, type ResolvedConfig } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { userInfo } from 'node:os';
import { uninstallRecoveryDirectory, installationScopes, prepareUninstallBackup, writeUninstallTombstone } from '#adapters/index.js';
import { observeUninstallInventory as configuredUninstallInventory } from '#adapters/index.js';

/** The runtime's existing exclusive ledger custody fences startup; a durable hold survives this process. No lock stealing or forced drain. */
export async function withUninstallAdmission<T>(config: ResolvedConfig, plan: UninstallPlan, principal: VerifiedPrincipal,
  scopeId: string, scopeIds: readonly string[], options: ConfigLoadOptions, work: (admission: UninstallAdmission) => Promise<T>): Promise<T> {
  const path = await prepareProductCompanionPath(config.productLayout, 'ledger', '-lock');
  // A running service holds this custody: it is stopped by the plan's governed step, so a holder now is a service that came back (S4b).
  const lock = (() => { try { return acquireLedgerLock(path); } catch (error) { if ((error as { code?: string }).code !== 'LOCAL_RUNTIME_ALREADY_RUNNING') throw error;
    throw ErrorRegistry.createError('UNINSTALL_SERVICE_RUNNING', { params: { unit: plan.service.unit ?? '', command: plan.service.command ?? '' } }); } })();
  try {
    // Fresh identity/layout/target observations after custody and before the first journal write.
    const current = await configuredUninstallInventory(config, plan.policyRevision, scopeIds, options), directory = uninstallRecoveryDirectory(config.productLayout.root, options.env ?? process.env);
    if (current.inventory.installation.id !== plan.installation.id || current.inventory.layoutRevision !== plan.layoutRevision || current.inventory.blockers.length
      || plan.purge && current.inventory.dataBlockers.length) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
    const integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile);
    const recovery = new UninstallRecovery(config.productLayout.root, plan.installation.id, principal, integrity, config.installation.profileMaxBytes, directory);
    const clock = new SystemTrustedClock(), peer = localPrincipalPeer();
    const sessions = await LocalOsSessionAuthority.create(scopeIds, config.approvals.sessionTtlMs, clock, peer ? { pid: peer.pid, uid: peer.uid } : undefined);
    sessions.requireInteractiveTerminal();
    const policy = createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes);
    const path = await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']);
    // Every ledger-recorded and policy-named scope is quiescent and decided again under custody: a deny or legal hold is never skipped.
    const affected = installationScopes(path, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs, maxScopes: config.audit.maxRecords }, scopeIds);
    const decided = await policy.load();
    for (const action of plan.purge ? ['uninstall', 'purge'] as const : ['uninstall'] as const) authorizeUninstall(decided, { ...principal, scopeIds: affected }, plan.installation.id, affected, action);
    const recoveryLocation = await recovery.admit(plan);
    const store = new FileEffectStore(recoveryLocation, integrity, { maxBytes: config.installation.packageMeasurement.maxFileBytes, maxRecords: config.audit.maxRecords });
    await store.initialize();
    const approvals = openSqliteApprovalStore(path, config.storage.sqlite);
    let audit: Awaited<ReturnType<typeof openSqliteAuditStore>> | undefined, authorityClosed = false;
    try {
      audit = await openSqliteAuditStore(path, config.storage.sqlite, 'forbid');
      const auditApplication = new AuditApplication(audit, integrity);
      const catalog = { resolve: async (ref: { id: string; version: number }) => uninstallOperationDescriptors().find(item => item.operation.id === ref.id && item.operation.version === ref.version) ?? null };
      const broker = new OperationApprovalBroker(approvals.store, integrity, policy, clock,
        { requestTtlMs: config.approvals.requestTtlMs, defaultAdmitWithinMs: config.approvals.requestTtlMs });
      const app = new EffectApplication(catalog, { resolve: kind => [current.target, ...current.targets].find(target => target.kind === kind) ?? null }, store, broker,
        sessions, new OperationPolicyAuthorization(policy), clock, { surface: 'authority', producer: PRINCIPAL_EFFECT_PRODUCER });
      const decider = new ApprovalApplication(approvals.store, { verify: async () => principal }, sessions, policy, integrity, clock,
        'local-terminal-card', config.approvals.pageSize, undefined, { catalog, surface: 'authority' },
        { producers: resolveAuditedApprovalAssurance(config.approvals.assuranceProducers, undefined,
          { scopeId, principal, policyRevision: plan.policyRevision, atMs: clock.sample().wallMs }, event => { auditApplication.record(event); }),
          interactive: () => attestLocalInteractiveTerminal(peer?.pid, peer?.uid) });
      let passphrase = '', backup = plan.backup;
      const close = () => { if (!authorityClosed) { audit?.close(); audit = undefined; approvals.close(); authorityClosed = true; } };
      current.dataTarget.prepare(async () => {
        close();
        const final = await prepareUninstallBackup(config, plan, scopeId, { ...principal, scopeIds: affected }, await policy.load(), integrity, current.portable, passphrase, true, options); backup = { ...plan.backup, destination: final.set }; return final.snapshot!;
      });
      return await work({ scopeId, recoveryLocation,
        effects: approvedUninstallEffects(plan, scopeId, app, decider),
        async revalidate(item) {
          const fresh = await loadComposedConfig(config.projectRoot, { ...options, heal: false, force: true, uninstallHold: 'admit' });
          const document = await policy.load();
          const observed = await configuredUninstallInventory(fresh, plan.policyRevision, scopeIds, options);
          if (fresh.productLayout.revision !== plan.layoutRevision || (document as { revision: string }).revision !== plan.policyRevision
            || observed.inventory.installation.id !== plan.installation.id || observed.inventory.blockers.length) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
          if (item && item.action === 'remove') {
            const record = await store.loadEffect(scopeId, commandKey(plan, item.resourceId));
            const target = observed.inventory.resources.find(value => value.resourceId === item.resourceId);
            if (!record && (!target || target.version !== item.version || target.ownershipEvidence !== item.ownershipEvidence
              || target.ownership !== 'exclusive' || target.protected || !target.capability)) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
          }
        },
        verifiedBackup: () => backup,
        async prepareBackup(phrase) {
          if (!phrase) throw ErrorRegistry.createError('BACKUP_PASSPHRASE_REQUIRED');
          passphrase = phrase;
          const initial = await prepareUninstallBackup(config, plan, scopeId, principal, await policy.load(), integrity, current.portable, phrase, false, options); backup = { ...plan.backup, destination: initial.set };
        },
        async approvePlan() { /* The immutable witnessed plan is retained; each command is decided through the broker above. */ },
        async finish(result) { await writeUninstallTombstone(directory, config.productLayout.root, principal, plan, result); await recovery.finish(result); passphrase = ''; },
      });
    } catch (error) {
      const items = []; // One store transaction at a time: its custody lock is exclusive even within this process.
      for (const item of plan.items) items.push({ resourceId: item.resourceId, state: (await store.loadEffect(scopeId, commandKey(plan, item.resourceId)))?.state ?? null });
      if (items.every(item => item.state === null || item.state === 'refused')) await recovery.finish({ schemaVersion: 2, planDigest: plan.planDigest,
        status: 'cancelled', items, recoveryLocation, backup: plan.backup, packageRemoval: plan.packageRemoval, uncertain: plan.work.uncertain });
      throw error;
    } finally { audit?.close(); if (!authorityClosed) approvals.close(); }
  } finally { lock.release(); }
}
const commandKey = (plan: UninstallPlan, id: string) => createHash('sha256').update(JSON.stringify([plan.installation.id, plan.planDigest, id])).digest('hex');
