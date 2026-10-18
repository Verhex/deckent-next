import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTargetQueue } from '#adapters/core/target-queue-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { createTargetQueueService, RUNTIME_SERVICE_SCHEMA_VERSION, TargetQueueApplication, assertRunDeliveryIntent, stepRunDelivery, stepDeliveryReattempt, reattemptCommandIds,
  selectQueueActor, projectTargetQueue, type QueueServiceContext, type TargetQueueView } from '#engine/index.js';
import { mcpPrincipalRef, queueServiceActor, targetQueueRequestSchema, type RunSnapshot, type TargetQueueRecord, type TargetQueueRequest } from '#domain/index.js';
import { renderQueueStatus } from '#surfaces/core/effect-confirmation/index.js';

// alpha.47 R4-b (owner D2b, 2026-10-18). A human approves a Run whose proposal carries `delivery: { target, mode: 'enqueue-accepted' }`. The
// service then submits the Run's accepted Attempts to that target as the human's service principal (delegation recorded), re-queues a ticket that
// stopped before any effect by typed cause up to `targetQueue.requeueMax`, and leaves a base-advanced conflict to the bounded re-attempt. The
// owner's publish/adopt cards stay mandatory; MCP never obtains or uses an intent. Business target: no Git, no test suite.
const human = { id: 'human', issuer: 'os', subject: '1000', assurance: 'os-user', scopeIds: ['s'] } as const;
const grantedBy = { id: 'human', issuer: 'os', subject: '1000' } as const;
const bounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 2, batchWindowMs: 1, leaseMs: 1000, verificationTimeoutMs: 60000, revalidations: 2, reattempts: 1, requeueMax: 2 };
const binding = { schemaVersion: 1, installationId: 'i', adapter: { id: 'business-adapter', version: 1 }, resourceBinding: 'a'.repeat(64), target: { kind: 'record', id: 'order-42' } } as const;
const display = { schemaVersion: 1, labelKey: 'queue.git.target', basisKey: 'queue.git.basis', versionKey: 'queue.git.version', prepareActionKey: 'queue.git.prepare' } as const;
const identity = (runId: string, taskId: string) => ({ scopeId: 's', runId, taskId, attemptId: `${runId}-${taskId}-1`, generation: 1, layoutRevision: 'l' });
const criterion = { id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: {} };
const proposal = { schemaVersion: 1, proposalId: 'plan', digest: 'd'.repeat(64), budgetCeiling: { currency: 'USD', limitMinorUnits: 100 }, requiredPermissions: [], admission: null };
const approved = { decision: { eventId: 'decision', sequence: 1 }, approval: { approvalId: 'card', actionDigest: 'a'.repeat(64), requestDigest: 'b'.repeat(64), commandId: 'allow' } };
type Phase = 'pending' | 'active' | 'accepted' | 'failed';
function run(tasks: readonly { id: string; phase: Phase; delivery?: 'none' }[], options: { intent?: boolean; card?: boolean } = {}) {
  return { identity: { runId: 'r', scopeId: 's', layoutRevision: 'l' }, revision: 3, state: { kind: 'running' },
    proposal: { ...proposal, ...(options.intent === false ? {} : { delivery: { target: binding.target, mode: 'enqueue-accepted', grantedBy } }) },
    ...(options.card === false ? { authority: { decision: approved.decision } } : { authority: approved }),
    graph: { schemaVersion: 4, revision: 1, criterionDefinitions: [criterion], tasks: tasks.map(task => ({ id: task.id, kind: 'operation', dependencies: [], acceptanceCriteria: ['exit'] })) },
    progress: tasks.map(task => ({ taskId: task.id, phase: task.phase, unresolvedEffects: false, eligibility: { kind: 'immediate' } })),
    bindings: tasks.filter(task => task.phase !== 'pending').map(task => ({ identity: identity('r', task.id), observedKind: task.phase === 'active' ? null : 'exited' })),
    execution: { schemaVersion: 1, registryRevision: 'r', tasks: tasks.map(task => ({ taskId: task.id, profile: { id: 'w', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {} },
      ...(task.delivery ? { workspaceDelivery: task.delivery } : {}) })), criteria: [] } } as unknown as RunSnapshot;
}

