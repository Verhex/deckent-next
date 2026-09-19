import { expect, it } from 'vitest';
import { diagnoseReservationWave, planSchedulingWave, RunStoreError } from '#engine/index.js';
import type { ReservationDiagnostic } from '#engine/index.js';
import { queryFailure } from '../../../src/composition/core/query-errors/index.js';
import type { TaskGraph, TaskProgress } from '#domain/index.js';

const graph: TaskGraph = { schemaVersion: 2, revision: 1,
  tasks: [{ id: 'a', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Exit', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] };
function wave(progress: TaskProgress, capacity = 1, now = 10) {
  return planSchedulingWave(graph, { schemaVersion: 1, capacity: { executionSlots: capacity, inFlightSlots: capacity }, ordering: ['a'],
    snapshot: { graphRevision: 1, progress: [progress], now } });
}
const pending = { taskId: 'a', phase: 'pending', unresolvedEffects: false, eligibleAt: 0 } as const;

it('classifies every bounded reservation diagnostic reason without changing the scheduling wave', () => {
  const ready = wave(pending); expect(ready.selectedTaskIds).toEqual(['a']);
  expect(diagnoseReservationWave(ready, 'transaction-wave-mismatch', 1, { executionSlots: 1, inFlightSlots: 1 })).toMatchObject({ reason: 'store-wave-mismatch', selectedCount: 1, requestedCount: 1, readyCount: 1 });

  const exhausted = wave(pending, 0); expect(exhausted.selectedTaskIds).toEqual([]);
  expect(diagnoseReservationWave(exhausted, 'application-empty', 0, { executionSlots: 0, inFlightSlots: 0 })).toMatchObject({ reason: 'capacity-exhausted', readyCount: 1, selectedCount: 0 });

  const delayed = wave({ ...pending, eligibleAt: 11 });
  expect(diagnoseReservationWave(delayed, 'application-empty', 0, { executionSlots: 1, inFlightSlots: 1 })).toMatchObject({ reason: 'delayed', delayedCount: 1, now: 10 });

  const terminal = wave({ ...pending, phase: 'accepted' });
  expect(diagnoseReservationWave(terminal, 'application-empty', 0, { executionSlots: 1, inFlightSlots: 1 })).toMatchObject({ reason: 'no-ready-task', terminalCount: 1 });
});

it('maps only the fixed string and numeric diagnostic fields to public error params', () => {
  const diagnostic = diagnoseReservationWave(wave({ ...pending, phase: 'active' }), 'application-empty', 0, { executionSlots: 1, inFlightSlots: 1 });
  const injected = { ...diagnostic, internalPath: '/private/customer/ledger', secret: 'credential-marker' } as ReservationDiagnostic;
  const failure = queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER', injected));
  expect(failure.code).toBe('RUN_CAPACITY_OR_ORDER');
  expect(failure.params).toEqual({ site: 'application-empty', reason: 'no-ready-task', now: 10,
    executionSlots: 1, inFlightSlots: 1, executionOccupied: 1, inFlightOccupied: 1, selectedCount: 0, requestedCount: 0,
    readyCount: 0, waitingCount: 0, blockedCount: 0, delayedCount: 0, occupiedCount: 1,
    terminalCount: 0, reconciliationCount: 0 });
  expect(Object.values(failure.params!).every(value => typeof value === 'string' || typeof value === 'number')).toBe(true);
  expect(failure.params).not.toHaveProperty('internalPath'); expect(failure.params).not.toHaveProperty('secret');
  expect(JSON.stringify(failure.params)).not.toContain('/private'); expect(JSON.stringify(failure.params)).not.toContain('credential-marker');
});
