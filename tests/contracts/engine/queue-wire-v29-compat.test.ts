import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { SqliteTargetQueue } from '#adapters/core/target-queue-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { createRuntimeQueueSubmission, createTargetQueueService, queueInspectionSchema, queuePageSchema, RUNTIME_SERVICE_SCHEMA_VERSION, TargetQueueApplication,
  targetQueueViewSchema, type QueueServiceContext } from '#engine/index.js';
import { attemptIdentitySchema, effectTargetRefSchema, identitySchema, queueReasonSchema, targetDisplaySchema, targetQueueOutcomeSchema,
  targetQueueStateSchema } from '#domain/index.js';

/**
 * Astra 2661 R2: the delivery-queue wire shape is protocol v29 on both sides, with no build handshake in front of queue calls. A field the
 * alpha.47 strict view does not know breaks every alpha.47 client (list, inspect, confirm's first inspect, and the enqueue reply after the
 * ticket was durably admitted). This file pins the alpha.47 view as the oracle: verbatim from `ab055423:src/engine/core/effect/internal/
 * queue-view.ts` (the domain schemas it imports are unchanged since that commit). A new view field needs a protocol bump, not a test edit.
 */
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const alpha47ReattemptSchema = z.object({ state: z.enum(['waiting-base', 'awaiting-approval', 'running', 'enqueued', 'refused', 'failed', 'exhausted']),
  count: z.number().int().nonnegative().safe(), bound: z.number().int().nonnegative().safe().optional(), cause: queueReasonSchema,
  runId: identitySchema.optional(), commandId: identitySchema.optional(), reason: queueReasonSchema.optional() }).strict().readonly();
const alpha47ViewSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema, identity: attemptIdentitySchema,
  operation: z.enum(['delivery', 'rollback']), target: effectTargetRefSchema, display: targetDisplaySchema, state: targetQueueStateSchema, outcome: targetQueueOutcomeSchema.nullable(), revision: z.number().int().nonnegative().safe(),
  observedAt: z.number().int().nonnegative().safe(), freshness: z.literal('last-known'), position: z.number().int().positive().safe().nullable(),
  nextAction: z.enum(['wait-service', 'confirm-batch', 'watch-reconciliation', 'new-attempt', 'select-target', 'prepare-current', 'inspect-receipt', 'approve-run']),
  responsibility: z.enum(['human', 'reconciler', 'service']), basis: z.object({ observed: z.string(), effective: z.string(), candidate: z.string() }).strict().nullable(),
  verification: z.object({ phase: z.enum(['accepted', 'failed', 'pending', 'cancelled', 'unknown']), receipt: digest }).strict().nullable(), evidenceRefs: z.array(digest),
  reason: queueReasonSchema.nullable().optional(),
  reattempt: alpha47ReattemptSchema.optional(),
  delegation: z.object({ grantedBy: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict(), runId: identitySchema,
    requeues: z.number().int().nonnegative().safe() }).strict().optional() }).strict().readonly();
const alpha47InspectionSchema = z.object({ schemaVersion: z.literal(1), record: alpha47ViewSchema.nullable() }).strict().readonly();
const alpha47PageSchema = z.object({ schemaVersion: z.literal(1), records: z.array(alpha47ViewSchema) }).strict().readonly();
const ALPHA47_VIEW_KEYS = ['schemaVersion', 'commandId', 'identity', 'operation', 'target', 'display', 'state', 'outcome', 'revision', 'observedAt', 'freshness',
  'position', 'nextAction', 'responsibility', 'basis', 'verification', 'evidenceRefs', 'reason', 'reattempt', 'delegation'];

/** The real queue service over an in-memory ledger: what a new service actually sends for enqueue, inspect and list. */
function service() {
  const db = new DatabaseSync(':memory:'); migrateLedger(db, 'allow');
  const queue = new SqliteTargetQueue(db), principal = { id: 'human', issuer: 'os', subject: '1000', assurance: 'os-user', scopeIds: ['s'] } as const;
  const bounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 2, batchWindowMs: 5, leaseMs: 1000, verificationTimeoutMs: 1000, revalidations: 2 };
  const binding = { schemaVersion: 1, installationId: 'i', adapter: { id: 'business-adapter', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'order-42' } } as const;
  const app = new TargetQueueApplication(queue, { async authorize() {}, async validate() {} }, bounds, () => {});
  const context: QueueServiceContext = { principal, document: { revision: 'p' }, config: { targetQueue: { capacity: 8, ttlMs: 1000 } }, queue, bounds, app,
    target: { async binding() { return binding; }, async describe() { return { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' }; } },
    accepted: async () => ({ acceptedRevision: 7, outputDigest: 'c'.repeat(64) }), async describeCandidate() { return { changes: [] }; } };
  const queueService = createTargetQueueService({ instanceId: 'service', config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: 5 } },
    withScope: async (_scope, _peer, _read, work) => work(context), withActor: async (_record, work) => work(), snapshot: async () => queue.pending(8),
    effects: async () => { throw new Error('no-effects'); }, preparation: async () => { throw new Error('not-preparing'); },
    captureProcess: async () => null, isMcp: () => false, record: async () => {} });
  const call = (operation: 'enqueueTargetQueue' | 'inspectTargetQueue' | 'listTargetQueue', input: unknown) => queueService.execute({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION,
    requestId: operation, operation, input, delivery: { maxResultBytes: 65536 } } as never, { pid: 42, uid: 1000 }, 65536);
  return { db, call, target: binding.target };
}
const identity = (taskId: string) => ({ scopeId: 's', runId: 'r', taskId, attemptId: 'a', generation: 1, layoutRevision: 'l' });

