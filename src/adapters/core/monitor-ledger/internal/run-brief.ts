import type { AttemptIdentity } from '#domain/index.js';
import type { Environment, ResolvedConfig } from '#platform/index.js';
import { projectMonitorRun, projectResultBrief, type ResultBrief } from '#engine/index.js';
import { prepareMonitorInstall } from './install.js';
/** The same typed evidence and read-output gate as the monitor, restricted to the explicitly inspected Run and its exact revision. */
export async function readMonitorRunResults(config: ResolvedConfig, env: Environment | undefined, query: { scopeId: string; runId: string }, expected: { revision: number; layoutRevision: string },
  readOutput: (identity: AttemptIdentity) => Promise<boolean>): Promise<ReadonlyMap<string, ResultBrief>> {
  const captured = await prepareMonitorInstall(config, env, readOutput, { scopeId: query.scopeId, runId: query.runId });
  const source = captured.reading.runs.find(run => run.snapshot.identity.scopeId === query.scopeId && run.snapshot.identity.runId === query.runId);
  // Never attach a concurrently advanced Run's evidence to an earlier inspected view.
  if (!source || source.snapshot.revision !== expected.revision || source.snapshot.identity.layoutRevision !== expected.layoutRevision) return new Map();
  const reading = await captured.readShown(source.snapshot.bindings.map(binding => binding.identity));
  const run = reading.runs[0]!;
  const projected = projectMonitorRun({ run, workers: new Map(), approvals: [], pool: null, observedAt: Date.now() });
  return new Map(projected.tasks.map(task => {
    const content = run.attempts.find(attempt => attempt.attemptId === task.lastAttempt?.attemptId)?.content;
    return [task.taskId, projectResultBrief(task.lastAttempt?.attemptId ?? null, { verdict: task.evaluation.verdict,
      ...(task.evaluation.reason ? { reason: task.evaluation.reason } : {}) }, content?.finalReport ?? null, run.delivery ?? null)];
  }));
}
