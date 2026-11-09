 import { resolve } from 'node:path'; import { inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { FileArtifactStore, openSqliteAttemptStore, resolveGitWorkTarget, removeRunBase, sweepRunBases } from '#adapters/index.js';
import { validateExecutionSupervisorProfile, recordedTaskSupervisor, taskProfileObservesWorker, gitDockerAttemptCustody } from '#adapters/index.js';
import { AttemptCustodyReleaseApplication, DispatchPolicyAuthorization, sweepAttemptCustodyScopes } from '#engine/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js'; import { queryFailure } from '#composition/core/query-errors/index.js'; import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** EXEC-RELEASE service-start sweep (under the service's ledger custody): the same release owner and ledger condition as patch preparation. */
export async function sweepConfiguredAttemptCustody(root: string, scopeIds: readonly string[], options: ConfigLoadOptions = {}) {
  return sweepAttemptCustodyScopes(scopeIds, async scopeId => {
    const c = await loadConfiguredScopeContext(root, scopeId, options, 'read'), execution = c.config.execution, layout = c.layout; if (!execution) return null;
    const git = { ...execution.git, ...(await resolveGitWorkTarget(resolve(root), execution, layout)).git, workspaceRoot: await inspectProductDirectory(layout, 'workspaces') };
    const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, { now: Date.now, timeoutMs: c.config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateExecutionSupervisorProfile });
    try { return await new AttemptCustodyReleaseApplication({ store, artifacts: new FileArtifactStore({ root: await inspectProductDirectory(layout, 'artifacts'), maxBytes: c.config.artifacts.maxBytes }),
      verifier: { async verify() { return c.principal; } }, authorization: new DispatchPolicyAuthorization(contextPolicySource({ layout, config: c.config })),
      owner: c.principal.id, retention: execution.retention, ...gitDockerAttemptCustody(git), supervisor: recordedTaskSupervisor, observed: taskProfileObservesWorker }).sweep(scopeId, c.config.inspection.maxPageSize); } finally { store.close(); }
  }, error => queryFailure(error).code);
}
import { inspectConfiguredRun } from './inspect.js';
import { inspectConfiguredDismissedDeliveries } from '#composition/core/workspace-patch/index.js';
/** L1c start sweep of working-tree Runs' private bases (one installation workspace root): stale capture/removal remnants go, and a recorded Run's base goes
 * once its Run is terminal and none of its tasks still awaits delivery (the same result view /deliver offers from); a set-aside one counts as settled only
 * after `retention.setAsideDays` from its latest set-aside record (M-33 return window). Bounded by `retention.sweepLimit`; an unreadable Run keeps its base. */
export async function sweepConfiguredRunBases(root: string, scopeIds: readonly string[], options: ConfigLoadOptions = {}) {
  const c = scopeIds[0] === undefined ? null : await loadConfiguredScopeContext(root, scopeIds[0], options, 'read'), execution = c?.config.execution; if (!c || !execution) return null;
  const workspaceRoot = await inspectProductDirectory(c.layout, 'workspaces'), swept = await sweepRunBases(workspaceRoot, execution.git.timeoutMs, execution.retention.sweepLimit); let released = 0;
  const since = Date.now() - execution.retention.setAsideDays * 86_400_000, dismissed = new Map<string, Promise<Awaited<ReturnType<typeof inspectConfiguredDismissedDeliveries>> | null>>(); // KG6 F7: one read per scope
  for (const run of swept.runs.filter(run => scopeIds.includes(run.scopeId))) {
    const view = await inspectConfiguredRun(root, { schemaVersion: 1, ...run }, options).then(result => result.run, () => null);
    if (!dismissed.has(run.scopeId)) dismissed.set(run.scopeId, inspectConfiguredDismissedDeliveries(root, run.scopeId, c.config.inspection.maxPageSize, options).catch(() => null));
    const aside = (await dismissed.get(run.scopeId))?.filter(row => row.runId === run.runId) ?? null;
    if (view && aside && runBaseSettled(view, aside, since) && await removeRunBase(workspaceRoot, run).catch(() => null) === 'removed') released++;
  }
  return Object.freeze({ removed: swept.removed, kept: swept.kept, released });
}
/** L1c: settled only on positive evidence: a terminal Run that is closed (not completed), or whose every accepted task is delivered, owes nothing, or was set
 * aside before `since` (its latest set-aside record, M-33 return window); an unknown outlook (unread output, older evidence) keeps the base. */
type SettledView = Readonly<{ state: Readonly<{ kind: string; outcome?: string | undefined }>; tasks: readonly Readonly<{ id: string; phase: string; resultBrief?: Readonly<{
  runDelivery?: Readonly<{ state?: string | undefined }> | null | undefined; deliveryOutlook?: string | undefined; setAside?: boolean | undefined }> | null | undefined }>[] }>;
export function runBaseSettled(view: SettledView, aside: readonly Readonly<{ taskId: string; atMs: number }>[], since: number) {
  return view.state.kind === 'terminal' && (view.state.outcome !== 'completed' || view.tasks.every(({ id, phase, resultBrief: brief }) => phase !== 'accepted' || brief?.runDelivery?.state === 'delivered'
    || brief?.deliveryOutlook === 'none' || brief?.deliveryOutlook === 'patch-not-prepared' || (brief?.deliveryOutlook === 'awaiting-delivery' && !!brief.setAside && !aside.some(row => row.taskId === id && row.atMs > since))));
}
