import { expect, it } from 'vitest';
import { planSchedulingWave } from '#engine/index.js';
import type { TaskGraph, TaskProgress } from '#domain/index.js';
import { diagnoseReservationWave, measureResourceOccupancy } from '#engine/core/scheduling/index.js';
const subscription = '5d68b7c0-e5f3-4a95-8319-f97ede9d5cb3';
const otherSubscription = '13245373-2311-4f13-bc93-e456c6abb7d4';
function fixture(count: number) {
  const graph: TaskGraph = { schemaVersion: 2, revision: 1, tasks: Array.from({ length: count }, (_, i) => ({ id: String(i), kind: 'custom-kind', dependencies: [], acceptanceCriteria: ['verified'] })),
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verify task result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
  const progress: TaskProgress[] = graph.tasks.map(task => ({ taskId: task.id, phase: 'pending', unresolvedEffects: false, eligibility: { kind: 'immediate' } }));
  const input = { schemaVersion: 2, capacity: { executionSlots: 6, inFlightSlots: 8 }, ordering: graph.tasks.map(task => task.id), snapshot: { graphRevision: 1, now: 10, progress } };
  return { graph, input, progress };
}
it('bounds a 50-task plan, follows explicit policy order and replenishes only released capacity', () => {
  const { graph, input, progress } = fixture(50); input.ordering.reverse();
  const first = planSchedulingWave(graph, input); expect(first.selectedTaskIds).toEqual(['49', '48', '47', '46', '45', '44']);
  for (const id of first.selectedTaskIds) progress[Number(id)] = { ...progress[Number(id)]!, phase: 'active' };
  expect(planSchedulingWave(graph, input).selectedTaskIds).toEqual([]);
  progress[49] = { ...progress[49]!, phase: 'evaluating' };
  expect(planSchedulingWave(graph, input).selectedTaskIds).toEqual(['43']);
  progress[43] = { ...progress[43]!, phase: 'active' };
  progress[48] = { ...progress[48]!, phase: 'evaluating' };
  expect(planSchedulingWave(graph, input).selectedTaskIds).toEqual(['42']);
  progress[42] = { ...progress[42]!, phase: 'active' }; progress[47] = { ...progress[47]!, phase: 'evaluating' };
  expect(planSchedulingWave(graph, input).selectedTaskIds).toEqual([]); // evaluation backlog consumes in-flight budget
  progress[49] = { ...progress[49]!, phase: 'accepted' };
  expect(planSchedulingWave(graph, input).selectedTaskIds).toEqual(['41']);
});
it('keeps dependent work closed until acceptance and retains uncertain execution capacity', () => {
  const { graph, input, progress } = fixture(4);
  const dependent = { ...graph, tasks: graph.tasks.map(task => task.id === '1' ? { ...task, dependencies: ['0'] } : task) };
  input.capacity = { executionSlots: 1, inFlightSlots: 2 }; progress[0] = { ...progress[0]!, phase: 'evaluating' };
  expect(planSchedulingWave(dependent, input).selectedTaskIds).toEqual(['2']);
  progress[0] = { ...progress[0]!, phase: 'reconciling', unresolvedEffects: true };
  expect(planSchedulingWave(dependent, input).selectedTaskIds).toEqual([]);
  progress[0] = { ...progress[0]!, phase: 'accepted', unresolvedEffects: false };
  expect(planSchedulingWave(dependent, input).selectedTaskIds).toEqual(['1']);
  progress[0] = { ...progress[0]!, phase: 'failed' };
  expect(planSchedulingWave(dependent, input).readiness.find(x => x.taskId === '1')!.disposition).toBe('blocked');
  // Two projects/models share one opaque subscription resource; an unrelated resource can still progress.
  const otherProject = fixture(1), current = fixture(3), capacity = { executionSlots: 1, inFlightSlots: 1 };
  otherProject.progress[0] = { ...otherProject.progress[0]!, phase: 'active' };
  expect(measureResourceOccupancy([{ resourceKey: subscription, progress: otherProject.progress },
    { resourceKey: subscription.toUpperCase(), progress: otherProject.progress }]).get(subscription)).toEqual({ execution: 2, inFlight: 2 });
  const plan = () => planSchedulingWave(current.graph, { ...current.input, resourceCapacity: {
    bindings: [{ taskId: '0', resourceKey: subscription }, { taskId: '1', resourceKey: subscription }, { taskId: '2', resourceKey: otherSubscription }],
    resources: [{ resourceKey: subscription, capacity, occupancy: measureResourceOccupancy([{ resourceKey: subscription, progress: otherProject.progress }]).get(subscription) },
      { resourceKey: otherSubscription, capacity, occupancy: { execution: 0, inFlight: 0 } }],
  } });
  expect(plan()).toMatchObject({ selectedTaskIds: ['2'], deferredTaskIds: ['0', '1'], resourceWaits: [
    { taskId: '0', resourceKey: subscription, code: 'waiting-resource-slot' }, { taskId: '1', resourceKey: subscription, code: 'waiting-resource-slot' }],
  });
  // A cancellation/crash with unresolved custody retains its slot until termination is established.
  otherProject.progress[0] = { ...otherProject.progress[0]!, phase: 'cancelled', unresolvedEffects: true };
  expect(plan().selectedTaskIds).toEqual(['2']);
  otherProject.progress[0] = { ...otherProject.progress[0]!, workerCustody: { schemaVersion: 1, state: 'released', basis: 'termination-proof', fenceReceiptId: 'fence', proofReceiptId: 'termination' } };
  expect(plan().selectedTaskIds).toEqual(['0', '2']); // not both models, even within one wave
  otherProject.progress[0] = { ...otherProject.progress[0]!, workerCustody: undefined, phase: 'reconciling' };
  expect(plan().selectedTaskIds).toEqual(['2']);
  otherProject.progress[0] = { ...otherProject.progress[0]!, phase: 'evaluating', unresolvedEffects: false };
  expect(plan().selectedTaskIds).toEqual(['2']); // evaluation still holds in-flight capacity
  const blocked = planSchedulingWave(current.graph, { ...current.input, resourceCapacity: {
    bindings: current.graph.tasks.map(task => ({ taskId: task.id, resourceKey: subscription })),
    resources: [{ resourceKey: subscription, capacity, occupancy: { execution: 1, inFlight: 1 } }],
  } });
  expect(diagnoseReservationWave(blocked, 'application-empty', 0, current.input.capacity)).toMatchObject({ reason: 'resource-capacity-exhausted', resourceWaitingCount: 3 });
});
it('fails invalid orders/revisions and respects explicit not-before eligibility or reduced limits', () => {
  const { graph, input, progress } = fixture(3);
  for (const ordering of [['0', '0', '2'], ['0', '1'], ['0', '1', 'foreign']]) expect(() => planSchedulingWave(graph, { ...input, ordering })).toThrow('SCHEDULING_ORDER_INVALID');
  expect(() => planSchedulingWave(graph, { ...input, snapshot: { ...input.snapshot, graphRevision: 2 } })).toThrow('TASK_GRAPH_REVISION_MISMATCH');
  progress[0] = { ...progress[0]!, eligibility: { kind: 'not-before', at: 11 } }; input.capacity = { executionSlots: 1, inFlightSlots: 1 };
  expect(planSchedulingWave(graph, input).selectedTaskIds).toEqual(['1']);
  progress[1] = { ...progress[1]!, phase: 'active' }; input.capacity = { executionSlots: 0, inFlightSlots: 0 };
  expect(planSchedulingWave(graph, input).selectedTaskIds).toEqual([]);
  const resource = { resourceKey: subscription, capacity: { executionSlots: 1, inFlightSlots: 1 }, occupancy: { execution: 0, inFlight: 0 } };
  const bindings = [{ taskId: '0', resourceKey: subscription }];
  for (const resourceCapacity of [
    { bindings, resources: [] }, { bindings, resources: [resource, { ...resource, resourceKey: subscription.toUpperCase() }] },
    { bindings: [...bindings, ...bindings], resources: [resource] },
    { bindings: [{ taskId: 'foreign', resourceKey: subscription }], resources: [resource] },
    { bindings: [{ taskId: '0', resourceKey: 'account-or-login-path' }], resources: [resource] },
    { bindings, resources: [{ ...resource, occupancy: { execution: -1, inFlight: 0 } }] },
  ]) expect(() => planSchedulingWave(graph, { ...input, resourceCapacity })).toThrow('SCHEDULING_INPUT_INVALID');
});
it('selects a bounded wave from a 10k-task graph without treating the example as a throughput guarantee', () => {
  const { graph, input } = fixture(10000); input.capacity = { executionSlots: 500, inFlightSlots: 750 };
  const result = planSchedulingWave(graph, input); expect(result.selectedTaskIds).toHaveLength(500); expect(result.deferredTaskIds).toHaveLength(9500);
  expect(Object.isFrozen(result.selectedTaskIds)).toBe(true);
});
