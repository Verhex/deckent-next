import { createHash, randomUUID } from 'node:crypto';
import { UninstallRecovery, FileEffectStore, acquireLedgerLock, LocalOsSessionAuthority, openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAuditStore, openSqliteInventoryReader,
  localPrincipalPeer, attestLocalInteractiveTerminal } from '#adapters/index.js';
import { ApprovalApplication, AuditApplication, EffectApplication, OperationApprovalBroker, OperationPolicyAuthorization, uninstallOperationDescriptors,
  UninstallError, resolveAuditedApprovalAssurance, type UninstallAdmission, type UninstallPlan } from '#engine/index.js';
import { PRINCIPAL_EFFECT_PRODUCER, effectCommandSchema, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry, prepareProductCompanionPath, inspectProductFile, SystemTrustedClock, type ConfigLoadOptions, type ResolvedConfig } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { userInfo } from 'node:os';
import { configuredUninstallInventory } from './uninstall-inventory.js';

/** The runtime's existing exclusive ledger custody fences startup; a durable hold survives this process. No lock stealing or forced drain. */
export async function withUninstallAdmission<T>(config: ResolvedConfig, plan: UninstallPlan, principal: VerifiedPrincipal,
  scopeId: string, scopeIds: readonly string[], options: ConfigLoadOptions, work: (admission: UninstallAdmission) => Promise<T>): Promise<T> {
  const path = await prepareProductCompanionPath(config.productLayout, 'ledger', '-lock');
  const lock = (() => {
    try { return acquireLedgerLock(path); }
    catch (error) {
      if ((error as { code?: string }).code === 'LOCAL_RUNTIME_ALREADY_RUNNING') throw ErrorRegistry.createError('UNINSTALL_WORK_ACTIVE');
      throw error;
    }
  })();
  try {
    // Fresh identity/layout/target observations after custody and before the first journal write.
    const current = await configuredUninstallInventory(config, plan.policyRevision, scopeIds, options);
    if (current.inventory.installation.id !== plan.installation.id || current.inventory.layoutRevision !== plan.layoutRevision) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
    const integrity = await openLocalIntegrityAuthority(config.productLayout, config.approvals.keyFile);
    const recovery = new UninstallRecovery(config.productLayout.root, plan.installation.id, principal, integrity, config.installation.profileMaxBytes);
    const clock = new SystemTrustedClock(), peer = localPrincipalPeer();
    const sessions = await LocalOsSessionAuthority.create(scopeIds, config.approvals.sessionTtlMs, clock, peer ? { pid: peer.pid, uid: peer.uid } : undefined);
    sessions.requireInteractiveTerminal();
    const policy = createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes);
    const path = await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']);
    const inventory = await openSqliteInventoryReader(path, { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
    try {
      for (const scopeId of scopeIds) {
        const page = await inventory.listDispatches({ schemaVersion: 1, scopeId, after: null, limit: config.inspection.maxPageSize });
        if (page.nextAfter || page.entries.some(entry => entry.terminal === null)) throw ErrorRegistry.createError('UNINSTALL_WORK_ACTIVE');
      }
    } finally { inventory.close(); }
    const recoveryLocation = await recovery.admit(plan);
    const store = new FileEffectStore(recoveryLocation, integrity, { maxBytes: config.installation.packageMeasurement.maxFileBytes, maxRecords: config.audit.maxRecords });
    await store.initialize();
    const approvals = openSqliteApprovalStore(path, config.storage.sqlite);
    let audit: Awaited<ReturnType<typeof openSqliteAuditStore>> | undefined;
    try {
      audit = await openSqliteAuditStore(path, config.storage.sqlite, 'forbid');
      const auditApplication = new AuditApplication(audit, integrity);
      const catalog = { resolve: async (ref: { id: string; version: number }) => uninstallOperationDescriptors().find(item => item.operation.id === ref.id && item.operation.version === ref.version) ?? null };
      const broker = new OperationApprovalBroker(approvals.store, integrity, policy, clock,
        { requestTtlMs: config.approvals.requestTtlMs, defaultAdmitWithinMs: config.approvals.requestTtlMs });
      const app = new EffectApplication(catalog, { resolve: kind => kind === current.target.kind ? current.target : null }, store, broker,
        sessions, new OperationPolicyAuthorization(policy), clock, { surface: 'authority', producer: PRINCIPAL_EFFECT_PRODUCER });
      const decider = new ApprovalApplication(approvals.store, { verify: async () => principal }, sessions, policy, integrity, clock,
        'local-terminal-card', config.approvals.pageSize, undefined, { catalog, surface: 'authority' },
        { producers: resolveAuditedApprovalAssurance(config.approvals.assuranceProducers, undefined,
          { scopeId, principal, policyRevision: plan.policyRevision, atMs: clock.sample().wallMs }, event => { auditApplication.record(event); }),
          interactive: () => attestLocalInteractiveTerminal(peer?.pid, peer?.uid) });
      return await work({ scopeId, recoveryLocation,
        effects: { inspect: (scope, id) => app.inspect(scope, id),
          async execute(input) {
            const command = effectCommandSchema.parse(input);
            let outcome = await app.submit('execute', command);
            if (outcome.status === 'approval-pending') {
              // One witnessed card confirmed the whole exact plan. The broker still persists a separate exact-command decision.
              if (!plan.items.some(item => item.resourceId === command.target.id && item.action === 'remove')
                || JSON.stringify(command.input) !== JSON.stringify({ planDigest: plan.planDigest, resourceId: command.target.id })) throw new UninstallError('UNINSTALL_INVALID');
              await decider.decide({ schemaVersion: 1, commandId: randomUUID(), scopeId, approvalId: outcome.approval.approvalId,
                expectedRevision: outcome.approval.revision, decision: 'allow', reason: plan.planDigest, channel: 'local-terminal-card' });
              outcome = await app.submit('execute', command);
            }
            if (outcome.status !== 'settled') throw ErrorRegistry.createError('EFFECT_APPROVAL_REQUIRED');
            return outcome;
          } },
        async revalidate(item) {
          const fresh = await loadComposedConfig(config.projectRoot, { ...options, heal: false, force: true, uninstallHold: 'admit' });
          const document = await policy.load();
          const observed = await configuredUninstallInventory(fresh, plan.policyRevision, scopeIds, options);
          if (fresh.productLayout.revision !== plan.layoutRevision || (document as { revision: string }).revision !== plan.policyRevision
            || observed.inventory.installation.id !== plan.installation.id) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
          if (item && item.action === 'remove') {
            const record = await store.loadEffect(scopeId, commandKey(plan, item.resourceId));
            const target = observed.inventory.resources.find(value => value.resourceId === item.resourceId);
            if (!record && (!target || target.version !== item.version || target.ownershipEvidence !== item.ownershipEvidence
              || target.ownership !== 'exclusive' || target.protected || !target.capability)) throw new UninstallError('UNINSTALL_PLAN_CHANGED');
          }
        },
        async prepareBackup() {
          // B's exact owner coverage is required before any deletion. The current production owners do not export signer/secrets.
          throw new UninstallError('UNINSTALL_BACKUP_COVERAGE');
        },
        async approvePlan() { /* The immutable witnessed plan is retained; each command is decided through the broker above. */ },
        finish: result => recovery.finish(result),
      });
    } catch (error) {
      const items = await Promise.all(plan.items.map(async item => ({ resourceId: item.resourceId,
        state: (await store.loadEffect(scopeId, commandKey(plan, item.resourceId)))?.state ?? null })));
      if (items.every(item => item.state === null || item.state === 'refused')) await recovery.finish({ schemaVersion: 1, planDigest: plan.planDigest,
        status: 'cancelled', items, recoveryLocation, backup: plan.backup, packageRemoval: plan.packageRemoval });
      throw error;
    } finally { audit?.close(); approvals.close(); }
  } finally { lock.release(); }
}
const commandKey = (plan: UninstallPlan, id: string) => createHash('sha256').update(JSON.stringify([plan.installation.id, plan.planDigest, id])).digest('hex');
