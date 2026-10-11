import { decideDispatchLoss, sameAttemptIdentity, type DispatchLossRecord, type DispatchFence, type DispatchTerminationProof } from '#domain/core/attempt/index.js';
import { checkedRun, runSnapshotSchema, RunError } from './contract.js';
/** Trusted receipt inputs are loaded by the application/store inside its transaction. Missing custody means held.
 * This sole reducer releases capacity only: no effect settlement, acceptance, metric or new Attempt. Beta has no manual release. */
export function releaseWorkerCustody(input: unknown, expectedRevision: number, record: DispatchLossRecord,
  fence: DispatchFence | null, proof: DispatchTerminationProof | null) {
  const run = checkedRun(input, expectedRevision);
  const binding = run.bindings.find(row => sameAttemptIdentity(row.identity, record.identity));
  const task = run.progress.find(row => row.taskId === record.identity.taskId);
  const decision = decideDispatchLoss(record, fence, proof, 'release-slot');
  if (!binding || !task || binding.observedKind !== 'unknown' || task.phase !== 'reconciling' || !task.unresolvedEffects
    || decision.kind !== 'release') throw new RunError('RUN_ATTEMPT_CONFLICT');
  const workerCustody = { schemaVersion: 1 as const, state: 'released' as const, basis: 'termination-proof' as const,
    fenceReceiptId: decision.fenceReceiptId, proofReceiptId: decision.terminationReceiptId };
  if (task.workerCustody?.state === 'released') {
    if (JSON.stringify(task.workerCustody) !== JSON.stringify(workerCustody)) throw new RunError('RUN_ATTEMPT_CONFLICT');
    return run;
  }
  const proposed = runSnapshotSchema.safeParse({ ...run, revision: run.revision + 1,
    progress: run.progress.map(row => row === task ? { ...row, workerCustody } : row) });
  if (!proposed.success) throw new RunError('RUN_ATTEMPT_CONFLICT');
  return proposed.data;
}
