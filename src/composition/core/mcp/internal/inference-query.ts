import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { buildInferenceServingPlan, estimateReplicaCapacity, InferenceTokenBudget, roleContextCeiling, selectInferenceProfile } from '#engine/index.js';

/** Read-only plan/budget for MCP. Budget is an empty estimate, not a reservation and not Run admission. */
export async function describeMcpInference(root: string, kind: 'plan' | 'budget', profileId?: string, options: ConfigLoadOptions = {}): Promise<unknown> {
  const config = await loadConfig(root, { ...options, heal: false }) as Record<string, unknown>;
  const profile = selectInferenceProfile(config, profileId);
  if (!profile) return Object.freeze({ schemaVersion: 1, configured: false });
  if (kind === 'plan') return Object.freeze({ schemaVersion: 1, configured: true, plan: buildInferenceServingPlan(profile) });
  const capacity = estimateReplicaCapacity(profile);
  const budget = new InferenceTokenBudget(capacity.totalTokenBudget, role => roleContextCeiling(profile, role));
  return Object.freeze({ schemaVersion: 1, configured: true, estimate: 'empty-budget-not-a-reservation', budget: budget.snapshot() });
}
