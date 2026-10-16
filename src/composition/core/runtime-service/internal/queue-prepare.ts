import { WorkspacePatchApplication, createWorkspaceQueuePreparation } from '#engine/index.js';
import { GitIntegrationTarget, GitIntegrationDelivery, GitRunWorkspaceProvider, GitWorkspaceBroker, gitQueueCandidateSource } from '#adapters/index.js';
import { withConfiguredRunAdmission } from '#composition/core/runs/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { QueueContext } from './queue-context.js';
export async function queuePreparation(root: string, c: QueueContext, options: ConfigLoadOptions) {
  const store = await c.openAttempts(), verifier = { async verify() { return c.principal; } };
  const patches = new WorkspacePatchApplication(store, c.artifacts, verifier, c.authorization, c.config.artifacts.maxBytes, c.scopeMode);
  return createWorkspaceQueuePreparation({ ...c, registry: c.config.admission?.registry ?? null, bar: c.config.execution!.adoption.verification, maxBytes: c.config.artifacts.maxBytes }, store, patches, {
    delivery: new GitIntegrationDelivery(c.git), withAdmission: work => withConfiguredRunAdmission(root, c, options, work),
    async target(previous) {
      const source = previous ? await gitQueueCandidateSource(previous, store, c.artifacts, c.git, c.limits) : undefined;
      return new GitIntegrationTarget(c.git, c.limits, source ? { commit: source.baseCommit, repository: source.repositoryRoot } : undefined);
    },
    async provider(record) {
      const source = await gitQueueCandidateSource(record, store, c.artifacts, c.git, c.limits), provider = new GitRunWorkspaceProvider(new GitWorkspaceBroker(c.git, source));
      return { capture: () => provider.captureSource(record.candidate!.candidateVersion) };
    },
  });
}
