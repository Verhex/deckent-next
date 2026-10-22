import { sameAttemptIdentity, CandidateBindingError, TargetQueueError, type TargetQueueRecord, type RunSnapshot } from '#domain/index.js';
import type { TargetQueueStore } from '#engine/core/effect/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import { workspacePatchSchema } from './contract.js';
import { integrationManifestSchema } from './integration.js';
import type { IntegrationReader } from './inspection.js';
import { queueCommandIds } from './queue-git.js';
import type { IntegrationCommitMetadata } from './commit-metadata.js';
/** Reuses immutable integration and patch receipts; a queue JSON path is never workspace authority. */
export async function readQueueCandidate(record: TargetQueueRecord, reader: IntegrationReader, artifacts: ArtifactStore, maxBytes: number) {
  const candidate = record.candidate, ids = queueCommandIds(record), identity = record.request.identity;
  const stored = await reader.loadIntegration({ schemaVersion: 1, identity, commandId: ids.candidate });
  if (!candidate || !stored?.manifest || stored.manifest.digest !== candidate.custodyReceipt || stored.manifest.byteLength > maxBytes
    || stored.intent.patch.byteLength > maxBytes || stored.intent.patch.digest !== record.request.outputDigest) throw new CandidateBindingError('CANDIDATE_MISMATCH');
  const manifest = integrationManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(identity.scopeId, stored.manifest))));
  const patch = workspacePatchSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(identity.scopeId, stored.intent.patch))));
  if (JSON.stringify(manifest.command) !== JSON.stringify(stored.intent.command) || manifest.observation !== stored.intent.observation
    || JSON.stringify(manifest.patch) !== JSON.stringify(stored.intent.patch) || !sameAttemptIdentity(patch.identity, identity)
    || !sameAttemptIdentity(candidate.identity, identity) || patch.source.sourceFingerprint !== candidate.sourceBinding
    || manifest.snapshotDigest !== candidate.candidateDigest || (manifest.schemaVersion === 2 ? manifest.effectiveBaseCommit : patch.baseCommit) !== candidate.effectiveVersion)
    throw new CandidateBindingError('CANDIDATE_MISMATCH');
  return { manifest, patch };
}
/** Deterministic from durable inputs only (no clock, no secret snapshot): the commit message, hence the candidate commit, is replayable.
 * The title is the Brain-authored work-input title, else the task id; the Git adapter redacts and bounds it at commit time. */
export function queueCommitMetadata(record: TargetQueueRecord, run: RunSnapshot): IntegrationCommitMetadata {
  const task = run.graph.tasks.find(row => row.id === record.request.identity.taskId), progress = run.progress.find(row => row.taskId === task?.id);
  if (!task || progress?.phase !== 'accepted' || !run.bindings.some(row => sameAttemptIdentity(row.identity, record.request.identity))) throw new CandidateBindingError('CANDIDATE_MISMATCH');
  return { title: task.workInput?.title || task.id, acceptance: { phase: progress.phase, criteria: task.acceptanceCriteria.length, runRevision: record.request.acceptedRevision,
    modelUnverified: progress.acceptedEvidence === 'model-unverified' }, deliveredAtMs: record.request.submittedAt };
}
/**
 * Plans a ticket's commit and keeps candidates bound before alpha.53 replayable: they were planned with the task id as title, so when the
 * exact candidate commit does not match the current title, the same plan is tried once with that title. Never a weaker check: the caller
 * still requires `plan.commit === candidate.candidateVersion`.
 */
export async function planQueueCommit<P extends { readonly commit: string }>(record: TargetQueueRecord, run: RunSnapshot,
  plan: (metadata: IntegrationCommitMetadata) => Promise<P>): Promise<P> {
  const metadata = queueCommitMetadata(record, run), planned = await plan(metadata), legacy = record.request.identity.taskId;
  if (!record.candidate || planned.commit === record.candidate.candidateVersion || metadata.title === legacy) return planned;
  return plan({ ...metadata, title: legacy });
}

export async function describeWorkspaceQueueCandidate(record: TargetQueueRecord, queue: TargetQueueStore, reader: IntegrationReader, artifacts: ArtifactStore, maxBytes: number) {
  const basis = record.request.operation === 'rollback' ? queue.load(record.request.identity.scopeId, record.request.sourceCommandId!) : record;
  if (!basis) throw new TargetQueueError('QUEUE_CORRUPT');
  const { patch } = await readQueueCandidate(basis, reader, artifacts, maxBytes);
  return { changes: patch.changes.map(change => change.path) };
}
