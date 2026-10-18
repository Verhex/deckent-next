import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTargetQueue } from '#adapters/core/target-queue-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { createTargetQueueService, RUNTIME_SERVICE_SCHEMA_VERSION, TargetQueueApplication, stepDeliveryReattempt, reattemptCommandIds, reattemptEligibility,
  reattemptGraph, queueEnqueueSchema, selectQueueActor, type QueueServiceContext, type ReattemptEffects, type TargetQueueView } from '#engine/index.js';
import { queueServiceActor, targetQueueRequestSchema, type RunSnapshot, type TargetQueueRecord } from '#domain/index.js';

// alpha.47 S5b (owner D1a + D2b, 2026-10-18). A delivery ticket that the target refused because its base advanced is re-attempted ONCE by the
// service, only under the human's per-Run delivery intent: the same frozen Task runs again as a new single-task Run on the current base, and
// its accepted Attempt is enqueued by the human's service principal (delegation recorded) for the same two human cards. Business target, no Git.
const human = { id: 'human', issuer: 'os', subject: '1000', assurance: 'os-user', scopeIds: ['s'] } as const;
const bounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 2, batchWindowMs: 1, leaseMs: 1000, verificationTimeoutMs: 60000, revalidations: 2, reattempts: 1 };
const binding = { schemaVersion: 1, installationId: 'i', adapter: { id: 'business-adapter', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'order-42' } } as const;
const display = { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' } as const;
const identity = (runId: string, taskId = 't') => ({ scopeId: 's', runId, taskId, attemptId: `${runId}-${taskId}-1`, generation: 1, layoutRevision: 'l' });
const criterion = { id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } };
const workInput = { schemaVersion: 1, task: 'Set the approved amount of order 42', scope: { paths: ['orders/42'] }, acceptance: 'The amount is approved',
  model: { channelId: 'claude', modelId: 'claude-opus-5-5', auxiliaryModelIds: [] } };
const profile = { id: 'worker', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {} };
type Phase = 'pending' | 'active' | 'accepted' | 'failed';
/** A Run snapshot with the fields the re-attempt reads: graph, per-task progress, exited bindings and the frozen profile. */
function run(runId: string, tasks: readonly { id: string; phase: Phase; dependencies?: unknown[]; inputs?: unknown[]; observed?: string; unresolved?: boolean }[]) {
  return { identity: { runId, scopeId: 's', layoutRevision: 'l' }, revision: 3, state: { kind: tasks.every(task => task.phase === 'accepted' || task.phase === 'failed') ? 'terminal' : 'running' },
    graph: { schemaVersion: 4, revision: 1, criterionDefinitions: [criterion],
      tasks: tasks.map(task => ({ id: task.id, kind: 'coding', dependencies: task.dependencies ?? [], acceptanceCriteria: ['exit'], workInput, ...(task.inputs ? { inputs: task.inputs } : {}) })) },
    progress: tasks.map(task => ({ taskId: task.id, phase: task.phase, unresolvedEffects: task.unresolved ?? false, eligibility: { kind: 'immediate' } })),
    bindings: tasks.filter(task => task.phase !== 'pending').map(task => ({ identity: identity(runId, task.id), observedKind: task.observed ?? 'exited' })),
    execution: { schemaVersion: 1, registryRevision: 'r', tasks: tasks.map(task => ({ taskId: task.id, profile })), criteria: [] } } as unknown as RunSnapshot;
}
const conflict = Object.assign(new Error('PATCH_BASE_ADVANCED'), { code: 'PATCH_BASE_ADVANCED' });