describe('delivery queue wire, protocol v29 (Astra 2661 R2)', () => {
  it('the current view schema has exactly the alpha.47 keys: a new view field needs a protocol bump', () => {
    expect(Object.keys(targetQueueViewSchema.unwrap().shape)).toEqual(ALPHA47_VIEW_KEYS);
    expect(Object.keys(alpha47ViewSchema.unwrap().shape)).toEqual(ALPHA47_VIEW_KEYS);
  });

  it('old client → new service: the enqueue reply, inspect and list a new service sends parse with the alpha.47 strict schemas', async () => {
    const s = service();
    try {
      const enqueued = await s.call('enqueueTargetQueue', { schemaVersion: 1, commandId: 'q-1', identity: identity('t1'), target: s.target });
      expect(Object.keys(enqueued as object).every(key => ALPHA47_VIEW_KEYS.includes(key))).toBe(true);
      expect(alpha47ViewSchema.parse(enqueued)).toMatchObject({ commandId: 'q-1', state: 'queued' });
      await s.call('enqueueTargetQueue', { schemaVersion: 1, commandId: 'q-2', identity: identity('t2'), target: s.target });
      // Inspect is also the first call of an alpha.47 `integration-queue-confirm`; its consent and execution schemas are byte-identical since alpha.47.
      expect(alpha47InspectionSchema.parse(await s.call('inspectTargetQueue', { schemaVersion: 1, scopeId: 's', commandId: 'q-1' })).record?.commandId).toBe('q-1');
      expect(alpha47InspectionSchema.parse(await s.call('inspectTargetQueue', { schemaVersion: 1, scopeId: 's', commandId: 'missing' })).record).toBeNull();
      const page = alpha47PageSchema.parse(await s.call('listTargetQueue', { schemaVersion: 1, scopeId: 's', after: null, limit: 8 }));
      expect(page.records.map(view => view.commandId)).toEqual(['q-1', 'q-2']);
    } finally { s.db.close(); }
  });

  it('new client → old service: the current client accepts the alpha.47 view shape for enqueue, inspect and list', async () => {
    // Literal alpha.47 view (every key alpha.47 sends for an ordinary queued ticket), checked against the pinned oracle first.
    const view = alpha47ViewSchema.parse({ schemaVersion: 1, commandId: 'q-1', identity: identity('t1'), operation: 'delivery', target: { kind: 'record', id: 'order-42' },
      display: { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' },
      state: 'queued', outcome: null, revision: 0, observedAt: 10, freshness: 'last-known', position: 1, nextAction: 'wait-service', responsibility: 'service',
      basis: null, verification: null, evidenceRefs: [], reason: null });
    const replies: Record<string, unknown> = { enqueueTargetQueue: view, inspectTargetQueue: { schemaVersion: 1, record: view }, listTargetQueue: { schemaVersion: 1, records: [view] } };
    const client = createRuntimeQueueSubmission({ attempt: async operation => replies[operation], readPolicy: async () => null, wait: async () => undefined,
      mapFailure: error => error });
    expect(await client.enqueueTargetQueue({ schemaVersion: 1, commandId: 'q-1', identity: identity('t1'), target: view.target })).toEqual(view);
    expect((await client.inspectTargetQueue({ schemaVersion: 1, scopeId: 's', commandId: 'q-1' })).record?.commandId).toBe('q-1');
    expect((await client.listTargetQueue({ schemaVersion: 1, scopeId: 's', after: null, limit: 10 })).records).toHaveLength(1);
    // The restored shape is strict again: a view carrying an unknown key (as the deferred `submittedAt` would) is refused, never silently read.
    expect(targetQueueViewSchema.safeParse({ ...view, submittedAt: 1 }).success).toBe(false);
    expect(queuePageSchema.safeParse({ schemaVersion: 1, records: [{ ...view, submittedAt: 1 }] }).success).toBe(false);
    expect(queueInspectionSchema.safeParse({ schemaVersion: 1, record: { ...view, submittedAt: 1 } }).success).toBe(false);
  });
});
