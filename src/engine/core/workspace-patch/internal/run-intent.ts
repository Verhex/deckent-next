import { createHash } from 'node:crypto';
import { ErrorRegistry } from '#platform/index.js';
import { queueRequeueCause, queueServiceActor, sameAttemptIdentity, type AttemptIdentity, type RunSnapshot, type TargetBinding, type TargetQueueRecord,
  type TargetQueueRequest, type VerifiedPrincipal } from '#domain/index.js';
import type { TargetQueueApplication } from '#engine/core/effect/index.js';
import type { RunStore } from '#engine/core/runs/index.js';
import type { RunBoundDispatchStore } from '#engine/core/dispatch/index.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: { id: string; issuer: string; subject: string }, b: { id: string; issuer: string; subject: string }) => a.id === b.id && a.issuer === b.issuer && a.subject === b.subject;
/** D2b, pure: a delegated ticket is admitted only for the Run whose proposal carries the intent for exactly this target, granted by this
 * human, and whose Run-create card was approved (an intent always asks a human; no card, no intent). Checked at every admission. */
export function assertRunDeliveryIntent(run: RunSnapshot | null, request: Pick<TargetQueueRequest, 'identity' | 'target' | 'delegation'>): void {
  const intent = run?.proposal?.delivery, delegation = request.delegation;
  if (!run || !intent || !delegation || !run.authority?.approval || intent.mode !== 'enqueue-accepted' || run.identity.runId !== request.identity.runId
    || intent.target.kind !== request.target.target.kind || intent.target.id !== request.target.target.id || !same(intent.grantedBy, delegation.grantedBy)
    || delegation.intentRef.proposalId !== run.proposal!.proposalId || delegation.intentRef.digest !== run.proposal!.digest) throw ErrorRegistry.createError('DELIVERY_INTENT_NOT_ADMITTED');
}
export type RunDeliveryStep = Readonly<{ taskId: string; state: 'enqueued' | 'requeued' | 'exhausted' | 'refused'; commandId?: string; reason?: string }>;
export interface RunDeliveryPorts {
  readonly requeueMax: number; readonly policyRevision: string; readonly ttlMs: number; now(): number;
  forRun(scopeId: string, runId: string): readonly TargetQueueRecord[];
  binding(target: { kind: string; id: string }): Promise<TargetBinding>;
  /** The accepted Attempt's output (its patch retained first when evaluation did not, like a human `patch-prepare`). */
  accepted(identity: AttemptIdentity): Promise<{ acceptedRevision: number; outputDigest: string }>;
  submit(request: TargetQueueRequest): Promise<TargetQueueRecord>;
}
/** One bounded pass over a Run under delivery intent, as the granting human. Each accepted Attempt that delivers a workspace gets one
 * service ticket; a delegated ticket that stopped before any effect is re-queued by typed cause under a new command id up to the bound.
 * A base-advanced conflict stays with the existing bounded re-attempt (the ticket carries its intent). Human tickets stay the human's. */
export async function stepRunDelivery(ports: RunDeliveryPorts, run: RunSnapshot): Promise<readonly RunDeliveryStep[]> {
  const intent = run.proposal?.delivery, scopeId = run.identity.scopeId, runId = run.identity.runId;
  if (!intent || !run.authority?.approval) return [];
  const tickets = ports.forRun(scopeId, runId), steps: RunDeliveryStep[] = [];
  const intentRef = { runId, proposalId: run.proposal!.proposalId, digest: run.proposal!.digest }, actor = queueServiceActor(intent.grantedBy);
  for (const task of run.progress) {
    const identity = run.bindings.find(row => row.identity.taskId === task.taskId && row.observedKind === 'exited')?.identity;
    if (task.phase !== 'accepted' || !identity || run.execution.tasks.find(row => row.taskId === task.taskId)?.workspaceDelivery === 'none') continue;
    const own = tickets.filter(row => sameAttemptIdentity(row.request.identity, identity));
    const tip = own.find(row => row.request.delegation && !own.some(other => other.request.delegation?.requeue?.sourceCommandId === row.request.commandId));
    const cause = tip ? queueRequeueCause(tip) : null, count = (tip?.request.delegation?.requeue?.count ?? 0) + 1;
    if (own.length && !cause) continue;
    if (tip && cause && count > ports.requeueMax) { steps.push({ taskId: task.taskId, state: 'exhausted', reason: 'QUEUE_REQUEUE_EXHAUSTED' }); continue; }
    const requeue = tip && cause ? { sourceCommandId: tip.request.commandId, count, cause, ...(tip.reason ? { reason: tip.reason } : {}) } : undefined;
    const commandId = `queue-intent-${digest({ scopeId, runId, attemptId: identity.attemptId, requeue: requeue?.sourceCommandId ?? null })}`;
    try {
      const target = await ports.binding(intent.target), accepted = await ports.accepted(identity), now = ports.now();
      await ports.submit({ schemaVersion: 1, commandId, identity, target, actor, payloadDigest: digest({ intentRef, identity, requeue: requeue ?? null }),
        policyRevision: ports.policyRevision, outputDigest: accepted.outputDigest, acceptedRevision: accepted.acceptedRevision, submittedAt: now, deadline: now + ports.ttlMs,
        deliveryIntent: 'service-reattempt', delegation: { intentRef, grantedBy: intent.grantedBy, ...(requeue ? { requeue } : {}) } });
      steps.push({ taskId: task.taskId, state: requeue ? 'requeued' : 'enqueued', commandId });
    } catch (error) {
      // A typed refusal (intent, policy, target, bound) is shown and retried on a later scan; anything else is the service's failure.
      const code = (error as { code?: unknown }).code;
      if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) throw error;
      steps.push({ taskId: task.taskId, state: code === 'QUEUE_REQUEUE_EXHAUSTED' ? 'exhausted' : 'refused', reason: code });
    }
  }
  return Object.freeze(steps);
}
export interface WorkspaceRunDeliveryContext {
  readonly principal: VerifiedPrincipal; readonly document: { readonly revision: string };
  readonly config: { readonly targetQueue: { readonly requeueMax: number; readonly ttlMs: number; readonly capacity: number } };
  readonly queue: { forRun(scopeId: string, runId: string, limit: number): readonly TargetQueueRecord[] };
  readonly target: { binding(target: { kind: string; id: string }): Promise<TargetBinding> };
  readonly app: Pick<TargetQueueApplication, 'submitDelegated'>;
  accepted(identity: AttemptIdentity): Promise<{ acceptedRevision: number; outputDigest: string }>;
}
/** Work-target wiring of one Run's pass as the granting human (the same patch retention as the bounded re-attempt). */
export async function stepWorkspaceRunDelivery(c: WorkspaceRunDeliveryContext, store: Pick<RunStore, 'loadRun'> & RunBoundDispatchStore,
  preparePatch: (identity: AttemptIdentity) => Promise<void>, ref: Readonly<{ scopeId: string; runId: string }>): Promise<readonly RunDeliveryStep[]> {
  const run = await store.loadRun(ref.scopeId, ref.runId);
  return run ? stepRunDelivery({ requeueMax: c.config.targetQueue.requeueMax, policyRevision: c.document.revision, ttlMs: c.config.targetQueue.ttlMs, now: Date.now,
    forRun: (scopeId, runId) => c.queue.forRun(scopeId, runId, c.config.targetQueue.capacity), binding: target => c.target.binding(target),
    async accepted(identity) { if (!(await store.loadBoundDispatch(identity))?.patch) await preparePatch(identity); return c.accepted(identity); },
    submit: request => c.app.submitDelegated(request, c.principal) }, run) : [];
}