function fixture(initial: RunSnapshot = run([{ id: 'approve', phase: 'accepted' }, { id: 'invoice', phase: 'accepted' }, { id: 'report', phase: 'accepted', delivery: 'none' }, { id: 'ship', phase: 'active' }])) {
  const db = new DatabaseSync(':memory:'); migrateLedger(db, 'allow');
  const runs = new Map<string, RunSnapshot>([['r', initial]]);
  const queue = new SqliteTargetQueue(db), app = new TargetQueueApplication(queue, { async authorize() {},
    async validate(request) { if (request.delegation) assertRunDeliveryIntent(runs.get(request.identity.runId) ?? null, request); } }, bounds, () => {});
  let parkVerification = new Set<string>(), conflicting = new Set<string>(), mcp = false;
  const context: QueueServiceContext = { principal: human, document: { revision: 'p' }, config: { targetQueue: { capacity: 8, ttlMs: 60000 } }, queue, bounds, app,
    target: { async binding() { return binding; }, async describe() { return display; } },
    accepted: async () => ({ acceptedRevision: 3, outputDigest: 'c'.repeat(64) }), async describeCandidate() { return { changes: ['order-42'] }; } };
  const candidate = (record: TargetQueueRecord) => ({ schemaVersion: 1, target: binding, identity: record.request.identity, sourceBinding: 'd'.repeat(64), outputDigest: 'c'.repeat(64),
    observedVersion: 'V2', effectiveVersion: 'V2', candidateVersion: 'V3', candidateDigest: 'e'.repeat(64), custodyReceipt: 'f'.repeat(64), criteria: ['1'.repeat(64)],
    profileFingerprint: '2'.repeat(64), replacesCommandId: null }) as const;
  const preparation = { async prepare(record: TargetQueueRecord) { if (conflicting.has(record.request.identity.taskId)) throw Object.assign(new Error('x'), { code: 'PATCH_BASE_ADVANCED' }); return candidate(record); },
    async admitVerification(record: TargetQueueRecord) { if (parkVerification.has(record.request.identity.taskId)) throw Object.assign(new Error('x'), { code: 'QUEUE_VERIFICATION_NOT_ADMITTED' }); },
    effectIds: () => ['x1', 'x2', 'x3', 'x4'],
    async evidence(record: TargetQueueRecord) { const c = candidate(record); return { schemaVersion: 1, candidateDigest: c.candidateDigest, custodyReceipt: c.custodyReceipt,
      sourceBinding: c.sourceBinding, candidateVersion: c.candidateVersion, profileFingerprint: c.profileFingerprint, criteria: c.criteria, identity: c.identity, evidenceReceipt: '3'.repeat(64), phase: 'accepted' } as const; } };
  const ports = { requeueMax: bounds.requeueMax, policyRevision: 'p', ttlMs: 60000, now: Date.now, forRun: (scopeId: string, runId: string) => queue.forRun(scopeId, runId, 8),
    binding: async () => binding, accepted: vi.fn(context.accepted), submit: (request: TargetQueueRequest) => app.submitDelegated(request, human) };
  const reattemptPorts = { bound: 1, policyRevision: 'p', ttlMs: 60000, now: Date.now, load: (scopeId: string, commandId: string) => queue.load(scopeId, commandId),
    forRun: (scopeId: string, runId: string) => queue.forRun(scopeId, runId, 8), loadRun: async (_scope: string, runId: string) => runs.get(runId) ?? null,
    effects: () => 'workspace-only' as const, baseAdvanced: async () => true, admit: vi.fn(async () => {}), accepted: context.accepted,
    submit: (request: unknown) => app.submitReattempt(request, human) };
  const withActor = vi.fn(async (_subject: unknown, work: () => Promise<unknown>) => work());
  const service = createTargetQueueService({ instanceId: 'service', config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: 1 } },
    withScope: async (_scope, _peer, _read, work) => work(context), snapshot: async () => queue.pending(8), withActor: withActor as never,
    effects: async () => { throw new Error('no-effect-without-cards'); }, preparation: async () => preparation, isMcp: () => mcp, record: async () => {},
    captureProcess: async () => ({ processStart: 'start', terminal: 'tty' }),
    reattempts: async () => queue.reattemptable(0, 8), reattempt: (_c, record, act) => stepDeliveryReattempt(reattemptPorts, record, act),
    intents: async () => [{ scopeId: 's', runId: 'r', grantedBy }], deliver: (_c, ref) => stepRunDelivery(ports, runs.get(ref.runId)!) });
  const call = <T>(operation: string, input: unknown) => service.execute({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: operation, operation, input, delivery: { maxResultBytes: 1 << 16 } } as never,
    { pid: 42, uid: 1000 }, 1 << 17) as Promise<T>;
  const inspect = async (commandId: string) => (await call<{ record: TargetQueueView }>('inspectTargetQueue', { schemaVersion: 1, scopeId: 's', commandId })).record;
  /** One service turn after the batch window (the scan cadence is the batch window here: no lease is configured). */
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 5)); await service.tick(); };
  const tickets = () => queue.forRun('s', 'r', 8);
  return { db, queue, app, runs, ports, reattemptPorts, service, call, inspect, tick, tickets, withActor,
    park: (...tasks: string[]) => { parkVerification = new Set(tasks); }, conflict: (...tasks: string[]) => { conflicting = new Set(tasks); }, mcp: (value: boolean) => { mcp = value; }, close: () => db.close() };
}
const ticketOf = (records: readonly TargetQueueRecord[], taskId: string) => records.filter(row => row.request.identity.taskId === taskId);

