import { sameAttemptIdentity, type AttemptIdentity, type RunSnapshot } from '#domain/index.js';
import type { Environment, ResolvedConfig } from '#platform/index.js';
import { projectRunWithDismissals, projectResultBrief, type ResultBrief } from '#engine/index.js';
import { aggregateDelivery } from './receipt-observation.js';
import { prepareMonitorInstall } from './install.js';
/** The same typed evidence and read-output gate as the monitor, restricted to the explicitly inspected Run and its exact revision. */
export async function readMonitorRunResults(config: ResolvedConfig, env: Environment | undefined, query: { scopeId: string; runId: string }, expected: { revision: number; layoutRevision: string },
  readOutput: (identity: AttemptIdentity) => Promise<boolean>, retained?: RunSnapshot, dismissed?: (limit: number) => Promise<ReadonlySet<string>>): Promise<ReadonlyMap<string, ResultBrief>> {
  const permitted = new Set<string>();
  const captured = await prepareMonitorInstall(config, env, async identity => {
    const allowed = await readOutput(identity);
    if (allowed) permitted.add(identity.attemptId); else permitted.delete(identity.attemptId);
    return allowed;
  }, { scopeId: query.scopeId, runId: query.runId }, retained, expected);
  const source = captured.reading.runs.find(run => run.snapshot.identity.scopeId === query.scopeId && run.snapshot.identity.runId === query.runId);
  // Never attach a concurrently advanced Run's evidence to an earlier inspected view.
  if (!source || source.snapshot.revision !== expected.revision || source.snapshot.identity.layoutRevision !== expected.layoutRevision) return new Map();
  const reading = await captured.readShown(source.snapshot.bindings.map(binding => binding.identity));
  const run = reading.runs[0]!;
  const { projected, setAside, unread } = await projectRunWithDismissals({ run, workers: new Map(), approvals: [], pool: null, observedAt: Date.now() }, dismissed); // BeUser M-33
  return new Map(projected.tasks.filter(task => {
    const binding = source.snapshot.bindings.find(value => value.identity.taskId === task.taskId);
    return !binding || permitted.has(binding.identity.attemptId);
  }).map(task => {
    const content = run.attempts.find(attempt => attempt.attemptId === task.lastAttempt?.attemptId)?.content;
    const binding = source.snapshot.bindings.find(value => value.identity.taskId === task.taskId), bound = Boolean(binding);
    const delivery = binding ? aggregateDelivery((run.deliveryReceipts ?? []).filter(value => value.identity && sameAttemptIdentity(value.identity, binding.identity))) : null;
    const definition = source.snapshot.graph.tasks.find(value => value.id === task.taskId);
    const recorded = run.attempts.find(value => value.attemptId === binding?.identity.attemptId)?.dispatch?.patchRecorded;
    const outlook: ResultBrief['deliveryOutlook'] = projected.state === 'accepted' && run.deliveryOutputPermitted !== false && task.phase === 'accepted'
      ? !definition?.workInput ? 'none' : ['delivered', 'adopting', 'adopted', 'rolling-back', 'rolled-back'].includes(delivery?.state ?? '') ? undefined
        : recorded === true ? 'awaiting-delivery' : recorded === false ? 'patch-not-prepared' : undefined : undefined;
    return [task.taskId, projectResultBrief(task.lastAttempt?.attemptId ?? null, { verdict: task.evaluation.verdict,
      ...(task.evaluation.reason ? { reason: task.evaluation.reason } : {}) }, content?.finalReport ?? null, delivery,
      { ...(task.lastAttempt?.failedTests ? { failedTests: task.lastAttempt.failedTests } : {}), ...(bound && outlook ? { deliveryOutlook: outlook } : {}), ...(bound && outlook === 'awaiting-delivery' && setAside(task.taskId) ? { setAside: true as const } : {}), ...(bound && unread ? { dismissalUnread: unread } : {}) })];
  }));
}
