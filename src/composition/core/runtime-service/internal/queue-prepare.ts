import { WorkspacePatchApplication, createWorkspaceQueuePreparation, stepWorkspaceQueueReattempt, stepWorkspaceRunDelivery } from '#engine/index.js';
import { GitIntegrationTarget, GitIntegrationDelivery, GitRunWorkspaceProvider, GitWorkspaceBroker, gitQueueCandidateSource, openSqliteInventoryReader, classifyDockerTaskEffects } from '#adapters/index.js';
import type { TargetQueueRecord } from '#domain/index.js';
import { withConfiguredRunAdmission } from '#composition/core/runs/index.js';
import { prepareConfiguredWorkspacePatch } from '#composition/core/workspace-patch/index.js';
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
/** D1a/D2b: one re-attempt step as the delegating human. Only the installed Docker profile (`--network none`) is workspace-only; others never re-run. */
export async function queueReattempt(root: string, c: QueueContext, options: ConfigLoadOptions, record: TargetQueueRecord, act: boolean) {
  const reader = await openSqliteInventoryReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
  try { return await stepWorkspaceQueueReattempt(c, reader, { target: new GitIntegrationTarget(c.git, c.limits), async admit(command) { await withConfiguredRunAdmission(root, c, options, app => app.create(command)); },
    effects: classifyDockerTaskEffects,
    async preparePatch(identity) { await prepareConfiguredWorkspacePatch(root, identity, options); } }, record, act); } finally { reader.close(); }
}
/** D2b: one pass over a Run under delivery intent as its granting human; the accepted output is retained first, like the re-attempt. */
export async function queueRunDelivery(root: string, c: QueueContext, options: ConfigLoadOptions, ref: Readonly<{ scopeId: string; runId: string }>) {
  const reader = await openSqliteInventoryReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
  try { return await stepWorkspaceRunDelivery(c, reader, identity => prepareConfiguredWorkspacePatch(root, identity, options).then(() => undefined), ref); } finally { reader.close(); }
}
