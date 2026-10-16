import type { RunSnapshot } from '#domain/index.js';
import { projectResultBrief, type ResultBrief } from '#engine/core/runs/index.js';
import { projectMonitorRun } from './derive.js';
import type { MonitorLedgerRun } from './evidence.js';
/** Projects an already authorized, revision-matched reading without opening storage. */
export function projectMonitorRunResults(run: MonitorLedgerRun, bindings: RunSnapshot['bindings'], permitted: ReadonlySet<string>): ReadonlyMap<string, ResultBrief> {
  const projected = projectMonitorRun({ run, workers: new Map(), approvals: [], pool: null, observedAt: Date.now() });
  return new Map(projected.tasks.filter(task => {
    const binding = bindings.find(value => value.identity.taskId === task.taskId);
    return !binding || permitted.has(binding.identity.attemptId);
  }).map(task => {
    const content = run.attempts.find(attempt => attempt.attemptId === task.lastAttempt?.attemptId)?.content;
    const bound = bindings.some(value => value.identity.taskId === task.taskId);
    return [task.taskId, projectResultBrief(task.lastAttempt?.attemptId ?? null, { verdict: task.evaluation.verdict,
      ...(task.evaluation.reason ? { reason: task.evaluation.reason } : {}) }, content?.finalReport ?? null, bound ? run.delivery ?? null : null,
      { ...(task.lastAttempt?.failedTests ? { failedTests: task.lastAttempt.failedTests } : {}), ...(bound && projected.deliveryOutlook ? { deliveryOutlook: projected.deliveryOutlook } : {}) })];
  }));
}