function fixture(options: { effects?: ReattemptEffects; advanced?: boolean; approval?: boolean } = {}) {
  const db = new DatabaseSync(':memory:'); migrateLedger(db, 'allow');
  const queue = new SqliteTargetQueue(db), app = new TargetQueueApplication(queue, { async authorize() {}, async validate() {} }, bounds, () => {});
  const runs = new Map<string, RunSnapshot>([['r', run('r', [{ id: 't', phase: 'accepted' }])]]);
  const admitted: { runId: string; commandId: string; graph: unknown }[] = [], submitted: TargetQueueRecord[] = [];
  let conflicting = new Set<string>(), approval = options.approval ?? false;
  const context: QueueServiceContext = { principal: human, document: { revision: 'p' }, config: { targetQueue: { capacity: 8, ttlMs: 60000 } }, queue, bounds, app,
    target: { async binding() { return binding; }, async describe() { return display; } },
    accepted: async () => ({ acceptedRevision: 3, outputDigest: 'c'.repeat(64) }), async describeCandidate() { return { changes: ['orders/42'] }; } };
  const candidate = (record: TargetQueueRecord) => ({ schemaVersion: 1, target: binding, identity: record.request.identity, sourceBinding: 'd'.repeat(64), outputDigest: 'c'.repeat(64),
    observedVersion: 'V2', effectiveVersion: 'V2', candidateVersion: 'V3', candidateDigest: 'e'.repeat(64), custodyReceipt: 'f'.repeat(64), criteria: ['1'.repeat(64)],
    profileFingerprint: '2'.repeat(64), replacesCommandId: null }) as const;
  const preparation = { async prepare(record: TargetQueueRecord) { if (conflicting.has(record.request.commandId)) throw conflict; return candidate(record); },
    async admitVerification() {}, effectIds: () => ['x1', 'x2', 'x3', 'x4'],
    async evidence(record: TargetQueueRecord) { const c = candidate(record); return { schemaVersion: 1, candidateDigest: c.candidateDigest, custodyReceipt: c.custodyReceipt,
      sourceBinding: c.sourceBinding, candidateVersion: c.candidateVersion, profileFingerprint: c.profileFingerprint, criteria: c.criteria, identity: c.identity, evidenceReceipt: '3'.repeat(64), phase: 'accepted' } as const; } };
  const ports = { bound: bounds.reattempts, policyRevision: 'p', ttlMs: 60000, now: Date.now, load: (scopeId: string, commandId: string) => queue.load(scopeId, commandId),
    forRun: (scopeId: string, runId: string) => queue.forRun(scopeId, runId, 8), loadRun: async (_scope: string, runId: string) => runs.get(runId) ?? null,
    effects: () => options.effects ?? 'workspace-only', baseAdvanced: vi.fn(async () => options.advanced ?? true),
    admit: vi.fn(async (command: { runId: string; commandId: string; graph: unknown }) => {
      if (approval) throw Object.assign(new Error('RUN_APPROVAL_REQUIRED'), { code: 'RUN_APPROVAL_REQUIRED' });
      if (!runs.has(command.runId)) { admitted.push(command); runs.set(command.runId, run(command.runId, [{ id: 't', phase: 'active' }])); } }),
    accepted: context.accepted, submit: async (request: unknown) => { const record = await app.submitReattempt(request, human); submitted.push(record); return record; } };
  let mcp = false;
  const service = createTargetQueueService({ instanceId: 'service', config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: 1 } },
    withScope: async (_scope, _peer, _read, work) => work(context), snapshot: async () => queue.pending(8), withActor: async (_record, work) => work(),
    effects: async () => { throw new Error('no-effect-without-cards'); }, preparation: async () => preparation, isMcp: () => mcp, record: async () => {},
    captureProcess: async () => ({ processStart: 'start', terminal: 'tty' }),
    reattempts: async () => queue.reattemptable(0, 8), reattempt: (_c, record, act) => stepDeliveryReattempt(ports, record, act) });
  const peer = { pid: 42, uid: 1000 }, delivery = { maxResultBytes: 1 << 16 };
  const call = <T>(operation: string, input: unknown) => service.execute({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: operation, operation, input, delivery } as never, peer, 1 << 17) as Promise<T>;
  const enqueue = (commandId: string, runId: string, intent = true) => call<TargetQueueView>('enqueueTargetQueue',
    { schemaVersion: 1, commandId, identity: identity(runId), target: binding.target, ...(intent ? { deliveryIntent: 'service-reattempt' } : {}) });
  const inspect = async (commandId: string) => (await call<{ record: TargetQueueView }>('inspectTargetQueue', { schemaVersion: 1, scopeId: 's', commandId })).record;
  /** One service turn after the batch window: revalidation, verification, then the re-attempt scan. */
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 5)); await service.tick(); };
  return { db, queue, app, runs, admitted, submitted, ports, service, enqueue, inspect, tick, call, conflict: (...ids: string[]) => { conflicting = new Set(ids); },
    mcp: (value: boolean) => { mcp = value; }, approve: () => { approval = false; },
    accept: (runId: string) => { runs.set(runId, run(runId, [{ id: 't', phase: 'accepted' }])); }, fail: (runId: string) => { runs.set(runId, run(runId, [{ id: 't', phase: 'failed' }])); },
    close: () => db.close() };
}

