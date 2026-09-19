import { userInfo } from 'node:os';
import { inspectProductFile, type ResolvedConfig } from '#platform/index.js';
import { LocalPeerShutdownAuthentication, openSqliteAttemptStore, readLocalOsIdentity, type LocalPeerIdentity } from '#adapters/index.js';
import { policySchema } from '#domain/index.js';
import { ServiceShutdownApplication, ServicePolicyAuthorization, ServiceShutdownError, PolicyAuthorizationError, resolvePolicyScopeMembership,
  type ServiceInstance, type ShutdownAdmission, type RuntimeServiceDrainResult } from '#engine/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

/** Hosting composition pins installation/storage identity; the policy source is read afresh on every admission. */
export function configuredServiceShutdown(config: ResolvedConfig, instance: ServiceInstance) {
  const source = createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes);
  const openStore = async () => openSqliteAttemptStore(
    await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite, 'forbid');
  return Object.freeze({
    async admit(input: unknown, peer: LocalPeerIdentity) {
      let document;
      try { document = policySchema.parse(await source.load()); }
      catch { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }
      const scopes = resolvePolicyScopeMembership(document, readLocalOsIdentity(), [instance.scopeId]);
      if (!scopes.length) throw new PolicyAuthorizationError('POLICY_DENIED');
      const authentication = new LocalPeerShutdownAuthentication(peer, scopes);
      return new ServiceShutdownApplication(instance, authentication, new ServicePolicyAuthorization(source), openStore, Date.now)
        .admit(input, undefined);
    },
    async recordOutcome(admission: ShutdownAdmission, result: RuntimeServiceDrainResult) {
      try {
        const store = await openStore();
        try { return await store.retainServiceShutdownOutcome({ schemaVersion: 1, scopeId: admission.scopeId,
          serviceId: admission.command.serviceId, instanceId: admission.command.instanceId, commandId: admission.command.commandId,
          ...result, observedAtMs: Date.now() }); }
        finally { store.close(); }
      } catch (error) {
        if (error instanceof ServiceShutdownError) throw error;
        throw new ServiceShutdownError('SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE');
      }
    },
  });
}
