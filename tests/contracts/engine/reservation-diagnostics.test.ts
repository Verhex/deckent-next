import { expect, it } from 'vitest';
import { diagnoseReservationWave, planSchedulingWave, RunStoreError } from '#engine/index.js';
import type { ReservationDiagnostic } from '#engine/index.js';
import { queryFailure } from '../../../src/composition/core/query-errors/index.js';
import type { TaskGraph, TaskProgress } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';

const graph: TaskGraph = { schemaVersion: 2, revision: 1,
  tasks: [{ id: 'a', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Exit', evaluator: { id: 'process-exit', version: 1 }, parameters: {} }] };
function wave(progress: TaskProgress, capacity = 1, now = 10) {
  return planSchedulingWave(graph, { schemaVersion: 2, capacity: { executionSlots: capacity, inFlightSlots: capacity }, ordering: ['a'],
    snapshot: { graphRevision: 1, progress: [progress], now } });
}
const pending = { taskId: 'a', phase: 'pending', unresolvedEffects: false, eligibility: { kind: 'immediate' } } as const;

it('classifies every bounded reservation diagnostic reason without changing the scheduling wave', () => {
  const ready = wave(pending); expect(ready.selectedTaskIds).toEqual(['a']);
  expect(diagnoseReservationWave(ready, 'transaction-wave-mismatch', 1, { executionSlots: 1, inFlightSlots: 1 })).toMatchObject({ reason: 'store-wave-mismatch', selectedCount: 1, requestedCount: 1, readyCount: 1 });

  const exhausted = wave(pending, 0); expect(exhausted.selectedTaskIds).toEqual([]);
  expect(diagnoseReservationWave(exhausted, 'application-empty', 0, { executionSlots: 0, inFlightSlots: 0 })).toMatchObject({ reason: 'capacity-exhausted', readyCount: 1, selectedCount: 0 });

  const delayed = wave({ ...pending, eligibility: { kind: 'not-before', at: 11 } });
  expect(diagnoseReservationWave(delayed, 'application-empty', 0, { executionSlots: 1, inFlightSlots: 1 })).toMatchObject({ reason: 'delayed', delayedCount: 1, now: 10, eligibilityGapMs: 1 });

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

it('renders bounded diagnostics in both locales and preserves a complete generic fallback', () => {
  const diagnostic = diagnoseReservationWave(wave({ ...pending, eligibility: { kind: 'not-before', at: 11 } }), 'application-empty', 0,
    { executionSlots: 1, inFlightSlots: 1 });
  const detailed = queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER', diagnostic));
  expect(detailed.localize?.('en').message).toBe('Task reservation refused (application-empty/delayed): ready 0, delayed 1, occupied execution slots 0/1, eligibility gap 1 ms.');
  expect(detailed.localize?.('tr').message).toBe('Görev rezervasyonu reddedildi (application-empty/delayed): hazır 0, gecikmeli 1, dolu yürütme kapasitesi 0/1, uygunluk bekleme süresi 1 ms.');
  const generic = queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER'));
  const incomplete = ErrorRegistry.createError('RUN_CAPACITY_OR_ORDER', { params: { site: 'application-empty', reason: 'delayed' } });
  for (const locale of ['en', 'tr'] as const) {
    expect(incomplete.localize?.(locale).message).toBe(generic.localize?.(locale).message);
    expect(generic.localize?.(locale).message).not.toMatch(/[{}]/);
    expect(generic.localize?.(locale).message).not.toContain('undefined');
    expect(generic.localize?.(locale).message).not.toContain('application-empty');
  }
});


it('measures the earliest delayed task only, excluding blocked or waiting future tasks', () => {
  const tasks = ['a', 'b', 'c'].map(id => ({ ...graph.tasks[0]!, id, dependencies: id === 'c' ? ['a'] : [] }));
  const scheduling = planSchedulingWave({ ...graph, tasks }, { schemaVersion: 2,
    capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['a', 'b', 'c'],
    snapshot: { graphRevision: 1, now: 10, progress: [
      { ...pending, taskId: 'a', eligibility: { kind: 'not-before', at: 30 } },
      { ...pending, taskId: 'b', eligibility: { kind: 'not-before', at: 15 } },
      { ...pending, taskId: 'c', eligibility: { kind: 'not-before', at: 11 } },
    ] } });
  const d = diagnoseReservationWave(scheduling, 'application-empty', 0, { executionSlots: 1, inFlightSlots: 1 });
  expect(d).toMatchObject({ delayedCount: 2, waitingCount: 1, eligibilityGapMs: 5 });
  expect(queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER', d)).params).toMatchObject({ eligibilityGapMs: 5 });
  const error = queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER', d));
  expect(error.localize?.('en').message).toContain('eligibility gap 5 ms');
  expect(error.localize?.('tr').message).toContain('uygunluk bekleme süresi 5 ms');
  expect(scheduling.selectedTaskIds).toEqual([]);
  const ready = diagnoseReservationWave(wave(pending), 'transaction-wave-mismatch', 1, { executionSlots: 1, inFlightSlots: 1 });
  expect(ready).not.toHaveProperty('eligibilityGapMs');
  expect(queryFailure(new RunStoreError('RUN_CAPACITY_OR_ORDER', ready)).params).not.toHaveProperty('eligibilityGapMs');
});
