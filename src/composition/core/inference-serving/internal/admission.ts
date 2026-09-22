import type { InferenceServingProfile, InferenceRole, RunSnapshot, VerifiedPrincipal } from '#domain/index.js';
import type { RunAdmissionFilter } from '#engine/index.js';
import { estimateReplicaCapacity, InferenceTokenBudget, roleContextCeiling } from '#engine/index.js';

function roleForTaskKind(kind: string): InferenceRole {
  if (kind === 'brain') return 'brain';
  if (kind === 'auditor' || kind === 'audit') return 'auditor';
  return 'worker';
}

function estimateTokens(profile: InferenceServingProfile, role: InferenceRole): number {
  return Math.min(profile.workload.avgActiveCtx, roleContextCeiling(profile, role));
}

/**
 * Per-run admission estimate only — not a cross-run endpoint reservation broker.
 * Shared replica capacity and atomic slot accounting belong in runtime (Paket B).
 */
export function createInferenceRunAdmission(profile: InferenceServingProfile): RunAdmissionFilter {
  const capacity = estimateReplicaCapacity(profile);
  return {
    async prepare(run: RunSnapshot, principal: VerifiedPrincipal, now: number) {
      void principal;
      void now;
      const budget = new InferenceTokenBudget(capacity.totalTokenBudget, role => roleContextCeiling(profile, role));
      for (const progress of run.progress) {
        if (progress.phase !== 'active' && progress.phase !== 'evaluating') continue;
        const definition = run.graph.tasks.find(task => task.id === progress.taskId);
        const role = roleForTaskKind(definition?.kind ?? 'worker');
        budget.tryReserve({ id: progress.taskId, role, estimatedTokens: estimateTokens(profile, role) });
      }
      const excluded: string[] = [];
      for (const progress of run.progress) {
        if (progress.phase !== 'pending') continue;
        const definition = run.graph.tasks.find(task => task.id === progress.taskId);
        const role = roleForTaskKind(definition?.kind ?? 'worker');
        const request = { id: `candidate:${progress.taskId}`, role, estimatedTokens: estimateTokens(profile, role) };
        if (budget.tryReserve(request) === 'wait') excluded.push(progress.taskId);
        else budget.release(request.id);
      }
      return Object.freeze(excluded);
    },
    excluded() { return Object.freeze([]); },
  };
}