describe('delivery re-attempt after the target base advanced (D1a/D2b)', () => {
  it('re-runs the same frozen Task once on the current base and enqueues it for the same two human cards', async () => {
    const f = fixture();
    try {
      await f.enqueue('first', 'r'); f.conflict('first'); await f.tick();
      const ids = reattemptCommandIds(f.queue.load('s', 'first')!);
      expect(f.queue.load('s', 'first')).toMatchObject({ state: 'settled', outcome: 'conflict-needs-reattempt', reason: 'PATCH_BASE_ADVANCED' });
      // The service admitted exactly one single-task Run of the same frozen Task (work input, kind, criteria), no dependencies.
      expect(f.admitted).toEqual([{ schemaVersion: 1, commandId: ids.create, scopeId: 's', runId: ids.run, graph: expect.anything() }]);
      expect(f.admitted[0]!.graph).toEqual({ schemaVersion: 4, revision: 1, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], workInput }], criterionDefinitions: [criterion] });
      expect(await f.inspect('first')).toMatchObject({ nextAction: 'wait-service', responsibility: 'service',
        reattempt: { state: 'running', count: 1, bound: 1, cause: 'PATCH_BASE_ADVANCED', runId: ids.run } });
      await f.tick(); await f.tick(); expect(f.ports.admit).toHaveBeenCalledOnce(); // replay-safe: one Run, however many turns
      f.accept(ids.run); await f.tick();
      const successor = f.queue.load('s', ids.ticket)!;
      expect(successor.request).toMatchObject({ identity: identity(ids.run), target: binding, deliveryIntent: 'service-reattempt',
        actor: queueServiceActor({ id: human.id, issuer: human.issuer, subject: human.subject }),
        reattempt: { sourceCommandId: 'first', intentCommandId: 'first', count: 1, cause: 'PATCH_BASE_ADVANCED', approvedBy: { id: 'human', issuer: 'os', subject: '1000' } } });
      expect(f.queue.reattemptable(0, 8)).toEqual([]); // a successor ends the work list
      expect(await f.inspect('first')).toMatchObject({ reattempt: { state: 'enqueued', commandId: ids.ticket } });
      // Background work for the service ticket runs as the delegating human, never as an MCP or service identity.
      expect(selectQueueActor(successor, channel => channel === 'mcp' ? { id: 'mcp', issuer: 'os/mcp', subject: '1000' } : human)).toBeUndefined();
      await f.tick(); await f.tick();
      expect(f.queue.load('s', ids.ticket)).toMatchObject({ state: 'awaiting-confirmation' });
      expect(await f.inspect(ids.ticket)).toMatchObject({ nextAction: 'confirm-batch', responsibility: 'human' });
      // The owner's two cards stay mandatory: no consent, no effect; the AI channel cannot ask for or answer one.
      await expect(f.call('executeTargetQueue', { schemaVersion: 1, scopeId: 's', commandId: ids.ticket, publishDigest: 'a'.repeat(64), adoptDigest: 'b'.repeat(64) }))
        .rejects.toMatchObject({ code: 'QUEUE_CONFIRMATION_REQUIRED' });
      f.mcp(true);
      for (const operation of ['challengeTargetQueue', 'answerTargetQueue', 'executeTargetQueue', 'enqueueTargetQueue'])
        await expect(f.call(operation, { schemaVersion: 1, scopeId: 's', commandId: ids.ticket, operation: 'publish' })).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
      expect(f.queue.load('s', ids.ticket)?.state).toBe('awaiting-confirmation');
    } finally { f.close(); }
  });

  it('ends a lineage that exceeds the bound in a typed final state owned by a human', async () => {
    const f = fixture();
    try {
      await f.enqueue('first', 'r'); f.conflict('first'); await f.tick();
      const ids = reattemptCommandIds(f.queue.load('s', 'first')!); f.accept(ids.run); await f.tick();
      f.conflict(ids.ticket); await f.tick(); // the re-attempt meets an advanced base again
      expect(f.queue.load('s', ids.ticket)).toMatchObject({ state: 'settled', outcome: 'conflict-needs-reattempt', reason: 'DELIVERY_REATTEMPT_EXHAUSTED' });
      expect(await f.inspect(ids.ticket)).toMatchObject({ nextAction: 'new-attempt', responsibility: 'human', reason: 'DELIVERY_REATTEMPT_EXHAUSTED',
        reattempt: { state: 'exhausted', count: 1, cause: 'PATCH_BASE_ADVANCED', reason: 'DELIVERY_REATTEMPT_EXHAUSTED' } });
      await f.tick(); await f.tick();
      expect(f.ports.admit).toHaveBeenCalledOnce(); expect(f.queue.reattemptable(0, 8)).toEqual([]);
      // The application refuses a forged second hop even if a caller tried it directly.
      const exhausted = f.queue.load('s', ids.ticket)!, next = reattemptCommandIds(exhausted);
      await expect(f.app.submitReattempt({ ...exhausted.request, commandId: next.ticket, reattempt: { ...exhausted.request.reattempt!, sourceCommandId: ids.ticket, count: 2 } }, human))
        .rejects.toThrow('QUEUE_AUTHORITY_REQUIRED');
    } finally { f.close(); }
  });

  it.each([
    ['unclassified (possibly external) effects', { effects: 'unknown' as const }, 'r', 'DELIVERY_REATTEMPT_EFFECTS'],
    ['external effects', { effects: 'external' as const }, 'r', 'DELIVERY_REATTEMPT_EFFECTS'],
    ['an uncertain worker outcome', {}, 'uncertain', 'DELIVERY_REATTEMPT_EFFECTS'],
    ['an unresolved effect', {}, 'unresolved', 'DELIVERY_REATTEMPT_EFFECTS'],
    ['cross-task inputs', {}, 'inputs', 'DELIVERY_REATTEMPT_NOT_ELIGIBLE'],
  ])('never re-attempts a Task with %s', async (_name, options, runId, reason) => {
    const f = fixture(options);
    try {
      f.runs.set('uncertain', run('uncertain', [{ id: 't', phase: 'accepted', observed: 'unknown' }]));
      f.runs.set('unresolved', run('unresolved', [{ id: 't', phase: 'accepted', unresolved: true }]));
      f.runs.set('inputs', run('inputs', [{ id: 'p', phase: 'accepted' }, { id: 't', phase: 'accepted', inputs: [{ name: 'notes', taskId: 'p' }] }]));
      await f.enqueue('first', runId); f.conflict('first'); await f.tick(); await f.tick();
      expect(f.ports.admit).not.toHaveBeenCalled(); expect(f.submitted).toEqual([]);
      expect(await f.inspect('first')).toMatchObject({ nextAction: 'new-attempt', responsibility: 'human', reattempt: { state: 'refused', count: 0, reason } });
    } finally { f.close(); }
  });

  it('never re-attempts failed verification or a parked ticket, only a base-advanced conflict', async () => {
    const f = fixture();
    try {
      await f.enqueue('first', 'r'); await f.tick();
      const record = f.queue.load('s', 'first')!;
      expect(record.state).toBe('awaiting-confirmation');
      const failed = { ...record, state: 'settled', outcome: 'verification-failed', reason: null } as TargetQueueRecord;
      expect(await stepDeliveryReattempt(f.ports, failed, true)).toBeNull();
      expect(reattemptEligibility({ ...record, state: 'settled', outcome: 'conflict-needs-reattempt', reason: 'PATCH_BASE_ADVANCED', batchDigest: 'a'.repeat(64) } as TargetQueueRecord,
        f.runs.get('r')!, 1, () => 'workspace-only', [])).toBe('DELIVERY_REATTEMPT_NOT_ELIGIBLE'); // an effect had started: reconciliation owns it
      expect(reattemptEligibility({ ...record, state: 'settled', outcome: 'conflict-needs-reattempt', reason: 'QUEUE_PREPARATION_REFUSED' } as TargetQueueRecord,
        f.runs.get('r')!, 1, () => 'workspace-only', [])).toBe('DELIVERY_REATTEMPT_NOT_ELIGIBLE');
      expect(reattemptEligibility({ ...record, state: 'settled', outcome: 'conflict-needs-reattempt', reason: 'PATCH_BASE_ADVANCED' } as TargetQueueRecord,
        run('r', [{ id: 't', phase: 'failed' }]), 1, () => 'workspace-only', [])).toBe('DELIVERY_REATTEMPT_NOT_ELIGIBLE');
      expect(f.ports.admit).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('without a delivery intent the service enqueues nothing and the human requeue stays as before', async () => {
    const f = fixture();
    try {
      await f.enqueue('first', 'r', false); f.conflict('first'); await f.tick(); await f.tick();
      expect(f.queue.load('s', 'first')).toMatchObject({ state: 'settled', outcome: 'conflict-needs-reattempt', reason: 'PATCH_BASE_ADVANCED' });
      expect(f.queue.reattemptable(0, 8)).toEqual([]); expect(f.ports.admit).not.toHaveBeenCalled(); expect(f.submitted).toEqual([]);
      const view = await f.inspect('first');
      expect(view).toMatchObject({ nextAction: 'new-attempt', responsibility: 'service' }); expect(view.reattempt).toBeUndefined(); // unchanged projection
      // The human makes the new Attempt and queues it, exactly as before (here: another accepted Run's Attempt).
      f.runs.set('r2', run('r2', [{ id: 't', phase: 'accepted' }])); f.conflict();
      expect(await f.enqueue('second', 'r2', false)).toMatchObject({ commandId: 'second', state: 'queued' });
    } finally { f.close(); }
  });

  it('the AI channel cannot enqueue, and no wire or human path can forge a service re-attempt', async () => {
    const f = fixture();
    try {
      f.mcp(true);
      await expect(f.enqueue('first', 'r')).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
      expect(f.queue.load('s', 'first')).toBeNull();
      f.mcp(false); await f.enqueue('first', 'r'); f.conflict('first');
      // The wire carries only the intent; a lineage or delegation is never accepted from a client.
      expect(() => queueEnqueueSchema.parse({ schemaVersion: 1, commandId: 'x', identity: identity('r'), target: binding.target, reattempt: { count: 1 } })).toThrow();
      await f.tick();
      const source = f.queue.load('s', 'first')!, ids = reattemptCommandIds(source);
      const forged = targetQueueRequestSchema.parse({ ...source.request, commandId: ids.ticket, identity: identity('r'), actor: queueServiceActor(source.request.actor),
        reattempt: { sourceCommandId: 'first', intentCommandId: 'first', count: 1, cause: 'PATCH_BASE_ADVANCED', approvedBy: source.request.actor } });
      await expect(f.app.submit(forged, human)).rejects.toThrow('QUEUE_AUTHORITY_REQUIRED'); // the human path never submits a lineage
      const mcp = { id: 'mcp', issuer: 'os/mcp', subject: '1000', assurance: 'workload-verified', scopeIds: ['s'] } as const;
      await expect(f.app.submitReattempt({ ...forged, actor: queueServiceActor(mcp), reattempt: { ...forged.reattempt!, approvedBy: { id: mcp.id, issuer: mcp.issuer, subject: mcp.subject } } }, mcp))
        .rejects.toThrow('QUEUE_AUTHORITY_REQUIRED');
      const other = { ...human, id: 'other', subject: '1001' };
      await expect(f.app.submitReattempt({ ...forged, actor: queueServiceActor(other), reattempt: { ...forged.reattempt!, approvedBy: { id: other.id, issuer: other.issuer, subject: other.subject } } }, other))
        .rejects.toThrow('QUEUE_AUTHORITY_REQUIRED');
      // An actor that is not the approver's service principal is refused by the contract itself.
      expect(() => targetQueueRequestSchema.parse({ ...forged, actor: source.request.actor })).toThrow();
    } finally { f.close(); }
  });

  it('waits while the live base has not moved and while policy asks a human to approve the re-attempt Run', async () => {
    const f = fixture({ advanced: false, approval: true });
    try {
      await f.enqueue('first', 'r'); f.conflict('first'); await f.tick(); await f.tick();
      expect(f.ports.admit).not.toHaveBeenCalled();
      expect(await f.inspect('first')).toMatchObject({ nextAction: 'wait-service', responsibility: 'service', reattempt: { state: 'waiting-base' } });
      f.ports.baseAdvanced.mockResolvedValue(true); await f.tick();
      // The re-attempt Run asks for its normal Run-create card: no card bypass, a human approves it.
      expect(f.ports.admit).toHaveBeenCalledOnce(); expect(f.admitted).toEqual([]);
      expect(await f.inspect('first')).toMatchObject({ nextAction: 'approve-run', responsibility: 'human', reattempt: { state: 'awaiting-approval' } });
      f.approve(); await f.tick();
      const record = f.queue.load('s', 'first')!;
      expect(f.admitted).toHaveLength(1); expect(await f.inspect('first')).toMatchObject({ reattempt: { state: 'running' } });
      f.fail(reattemptCommandIds(record).run);
      expect(await f.inspect('first')).toMatchObject({ nextAction: 'new-attempt', responsibility: 'human', reattempt: { state: 'failed', reason: 'DELIVERY_REATTEMPT_FAILED' } });
    } finally { f.close(); }
  });
});

describe('chained re-attempt eligibility (accepted-patch edge)', () => {
  const record = (outcome = 'conflict-needs-reattempt') => ({ request: targetQueueRequestSchema.parse({ schemaVersion: 1, commandId: 'dep', identity: identity('chain', 'd'),
    target: binding, actor: { id: 'human', issuer: 'os', subject: '1000' }, payloadDigest: 'b'.repeat(64), policyRevision: 'p', outputDigest: 'c'.repeat(64),
    acceptedRevision: 3, submittedAt: 1, deadline: 100, deliveryIntent: 'service-reattempt' }), key: 'a'.repeat(64), state: 'settled', outcome, reason: 'PATCH_BASE_ADVANCED', batchDigest: null }) as unknown as TargetQueueRecord;
  const chain = run('chain', [{ id: 'p', phase: 'accepted' }, { id: 'd', phase: 'accepted', dependencies: [{ taskId: 'p', startFrom: 'accepted-patch' }] }]);
  const adopted = (outcome: string) => [{ ...record(), request: { ...record().request, commandId: 'pred', identity: identity('chain', 'p') }, outcome }] as unknown as TargetQueueRecord[];
  it('re-runs a dependent alone only after its predecessor was adopted on the same target', () => {
    expect(reattemptEligibility(record(), chain, 1, () => 'workspace-only', [])).toBe('DELIVERY_REATTEMPT_NOT_ELIGIBLE');
    expect(reattemptEligibility(record(), chain, 1, () => 'workspace-only', adopted('conflict-needs-reattempt'))).toBe('DELIVERY_REATTEMPT_NOT_ELIGIBLE');
    expect(reattemptEligibility(record(), chain, 1, () => 'workspace-only', adopted('adopted'))).toBeNull();
    expect(reattemptEligibility(record(), chain, 1, () => 'workspace-only', adopted('re-prepared+adopted'))).toBeNull();
    expect(reattemptEligibility(record(), chain, 0, () => 'workspace-only', adopted('adopted'))).toBe('DELIVERY_REATTEMPT_EXHAUSTED'); // 0 disables
    // The re-run carries the same frozen work input without the edge: the predecessor's output is already on the target base.
    expect(reattemptGraph(chain, 'd')).toEqual({ schemaVersion: 4, revision: 1, tasks: [{ id: 'd', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], workInput }], criterionDefinitions: [criterion] });
  });
});
