import { createHash } from 'node:crypto';
import { queueApprover, queueServiceActor, sameAttemptIdentity, taskGraphSchema, type AttemptIdentity, type ExecutionProfileDefinition,
  type VerifiedPrincipal, type RunSnapshot, type TargetQueueRecord, type TargetQueueRequest, type TaskGraph } from '#domain/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import type { QueueReattemptView, TargetQueueApplication } from '#engine/core/effect/index.js';
import type { RunAdmission, RunStore } from '#engine/core/runs/index.js';
import type { DispatchIdentityAuthorization, RunBoundDispatchStore } from '#engine/core/dispatch/index.js';
import { WorkspacePatchApplication, type RunBoundTaskStore } from './application.js';
import { WorkspaceIntegrationApplication, type IntegrationTarget } from './integration.js';
import type { PatchScopeMode } from './scope.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Adapter-classified effect reach of a task's frozen execution profile. Anything not proven workspace-only is never re-attempted. */
export type ReattemptEffects = 'workspace-only' | 'external' | 'unknown';
/** Versioned names derived from the replaced ticket's durable identity: the scan, a restart and replay meet the same Run and ticket. */
export function reattemptCommandIds(record: Pick<TargetQueueRecord, 'request'>) {
  const key = digest({ scopeId: record.request.identity.scopeId, commandId: record.request.commandId });
  return { run: `queue-reattempt-${key}`, create: `queue-reattempt-create-${key}`, ticket: `queue-reattempt-ticket-${key}` };
}
/** D1a eligibility, pure. Only a settled base-advanced delivery under the human's intent, whose accepted Attempt exited with settled effects,
 * whose profile is workspace-only, with no cross-task inputs and every accepted-patch predecessor adopted on this target, below the bound. */
