import { sameAttemptIdentity, processExitCauseSchema, type AttemptIdentity, type ProcessExitCause } from './contract.js';

/** Incarnation comes from trusted supervisor custody, never a PID supplied by a caller.
 * Absence without a retained incarnation is not termination evidence. */
export type WorkerIncarnation = Readonly<
  { kind: 'process'; pid: number; startedAt: string } |
  { kind: 'container'; id: string; startedAt: string }
>;
export interface DispatchLossRecord {
  readonly identity: AttemptIdentity;
  readonly owner: string;
  readonly launch: 'pending' | 'granted' | 'prevented-before-launch';
  readonly lost: boolean;
  readonly worker: WorkerIncarnation | null;
  /** S6R-1: the container id Docker returned at `create` (before start); only the created-container termination variant reads it. */
  readonly containerId?: string | null | undefined;
}
/** A trusted store must supply a committed receipt; this value alone grants no authority.
 * Full Attempt identity (including generation) and owner form the revoked dispatch token. */
export interface DispatchFence {
  readonly identity: AttemptIdentity;
  readonly owner: string;
  readonly receiptId: string;
}
/** S6R-3 `created-container-absent` (lead on s6r1 Q2): the dispatch retained no incarnation, only its created container id, and the
 * supervisor proved that exact id absent. It never replaces an incarnation: once a worker was retained only its own proof releases. */
export type DispatchTerminationProof = Readonly<{
  identity: AttemptIdentity;
  owner: string;
  receiptId: string;
} & ({ worker: WorkerIncarnation } & ({ kind: 'supervisor-exit'; result: ProcessExitCause } | { kind: 'worker-absent' }) | { kind: 'created-container-absent'; containerId: string })>;
export type LostDispatchAction = 'release-slot' | 'finish-dispatch' | 'result' | 'output' | 'patch' | 'effect';
export type DispatchLossDecision = Readonly<
  { kind: 'release'; fenceReceiptId: string; terminationReceiptId: string } |
  { kind: 'hold-manual'; reason: 'not-lost' | 'not-granted' | 'fence-required' | 'fence-mismatch' | 'termination-required' | 'termination-mismatch' } |
  { kind: 'reject-late-write'; code: 'DISPATCH_FENCED' }
>;
function matches(record: DispatchLossRecord, evidence: DispatchFence | DispatchTerminationProof): boolean {
  return sameAttemptIdentity(record.identity, evidence.identity) && record.owner === evidence.owner && evidence.receiptId.length > 0;
}
const CONTAINER_ID = /^[a-f0-9]{64}$/;
function sameWorker(expected: WorkerIncarnation | null, observed: WorkerIncarnation): boolean {
  if (!expected || !expected.startedAt || expected.startedAt !== observed.startedAt) return false;
  return expected.kind === 'process' && observed.kind === 'process'
    ? Number.isSafeInteger(expected.pid) && expected.pid > 0 && expected.pid === observed.pid
    : expected.kind === 'container' && observed.kind === 'container' && !!expected.id && expected.id === observed.id;
}
/** Pure assessment for lost dispatch custody, not normal dispatch admission.
 * Release concerns capacity only: it neither accepts work, settles effects nor starts a retry.
 * Heartbeat age and a bare PID cannot enter the termination-proof contract. */
export function decideDispatchLoss(record: DispatchLossRecord, fence: DispatchFence | null,
  termination: DispatchTerminationProof | null, action: LostDispatchAction): DispatchLossDecision {
  const hold = (reason: Extract<DispatchLossDecision, { kind: 'hold-manual' }>['reason']): DispatchLossDecision => Object.freeze({ kind: 'hold-manual', reason });
  if (!fence) return hold('fence-required');
  if (!matches(record, fence)) return hold('fence-mismatch');
  if (action !== 'release-slot') return Object.freeze({ kind: 'reject-late-write', code: 'DISPATCH_FENCED' });
  if (!record.lost) return hold('not-lost');
  if (record.launch !== 'granted') return hold('not-granted');
  if (!termination) return hold('termination-required');
  if (termination.kind === 'created-container-absent') return matches(record, termination) && record.worker === null && CONTAINER_ID.test(termination.containerId)
    && record.containerId === termination.containerId ? Object.freeze({ kind: 'release', fenceReceiptId: fence.receiptId, terminationReceiptId: termination.receiptId }) : hold('termination-mismatch');
  if (!matches(record, termination) || !sameWorker(record.worker, termination.worker)) return hold('termination-mismatch');
  if (termination.kind !== 'worker-absent' && (termination.kind !== 'supervisor-exit' || !processExitCauseSchema.safeParse(termination.result).success)) return hold('termination-mismatch');
  return Object.freeze({ kind: 'release', fenceReceiptId: fence.receiptId, terminationReceiptId: termination.receiptId });
}
