import { expect } from 'vitest';
import type { RunView } from '#engine/index.js';

/** Keep all observation values exact; only the sampling instant changes between separate reads. */
export function atSameCostObservation(run: RunView): RunView {
  expect(run.costReport).toBeDefined();
  expect(run.costReport!.observedAtMs).toBeGreaterThan(0);
  expect(run.costReport).toMatchObject({ schemaVersion: 1, scopeId: run.scopeId, runId: run.runId, runRevision: run.revision, coverage: 'partial' });
  return { ...run, costReport: { ...run.costReport!, observedAtMs: 0 } };
}
export function atSameRunObservation<T extends { readonly run: RunView | null }>(result: T): T {
  return { ...result, run: result.run ? atSameCostObservation(result.run) : null };
}
/** A command replay must remain fully equal, without inspection-only observations. */
export function expectRecordedEvaluation<T extends { readonly evaluation: { readonly run: RunView } }>(result: T): T {
  expect(result.evaluation.run).not.toHaveProperty('costReport');
  expect(result.evaluation.run).not.toHaveProperty('pool');
  return result;
}
/** An immutable admission/cancellation receipt has no cost observation. Assert the whole additive report separately. */
export function expectEmptyCostObservation(run: RunView, withheld = 0) {
  const { costReport, ...recorded } = run;
  expect(atSameCostObservation(run).costReport).toEqual({ schemaVersion: 1, scopeId: run.scopeId, runId: run.runId, runRevision: run.revision,
    observedAtMs: 0, coverage: 'partial', attempts: [], withheld, recommendations: [], recommendationsTruncated: false,
    summary: { acceptedTasks: 0, failedTasks: 0, unknownTasks: 0, measuredApiUsdNanos: null, measuredCpuSeconds: null,
      sampledCpuSecondsPerAcceptedTask: null, sampledPeakBytes: null, unknownApiAttempts: 0 } });
  void costReport; return recorded;
}