export function reattemptEligibility(record: TargetQueueRecord, run: RunSnapshot | null, bound: number,
  effects: (profile: ExecutionProfileDefinition) => ReattemptEffects, runTickets: readonly TargetQueueRecord[]): string | null {
  const request = record.request, taskId = request.identity.taskId;
  if (!request.deliveryIntent) return 'DELIVERY_INTENT_MISSING';
  if (record.reason === 'DELIVERY_REATTEMPT_EXHAUSTED' || (request.reattempt?.count ?? 0) >= bound) return 'DELIVERY_REATTEMPT_EXHAUSTED';
  const task = run?.graph.tasks.find(row => row.id === taskId), progress = run?.progress.find(row => row.taskId === taskId);
  const binding = run?.bindings.find(row => sameAttemptIdentity(row.identity, request.identity)), profile = run?.execution.tasks.find(row => row.taskId === taskId)?.profile;
  if (record.state !== 'settled' || record.outcome !== 'conflict-needs-reattempt' || record.reason !== 'PATCH_BASE_ADVANCED' || record.batchDigest !== null
    || request.operation === 'rollback' || !task || progress?.phase !== 'accepted') return 'DELIVERY_REATTEMPT_NOT_ELIGIBLE';
  // Uncertain or external effects stay with reconciliation and a human: never a silent second execution.
  if (progress.unresolvedEffects || binding?.observedKind !== 'exited' || !profile || effects(profile) !== 'workspace-only') return 'DELIVERY_REATTEMPT_EFFECTS';
  const adopted = (predecessor: string) => {
    const identity = run!.bindings.find(row => row.identity.taskId === predecessor)?.identity;
    return !!identity && runTickets.some(row => row.key === record.key && row.state === 'settled' && sameAttemptIdentity(row.request.identity, identity)
      && (row.outcome === 'adopted' || row.outcome === 're-prepared+adopted'));
  };
  // A dependent re-runs alone on the current base, so each accepted-patch predecessor must already be adopted there; inputs are not re-wired.
  if (task.inputs?.length || task.dependencies.some(edge => typeof edge !== 'string' && edge.startFrom === 'accepted-patch' && !adopted(edge.taskId)))
    return 'DELIVERY_REATTEMPT_NOT_ELIGIBLE';
  return null;
}
/** The same frozen Task (kind, work class, work input, criteria) as a single-task graph; its predecessors are already on the target. */
export function reattemptGraph(run: RunSnapshot, taskId: string): TaskGraph {
  const task = run.graph.tasks.find(row => row.id === taskId)!, { inputs: _inputs, ...frozen } = task; void _inputs;
  return taskGraphSchema.parse({ schemaVersion: run.graph.schemaVersion, revision: 1, tasks: [{ ...frozen, dependencies: [] }],
    criterionDefinitions: run.graph.criterionDefinitions.filter(row => task.acceptanceCriteria.includes(row.id)) });
}
export interface DeliveryReattemptPorts {
  readonly bound: number; readonly policyRevision: string; readonly ttlMs: number; now(): number;
  load(scopeId: string, commandId: string): TargetQueueRecord | null;
  forRun(scopeId: string, runId: string): readonly TargetQueueRecord[];
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
  effects(profile: ExecutionProfileDefinition): ReattemptEffects;
  /** The adapter's own optimistic-concurrency check of the ORIGINAL output on the live target (Git: base commit; ERP: record version). */
  baseAdvanced(record: TargetQueueRecord): Promise<boolean>;
  /** Normal Run admission as the delegating human: policy, pool, ceilings and any Run-create approval card are unchanged. */
  admit(command: RunAdmission): Promise<void>;
  accepted(identity: AttemptIdentity): Promise<{ acceptedRevision: number; outputDigest: string }>;
  submit(request: TargetQueueRequest): Promise<TargetQueueRecord>;
}
/** One bounded step of one base-advanced ticket's re-attempt. `act` false observes only (queue view); every write is idempotent by name. */
export async function stepDeliveryReattempt(ports: DeliveryReattemptPorts, record: TargetQueueRecord, act: boolean): Promise<QueueReattemptView | null> {
  const request = record.request, ids = reattemptCommandIds(record), scopeId = request.identity.scopeId, used = request.reattempt?.count ?? 0;
  if (!request.deliveryIntent || record.outcome !== 'conflict-needs-reattempt') return null;
  const view = (state: QueueReattemptView['state'], extra: Partial<QueueReattemptView> = {}): QueueReattemptView =>
    ({ state, count: used + 1, bound: ports.bound, cause: record.reason ?? 'PATCH_BASE_ADVANCED', runId: ids.run, ...extra });
  if (ports.load(scopeId, ids.ticket)) return view('enqueued', { commandId: ids.ticket });
  const run = await ports.loadRun(scopeId, ids.run);
  if (!run) {
    const original = await ports.loadRun(scopeId, request.identity.runId);
    const refused = reattemptEligibility(record, original, ports.bound, ports.effects, ports.forRun(scopeId, request.identity.runId));
    if (refused) return { state: refused === 'DELIVERY_REATTEMPT_EXHAUSTED' ? 'exhausted' : 'refused', count: used, bound: ports.bound, cause: request.reattempt?.cause ?? 'PATCH_BASE_ADVANCED', reason: refused };
    // Observation never touches the target; the service checks the live base before it starts the Run.
    if (!act || !await ports.baseAdvanced(record)) return view('waiting-base');
    try { await ports.admit({ schemaVersion: 1, commandId: ids.create, scopeId, runId: ids.run, graph: reattemptGraph(original!, request.identity.taskId) }); }
    catch (error) {
      // A Run-create card waits for a human; any other typed admission refusal (policy, pool, ceilings) is shown and retried after backoff.
      const code = (error as { code?: unknown }).code;
      if (code === 'RUN_APPROVAL_REQUIRED') return view('awaiting-approval');
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return view('refused', { reason: code });
      throw error;
    }
    return view('running');
  }
  const phase = run.progress.find(row => row.taskId === request.identity.taskId)?.phase;
  const identity = run.bindings.find(row => row.identity.taskId === request.identity.taskId)?.identity;
  if (phase === 'failed' || phase === 'cancelled' || phase === 'skipped' || (run.state.kind === 'terminal' && phase !== 'accepted')) return view('failed', { reason: 'DELIVERY_REATTEMPT_FAILED' });
  if (phase !== 'accepted' || !identity || !act) return view('running');
  const accepted = await ports.accepted(identity), approver = queueApprover(request), now = ports.now();
  await ports.submit({ schemaVersion: 1, commandId: ids.ticket, identity, target: request.target, actor: queueServiceActor(approver),
    payloadDigest: digest({ reattemptOf: request.commandId, identity }), policyRevision: ports.policyRevision, outputDigest: accepted.outputDigest,
    acceptedRevision: accepted.acceptedRevision, submittedAt: now, deadline: now + ports.ttlMs, deliveryIntent: request.deliveryIntent,
    reattempt: { sourceCommandId: request.commandId, intentCommandId: request.reattempt?.intentCommandId ?? request.commandId, count: used + 1, cause: record.reason!, approvedBy: approver } });
  return view('enqueued', { commandId: ids.ticket });
}
export interface WorkspaceReattemptContext {
  readonly principal: VerifiedPrincipal; readonly document: { readonly revision: string }; readonly artifacts: ArtifactStore; readonly scopeMode: PatchScopeMode;
  readonly config: { readonly targetQueue: { readonly reattempts: number; readonly ttlMs: number; readonly perTarget: number }; readonly artifacts: { readonly maxBytes: number } };
  readonly queue: { load(scopeId: string, commandId: string): TargetQueueRecord | null; forRun(scopeId: string, runId: string, limit: number): readonly TargetQueueRecord[] };
  readonly app: Pick<TargetQueueApplication, 'submitReattempt'>; readonly authorization: DispatchIdentityAuthorization;
  accepted(identity: AttemptIdentity): Promise<{ acceptedRevision: number; outputDigest: string }>;
}
/** Work-target wiring of one step as the delegating human: the base check is the work target's own integration check of the original output. */
export function stepWorkspaceQueueReattempt(c: WorkspaceReattemptContext, store: RunBoundDispatchStore & RunBoundTaskStore & Pick<RunStore, 'loadRun'>,
  adapter: { readonly target: IntegrationTarget; effects(profile: ExecutionProfileDefinition): ReattemptEffects; admit(command: RunAdmission): Promise<void>;
    /** Retains the accepted Attempt's patch when evaluation did not (a kind without work input), like a human `patch-prepare`. */
    preparePatch(identity: AttemptIdentity): Promise<void> },
  record: TargetQueueRecord, act: boolean) {
  const verifier = { async verify() { return c.principal; } }, maxBytes = c.config.artifacts.maxBytes;
  const integration = new WorkspaceIntegrationApplication(new WorkspacePatchApplication(store, c.artifacts, verifier, c.authorization, maxBytes, c.scopeMode),
    adapter.target, verifier, c.authorization, c.artifacts, maxBytes);
  return stepDeliveryReattempt({ bound: c.config.targetQueue.reattempts, policyRevision: c.document.revision, ttlMs: c.config.targetQueue.ttlMs, now: Date.now,
    load: (scopeId, commandId) => c.queue.load(scopeId, commandId), forRun: (scopeId, runId) => c.queue.forRun(scopeId, runId, c.config.targetQueue.perTarget),
    loadRun: (scopeId, runId) => store.loadRun(scopeId, runId), effects: profile => adapter.effects(profile), admit: command => adapter.admit(command),
    async baseAdvanced(ticket) {
      try { await integration.check(ticket.request.identity); return false; }
      catch (error) { if ((error as { code?: unknown }).code === 'PATCH_BASE_ADVANCED') return true; throw error; }
    },
    async accepted(identity) { if (!(await store.loadBoundDispatch(identity))?.patch) await adapter.preparePatch(identity); return c.accepted(identity); },
    submit: request => c.app.submitReattempt(request, c.principal) }, record, act);
}
