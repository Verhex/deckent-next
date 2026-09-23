import { ErrorRegistry, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { buildInferenceServingPlan, estimateReplicaCapacity, InferenceServingError, InferenceTokenBudget, roleContextCeiling, selectInferenceProfile } from '#engine/index.js';

/** Read-only plan/budget for MCP through the same profile selector as the CLI. Budget is an empty estimate, not a reservation
 * and not Run admission; unlike the CLI it takes no simulated reservation inputs. */
export async function describeMcpInference(root: string, kind: 'plan' | 'budget', profileId?: string, options: ConfigLoadOptions = {}): Promise<unknown> {
  const config = await loadConfig(root, { ...options, heal: false }) as Record<string, unknown>;
  let profile;
  try { profile = selectInferenceProfile(config, profileId); }
  catch (error) {
    if (error instanceof InferenceServingError) throw ErrorRegistry.createError(error.code, { params: { profile: error.profileId }, cause: error });
    throw error;
  }
  if (!profile) return Object.freeze({ schemaVersion: 1, configured: false });
  if (kind === 'plan') return Object.freeze({ schemaVersion: 1, configured: true, plan: buildInferenceServingPlan(profile) });
  const capacity = estimateReplicaCapacity(profile);
  const budget = new InferenceTokenBudget(capacity.totalTokenBudget, role => roleContextCeiling(profile, role));
  return Object.freeze({ schemaVersion: 1, configured: true, estimate: 'empty-budget-not-a-reservation', budget: budget.snapshot() });
}
