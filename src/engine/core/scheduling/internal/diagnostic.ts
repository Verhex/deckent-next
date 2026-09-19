import type { TaskReadiness } from '#domain/index.js';

export type ReservationDiagnosticSite = 'application-empty' | 'transaction-wave-mismatch';
export type ReservationDiagnosticReason = 'no-ready-task' | 'delayed' | 'capacity-exhausted' | 'store-wave-mismatch';
export interface ReservationDiagnostic {
  readonly site: ReservationDiagnosticSite;
  readonly reason: ReservationDiagnosticReason;
  readonly now: number;
  readonly eligibilityGapMs?: number;
  readonly executionSlots: number;
  readonly inFlightSlots: number;
  readonly executionOccupied: number;
  readonly inFlightOccupied: number;
  readonly selectedCount: number;
  readonly requestedCount: number;
  readonly readyCount: number;
  readonly waitingCount: number;
  readonly blockedCount: number;
  readonly delayedCount: number;
  readonly occupiedCount: number;
  readonly terminalCount: number;
  readonly reconciliationCount: number;
}

interface DiagnosticWave {
  readonly observedAt: number;
  readonly eligibilityGapMs?: number;
  readonly selectedTaskIds: readonly string[];
  readonly deferredTaskIds: readonly string[];
  readonly occupancy: Readonly<{ execution: number; inFlight: number }>;
  readonly readiness: readonly TaskReadiness[];
}

/** Bounded metadata derived from an authoritative scheduling wave. The reason is a stable observed-blocker
 * summary for triage, not a claim that one condition caused the reservation outcome. It carries no task IDs
 * or resource details.
 */
export function diagnoseReservationWave(wave: DiagnosticWave, site: ReservationDiagnosticSite,
  requestedCount: number, capacity: Readonly<{ executionSlots: number; inFlightSlots: number }>): ReservationDiagnostic {
  const counts = { ready: 0, waiting: 0, blocked: 0, delayed: 0, occupied: 0, terminal: 0, reconciliation: 0 };
  for (const task of wave.readiness) counts[task.disposition]++;
  const reason: ReservationDiagnosticReason = site === 'transaction-wave-mismatch' ? 'store-wave-mismatch'
    : counts.ready === 0 && counts.delayed > 0 ? 'delayed'
      : counts.ready > 0 && wave.selectedTaskIds.length === 0 && wave.deferredTaskIds.length > 0 ? 'capacity-exhausted' : 'no-ready-task';
  return Object.freeze({ site, reason, now: wave.observedAt,
    ...(wave.eligibilityGapMs === undefined ? {} : { eligibilityGapMs: wave.eligibilityGapMs }),
    executionSlots: capacity.executionSlots, inFlightSlots: capacity.inFlightSlots,
    executionOccupied: wave.occupancy.execution, inFlightOccupied: wave.occupancy.inFlight,
    selectedCount: wave.selectedTaskIds.length, requestedCount,
    readyCount: counts.ready, waitingCount: counts.waiting, blockedCount: counts.blocked,
    delayedCount: counts.delayed, occupiedCount: counts.occupied, terminalCount: counts.terminal,
    reconciliationCount: counts.reconciliation });
}
