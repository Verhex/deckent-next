import type { ArtifactStore } from '#capabilities/index.js';
import { instructionSurfacePaths, type TargetQueueRecord } from '#domain/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import { autonomyShadowRecord, readSystemDeliverySummary, type AutonomyShadowStore, type DeliverySummaryPorts } from '#engine/core/delivery-summary/index.js';
import type { IntegrationReader } from './inspection.js';
import { readQueueCandidate } from './queue-custody.js';
import { queueCommandIds } from './queue-git.js';
import { classifyPatchScope, type PatchScopeMode } from './scope.js';
import { workspacePatchChangeFacts } from './effect-summary.js';

export interface WorkspaceQueueShadowPorts {
  readonly shadow: AutonomyShadowStore; readonly artifacts: ArtifactStore; readonly maxBytes: number; readonly scopeMode: PatchScopeMode;
  readonly known?: KnownSecretSnapshot; now(): number;
}
/**
 * The workspace target's fill of the OTONOM-TESLIM shadow (alpha.53 B1): actor `system`, reads only the service's own stores (the ticket's
 * retained candidate patch, its Run, verification Run, worker report and model evidence), never a principal grant, then records the
 * `autonomy@1` advice once per ticket revision. The driver calls it right after `evidence()` re-validated the ticket's target binding, which
 * refuses every protected target (QUEUE_AUTHORITY_REQUIRED); the target is therefore recorded as not protected. Rollbacks are never evaluated.
 */
export function workspaceQueueShadow(store: IntegrationReader & DeliverySummaryPorts['store'], ports: WorkspaceQueueShadowPorts) {
  return async (record: TargetQueueRecord): Promise<void> => {
    if (record.request.operation === 'rollback' || record.state !== 'awaiting-confirmation') return;
    const identity = record.request.identity, run = await store.loadRun(identity.scopeId, identity.runId);
    const { patch } = await readQueueCandidate(record, store, ports.artifacts, ports.maxBytes);
    const declared = run?.graph.tasks.find(task => task.id === identity.taskId)?.workInput?.scope.paths ?? null;
    const surface = instructionSurfacePaths(run?.execution.tasks.find(task => task.taskId === identity.taskId)?.profile.parameters);
    const summary = await readSystemDeliverySummary({ identity, operation: 'deliver', target: { id: record.request.target.target.id, protected: false },
      verificationRunId: queueCommandIds(record).verificationRun, change: workspacePatchChangeFacts(patch, classifyPatchScope(patch, declared, ports.scopeMode, surface)) },
    { store, artifacts: ports.artifacts, ...(ports.known ? { known: ports.known } : {}) });
    if (!summary) throw new Error('AUTONOMY_SHADOW_RUN_MISSING'); // re-validated in this turn; a vanished Run is diagnosed, never a silent gap
    await ports.shadow.append(autonomyShadowRecord({ scopeId: identity.scopeId, commandId: record.request.commandId, revision: record.revision }, summary, ports.now()));
  };
}
