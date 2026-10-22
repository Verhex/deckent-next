import { criterionWithin } from '#capabilities/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import { candidateEvidenceSchema, CandidateBindingError, type TargetQueueRecord, type VerifiedPrincipal } from '#domain/index.js';
import { PrivateCandidateRunAdmission, type PrivateCandidateWorkspace, type RunAdmissionApplication, type RunStore } from '#engine/core/runs/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import type { TargetQueuePreparation, TargetQueueStore } from '#engine/core/effect/index.js';
import { WorkspacePatchApplication } from './application.js';
import { WorkspaceIntegrationApplication, type IntegrationStore, type IntegrationTarget } from './integration.js';
import { queueCommandIds } from './queue-git.js';
import { queueCommitMetadata } from './queue-custody.js';
import { bindIntegrationCandidate } from './candidate-binding.js';
import { queueVerificationGraph, assertQueueVerification } from './queue-verification.js';
import type { AdoptionVerificationStore, AdoptionVerificationRequirement } from './verification.js';
import type { IntegrationDeliveryTarget } from './delivery.js';
import { createHash } from 'node:crypto';
const queueDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface QueuePreparationContext {
  readonly bounds: { readonly revalidations: number }; readonly registry: unknown; readonly bar: AdoptionVerificationRequirement | null; readonly maxBytes: number; readonly principal: VerifiedPrincipal;
  readonly artifacts: ArtifactStore; readonly authorization: DispatchIdentityAuthorization; readonly queue: TargetQueueStore;
  validate(request: TargetQueueRecord['request']): Promise<void>;
}
interface QueuePreparationPorts {
  target(previous: TargetQueueRecord | null): Promise<IntegrationTarget>;
  readonly delivery: IntegrationDeliveryTarget;
  provider(record: TargetQueueRecord): Promise<PrivateCandidateWorkspace>;
  withAdmission<T>(work: (app: RunAdmissionApplication) => Promise<T>): Promise<T>;
  /** OTONOM-TESLIM shadow writer (workspaceQueueShadow); absent = no shadow evaluation. */
  shadow?(record: TargetQueueRecord): Promise<void>;
}
export function createWorkspaceQueuePreparation(c: QueuePreparationContext, store: IntegrationStore & Pick<RunStore, 'loadRun'> & AdoptionVerificationStore,
  patches: WorkspacePatchApplication, ports: QueuePreparationPorts): TargetQueuePreparation {
  const verifier = { async verify() { return c.principal; } };
  const expected = async (record: TargetQueueRecord) => {
    const original = await store.loadRun(record.request.identity.scopeId, record.request.identity.runId);
    if (!original || !c.registry) throw new CandidateBindingError('CANDIDATE_MISMATCH');
    return { original, ...queueVerificationGraph(record, original, c.registry, c.bar) };
  };
  return {
    ...(ports.shadow ? { shadow: ports.shadow } : {}),
    effectIds(record) { return Object.values(queueCommandIds(record)); },
    async prepare(record, predecessor) {
      await c.validate(record.request);
      const target = await ports.target(predecessor);
      const integrations = new WorkspaceIntegrationApplication(patches, target, verifier, c.authorization, c.artifacts, c.maxBytes);
      const checked = await integrations.check(record.request.identity), ids = queueCommandIds(record), proof = await expected(record);
      const preview = await patches.preview(record.request.identity);
      if (checked.observation.head !== preview.patch.baseCommit && c.bounds.revalidations === 0) throw new CandidateBindingError('CANDIDATE_MISMATCH');
      const prepared = await integrations.prepare({ schemaVersion: 1, identity: record.request.identity, commandId: ids.candidate, proposal: checked.proposal, ...(record.request.replacesCommandId ? { replacesCommandId: record.request.replacesCommandId } : {}) }, store);
      const plan = await ports.delivery.plan({ schemaVersion: 1, commandId: ids.delivery, identity: record.request.identity, integrationCommandId: ids.candidate },
        prepared.manifest, (await patches.preview(record.request.identity)).patch, queueCommitMetadata(record, proof.original));
      return bindIntegrationCandidate(record.request.target, (await patches.preview(record.request.identity)).patch, prepared.manifest, prepared.receipt, plan, proof.criteria, proof.profileFingerprint);
    },
    async admitVerification(record) {
      const proof = await expected(record), ids = queueCommandIds(record), candidate = record.candidate!;
      if (proof.profileFingerprint !== candidate.profileFingerprint || JSON.stringify(proof.criteria) !== JSON.stringify(candidate.criteria)) throw new CandidateBindingError('CANDIDATE_MISMATCH');
      const provider = await ports.provider(record);
      await ports.withAdmission(app => new PrivateCandidateRunAdmission(app,
        { async loadCandidate(scopeId, commandId) { const current = c.queue.load(scopeId, commandId); return current?.state === 'verifying' ? current.candidate : null; } },
        provider, { async assert(value, admission) {
          if (queueDigest(value) !== queueDigest(candidate) || JSON.stringify(admission.graph) !== JSON.stringify(proof.graph)) throw new CandidateBindingError('CANDIDATE_MISMATCH');
        } }, identity => c.authorization.authorizeIdentity('read-output', identity, c.principal))
        .create({ schemaVersion: 1, scopeId: record.request.identity.scopeId, runId: ids.verificationRun, commandId: ids.verificationCreate, graph: proof.graph }, record.request.commandId));
    },
    async evidence(record) {
      await c.validate(record.request);
      const proof = await expected(record), ids = queueCommandIds(record), run = await store.loadRun(record.request.identity.scopeId, ids.verificationRun), candidate = record.candidate!;
      let phase: 'accepted' | 'failed' | 'pending' | 'cancelled' | 'unknown' = 'unknown';
      if (run) {
        const observed = assertQueueVerification(candidate, proof, run, await store.loadRunWorkspaceCustody(record.request.identity.scopeId, ids.verificationRun), c.bar, criterionWithin);
        phase = observed === 'accepted' ? 'accepted' : observed === 'failed' ? 'failed' : observed === 'cancelled' ? 'cancelled' : observed === 'reconciling' ? 'unknown' : 'pending';
      }
      const receipt = await c.artifacts.put(record.request.identity.scopeId, Buffer.from(JSON.stringify({ schemaVersion: 1, run, candidateDigest: candidate.candidateDigest })));
      return candidateEvidenceSchema.parse({ schemaVersion: 1, candidateDigest: candidate.candidateDigest, custodyReceipt: candidate.custodyReceipt,
        sourceBinding: candidate.sourceBinding, candidateVersion: candidate.candidateVersion, profileFingerprint: candidate.profileFingerprint,
        criteria: candidate.criteria, identity: candidate.identity, evidenceReceipt: receipt.digest, phase });
    },
  };
}
