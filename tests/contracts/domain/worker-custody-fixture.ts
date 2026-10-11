import { applyAttemptObservation, createAttempt, createRun, observeRunAttempt, reserveRunTasks,
  type DispatchLossRecord, type DispatchFence, type DispatchTerminationProof } from '#domain/index.js';
import { execution, graph, identity } from './acceptance-fixture.js';

export function lostWorker() {
  const dag = { ...graph, tasks: [graph.tasks[0]!,
    { ...graph.tasks[0]!, id: 'dependent', dependencies: [identity.taskId] },
    { ...graph.tasks[0]!, id: 'other' }] };
  const reserved = reserveRunTasks(createRun({ scopeId: identity.scopeId, runId: identity.runId,
    layoutRevision: identity.layoutRevision }, dag, 0, execution(dag)), 0, [identity], 0);
  const attempt = applyAttemptObservation(createAttempt(identity), { protocolVersion: 1, identity,
    sequence: 1, eventId: 'lost', result: { kind: 'unknown', reasonCode: 'WORKER_LOST' } }, 0);
  const run = observeRunAttempt(reserved, reserved.revision, attempt);
  const worker = { kind: 'process' as const, pid: 42, startedAt: 'incarnation-a' };
  const record: DispatchLossRecord = { identity, owner: 'worker-owner', launch: 'granted', lost: true, worker };
  const fence: DispatchFence = { identity, owner: record.owner, receiptId: 'fence-receipt' };
  const proof: DispatchTerminationProof = { kind: 'supervisor-exit', identity, owner: record.owner, worker,
    receiptId: 'termination-receipt', result: { exitCode: 0 } };
  return { run, attempt, record, fence, proof };
}
