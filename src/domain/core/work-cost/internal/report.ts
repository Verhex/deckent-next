import { workCostSchema, workCostReportSchema, type WorkCost, type WorkCostReport } from './contract.js';
/** Sum only attributable, authorized rows. A subtotal is never an invented all-axis monetary total. */
export function summarizeWorkCosts(input: Omit<WorkCostReport, 'schemaVersion' | 'attempts' | 'summary' | 'coverage'> & { attempts: readonly WorkCost[] }): WorkCostReport {
  const rows = new Map<string, WorkCost>();
  for (const value of input.attempts) {
    const row = workCostSchema.parse(value), id = row.identity;
    if (id.scopeId !== input.scopeId || id.runId !== input.runId) throw new Error('WORK_COST_IDENTITY');
    const key = JSON.stringify(id), previous = rows.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('WORK_COST_REPLAY_CONFLICT'); rows.set(key, row);
  }
  const attempts = [...rows.values()], knownCpu = attempts.flatMap(row => row.axes.cpuSeconds === null ? [] : [row.axes.cpuSeconds]);
  const peaks = attempts.flatMap(row => row.axes.sampledPeakBytes === null ? [] : [row.axes.sampledPeakBytes]);
  const knownMoney = attempts.flatMap(row => row.axes.apiMoney === null ? [] : [BigInt(row.axes.apiMoney.amountUsdNanos)]);
  const tasks = new Map(attempts.map(row => [row.identity.taskId, row.acceptance.outcome]));
  const acceptedTasks = [...tasks.values()].filter(outcome => outcome === 'accepted').length;
  const measuredCpuSeconds = knownCpu.length ? knownCpu.reduce((sum, value) => sum + value, 0) : null;
  return workCostReportSchema.parse({ ...input, schemaVersion: 1, coverage: 'partial', attempts,
    summary: { acceptedTasks, failedTasks: [...tasks.values()].filter(outcome => outcome === 'failed').length,
      unknownTasks: [...tasks.values()].filter(outcome => outcome !== 'accepted' && outcome !== 'failed').length,
      measuredCpuSeconds, sampledPeakBytes: peaks.length ? Math.max(...peaks) : null,
      measuredApiUsdNanos: knownMoney.length ? knownMoney.reduce((sum, value) => sum + value, 0n).toString() : null,
      unknownApiAttempts: attempts.length - knownMoney.length,
      sampledCpuSecondsPerAcceptedTask: acceptedTasks && !input.withheld && knownCpu.length === attempts.length && measuredCpuSeconds !== null ? measuredCpuSeconds / acceptedTasks : null } });
}
