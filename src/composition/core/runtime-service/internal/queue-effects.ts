import { SystemTrustedClock, getConfigKnownSecrets } from '#platform/index.js';
import { TargetQueueError } from '#domain/index.js';
import { GitIntegrationTarget, GitIntegrationDelivery, GitIntegrationAdoption, GitWorkspaceBroker, GitRunWorkspaceProvider, LocalOsSessionAuthority, type LocalPeerIdentity } from '#adapters/index.js';
import { WorkspacePatchApplication, WorkspaceIntegrationInspection, createWorkspaceQueueEffects, targetQueueKey, type TargetBatch } from '#engine/index.js';
import { queuePreparation } from './queue-prepare.js';
import type { QueueContext } from './queue-context.js';
export async function queueEffects(c: QueueContext, peer: LocalPeerIdentity | undefined, consent: (operation: TargetBatch['operation']) => Promise<void>) {
  const store = await c.openAttempts(), verifier = { async verify() { return c.principal; } }, clock = new SystemTrustedClock();
  return createWorkspaceQueueEffects({ ...c, maxBytes: c.config.artifacts.maxBytes, registry: c.config.admission?.registry ?? null,
    bar: c.config.execution!.adoption.verification, allowedTargets: c.config.execution!.adoption.targets }, {
    store, clock, consent, known: getConfigKnownSecrets(c.config), source: new GitRunWorkspaceProvider(new GitWorkspaceBroker(c.git)),
    patches: new WorkspacePatchApplication(store, c.artifacts, verifier, c.authorization, c.config.artifacts.maxBytes, c.scopeMode),
    inspection: new WorkspaceIntegrationInspection(store, c.artifacts, verifier, c.authorization, c.config.artifacts.maxBytes), candidate: new GitIntegrationTarget(c.git, c.limits),
    delivery: fence => new GitIntegrationDelivery(c.git, fence), adoption: fence => new GitIntegrationAdoption(c.git, fence),
    fence: async (target, owner, epoch) => JSON.stringify(await c.target.fence(targetQueueKey(target), owner, epoch)),
    evidence: async record => (await queuePreparation(c.config.projectRoot, c, { heal: false })).evidence(record),
    async sessions() { if (!peer) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
      const authority = await LocalOsSessionAuthority.create(c.principal.scopeIds, c.config.approvals.sessionTtlMs, clock, peer); authority.requireInteractiveTerminal(); return authority; },
  });
}
