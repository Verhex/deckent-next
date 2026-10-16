import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createRuntimeEventsConsumer, RUNTIME_SERVICE_SCHEMA_VERSION, RUNTIME_SERVICE_LIFECYCLE_VERSIONS, runtimeServiceRequestSchema,
  runtimeServiceSubscriptionFrameSchema, runtimeServiceEventFrameSchema, classifyRuntimeServiceOperation } from '#engine/index.js';
const scopeId = 'scope', serviceEpoch = randomUUID(), viewId = randomUUID(), snapshotId = randomUUID();
const query = { schemaVersion: 1, scopeId, topics: ['run'], resume: null };
const ready = { type: 'ready' as const, scopeId, topics: ['run' as const], serviceEpoch, viewId, mode: 'observation-order' as const };
const resume = { serviceEpoch, viewId, sequence: 0 };
const record = { topic: 'run' as const, entity: 'run' as const, id: 'run', revision: 0, status: 'running' as const, observedAt: 1, evidence: 'ledger' as const, sourceLoss: false };
it('v29 has a separate bounded control subscription and retains only the previous lifecycle envelope', () => {
  expect(RUNTIME_SERVICE_SCHEMA_VERSION).toBe(29); expect(RUNTIME_SERVICE_LIFECYCLE_VERSIONS).toEqual([29, 28]);
  const request = { schemaVersion: 29, requestId: 'r', operation: 'subscribeEvents', input: query, delivery: { maxResultBytes: 4096 } };
  expect(runtimeServiceRequestSchema.safeParse(request).success).toBe(true); expect(classifyRuntimeServiceOperation('subscribeEvents')).toBe('control');
  for (const input of [{ ...query, actor: 'owner' }, { ...query, principal: 'owner' }, { ...query, topics: ['unknown'] }, { ...query, topics: ['run', 'run'] }, { ...query, resume: { ...resume, sequence: -1 } }]) {
    expect(runtimeServiceRequestSchema.safeParse({ ...request, input }).success).toBe(false);
  }
  expect(runtimeServiceRequestSchema.safeParse({ ...request, schemaVersion: 28 }).success).toBe(false);
  expect(runtimeServiceRequestSchema.safeParse({ ...request, delivery: undefined }).success).toBe(false);
  const frame = { schemaVersion: 29, requestId: 'r', kind: 'subscription', sequence: 0, item: ready };
  expect(runtimeServiceSubscriptionFrameSchema.safeParse(frame).success).toBe(true); expect(runtimeServiceEventFrameSchema.safeParse(frame).success).toBe(false);
});
it('requires one matching ready and one complete snapshot before live changes', () => {
  const accept = createRuntimeEventsConsumer(query); accept(ready); accept({ type: 'snapshot.begin', snapshotId }); accept({ type: 'snapshot.part', snapshotId, record });
  accept({ type: 'snapshot.end', snapshotId, resume }); accept({ type: 'change', operation: 'upsert', record: { ...record, revision: 1 }, resume: { ...resume, sequence: 1 } });
  expect(() => accept(ready)).toThrow();
});
it('refuses foreign scope/topics, mixed view tokens, mismatched snapshots and changes during an incomplete capture', () => {
  expect(() => createRuntimeEventsConsumer(query)({ ...ready, scopeId: 'foreign' })).toThrow();
  expect(() => createRuntimeEventsConsumer(query)({ ...ready, topics: ['usage'] })).toThrow();
  const accept = createRuntimeEventsConsumer(query); accept(ready);
  expect(() => accept({ type: 'change', operation: 'upsert', record, resume: { ...resume, sequence: 1 } })).toThrow();
  accept({ type: 'snapshot.begin', snapshotId });
  expect(() => accept({ type: 'snapshot.end', snapshotId: randomUUID(), resume })).toThrow();
  expect(() => accept({ type: 'close', reason: 'cancelled', resume: { ...resume, viewId: randomUUID() } })).toThrow();
});
it('gap invalidates an in-progress snapshot, allows a fresh barrier and never implies work cancellation', () => {
  const accept = createRuntimeEventsConsumer(query); accept(ready); accept({ type: 'snapshot.begin', snapshotId });
  accept({ type: 'gap', reason: 'overflow', resume: { ...resume, sequence: 5 }, requiresSnapshot: true, missing: null });
  expect(() => accept({ type: 'change', operation: 'upsert', record, resume: { ...resume, sequence: 6 } })).toThrow();
  const next = randomUUID(); accept({ type: 'snapshot.begin', snapshotId: next }); accept({ type: 'snapshot.end', snapshotId: next, resume: { ...resume, sequence: 5 } });
  accept({ type: 'close', reason: 'service-shutdown', resume: { ...resume, sequence: 5 } });
});
