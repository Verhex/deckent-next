import type { AttemptIdentity, TaskProgress } from '#domain/index.js';

/** Trusted store port: consumes durable cancellation intent plus recorded terminal evidence and moves the
 * bound task to `cancelled` (prevention for unlaunched attempts, settlement for exited ones). It never
 * fabricates an observation, launches, retries or touches accepted/failed tasks; `not-settleable` means
 * the attempt still belongs to its running owner or reconciler. */
export type RunCancellationSettlement = Readonly<{ status: 'prevented' | 'settled' | 'already-cancelled' | 'not-settleable'; phase: TaskProgress['phase'] }>;
export interface RunCancellationSettlementStore { settleCancelledAttempt(identity: AttemptIdentity): Promise<RunCancellationSettlement> }
