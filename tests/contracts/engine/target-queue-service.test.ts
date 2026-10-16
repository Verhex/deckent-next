import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTargetQueue } from '#adapters/core/target-queue-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { createTargetQueueService, selectQueueActor, RUNTIME_SERVICE_SCHEMA_VERSION, TargetQueueApplication, type QueueServiceContext } from '#engine/index.js';
import { targetQueueRequestSchema, type TargetQueueRecord } from '#domain/index.js';
describe('queue service ingress', () => {
  it('admits a business record through adapter ports with durable replay and no Git-specific input', async () => {
    const db = new DatabaseSync(':memory:'); migrateLedger(db, 'allow');
    try {
      const queue = new SqliteTargetQueue(db), principal = { id: 'human', issuer: 'os', subject: '1000', assurance: 'os-user', scopeIds: ['s'] } as const;
      const bounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 2, batchWindowMs: 5, leaseMs: 1000, verificationTimeoutMs: 1000, revalidations: 2 };
      const binding = { schemaVersion: 1, installationId: 'i', adapter: { id: 'business-adapter', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'order-42' } } as const;
      const app = new TargetQueueApplication(queue, { async authorize() {}, async validate(request) { expect(request.target).toEqual(binding); } }, bounds, () => {});
      const accepted = vi.fn(async () => ({ acceptedRevision: 7, outputDigest: 'c'.repeat(64) })), fence = vi.fn(async () => 'native-fence');
      const context: QueueServiceContext = { principal, document: { revision: 'p' }, config: { targetQueue: { capacity: 8, ttlMs: 1000 } }, queue, bounds, app,
        target: { async binding(target) { expect(target).toEqual(binding.target); return binding; }, async describe() { return { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' }; } },
        accepted, async describeCandidate() { return { changes: ['order-42: approved amount'] }; } };
      const service = createTargetQueueService({ instanceId: 'service', config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: 5 } },
        async withScope(_scope, _peer, _read, work) { return work(context); }, snapshot: async () => queue.pending(8), withActor: async (_record, work) => work(),
        effects: async () => ({ fence, async validate() {}, async publish() { return { state: 'unknown' }; }, async adopt() { return { state: 'unknown' }; }, async lookup() { return { state: 'unknown' }; } }),
        preparation: async () => { throw new Error('not-yet-preparing'); }, captureProcess: async () => null, isMcp: () => true, record: async () => {} });
      const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' }, input = { schemaVersion: 1, commandId: 'queue', identity, target: binding.target };
      const request = { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'rpc', operation: 'enqueueTargetQueue', input, delivery: { maxResultBytes: 4096 } } as const;
      const first = await service.execute(request, { pid: 42, uid: 1000 }, 8192);
      expect(first).toMatchObject({ commandId: 'queue', target: binding.target, state: 'queued', position: 1 });
      expect(await service.execute(request, { pid: 42, uid: 1000 }, 8192)).toMatchObject({ commandId: 'queue', state: 'queued' });
      expect(accepted).toHaveBeenCalledOnce(); expect(fence).toHaveBeenCalledOnce();
      expect(queue.load('s', 'queue')?.request).toMatchObject({ actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, acceptedRevision: 7, outputDigest: 'c'.repeat(64) });
    } finally { db.close(); }
  });
  it('refuses every hidden MCP decision operation before opening a scope or native writer', async () => {
    const withScope = vi.fn(async () => { throw new Error('writer-must-not-open'); });
    const service = createTargetQueueService({ instanceId: 'service', config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: 5 } }, withScope,
      snapshot: async () => [], withActor: async (_record, work) => work(),
      effects: async () => { throw new Error('no-effects'); }, preparation: async () => { throw new Error('no-preparation'); },
      captureProcess: async () => ({ processStart: 'real-process', terminal: 'real-terminal' }), isMcp: () => true, record: async () => {} });
    for (const operation of ['challengeTargetQueue', 'answerTargetQueue', 'executeTargetQueue', 'enqueueTargetQueueRollback'] as const) {
      await expect(service.execute({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'rpc', operation, channel: 'mcp', input: { confirmed: true, capability: 'forged' }, delivery: { maxResultBytes: 4096 } }, { pid: 42, uid: 1000 }, 8192)).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
    }
    expect(withScope).not.toHaveBeenCalled();
  });
  it('never launders an admitted MCP actor into the human background identity', () => {
    const human = { id: 'human', issuer: 'os', subject: '1000' }, mcp = { id: 'mcp', issuer: 'mcp', subject: '1000' };
    const request = targetQueueRequestSchema.parse({ schemaVersion: 1, commandId: 'queue', identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' },
      target: { schemaVersion: 1, installationId: 'i', adapter: { id: 'git', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'git-ref', id: 'refs/heads/integration' } }, actor: mcp,
      payloadDigest: 'b'.repeat(64), policyRevision: 'p', outputDigest: 'c'.repeat(64), acceptedRevision: 1, submittedAt: 1, deadline: 100 });
    const record = { request } as TargetQueueRecord;
    expect(selectQueueActor(record, channel => channel === 'mcp' ? mcp : human)).toBe('mcp');
    expect(() => selectQueueActor(record, () => human)).toThrow('QUEUE_AUTHORITY_REQUIRED');
  });
});
