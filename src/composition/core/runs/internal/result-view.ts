import type { RunSnapshot, VerifiedPrincipal } from '#domain/index.js';
import type { Environment, ResolvedConfig } from '#platform/index.js';
import { readMonitorRunResults } from '#adapters/index.js';
import { runViewSchema, type DispatchIdentityAuthorization, type RunView } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Inspection and evaluation share report/delivery observation and the same per-attempt output authority. */
export async function observeConfiguredRunResults(config: ResolvedConfig, env: Environment | undefined, run: RunView,
  principal: VerifiedPrincipal, policy: DispatchIdentityAuthorization, retained?: RunSnapshot, dismissed?: (limit: number) => Promise<ReadonlySet<string>>): Promise<RunView> {
  const briefs = await readMonitorRunResults(config, env, run, run, async identity => {
    try { await policy.authorizeIdentity('read-output', identity, principal); return true; }
    catch (error) {
      if (['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED', 'APPROVAL_DENIED'].includes(queryFailure(error).code)) return false;
      throw error;
    }
  }, retained, dismissed);
  return runViewSchema.parse({ ...run, tasks: run.tasks.map(task => {
    const { resultBrief, ...view } = task; void resultBrief;
    return { ...view, ...(briefs.has(task.id) ? { resultBrief: briefs.get(task.id)! } : {}) };
  }) });
}
