import { candidateBindingSchema, type CandidateBinding, type TargetBinding } from '#domain/index.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
import type { WorkspacePatch } from './contract.js';
import { WorkspacePatchError } from './contract.js';
import type { IntegrationManifest } from './integration.js';
import type { IntegrationDeliveryPlan } from './delivery.js';

/** Maps historical Git custody into the opaque envelope without rewriting any sealed v1/v2 manifest or plan. */
export function bindIntegrationCandidate(target: TargetBinding, patch: WorkspacePatch, manifest: IntegrationManifest,
  receipt: ArtifactReceipt, plan: IntegrationDeliveryPlan, criteria: readonly string[], profileFingerprint: string): CandidateBinding {
  const base = manifest.schemaVersion === 2 ? manifest.effectiveBaseCommit : patch.baseCommit;
  if (manifest.command.identity.scopeId !== receipt.scopeId || JSON.stringify(manifest.command.identity) !== JSON.stringify(patch.identity)
    || manifest.schemaVersion === 2 && manifest.baseCommit !== patch.baseCommit
    || manifest.snapshotDigest !== plan.snapshotDigest || plan.baseCommit !== patch.baseCommit
    || (plan.schemaVersion === 2 ? plan.effectiveBaseCommit : plan.baseCommit) !== base)
    throw new WorkspacePatchError('PATCH_CONFLICT');
  return candidateBindingSchema.parse({ schemaVersion: 1, target, identity: patch.identity, sourceBinding: patch.source.sourceFingerprint,
    outputDigest: manifest.patch.digest, observedVersion: patch.baseCommit, effectiveVersion: base, candidateVersion: plan.commit,
    candidateDigest: plan.snapshotDigest, custodyReceipt: receipt.digest, criteria, profileFingerprint,
    replacesCommandId: manifest.command.replacesCommandId ?? null });
}
