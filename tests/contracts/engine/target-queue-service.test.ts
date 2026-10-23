import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTargetQueue } from '#adapters/core/target-queue-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { createTargetQueueService, createRuntimeServiceClient, selectQueueActor, RUNTIME_SERVICE_SCHEMA_VERSION, TargetQueueApplication, type QueueServiceContext, type TargetQueuePreparation } from '#engine/index.js';
import { candidateBindingSchema, candidateEvidenceSchema, targetQueueRequestSchema, type TargetQueueRecord } from '#domain/index.js';
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
      let mcp = true; const withScope = vi.fn(async <T>(_scope: string, _peer: unknown, _read: boolean, work: (c: QueueServiceContext) => Promise<T>) => work(context));
      const service = createTargetQueueService({ instanceId: 'service', config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: 5 } },
        withScope, snapshot: async () => queue.pending(8), withActor: async (_record, work) => work(),
        effects: async () => ({ fence, async validate() {}, async publish() { return { state: 'unknown' }; }, async adopt() { return { state: 'unknown' }; }, async lookup() { return { state: 'unknown' }; } }),
        preparation: async () => { throw new Error('not-yet-preparing'); }, captureProcess: async () => null, isMcp: () => mcp, record: async () => {} });
      const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' }, input = { schemaVersion: 1, commandId: 'queue', identity, target: binding.target };
      const request = { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'rpc', operation: 'enqueueTargetQueue', input, delivery: { maxResultBytes: 4096 } } as const;
      // DESIGN §6 (Astra 2607 F3): the AI channel never submits. The same enqueue is refused before any scope, store or target port opens.
      await expect(service.execute({ ...request, channel: 'mcp' }, { pid: 42, uid: 1000 }, 8192)).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
      expect(withScope).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled(); expect(fence).not.toHaveBeenCalled();
      expect(queue.load('s', 'queue')).toBeNull(); expect(queue.pending(8)).toEqual([]);
      mcp = false; // the human CLI/Terminal submission stays
      const first = await service.execute(request, { pid: 42, uid: 1000 }, 8192);
      expect(first).toMatchObject({ commandId: 'queue', target: binding.target, state: 'queued', position: 1 });
      expect(await service.execute(request, { pid: 42, uid: 1000 }, 8192)).toMatchObject({ commandId: 'queue', state: 'queued' });
      expect(accepted).toHaveBeenCalledOnce(); expect(fence).not.toHaveBeenCalled(); // admission writes nothing to the target (Astra 2607 F1/F2)
      expect(queue.load('s', 'queue')?.request).toMatchObject({ actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, acceptedRevision: 7, outputDigest: 'c'.repeat(64) });
    } finally { db.close(); }
  });
  // PR #97 hosted CI (node 26): the human's consented execute arrived while the service's own background turn held the target key (every
  // batch window it opens the scope and preparation for the head) and was refused QUEUE_TARGET_BUSY "an earlier ticket owns this target".
  it('a human request waits for the service turn holding its target; another human request in flight still refuses it as busy', async () => {
    const db = new DatabaseSync(':memory:'); migrateLedger(db, 'allow');
    try {
      const queue = new SqliteTargetQueue(db), principal = { id: 'human', issuer: 'os', subject: '1000', assurance: 'os-user', scopeIds: ['s'] } as const;
      const bounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 2, batchWindowMs: 5, leaseMs: 1000, verificationTimeoutMs: 1000, revalidations: 2 };
      const binding = { schemaVersion: 1, installationId: 'i', adapter: { id: 'business-adapter', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'order-42' } } as const;
      const app = new TargetQueueApplication(queue, { async authorize() {}, async validate() {} }, bounds, () => {});
      const context: QueueServiceContext = { principal, document: { revision: 'p' }, config: { targetQueue: { capacity: 8, ttlMs: 1000 } }, queue, bounds, app,
        target: { async binding() { return binding; }, async describe() { return { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' }; } },
        accepted: async () => ({ acceptedRevision: 7, outputDigest: 'c'.repeat(64) }), async describeCandidate() { return { changes: [] }; } };
      let releaseTurn!: () => void; const turn = new Promise<void>(resolve => { releaseTurn = resolve; });
      let turnStarted!: () => void; const started = new Promise<void>(resolve => { turnStarted = resolve; });
      let blockSnapshot: Promise<void> | null = null, snapshotBlocked!: () => void;
      const service = createTargetQueueService({ instanceId: 'service', config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: 5 } },
        withScope: async (_scope, _peer, _read, work) => work(context), withActor: async (_record, work) => work(),
        snapshot: async () => { if (blockSnapshot) { snapshotBlocked(); await blockSnapshot; } return queue.pending(8); },
        effects: async () => { throw new Error('no-effects'); },
        // The background turn holds the key while it prepares (in the product: scope, Git work target and ledger opens on a loaded host).
        preparation: async () => { turnStarted(); await turn; throw new Error('turn-ended'); },
        captureProcess: async () => ({ processStart: 'p', terminal: 't' }), isMcp: () => false, record: async () => {} });
      const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
      const peer = { pid: 42, uid: 1000 }, delivery = { maxResultBytes: 4096 };
      await service.execute({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'enqueue', operation: 'enqueueTargetQueue', input: { schemaVersion: 1, commandId: 'queue', identity, target: binding.target }, delivery }, peer, 8192);
      const execute = { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'execute', operation: 'executeTargetQueue', delivery,
        input: { schemaVersion: 1, scopeId: 's', commandId: 'queue', publishDigest: 'a'.repeat(64), adoptDigest: 'b'.repeat(64) } } as const;
      const ticking = service.tick().catch(error => error as Error); await started;
      let settled = false; const waiting = service.execute(execute, peer, 8192).finally(() => { settled = true; });
      void waiting.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled).toBe(false); // waits for the service turn instead of refusing the human
      releaseTurn();
      expect(await ticking).toMatchObject({ message: 'turn-ended' });
      // It then holds the key itself and reaches its own checks: no consent covers this execute, so the typed refusal is about consent, not busy.
      await expect(waiting).rejects.toMatchObject({ code: 'QUEUE_CONFIRMATION_REQUIRED' });
      // Two human requests on one target: the second is refused while the first holds the key, exactly as before.
      blockSnapshot = new Promise<void>(resolve => { releaseTurn = resolve; }); const blocked = new Promise<void>(resolve => { snapshotBlocked = resolve; });
      const challenge = service.execute({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'challenge', operation: 'challengeTargetQueue', delivery,
        input: { schemaVersion: 1, scopeId: 's', commandId: 'queue', operation: 'publish' } }, peer, 8192); void challenge.catch(() => undefined);
      await blocked;
      await expect(service.execute(execute, peer, 8192)).rejects.toMatchObject({ code: 'QUEUE_TARGET_BUSY' });
      blockSnapshot = null; releaseTurn();
      await challenge.catch(() => undefined); // its own outcome (a queued head is not yet confirmable) is not what this proves
    } finally { db.close(); }
  });
  it('refuses every hidden MCP decision operation before opening a scope or native writer', async () => {
    const withScope = vi.fn(async () => { throw new Error('writer-must-not-open'); });
    const service = createTargetQueueService({ instanceId: 'service', config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: 5 } }, withScope,
      snapshot: async () => [], withActor: async (_record, work) => work(),
      effects: async () => { throw new Error('no-effects'); }, preparation: async () => { throw new Error('no-preparation'); },
      captureProcess: async () => ({ processStart: 'real-process', terminal: 'real-terminal' }), isMcp: () => true, record: async () => {} });
    for (const operation of ['enqueueTargetQueue', 'challengeTargetQueue', 'answerTargetQueue', 'executeTargetQueue', 'enqueueTargetQueueRollback'] as const) {
      await expect(service.execute({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'rpc', operation, channel: 'mcp', input: { confirmed: true, capability: 'forged' }, delivery: { maxResultBytes: 4096 } }, { pid: 42, uid: 1000 }, 8192)).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
    }
    expect(withScope).not.toHaveBeenCalled();
  });
  it('gives the SDK runtime client inspect and list only; submission is a separate CLI/Terminal capability', () => {
    const client = createRuntimeServiceClient({ attempt: async () => { throw new Error('no-call'); }, readPolicy: async () => null, wait: async () => undefined, mapFailure: error => error as Error });
    expect(typeof client.inspectTargetQueue).toBe('function'); expect(typeof client.listTargetQueue).toBe('function');
    expect('enqueueTargetQueue' in client).toBe(false); expect('enqueueTargetQueueRollback' in client).toBe(false);
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

// OTONOM-TESLIM shadow (alpha.53 B1, law-audit folds 1-2): the service evaluates the ticket revision that reached awaiting-confirmation as
// actor `system`; the store is never read back by the queue, so a failing, deleted or altered shadow store leaves queue rows and consent digests unchanged.
describe('queue service autonomy shadow', () => {
  const binding = { schemaVersion: 1, installationId: 'i', adapter: { id: 'business-adapter', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'order-42' } } as const;
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
  function fixture(shadow: (record: TargetQueueRecord) => Promise<void>) {
    const db = new DatabaseSync(':memory:'); migrateLedger(db, 'allow');
    const queue = new SqliteTargetQueue(db), principal = { id: 'human', issuer: 'os', subject: '1000', assurance: 'os-user', scopeIds: ['s'] } as const;
    const bounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 2, batchWindowMs: 1, leaseMs: 60_000, verificationTimeoutMs: 60_000, revalidations: 2 };
    const app = new TargetQueueApplication(queue, { async authorize() {}, async validate() {} }, bounds, () => {});
    const context: QueueServiceContext = { principal, document: { revision: 'p' }, config: { targetQueue: { capacity: 8, ttlMs: 60_000 } }, queue, bounds, app,
      target: { async binding() { return binding; }, async describe() { return { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' }; } },
      accepted: async () => ({ acceptedRevision: 7, outputDigest: 'c'.repeat(64) }), async describeCandidate() { return { changes: ['order-42'] }; } };
    const candidate = candidateBindingSchema.parse({ schemaVersion: 1, target: binding, identity, sourceBinding: 'b'.repeat(64), outputDigest: 'c'.repeat(64), observedVersion: 'V0',
      effectiveVersion: 'V0', candidateVersion: 'V1', candidateDigest: 'd'.repeat(64), custodyReceipt: 'e'.repeat(64), criteria: ['f'.repeat(64)], profileFingerprint: 'a'.repeat(64), replacesCommandId: null });
    const preparation: TargetQueuePreparation = { async prepare() { return candidate; }, async admitVerification() {}, effectIds: () => ['publish', 'adopt'], shadow,
      async evidence() { return candidateEvidenceSchema.parse({ schemaVersion: 1, identity, sourceBinding: candidate.sourceBinding, candidateVersion: candidate.candidateVersion,
        candidateDigest: candidate.candidateDigest, custodyReceipt: candidate.custodyReceipt, criteria: candidate.criteria, profileFingerprint: candidate.profileFingerprint,
        evidenceReceipt: 'f'.repeat(64), phase: 'accepted' }); } };
    const service = createTargetQueueService({ instanceId: 'service', config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: 1 } },
      withScope: async (_scope, _peer, _read, work) => work(context), withActor: async (_record, work) => work(), snapshot: async () => queue.pending(8),
      effects: async () => { throw new Error('no-effects'); }, preparation: async () => preparation,
      captureProcess: async () => ({ processStart: 'p', terminal: 't' }), isMcp: () => false, record: async () => {} });
    const call = (operation: 'enqueueTargetQueue' | 'challengeTargetQueue', input: unknown) => service.execute({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: operation,
      operation, input, delivery: { maxResultBytes: 1 << 20 } } as never, { pid: 42, uid: 1000 }, 1 << 21);
    return { db, queue, service, call, enqueue: async () => { await call('enqueueTargetQueue', { schemaVersion: 1, commandId: 'q1', identity, target: binding.target }); await new Promise(resolve => setTimeout(resolve, 5)); },
      challenge: () => call('challengeTargetQueue', { schemaVersion: 1, scopeId: 's', commandId: 'q1', operation: 'publish' }) as Promise<{ digest: string }> };
  }
  it('evaluates once per revision that reaches awaiting-confirmation; a deleted or altered store changes no queue row or consent digest', async () => {
    const store = new Map<string, string>(), f = fixture(async record => { store.set(`${record.request.commandId}:${record.revision}`, record.state); });
    try {
      await f.enqueue(); await f.service.tick();
      const waiting = f.queue.load('s', 'q1')!;
      expect(waiting.state).toBe('awaiting-confirmation'); expect([...store]).toEqual([[`q1:${waiting.revision}`, 'awaiting-confirmation']]);
      await f.service.tick(); expect(store.size).toBe(1); // a waiting ticket is not evaluated again
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      try {
        const before = { row: JSON.stringify(f.queue.load('s', 'q1')), digest: (await f.challenge()).digest };
        store.clear(); store.set('q1:999', 'forged would-deliver');
        await f.service.tick();
        expect({ row: JSON.stringify(f.queue.load('s', 'q1')), digest: (await f.challenge()).digest }).toEqual(before);
      } finally { now.mockRestore(); }
    } finally { f.db.close(); }
  });
  it('a failing shadow write is diagnosed with a typed code after the turn; the ticket still reaches awaiting-confirmation', async () => {
    const f = fixture(async () => { throw new Error('ENOSPC'); });
    try {
      await f.enqueue();
      await expect(f.service.tick()).rejects.toMatchObject({ code: 'AUTONOMY_SHADOW_NOT_RECORDED' });
      expect(f.queue.load('s', 'q1')?.state).toBe('awaiting-confirmation');
      await f.service.tick(); // no new evaluation, no new failure
    } finally { f.db.close(); }
  });
});
