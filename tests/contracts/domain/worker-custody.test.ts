import { expect, it } from 'vitest';
import { releaseWorkerCustody, reserveRunTasks, deriveAcceptanceView, runSnapshotSchema, taskProgressSchema } from '#domain/index.js';
import { deriveAcceptanceMetrics, measureTaskOccupancy, planSchedulingWave } from '#engine/index.js';
import { identity } from './acceptance-fixture.js';
import { lostWorker } from './worker-custody-fixture.js';

it('requires trusted fence and termination receipts; absence, owner and incarnation mismatches refuse release', () => {
  const f = lostWorker(), before = JSON.stringify(f);
  for (const [fence, proof] of [[null, f.proof], [f.fence, null], [{ ...f.fence, receiptId: '' }, f.proof],
    [f.fence, { ...f.proof, receiptId: '' }], [{ ...f.fence, owner: 'another' }, f.proof],
    [f.fence, { ...f.proof, owner: 'another' }], [{ ...f.fence, receiptId: ' invalid ' }, f.proof],
    [f.fence, { ...f.proof, receiptId: 'invalid\nreceipt' }],
    [f.fence, { ...f.proof, worker: { ...f.proof.worker, startedAt: 'reused-pid' } }]] as const) {
    expect(() => releaseWorkerCustody(f.run, f.run.revision, f.record, fence, proof)).toThrow('RUN_ATTEMPT_CONFLICT');
  }
  expect(JSON.stringify(f)).toBe(before);
});
it.each(['worker-absent', 'failed-exit'] as const)('accepts exact trusted %s as capacity evidence without turning it into acceptance', kind => {
  const f = lostWorker();
  const proof = kind === 'worker-absent' ? { kind: 'worker-absent' as const, identity, owner: f.record.owner,
    receiptId: f.proof.receiptId, worker: f.proof.worker } : { ...f.proof, kind: 'supervisor-exit' as const, result: { exitCode: 1 } };
  const next = releaseWorkerCustody(f.run, f.run.revision, f.record, f.fence, proof);
  expect(next.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true, workerCustody: { state: 'released' } });
  expect(deriveAcceptanceView(next, identity.taskId).outcome).toBe('incomplete');
});
it.each(['scopeId', 'runId', 'taskId', 'attemptId', 'layoutRevision', 'generation'] as const)('binds the reducer fence, proof and loss record to exact %s', key => {
  const f = lostWorker(), foreign = { ...identity, [key]: key === 'generation' ? 2 : 'other-id' };
  expect(() => releaseWorkerCustody(f.run, f.run.revision, f.record, { ...f.fence, identity: foreign }, f.proof)).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(() => releaseWorkerCustody(f.run, f.run.revision, f.record, f.fence, { ...f.proof, identity: foreign })).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(() => releaseWorkerCustody(f.run, f.run.revision, { ...f.record, identity: foreign },
    { ...f.fence, identity: foreign }, { ...f.proof, identity: foreign })).toThrow('RUN_ATTEMPT_CONFLICT');
});
it('releases capacity only and replays the same evidence without another revision', () => {
  const f = lostWorker(), attemptBytes = JSON.stringify(f.attempt), before = JSON.stringify(f.run);
  const next = releaseWorkerCustody(f.run, f.run.revision, f.record, f.fence, f.proof);
  expect(next).toEqual({ ...f.run, revision: f.run.revision + 1, progress: f.run.progress.map(task => task.taskId === identity.taskId
    ? { ...task, workerCustody: { schemaVersion: 1, state: 'released', basis: 'termination-proof', fenceReceiptId: f.fence.receiptId, proofReceiptId: f.proof.receiptId } } : task) });
  expect(next.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  expect(deriveAcceptanceView(next, identity.taskId)).toMatchObject({ outcome: 'incomplete', evaluationId: null, score: null, ceilingReasons: ['unsettled-effect'] });
  expect(deriveAcceptanceMetrics(JSON.stringify({ action: 'release-worker-custody' }), next)).toEqual([]);
  expect(JSON.stringify(f.run)).toBe(before); expect(JSON.stringify(f.attempt)).toBe(attemptBytes);
  expect(releaseWorkerCustody(next, next.revision, f.record, f.fence, f.proof)).toEqual(next);
  expect(() => releaseWorkerCustody(next, next.revision, f.record, f.fence, { ...f.proof, receiptId: 'other-proof' })).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(() => releaseWorkerCustody(next, f.run.revision, f.record, f.fence, f.proof)).toThrow('RUN_REVISION_CONFLICT');
});
it('K4 a: no new Attempt is reserved; released capacity serves another task while the dependency barrier stays closed', () => {
  const f = lostWorker(); const wave = (run: typeof f.run) => planSchedulingWave(run.graph, { schemaVersion: 2,
    capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: run.graph.tasks.map(task => task.id),
    snapshot: { graphRevision: run.graph.revision, now: 100, progress: run.progress } });
  expect(wave(f.run).selectedTaskIds).toEqual([]);
  const next = releaseWorkerCustody(f.run, f.run.revision, f.record, f.fence, f.proof);
  expect(next.bindings).toEqual(f.run.bindings);
  const planned = wave(next); expect(planned.selectedTaskIds).toEqual(['other']);
  expect(planned.readiness.find(row => row.taskId === identity.taskId)?.disposition).toBe('reconciliation');
  expect(planned.readiness.find(row => row.taskId === 'dependent')?.disposition).toBe('waiting');
  expect(() => reserveRunTasks(next, next.revision, [{ ...identity, attemptId: 'automatic-retry', generation: 2 }], 100)).toThrow('RUN_ATTEMPT_CONFLICT');
  expect(() => reserveRunTasks(next, next.revision, [{ ...identity, taskId: 'dependent', attemptId: 'dependent-attempt' }], 100)).toThrow('RUN_TASK_NOT_READY');
  const other = reserveRunTasks(next, next.revision, [{ ...identity, taskId: 'other', attemptId: 'other-attempt' }], 100);
  expect(other.bindings).toHaveLength(2); expect(other.bindings[0]).toEqual(f.run.bindings[0]);
  expect(measureTaskOccupancy(other.progress)).toEqual({ execution: 1, inFlight: 1 });
});
it('missing custody remains byte-identical and held; explicit held is counted, only released is excluded', () => {
  const f = lostWorker(), encoded = JSON.stringify(f.run);
  expect(JSON.stringify(runSnapshotSchema.parse(JSON.parse(encoded)))).toBe(encoded);
  expect(measureTaskOccupancy(f.run.progress)).toEqual({ execution: 1, inFlight: 1 });
  const held = { schemaVersion: 1 as const, state: 'held' as const, basis: 'termination-proof' as const,
    fenceReceiptId: f.fence.receiptId, proofReceiptId: f.proof.receiptId };
  expect(measureTaskOccupancy([{ ...f.run.progress[0]!, workerCustody: held }])).toEqual({ execution: 1, inFlight: 1 });
  const released = releaseWorkerCustody(f.run, f.run.revision, f.record, f.fence, f.proof);
  expect(measureTaskOccupancy([released.progress[0]!, { ...f.run.progress[0]!, taskId: 'unreleased' }])).toEqual({ execution: 1, inFlight: 1 });
  expect(measureTaskOccupancy(released.progress)).toEqual({ execution: 0, inFlight: 0 });
  expect(() => taskProgressSchema.parse({ ...released.progress[0], workerCustody: { ...held, proofReceiptId: undefined } })).toThrow();
  expect(() => taskProgressSchema.parse({ ...released.progress[0], workerCustody: { ...held, decisionReceiptId: 'smuggled' } })).toThrow();
});
it('refuses non-lost and ungranted records, and an Attempt that has not reached unknown reconciliation', () => {
  const f = lostWorker();
  for (const record of [{ ...f.record, lost: false }, { ...f.record, launch: 'pending' as const }, { ...f.record, launch: 'prevented-before-launch' as const }]) {
    expect(() => releaseWorkerCustody(f.run, f.run.revision, record, f.fence, f.proof)).toThrow('RUN_ATTEMPT_CONFLICT');
  }
  const active = { ...f.run, bindings: f.run.bindings.map(row => ({ ...row, observedKind: 'started' as const })),
    progress: f.run.progress.map(row => row.taskId === identity.taskId ? { ...row, phase: 'active' as const, unresolvedEffects: false } : row) };
  expect(() => releaseWorkerCustody(active, active.revision, f.record, f.fence, f.proof)).toThrow('RUN_ATTEMPT_CONFLICT');
});
