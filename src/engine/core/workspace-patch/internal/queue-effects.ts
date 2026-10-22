import type { TrustedClock, KnownSecretSnapshot } from '#platform/index.js';
import { TargetQueueError, type TargetQueueRecord, type TargetBinding, type CandidateEvidence, type VerifiedPrincipal } from '#domain/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import { criterionWithin } from '#capabilities/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import type { SessionVerifier, SessionAuthority } from '#engine/core/authentication/index.js';
import type { TargetBatchEffects, EffectConfirmation, TargetBatch } from '#engine/core/effect/index.js';
import { RunPolicyAuthorization } from '#engine/core/policy/index.js';
import type { RunWorkspaceProvider } from '#engine/core/workspaces/index.js';
import { WorkspaceDeliveryApplication, type IntegrationDeliveryStore, type IntegrationDeliveryTarget } from './delivery.js';
import { WorkspaceAdoptionApplication, adoptionNotApplied, type IntegrationAdoptionTarget, type IntegrationAdoptionStore } from './adoption.js';
import type { WorkspacePatchApplication } from './application.js';
import type { WorkspaceIntegrationInspection, IntegrationReader } from './inspection.js';
import type { IntegrationTarget } from './integration.js';
import type { AdoptionVerificationRequirement } from './verification.js';
import { readQueueCandidate, planQueueCommit } from './queue-custody.js';
import { queueCommandIds, type GitQueueFence } from './queue-git.js';
interface QueueEffectContext {
  readonly principal: VerifiedPrincipal; readonly document: unknown; readonly artifacts: ArtifactStore; readonly maxBytes: number;
  readonly registry: unknown; readonly bar: AdoptionVerificationRequirement | null; readonly allowedTargets: readonly string[];
  readonly authorization: DispatchIdentityAuthorization;
  validate(request: TargetQueueRecord['request']): Promise<void>;
}
interface QueueEffectPorts {
  readonly store: IntegrationAdoptionStore & IntegrationDeliveryStore & IntegrationReader;
  readonly patches: WorkspacePatchApplication; readonly inspection: WorkspaceIntegrationInspection; readonly candidate: IntegrationTarget;
  readonly source: Pick<RunWorkspaceProvider, 'captureSource'>; readonly clock: TrustedClock; readonly known: KnownSecretSnapshot;
  consent(operation: TargetBatch['operation']): Promise<void>; sessions(): Promise<SessionVerifier & SessionAuthority>;
  delivery(fence?: GitQueueFence): IntegrationDeliveryTarget; adoption(fence?: GitQueueFence): IntegrationAdoptionTarget;
  fence(target: TargetBinding, owner: string, epoch: number): Promise<string>; evidence(record: TargetQueueRecord): Promise<CandidateEvidence>;
}
/** Queue scheduling delegates every effect to the existing delivery/adoption owners. */
export function createWorkspaceQueueEffects(c: QueueEffectContext, ports: QueueEffectPorts): TargetBatchEffects {
  const { store, candidate: candidates, source, known, clock, consent, sessions } = ports;
  const loaded = async (record: TargetQueueRecord) => {
    const { manifest, patch } = await readQueueCandidate(record, store, c.artifacts, c.maxBytes), ids = queueCommandIds(record);
    const run = await store.loadRun(record.request.identity.scopeId, record.request.identity.runId);
    if (!run) throw new TargetQueueError('QUEUE_CORRUPT');
    const plan = await planQueueCommit(record, run, metadata => ports.delivery().plan({ schemaVersion: 1, commandId: ids.delivery, identity: record.request.identity, integrationCommandId: ids.candidate }, manifest, patch, metadata));
    if (plan.commit !== record.candidate?.candidateVersion) throw new TargetQueueError('QUEUE_CONFLICT');
    return { manifest, patch, plan, ids };
  };
  const confirmation = (record: TargetQueueRecord, operation: TargetBatch['operation']): EffectConfirmation => ({
    assertAvailable: () => consent(operation),
    async confirm(view) {
      const ids = queueCommandIds(record);
      if (view.commandId !== (operation === 'rollback' ? record.request.commandId : operation === 'publish' ? ids.delivery : ids.adoption) || view.scopeId !== record.request.identity.scopeId
        || view.operation !== (operation === 'rollback' ? 'rollback-integration' : operation === 'publish' ? 'deliver-integration' : 'adopt-integration')
        || view.from !== (operation === 'rollback' ? record.candidate?.candidateVersion : record.candidate?.effectiveVersion) || view.to !== (operation === 'rollback' ? record.candidate?.effectiveVersion : record.candidate?.candidateVersion)
        || operation !== 'publish' && view.resource !== record.request.target.target.id) throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED');
      await consent(operation); return () => consent(operation);
    },
  });
  /** The ticket's own journal intent and the target as observed now; `notApplied` per `adoptionNotApplied` from the ticket's own base. */
  const settlement = async (record: TargetQueueRecord) => {
    const rollback = record.request.operation === 'rollback', from = rollback ? record.candidate?.candidateVersion : record.candidate?.effectiveVersion;
    const found = await store.loadAdoption(record.request.identity.scopeId, rollback ? record.request.commandId : queueCommandIds(record).adoption);
    const adoption = found && found.intent.kind === (rollback ? 'rollback' : 'adopt') ? found : null;
    const observed = await ports.adoption().observe(record.request.target.target.id);
    // The ticket's target binding is revalidated before every adoption it makes, so it names the repository its intent was claimed in.
    return { adoption, observed,
      notApplied: (found === null || adoption !== null) && from !== undefined && adoptionNotApplied(observed, adoption, from, record.request.target.resourceBinding) };
  };
  return {
    async fence(target, owner, epoch) { return ports.fence(target, owner, epoch); },
    async validate(record, item) {
      await c.validate(record.request);
      if (record.request.operation !== 'rollback' && (await ports.evidence(record)).phase !== 'accepted') throw new TargetQueueError('QUEUE_CONFLICT');
      if (record.request.operation !== 'rollback') await c.authorization.authorizeIdentity('deliver-integration', record.request.identity, c.principal);
      await c.authorization.authorizeIdentity(record.request.operation === 'rollback' ? 'rollback-integration' : 'adopt-integration', record.request.identity, c.principal);
      const observed = await ports.adoption().observe(record.request.target.target.id);
      if (observed.tip !== item.from) throw new TargetQueueError('QUEUE_CONFLICT');
      // The repository's fence must agree with this repository's journal before anything is published (BENIMSEME-DEPO-KIMLIGI).
      await store.assertAdoptionFence(record.request.target.target.id, observed);
    },
    async publish(record, fence) {
      const { manifest, patch, plan, ids } = await loaded(record), git = ports.delivery(JSON.parse(fence) as GitQueueFence);
      const { patches, inspection } = ports;
      // The queue has pinned the effective parent; a prospective parent's live observation digest necessarily changes after its predecessor adopts.
      const pinned = { prepare: candidates.prepare.bind(candidates), verify: candidates.verify.bind(candidates), async observe() {
        const current = await candidates.observe(patch);
        if (current.head !== record.candidate!.effectiveVersion) throw new TargetQueueError('QUEUE_CONFLICT');
        return { ...current, digest: manifest.observation };
      } };
      await new WorkspaceDeliveryApplication(patches, inspection, pinned, { plan: async () => plan, delivered: git.delivered.bind(git), publish: git.publish.bind(git) },
        store, await sessions(), c.authorization, clock, confirmation(record, 'publish'), known)
        .deliver({ schemaVersion: 1, identity: record.request.identity, commandId: ids.delivery, integrationCommandId: ids.candidate });
      return { state: 'settled', evidenceRefs: [record.candidate!.custodyReceipt] };
    },
    async adopt(record, fence) {
      const ids = queueCommandIds(record), run = await store.loadRun(record.request.identity.scopeId, ids.verificationRun), kind = run?.graph.tasks[0]?.kind;
      if (!kind) throw new TargetQueueError('QUEUE_CONFLICT');
      const runs = new RunPolicyAuthorization({ async load() { return c.document; } });
      await new WorkspaceAdoptionApplication(store, ports.delivery(), ports.adoption(JSON.parse(fence) as GitQueueFence),
        c.allowedTargets, await sessions(), c.authorization, clock, { registry: c.registry,
          requirement: c.bar, criterionWithin, source,
          authorizeRun: (scopeId, runId, principal) => runs.authorize('inspect', { scopeId, runId }, principal) }, confirmation(record, 'adopt'), known)
        .adopt({ schemaVersion: 2, identity: record.request.identity, commandId: ids.adoption, deliveryCommandId: ids.delivery,
          targetRef: record.request.target.target.id, verificationRunId: ids.verificationRun, verificationKind: kind });
      const receipt = await c.artifacts.put(record.request.identity.scopeId, Buffer.from(JSON.stringify(await store.loadAdoption(record.request.identity.scopeId, ids.adoption))));
      return { state: 'settled', evidenceRefs: [receipt.digest] };
    },
    async compensate(record, fence) {
      const adopted = record.effectCommandIds[2]; if (!adopted) throw new TargetQueueError('QUEUE_CORRUPT');
      const runs = new RunPolicyAuthorization({ async load() { return c.document; } });
      const result = await new WorkspaceAdoptionApplication(store, ports.delivery(), ports.adoption(JSON.parse(fence) as GitQueueFence), c.allowedTargets,
        await sessions(), c.authorization, clock, { registry: c.registry, requirement: c.bar, criterionWithin, source,
          authorizeRun: (scopeId, runId, principal) => runs.authorize('inspect', { scopeId, runId }, principal) }, confirmation(record, 'rollback'), known)
        .rollback({ schemaVersion: 1, commandId: record.request.commandId, identity: record.request.identity, adoptionCommandId: adopted });
      const receipt = await c.artifacts.put(record.request.identity.scopeId, Buffer.from(JSON.stringify(result)));
      return { state: 'settled', evidenceRefs: [receipt.digest] };
    },
    async lookup(record) {
      const ids = queueCommandIds(record), { adoption, observed, notApplied } = await settlement(record);
      if (notApplied) return { state: 'not-applied' };
      if (!adoption) return { state: 'unknown' };
      if (observed.tip !== adoption.intent.toCommit || observed.fence?.commandId !== (record.request.operation === 'rollback' ? record.request.commandId : ids.adoption) || observed.fence.scopeId !== record.request.identity.scopeId
        || observed.fence.sequence !== adoption.sequence || adoption.intent.toCommit !== (record.request.operation === 'rollback' ? record.candidate?.effectiveVersion : record.candidate?.candidateVersion)) return { state: 'unknown' };
      const settled = await store.finishAdoption(adoption.intent);
      const receipt = await c.artifacts.put(record.request.identity.scopeId, Buffer.from(JSON.stringify(settled)));
      return { state: 'settled', evidenceRefs: [receipt.digest] };
    },
    async release(record) {
      const { adoption, observed, notApplied } = await settlement(record);
      if (!notApplied) return { state: 'unknown' };
      const released = adoption && !adoption.released ? await store.releaseAdoption(adoption.intent) : adoption;
      const receipt = await c.artifacts.put(record.request.identity.scopeId, Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'adoption-not-applied',
        commandId: record.request.commandId, adoption: released, observed: { tip: observed.tip, fence: observed.fence, repository: observed.repository } })));
      return { state: 'refused', evidenceRefs: [receipt.digest] };
    },
  };
}
