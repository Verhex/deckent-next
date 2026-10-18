import { createHash } from 'node:crypto';
import { ErrorRegistry } from '#platform/index.js';
import { TargetQueueError, encodeCommandProjection, targetQueueRequestSchema, queueApprover, type TargetQueueRecord, type TargetBinding, type TargetDisplay, type VerifiedPrincipal, type AttemptIdentity, type EffectTargetRef } from '#domain/index.js';
import { TargetQueueDriver, TargetBatchConfirmation, TargetBatchExecutor, prepareTargetBatch, targetBatchDigest, projectTargetQueue,
  queueRollbackSchema, queueEnqueueSchema, queueQuerySchema, queueListSchema, queueChallengeSchema, queueAnswerSchema, queueExecuteSchema,
  type BatchPeer, type BatchTerminalWitness, type TargetBatch, type TargetBatchEffects, type TargetQueueApplication, type TargetQueueBounds, type TargetQueueStore, type TargetQueuePreparation,
  type QueueReattemptView } from '#engine/core/effect/index.js';
import { runtimeServiceResultCapacity, type RuntimeServiceRequest } from './service-protocol.js';
const queueDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface QueueServiceContext {
  readonly principal: VerifiedPrincipal; readonly document: { readonly revision: string };
  readonly config: { readonly targetQueue: { readonly capacity: number; readonly ttlMs: number } };
  readonly target: { binding(target: EffectTargetRef): Promise<TargetBinding>; describe(): Promise<TargetDisplay> };
  readonly queue: TargetQueueStore; readonly bounds: TargetQueueBounds; readonly app: TargetQueueApplication;
  accepted(identity: AttemptIdentity): Promise<{ acceptedRevision: number; outputDigest: string }>;
  describeCandidate(record: TargetQueueRecord): Promise<{ readonly changes: readonly string[] }>;
}
export interface QueueServicePeer { readonly pid: number; readonly uid: number }
export interface QueueServicePorts<C extends QueueServiceContext, Peer extends QueueServicePeer> {
  readonly instanceId: string; readonly config: { readonly targetQueue: { readonly capacity: number; readonly candidateSlots: number; readonly batchWindowMs: number; readonly leaseMs?: number } };
  withScope<T>(scopeId: string, peer: Peer | undefined, readOnly: boolean, work: (context: C) => Promise<T>): Promise<T>;
  snapshot(): Promise<readonly TargetQueueRecord[]>;
  withActor<T>(record: TargetQueueRecord, work: () => Promise<T>): Promise<T>;
  effects(context: C, peer: Peer | undefined, consent: (operation: TargetBatch['operation']) => Promise<void>): Promise<TargetBatchEffects>;
  preparation(context: C): Promise<TargetQueuePreparation>;
  captureProcess(pid: number, uid: number): Promise<BatchTerminalWitness | null>;
  isMcp(peer: Peer): boolean;
  record(peer: BatchPeer, digest: string, operation: TargetBatch['operation'], answer: 'allow' | 'decline'): Promise<void>;
  /** D1a/D2b: settled base-advanced tickets under a human's delivery intent still inside the re-attempt window, without a successor. */
  reattempts?(): Promise<readonly TargetQueueRecord[]>;
  /** One bounded re-attempt step as the delegating human (`act`), or its read-only state for the queue view. */
  reattempt?(context: C, record: TargetQueueRecord, act: boolean): Promise<QueueReattemptView | null>;
}
/** Reconciliation never holds consent: it observes, settles a completed effect or releases a provably unapplied one, and never re-runs a write. */
async function reconcileQueueRecord<C extends QueueServiceContext, Peer extends QueueServicePeer>(ports: QueueServicePorts<C, Peer>, c: C, record: TargetQueueRecord) {
  const refuse = async () => { throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED'); };
  return new TargetBatchExecutor(c.app, c.queue, await ports.effects(c, undefined, refuse), { assert: refuse }, Date.now).reconcile(record);
}
/** One holder per target key. A service turn skips a held key; a human request waits for the bounded service turn holding its key instead of
 * being refused for the service's own housekeeping (PR #97 CI: a consented execute met the batch-window turn). A second request stays BUSY. */
function targetKeyLock() {
  const held = new Map<string, { by: 'turn' | 'request'; released: Promise<void> }>();
  const lock = async <T>(key: string, work: () => Promise<T>, by: 'turn' | 'request' = 'turn'): Promise<T> => {
    for (let holder = held.get(key); by === 'request' && holder?.by === 'turn'; holder = held.get(key)) await holder.released;
    if (held.has(key)) throw new TargetQueueError('QUEUE_TARGET_BUSY');
    let release!: () => void; held.set(key, { by, released: new Promise<void>(resolve => { release = resolve; }) });
    try { return await work(); } finally { held.delete(key); release(); }
  };
  return { held: held as ReadonlyMap<string, unknown>, lock };
}
/** D1a/D2b: one bounded step per base-advanced ticket under intent per turn; waiting ones back off like a reconciling head (existing bounds).
 * The last step's result stays in memory for the view (last known): a pending Run-create card or a typed admission refusal is not durable. */
function reattemptScheduler<C extends QueueServiceContext, Peer extends QueueServicePeer>(ports: QueueServicePorts<C, Peer>) {
  const { targetQueue } = ports.config, backoff = new Map<string, { at: number; delay: number }>(), last = new Map<string, QueueReattemptView>();
  const key = (record: TargetQueueRecord) => `${record.request.identity.scopeId}:${record.request.commandId}`;
  return {
    /** A Run not yet admitted shows the service's last step (base not moved, card pending, typed refusal); every later fact is durable. */
    async view(c: C, record: TargetQueueRecord) {
      const observed = await ports.reattempt?.(c, record, false) ?? undefined, previous = last.get(key(record));
      return observed?.state === 'waiting-base' && previous && ['awaiting-approval', 'refused'].includes(previous.state) ? previous : observed;
    },
    async turn(): Promise<unknown> {
      const scanned = new Set<string>(); let failure: unknown = null;
      for (const record of await ports.reattempts?.() ?? []) {
        const id = key(record), due = backoff.get(id); scanned.add(id); if (due && due.at > Date.now()) continue;
        let result: QueueReattemptView | null = null;
        try { result = await ports.withActor(record, () => ports.withScope(record.request.identity.scopeId, undefined, false, c => ports.reattempt!(c, record, true))); }
        catch (error) { failure ??= error; }
        const delay = Math.min(Math.max(due?.delay ?? 0, targetQueue.batchWindowMs) * 2, targetQueue.leaseMs ?? targetQueue.batchWindowMs);
        if (result) last.set(id, result); else last.delete(id);
        if (result?.state === 'enqueued') backoff.delete(id); else backoff.set(id, { at: Date.now() + delay, delay });
      }
      for (const id of new Set([...last.keys(), ...backoff.keys()])) if (!scanned.has(id)) { last.delete(id); backoff.delete(id); }
      return failure;
    },
  };
}
/** Service lifecycle, admission and batch authority; native custody, persistence and effect owners remain explicit ports. */
export function createTargetQueueService<C extends QueueServiceContext, Peer extends QueueServicePeer>(ports: QueueServicePorts<C, Peer>) {
  const { config, instanceId } = ports;
  const { held, lock } = targetKeyLock(), challenges = new Map<string, { batch: TargetBatch; peer: string; guard?: () => Promise<void> }>();
  const confirmation = new TargetBatchConfirmation({
    capture: peer => ports.captureProcess(peer.peerPid, Number(peer.principal.subject)),
    sessionActive: async peer => await ports.captureProcess(peer.peerPid, Number(peer.principal.subject)) !== null,
    record: ports.record,
  }, config.targetQueue.capacity, Date.now, () => performance.now());
  const initializeRollback = async (c: C, record: TargetQueueRecord) => {
    const original = record.request.sourceCommandId ? await c.app.inspect(record.request.identity.scopeId, record.request.sourceCommandId, c.principal) : null;
    if (!original?.candidate || !original.verification || original.request.operation === 'rollback' || original.state !== 'settled'
      || !['adopted', 're-prepared+adopted'].includes(original.outcome ?? '') || original.key !== record.key) throw new TargetQueueError('QUEUE_CONFLICT');
    const claimed = c.app.reserve(record, instanceId, Date.now())[0]!;
    const verifying = c.app.transition(claimed, { state: 'verifying', candidate: original.candidate, effectCommandIds: [...original.effectCommandIds.slice(0, 4), record.request.commandId] });
    return c.app.transition(verifying, { state: 'awaiting-confirmation', verification: original.verification });
  };
  const reconcile = (c: C, record: TargetQueueRecord) => reconcileQueueRecord(ports, c, record);
  /** Per-key retry time of a reconciling head: doubles from the batch window up to the lease (existing bounds; no new literal policy). */
  const backoff = new Map<string, { at: number; delay: number }>(), reattempts = reattemptScheduler(ports);
  const service = {
    async run(signal: AbortSignal, wait: (milliseconds: number, signal: AbortSignal) => Promise<void>, onError: (error: unknown) => Promise<void>) {
      while (!signal.aborted) { try { await service.tick(); } catch (error) { await onError(error); }
        await wait(config.targetQueue.batchWindowMs, signal); }
    },
    async recover() {
      const failures: unknown[] = [];
      for (const record of await ports.snapshot()) if (record.state !== 'queued') try { await ports.withActor(record, () => ports.withScope(record.request.identity.scopeId, undefined, false, async c => {
        // Ownership and the park decision are one ledger transition; a ticket whose effect never started is parked without a target write.
        const recovered = c.app.recover(record, instanceId, Date.now());
        if (recovered.state === 'parked') return;
        // A consented effect may still be in flight: reconcile() advances the physical generation before its exact lookup.
        await reconcile(c, recovered);
      })); } catch (error) { failures.push(error); }
      return failures;
    },
    async tick() {
      const grouped = new Map<string, TargetQueueRecord[]>();
      for (const record of await ports.snapshot()) { const rows = grouped.get(record.key) ?? []; rows.push(record); grouped.set(record.key, rows); }
      const targets = [...grouped.entries()]; let failure: unknown = null;
      for (let offset = 0; offset < targets.length; offset += config.targetQueue.candidateSlots) { const results = await Promise.allSettled(targets.slice(offset, offset + config.targetQueue.candidateSlots).map(async ([key, records]) => {
        if (held.has(key)) return;
        if (records[0]?.state === 'reconciling') {
          const due = backoff.get(key); if (due && due.at > Date.now()) return;
          let state: TargetQueueRecord['state'] = 'reconciling', cap = config.targetQueue.batchWindowMs;
          try { await lock(key, () => ports.withActor(records[0]!, () => ports.withScope(records[0]!.request.identity.scopeId, undefined, false, async c => {
            cap = Math.max(cap, c.bounds.leaseMs); state = (await reconcile(c, records[0]!)).state; }))); }
          finally {
            const delay = Math.min(Math.max(due?.delay ?? 0, config.targetQueue.batchWindowMs) * 2, cap);
            if (state === 'reconciling') backoff.set(key, { at: Date.now() + delay, delay }); else backoff.delete(key);
          }
          return;
        }
        await lock(key, () => ports.withActor(records[0]!, () => ports.withScope(records[0]!.request.identity.scopeId, undefined, false, async c => {
          if (records[0]?.request.operation === 'rollback' && records[0].state === 'queued') { await initializeRollback(c, records[0]); return; }
          await new TargetQueueDriver(c.app, c.bounds, await ports.preparation(c), instanceId, Date.now).advance(records);
        })));
      })); const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') failure = failed.reason; }
      failure ??= await reattempts.turn();
      if (failure) throw failure;
    },
    async execute(request: RuntimeServiceRequest, peer: Peer, responseMaxBytes: number) {
      if (!request.delivery) throw ErrorRegistry.createError('RUNTIME_SERVICE_TRANSPORT');
      // DESIGN §6: the AI channel reads (inspect/list) only. Submission, rollback, consent and execution are human CLI/Terminal acts. Amended by
      // owner D2b (2026-10-18): under a human's explicit per-Run delivery intent the service itself enqueues one bounded re-attempt (tick above),
      // as that human's service principal with the delegation recorded; its two cards stay human terminal acts.
      if (ports.isMcp(peer) && request.operation !== 'inspectTargetQueue' && request.operation !== 'listTargetQueue') throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
      const readOnly = request.operation === 'inspectTargetQueue' || request.operation === 'listTargetQueue';
      const input = request.operation === 'enqueueTargetQueueRollback' ? queueRollbackSchema.parse(request.input) : request.operation === 'enqueueTargetQueue' ? queueEnqueueSchema.parse(request.input) : request.operation === 'listTargetQueue' ? queueListSchema.parse(request.input)
        : request.operation === 'challengeTargetQueue' ? queueChallengeSchema.parse(request.input) : request.operation === 'answerTargetQueue' ? queueAnswerSchema.parse(request.input)
        : request.operation === 'executeTargetQueue' ? queueExecuteSchema.parse(request.input) : queueQuerySchema.parse(request.input);
      const scopeId = 'identity' in input ? input.identity.scopeId : input.scopeId;
      return ports.withScope(scopeId, peer, readOnly, async c => {
        const display = await c.target.describe(), view = async (record: TargetQueueRecord) => projectTargetQueue(record, display, Date.now(), await c.app.position(record, c.principal),
          record.request.deliveryIntent && record.outcome === 'conflict-needs-reattempt' ? await reattempts.view(c, record) : undefined);
        const result = await (async () => {
          if (request.operation === 'enqueueTargetQueueRollback') {
            const command = queueRollbackSchema.parse(input), original = await c.app.inspect(scopeId, command.sourceCommandId, c.principal), payloadDigest = queueDigest(command);
            if (!original) throw new TargetQueueError('QUEUE_CONFLICT');
            let record = await c.app.inspect(scopeId, command.commandId, c.principal);
            if (record && (record.request.payloadDigest !== payloadDigest || record.request.actor.id !== c.principal.id)) throw new TargetQueueError('QUEUE_CONFLICT');
            if (!record) {
              if (c.queue.head(original.key)) throw new TargetQueueError('QUEUE_TARGET_BUSY');
              const now = Date.now();
              const { deliveryIntent: _intent, reattempt: _lineage, ...source } = original.request; void _intent; void _lineage; // a rollback is the human's own act
              record = await c.app.submit({ ...source, operation: 'rollback', sourceCommandId: command.sourceCommandId, commandId: command.commandId,
                actor: { id: c.principal.id, issuer: c.principal.issuer, subject: c.principal.subject }, payloadDigest, policyRevision: c.document.revision, submittedAt: now, deadline: now + c.config.targetQueue.ttlMs }, c.principal);
            }
            if (record.state === 'queued') record = await initializeRollback(c, record);
            return view(record);
          }
          if (request.operation === 'enqueueTargetQueue') {
            const command = queueEnqueueSchema.parse(input), payloadDigest = queueDigest(command), existing = await c.app.inspect(scopeId, command.commandId, c.principal);
            if (existing) {
              if (existing.request.payloadDigest !== payloadDigest || JSON.stringify(existing.request.actor) !== JSON.stringify({ id: c.principal.id, issuer: c.principal.issuer, subject: c.principal.subject })) throw new TargetQueueError('QUEUE_CONFLICT');
              if (existing.state === 'verifying' && existing.candidate) { await c.app.submit(existing.request, c.principal); await (await ports.preparation(c)).admitVerification(existing); }
              return view(existing);
            }
            const accepted = await c.accepted(command.identity);
            const now = Date.now(), target = await c.target.binding(command.target);
            const admitted = await c.app.submit(targetQueueRequestSchema.parse({ schemaVersion: 1, commandId: command.commandId, identity: command.identity, target,
              actor: { id: c.principal.id, issuer: c.principal.issuer, subject: c.principal.subject }, payloadDigest, policyRevision: c.document.revision, ...(command.replacesCommandId ? { replacesCommandId: command.replacesCommandId } : {}),
              ...(command.deliveryIntent ? { deliveryIntent: command.deliveryIntent } : {}),
              outputDigest: accepted.outputDigest, acceptedRevision: accepted.acceptedRevision, submittedAt: now, deadline: now + c.config.targetQueue.ttlMs }), c.principal);
            // No physical generation here (Astra 2607 F1/F2): a queued ticket has no durable owner or epoch yet. The generation is
            // written only with an owner/epoch the ledger recorded first (reservation, recovery), by the consented execution or recovery.
            return view(admitted);
          }
          if (request.operation === 'listTargetQueue') { const query = queueListSchema.parse(input); return { schemaVersion: 1, records: await Promise.all((await c.app.list(scopeId, query.after, query.limit, c.principal)).map(view)) }; }
          if (request.operation === 'inspectTargetQueue') { const query = queueQuerySchema.parse(input), record = await c.app.inspect(scopeId, query.commandId, c.principal); return { schemaVersion: 1, record: record ? await view(record) : null }; }
          if (ports.isMcp(peer)) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
          const witness = await ports.captureProcess(peer.pid, peer.uid);
          if (!witness) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
          const batchPeer: BatchPeer = { scopeId, sessionId: `${witness.processStart}:${witness.terminal}`, principal: { issuer: c.principal.issuer, subject: c.principal.subject }, peerPid: peer.pid, channel: 'terminal' };
          const peerKey = encodeCommandProjection('batch-peer:1', batchPeer);
          for (const [digest, entry] of challenges) if (entry.batch.expiresAt <= Date.now()) challenges.delete(digest);
          if (request.operation === 'answerTargetQueue') {
            const answer = queueAnswerSchema.parse(input), entry = challenges.get(answer.digest);
            if (!entry || entry.peer !== peerKey) throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED');
            entry.guard = await confirmation.answer(batchPeer, entry.batch, answer.capability, answer.answer); return { schemaVersion: 1, digest: answer.digest, allowed: true };
          }
          const query = queueQuerySchema.parse({ schemaVersion: 1, scopeId, commandId: 'commandId' in input ? input.commandId : '' }), first = await c.app.inspect(scopeId, query.commandId, c.principal);
          if (!first) throw new TargetQueueError('QUEUE_CONFLICT');
          return lock(first.key, async () => {
            if (request.operation === 'challengeTargetQueue') {
              const command = queueChallengeSchema.parse(input), publish = command.publishDigest ? challenges.get(command.publishDigest) : undefined;
              const batch = publish && publish.peer === peerKey && publish.batch.operation === 'publish' ? { ...publish.batch, operation: command.operation }
                : command.operation === 'adopt' ? null : prepareTargetBatch((await ports.snapshot()).filter(row => row.key === first.key), command.operation, c.bounds, Date.now(), Date.now() + c.config.targetQueue.ttlMs);
              if (!batch || batch.items[0]?.commandId !== first.request.commandId || batch.items.some(row => row.scopeId !== scopeId)) throw new TargetQueueError('QUEUE_CONFLICT');
              const capability = await confirmation.challenge(batchPeer, batch), digest = targetBatchDigest(batch);
              if (challenges.size >= c.config.targetQueue.capacity && !challenges.has(digest)) throw new TargetQueueError('QUEUE_CAPACITY');
              challenges.set(digest, { batch, peer: peerKey });
              const items = await Promise.all(batch.items.map(async item => { const record = c.queue.load(item.scopeId, item.commandId)!; await c.app.inspect(scopeId, item.commandId, c.principal);
                const { changes } = await c.describeCandidate(record);
                return { commandId: item.commandId, from: item.from, to: item.to, candidateDigest: item.candidateDigest, verificationReceipt: item.verificationReceipt, changes }; }));
              return { schemaVersion: 1, digest, capability, operation: batch.operation, expiresAt: batch.expiresAt, target: batch.target.target, display, items };
            }
            const command = queueExecuteSchema.parse(input);
            if ('rollbackDigest' in command) {
              const rollback = challenges.get(command.rollbackDigest);
              if (!rollback?.guard || rollback.peer !== peerKey || rollback.batch.operation !== 'rollback' || rollback.batch.items[0]?.commandId !== command.commandId) throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED');
              challenges.delete(command.rollbackDigest);
              const consent = async () => rollback.guard!();
              return new TargetBatchExecutor(c.app, c.queue, await ports.effects(c, peer, consent), { assert: consent }, Date.now).rollback(rollback.batch);
            }
            const publish = challenges.get(command.publishDigest), adopt = challenges.get(command.adoptDigest);
            if (!publish?.guard || !adopt?.guard || publish.peer !== peerKey || adopt.peer !== peerKey || publish.batch.items[0]?.commandId !== command.commandId) throw new TargetQueueError('QUEUE_CONFIRMATION_REQUIRED');
            challenges.delete(command.publishDigest); challenges.delete(command.adoptDigest);
            const consent = async (operation: TargetBatch['operation']) => (operation === 'publish' ? publish.guard! : adopt.guard!)();
            return new TargetBatchExecutor(c.app, c.queue, await ports.effects(c, peer, consent), { assert: batch => consent(batch.operation) }, Date.now).execute(publish.batch, adopt.batch);
          }, 'request');
        })();
        if (Buffer.byteLength(JSON.stringify(result)) > runtimeServiceResultCapacity(request.requestId, responseMaxBytes, request.delivery!.maxResultBytes)) throw ErrorRegistry.createError('RUNTIME_SERVICE_RESPONSE_LIMIT');
        return result;
      });
    },
  };
  return service;
}

/** Background work keeps the admitted actor; an MCP request is never prepared under the owner's identity. A service re-attempt ticket runs as
 * the human who delegated it (its actor is that human's service principal, provenance only). */
export function selectQueueActor(record: TargetQueueRecord, read: (channel: 'mcp' | undefined) => { id: string; issuer: string; subject: string }): 'mcp' | undefined {
  for (const channel of [undefined, 'mcp'] as const) { const current = read(channel), actor = queueApprover(record.request);
    if (current.id === actor.id && current.issuer === actor.issuer && current.subject === actor.subject) return channel; }
  throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
}