describe('Run delivery intent (D2b): the service enqueues accepted work for the human\'s cards', () => {
  it('submits each accepted, delivering Attempt once as the granting human\'s service principal, then waits for the two human cards', async () => {
    const f = fixture();
    try {
      await f.tick(); await f.tick(); await f.tick();
      const rows = f.tickets();
      expect(rows.map(row => row.request.identity.taskId).sort()).toEqual(['approve', 'invoice']); // not the report-only task, not the running one
      const first = ticketOf(rows, 'approve')[0]!;
      expect(first.request).toMatchObject({ actor: queueServiceActor(grantedBy), deliveryIntent: 'service-reattempt', target: binding,
        delegation: { intentRef: { runId: 'r', proposalId: 'plan', digest: 'd'.repeat(64) }, grantedBy } });
      expect(first.request.delegation!.requeue).toBeUndefined();
      expect(f.withActor).toHaveBeenCalledWith(grantedBy, expect.any(Function)); // the pass runs as the granting human
      expect(selectQueueActor(first, channel => channel === 'mcp' ? { id: 'mcp', issuer: 'os/mcp', subject: '1000' } : human)).toBeUndefined();
      await f.tick(); await f.tick();
      expect(f.tickets().map(row => row.state)).toEqual(['awaiting-confirmation', 'awaiting-confirmation']);
      const view = await f.inspect(first.request.commandId);
      expect(view).toMatchObject({ nextAction: 'confirm-batch', responsibility: 'human', delegation: { grantedBy, runId: 'r', requeues: 0 } });
      expect(renderQueueStatus(view, 'en')).toContain('Submitted for human by the delivery intent of Run r');
      expect(renderQueueStatus(view, 'tr')).toContain('teslim niyetiyle human adına');
      // No card bypass: without the owner's two terminal answers nothing is published or adopted; MCP cannot ask or answer.
      await expect(f.call('executeTargetQueue', { schemaVersion: 1, scopeId: 's', commandId: first.request.commandId, publishDigest: 'a'.repeat(64), adoptDigest: 'b'.repeat(64) }))
        .rejects.toMatchObject({ code: 'QUEUE_CONFIRMATION_REQUIRED' });
      f.mcp(true);
      for (const operation of ['challengeTargetQueue', 'answerTargetQueue', 'executeTargetQueue', 'enqueueTargetQueue'])
        await expect(f.call(operation, { schemaVersion: 1, scopeId: 's', commandId: first.request.commandId, operation: 'publish' })).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
      expect(f.tickets().map(row => row.state)).toEqual(['awaiting-confirmation', 'awaiting-confirmation']);
      // More passes never duplicate a ticket.
      await f.tick(); await f.tick(); expect(f.tickets()).toHaveLength(2);
    } finally { f.close(); }
  });

  it.each([
    ['no intent on the approved proposal', { intent: false }],
    ['no approved Run-create card (no human approved the intent)', { card: false }],
  ])('enqueues nothing with %s', async (_name, options) => {
    const f = fixture(run([{ id: 'approve', phase: 'accepted' }], options));
    try {
      expect(await stepRunDelivery(f.ports, f.runs.get('r')!)).toEqual([]);
      expect(f.tickets()).toEqual([]);
    } finally { f.close(); }
  });

  it('a forged delegated ticket is refused unless it names the intent\'s Run, target, proposal and grantor, and the card was approved', async () => {
    const f = fixture();
    try {
      await stepRunDelivery(f.ports, f.runs.get('r')!);
      const good = ticketOf(f.tickets(), 'approve')[0]!.request, forge = (patch: object) => ({ ...good, commandId: 'forged', ...patch }) as TargetQueueRequest;
      const other = { id: 'other', issuer: 'os', subject: '2000' };
      for (const request of [
        forge({ target: { ...binding, target: { kind: 'record', id: 'order-43' } } }),
        forge({ delegation: { ...good.delegation!, intentRef: { ...good.delegation!.intentRef, digest: 'e'.repeat(64) } } }),
        forge({ delegation: { ...good.delegation!, intentRef: { ...good.delegation!.intentRef, proposalId: 'another-plan' } } }),
      ]) expect(() => assertRunDeliveryIntent(f.runs.get('r')!, request)).toThrow(expect.objectContaining({ code: 'DELIVERY_INTENT_NOT_ADMITTED' }));
      expect(() => assertRunDeliveryIntent(run([{ id: 'approve', phase: 'accepted' }], { card: false }), good)).toThrow(expect.objectContaining({ code: 'DELIVERY_INTENT_NOT_ADMITTED' }));
      expect(() => assertRunDeliveryIntent(run([{ id: 'approve', phase: 'accepted' }], { intent: false }), good)).toThrow(expect.objectContaining({ code: 'DELIVERY_INTENT_NOT_ADMITTED' }));
      await expect(f.app.submitDelegated(forge({ actor: queueServiceActor(other), delegation: { ...good.delegation!, grantedBy: other } }), { ...human, ...other }))
        .rejects.toMatchObject({ code: 'DELIVERY_INTENT_NOT_ADMITTED' });
      // Only the granting human (os-user) acts; MCP, a workload or a token principal, or another human never does.
      for (const principal of [{ ...human, ...mcpPrincipalRef(human) }, { ...human, assurance: 'workload-verified' as const }, { ...human, assurance: 'token-verified' as const }, { ...human, ...other }])
        await expect(f.app.submitDelegated(forge({}), principal)).rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
      // The human/MCP submit path never carries a delegation, and the wire enqueue has no such field.
      await expect(f.app.submit({ ...forge({}), actor: grantedBy }, human)).rejects.toThrow();
      await expect(f.call('enqueueTargetQueue', { schemaVersion: 1, commandId: 'wire', identity: identity('r', 'invoice'), target: binding.target, delegation: good.delegation })).rejects.toThrow();
      // The schema binds the service actor to the grantor and refuses a delegated rollback or a delegation without the re-attempt intent.
      for (const request of [forge({ actor: grantedBy }), forge({ deliveryIntent: undefined }), forge({ operation: 'rollback', sourceCommandId: 'x' }),
        forge({ identity: identity('other-run', 'approve') })]) expect(targetQueueRequestSchema.safeParse(request).success).toBe(false);
      expect(f.tickets().map(row => row.request.commandId)).not.toContain('forged');
    } finally { f.close(); }
  });

  it('re-queues a ticket that stopped before any effect by typed cause, up to requeueMax, then ends typed and owned by a human', async () => {
    const f = fixture(run([{ id: 'approve', phase: 'accepted' }]));
    try {
      f.park('approve');
      await f.tick(); await f.tick(); await f.tick(); await f.tick(); await f.tick(); await f.tick(); await f.tick(); await f.tick();
      const chain = ticketOf(f.tickets(), 'approve');
      expect(chain.map(row => [row.state, row.reason, row.request.delegation!.requeue?.count ?? 0, row.request.delegation!.requeue?.cause ?? null])).toEqual(expect.arrayContaining([
        ['parked', 'QUEUE_VERIFICATION_NOT_ADMITTED', 0, null], ['parked', 'QUEUE_VERIFICATION_NOT_ADMITTED', 1, 'parked'], ['parked', 'QUEUE_VERIFICATION_NOT_ADMITTED', 2, 'parked']]));
      expect(chain).toHaveLength(3); // the bound (2) holds however many passes run
      const last = chain.find(row => row.request.delegation!.requeue?.count === 2)!, first = chain.find(row => !row.request.delegation!.requeue)!;
      expect(last.request.delegation!.requeue).toMatchObject({ sourceCommandId: chain.find(row => row.request.delegation!.requeue?.count === 1)!.request.commandId, reason: 'QUEUE_VERIFICATION_NOT_ADMITTED' });
      expect(await stepRunDelivery(f.ports, f.runs.get('r')!)).toEqual([{ taskId: 'approve', state: 'exhausted', reason: 'QUEUE_REQUEUE_EXHAUSTED' }]);
      expect(await f.inspect(last.request.commandId)).toMatchObject({ nextAction: 'prepare-current', responsibility: 'human', reason: 'QUEUE_REQUEUE_EXHAUSTED', delegation: { requeues: 2 } });
      expect(await f.inspect(first.request.commandId)).toMatchObject({ nextAction: 'wait-service', responsibility: 'service' });
      // A projection without the service's bound (e.g. the /runs detail) keeps the record's own state and reason; never a false terminal.
      for (const row of [first, last]) expect(projectTargetQueue(row, display, Date.now())).toMatchObject({ nextAction: 'prepare-current', reason: 'QUEUE_VERIFICATION_NOT_ADMITTED' });
      // A forged third hop is refused by the application bound, whoever calls it.
      await expect(f.app.submitDelegated({ ...last.request, commandId: 'third', delegation: { ...last.request.delegation!, requeue: { sourceCommandId: last.request.commandId, count: 3, cause: 'parked' } } }, human))
        .rejects.toMatchObject({ code: 'QUEUE_REQUEUE_EXHAUSTED' });
      // A forged hop with a wrong count or cause, or from a ticket that never stopped, is refused.
      await expect(f.app.submitDelegated({ ...last.request, commandId: 'skip', delegation: { ...last.request.delegation!, requeue: { sourceCommandId: first.request.commandId, count: 2, cause: 'parked' } } }, human))
        .rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
      await expect(f.app.submitDelegated({ ...last.request, commandId: 'cause', delegation: { ...last.request.delegation!, requeue: { sourceCommandId: first.request.commandId, count: 1, cause: 'expired' } } }, human))
        .rejects.toMatchObject({ code: 'QUEUE_AUTHORITY_REQUIRED' });
    } finally { f.close(); }
  });

  it('never re-queues a ticket whose effect had started, a human\'s own ticket, or a refusal; a conflict goes to the bounded re-attempt', async () => {
    const f = fixture(run([{ id: 'approve', phase: 'accepted' }, { id: 'invoice', phase: 'accepted' }]));
    try {
      f.conflict('invoice'); await f.tick(); await f.tick(); await f.tick();
      const conflict = ticketOf(f.tickets(), 'invoice')[0]!;
      expect(conflict).toMatchObject({ state: 'settled', outcome: 'conflict-needs-reattempt', reason: 'PATCH_BASE_ADVANCED' });
      expect(ticketOf(f.tickets(), 'invoice')).toHaveLength(1); // a refusal is never re-queued
      // The delegated ticket carries the re-attempt intent, so the existing bounded re-attempt takes over as the same human.
      expect(f.queue.reattemptable(0, 8).map(row => row.request.commandId)).toEqual([conflict.request.commandId]);
      expect(f.reattemptPorts.admit).toHaveBeenCalledWith(expect.objectContaining({ runId: reattemptCommandIds(conflict).run }));
      // A started effect parked by reconciliation is the reconciler's and the human's, never the service's.
      const started = { ...ticketOf(f.tickets(), 'approve')[0]!, state: 'parked', batchDigest: 'a'.repeat(64), reason: 'QUEUE_RECOVERY_REQUIRED' } as TargetQueueRecord;
      const ports = { ...f.ports, forRun: () => [started] }, submit = vi.spyOn(ports, 'submit');
      expect(await stepRunDelivery(ports, run([{ id: 'approve', phase: 'accepted' }]))).toEqual([]); expect(submit).not.toHaveBeenCalled();
      const own = { ...started, batchDigest: null, request: { ...started.request, actor: grantedBy, delegation: undefined } } as TargetQueueRecord;
      expect(await stepRunDelivery({ ...ports, forRun: () => [own] }, run([{ id: 'approve', phase: 'accepted' }]))).toEqual([]); expect(submit).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
});
