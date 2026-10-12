import type { AttemptIdentity, RunSnapshot } from '#domain/index.js';
import type { Environment, ResolvedConfig } from '#platform/index.js';
import { projectMonitorRun, projectResultBrief, type ResultBrief } from '#engine/index.js';
import { prepareMonitorInstall } from './install.js';
/** The same typed evidence and read-output gate as the monitor, restricted to the explicitly inspected Run and its exact revision. */
export async function readMonitorRunResults(config: ResolvedConfig, env: Environment | undefined, query: { scopeId: string; runId: string }, expected: { revision: number; layoutRevision: string },
  readOutput: (identity: AttemptIdentity) => Promise<boolean>, retained?: RunSnapshot): Promise<ReadonlyMap<string, ResultBrief>> {
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
  const projected = projectMonitorRun({ run, workers: new Map(), approvals: [], pool: null, observedAt: Date.now() });
  return new Map(projected.tasks.filter(task => {
    const binding = source.snapshot.bindings.find(value => value.identity.taskId === task.taskId);
    return !binding || permitted.has(binding.identity.attemptId);
  }).map(task => {
    const content = run.attempts.find(attempt => attempt.attemptId === task.lastAttempt?.attemptId)?.content;
    const bound = source.snapshot.bindings.some(value => value.identity.taskId === task.taskId);
    return [task.taskId, projectResultBrief(task.lastAttempt?.attemptId ?? null, { verdict: task.evaluation.verdict,
      ...(task.evaluation.reason ? { reason: task.evaluation.reason } : {}) }, content?.finalReport ?? null, bound ? run.delivery ?? null : null,
      { ...(task.lastAttempt?.failedTests ? { failedTests: task.lastAttempt.failedTests } : {}), ...(bound && projected.deliveryOutlook ? { deliveryOutlook: projected.deliveryOutlook } : {}) })];
  }));
}
