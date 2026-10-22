import { CandidateBindingError, type TargetQueueRecord } from '#domain/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import type { GitWorkspaceOptions } from '#adapters/core/git-workspace/index.js';
import { readQueueCandidate, queueCommandIds, planQueueCommit, type IntegrationReader, type RunStore, type PatchLimits } from '#engine/index.js';
import { GitIntegrationTarget } from './integration-target.js';
import { GitIntegrationDelivery } from './delivery.js';
/** Service-only producer for normal Run workspace allocation; the path is resolved from sealed receipts, never a wire path. */
export async function gitQueueCandidateSource(record: TargetQueueRecord, reader: IntegrationReader & Pick<RunStore, 'loadRun'>,
  artifacts: ArtifactStore, options: GitWorkspaceOptions, limits: PatchLimits) {
  const { manifest, patch } = await readQueueCandidate(record, reader, artifacts, limits.maxBytes);
  await new GitIntegrationTarget(options, limits).verify(manifest, patch);
  const run = await reader.loadRun(record.request.identity.scopeId, record.request.identity.runId);
  if (!run) throw new CandidateBindingError('CANDIDATE_MISMATCH');
  const ids = queueCommandIds(record), delivery = new GitIntegrationDelivery(options), plan = await planQueueCommit(record, run, metadata => delivery.plan({ schemaVersion: 1,
    commandId: ids.delivery, identity: record.request.identity, integrationCommandId: ids.candidate }, manifest, patch, metadata));
  if (plan.commit !== record.candidate?.candidateVersion) throw new CandidateBindingError('CANDIDATE_MISMATCH');
  return { repositoryRoot: manifest.workspace, baseCommit: plan.commit };
}
