import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, workerReportLimits, parkRunProgression, holdRun, answerTaskInput, closeParkedRun, resumeParkedRun, expireParkedRun, parkTaskAwaitingDecision, resolveTaskDecision,
  counterSchema, identitySchema, runSnapshotSchema, type AttemptIdentity, type VerifiedPrincipal, type TaskProgress, type RunSnapshot } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
interface TaskDecisionAuthorization { authorize(identity: AttemptIdentity, principal: VerifiedPrincipal): Promise<void> }
import { runQuerySchema, type RunQuery, type RunAuthorization } from './application.js';
import { RunStoreError, type RunReceipt, type RunStore } from './store.js';
const base = z.object({ schemaVersion: z.literal(1), commandId: identitySchema, scopeId: identitySchema, runId: identitySchema,
  expectedRevision: counterSchema });
/** Human-only decisions. Timing, actor, evaluation and evidence never come from the caller. */
const holdReason = z.string().trim().min(1).max(workerReportLimits.handoffOpenQuestionChars);
const answer = z.string().trim().min(1).max(workerReportLimits.handoffSummaryChars);
/** Policy-gated Run controls, also exposed by MCP. Human input decisions are separate. */
export const runControlCommandSchema = z.discriminatedUnion('action', [
  base.extend({ action: z.literal('hold'), holdReason }).strict(),
  base.extend({ action: z.literal('resume') }).strict(),
]);
export const runLifecycleCommandSchema = z.discriminatedUnion('action', [
  base.extend({ action: z.enum(['close', 'resume']) }).strict(),
  base.extend({ action: z.literal('hold'), holdReason }).strict(),
  base.extend({ action: z.literal('answer'), taskId: identitySchema, answer }).strict(),
  base.extend({ action: z.enum(['accept', 'reject']), taskId: identitySchema }).strict(),
]);
export const runProgressionParkCommandSchema = base.extend({ failureCode: identitySchema }).strict();
export type RunLifecycleCommand = z.infer<typeof runLifecycleCommandSchema>;
/** Trusted, freshly authenticated application-to-ledger transition. */
export const runLifecycleWriteSchema = base.extend({ action: z.enum(['close', 'resume', 'hold', 'answer', 'expire', 'park-task', 'park-progression', 'accept', 'reject']),
  holdReason: holdReason.optional(), answer: answer.optional(), failureCode: identitySchema.optional(),
  taskId: identitySchema.optional(), reason: z.enum(['evaluation-unknown', 'evaluation-not-ready']).optional(),
  actor: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema,
    assurance: z.enum(['os-user', 'token-verified', 'workload-verified']) }).strict(),
  now: counterSchema, timeoutMs: counterSchema.positive(),
}).strict().superRefine((value, context) => {
  if ((['accept', 'reject', 'answer', 'park-task'].includes(value.action) !== (value.taskId !== undefined))
    || ((value.action === 'hold') !== (value.holdReason !== undefined)) || ((value.action === 'answer') !== (value.answer !== undefined))
    || ((value.action === 'park-progression') !== (value.failureCode !== undefined))
    || ((value.action === 'park-task') !== (value.reason !== undefined))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'RUN_INVALID' });
});
export type RunLifecycleWrite = z.infer<typeof runLifecycleWriteSchema>;
export interface RunLifecycleStore extends Pick<RunStore, 'loadRun'> {
  loadRunReceipt?(scopeId: string, commandId: string): Promise<RunReceipt | null>;
  hasTaskEvaluation?(identity: AttemptIdentity, revision: number): Promise<boolean>;
  commitRunLifecycle(input: RunLifecycleWrite, audit?: (store: AuditStore, snapshot: RunSnapshot) => void): Promise<RunReceipt>;
}
export type RunLifecycleAuditRecorder = (store: AuditStore) => { record(event: unknown): unknown };
export class RunLifecycleError extends Error {
  constructor(readonly code: 'TASK_DECISION_HUMAN_REQUIRED') { super(code); this.name = 'RunLifecycleError'; }
}
/** Trusted ledger transition proposal; the adapter owns CAS, receipt and atomic audit persistence. */
export function proposeRunLifecycleWrite(current: RunSnapshot, write: RunLifecycleWrite, audited: boolean, evidence?: readonly string[]): RunSnapshot {
  const { action, expectedRevision, now, timeoutMs } = write;
  if (action === 'resume' && ((write.actor.assurance !== 'os-user' && (current.state.kind !== 'parked' || current.state.reason !== 'operator-hold'))
    || (current.state.kind === 'parked' && current.state.reason === 'operator-hold' && !audited))) throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
  if (action === 'park-progression') {
    if (!audited) throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    return parkRunProgression(current, expectedRevision, write.failureCode!, now, timeoutMs);
  }
  if (action === 'hold') return holdRun(current, expectedRevision, write.holdReason!, now, timeoutMs);
  if (action === 'answer') return answerTaskInput(current, expectedRevision, write.taskId!, write.answer!, now, timeoutMs);
  if (action === 'close') return closeParkedRun(current, expectedRevision, now, timeoutMs);
  if (action === 'resume') return resumeParkedRun(current, expectedRevision, now, timeoutMs);
  if (action === 'expire') return expireParkedRun(current, expectedRevision, now, timeoutMs);
  if (action === 'park-task') return parkTaskAwaitingDecision(current, expectedRevision, write.taskId!, write.reason!, now, timeoutMs, undefined, evidence);
  return resolveTaskDecision(current, expectedRevision, write.taskId!, action, now, timeoutMs);
}
/** Every surface shares this ingress. Only human decisions require os-user assurance. */
export class RunLifecycleApplication {
  constructor(private readonly store: RunLifecycleStore, private readonly verifier: PrincipalVerifier,
    private readonly runAuthorization: RunAuthorization, private readonly taskAuthorization: TaskDecisionAuthorization,
    private readonly recorder: RunLifecycleAuditRecorder, private readonly now: () => number, private readonly timeoutMs: number, private readonly policyRevision: string) {}
  async advance(input: unknown, credential?: unknown) {
    const query: RunQuery = runQuerySchema.parse(input), principal = await authenticate(this.verifier, credential, query.scopeId);
    // Due discovery is a read; ordinary progression must not require terminal write authority.
    await this.runAuthorization.authorize('inspect', query, principal);
    let run = await this.store.loadRun(query.scopeId, query.runId);
    if (!run) return null;
    let receipt: RunReceipt | null = null;
    const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance };
    // Ledger45 preserves history. Previously recorded unknowns are parked on the first authorized maintenance turn, without re-evaluation.
    for (const binding of run.bindings) {
      if (binding.observedKind !== 'exited' || binding.observedRevision === null || !this.store.hasTaskEvaluation) continue;
      const task: TaskProgress | undefined = run.progress.find(value => value.taskId === binding.identity.taskId);
      if (task?.phase !== 'evaluating' || task.unresolvedEffects || !await this.store.hasTaskEvaluation(binding.identity, binding.observedRevision)) continue;
      await this.taskAuthorization.authorize(binding.identity, principal);
      receipt = await this.store.commitRunLifecycle({ ...query, commandId: randomUUID(), expectedRevision: run.revision,
        action: 'park-task', taskId: task.taskId, reason: 'evaluation-unknown', actor, now: this.now(), timeoutMs: this.timeoutMs });
      run = receipt.snapshot;
    }
    const now = this.now();
    if (!(run.state.kind === 'parked' && run.state.deadline <= now) && !run.progress.some(task => task.decision && task.decision.deadline <= now)) return receipt;
    // Only due Run/task expiry uses the same terminal write authority as operator close.
    await this.runAuthorization.authorize('cancel', query, principal);
    return this.store.commitRunLifecycle({ ...query, commandId: randomUUID(), expectedRevision: run.revision, action: 'expire', actor,
      now, timeoutMs: this.timeoutMs });
  }
  async parkProgression(input: unknown, credential?: unknown) {
    const command = runProgressionParkCommandSchema.parse(input), principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.runAuthorization.authorize('cancel', command, principal);
    const now = counterSchema.parse(this.now());
    return this.store.commitRunLifecycle({ ...command, action: 'park-progression', actor: { id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance }, now, timeoutMs: this.timeoutMs }, (store, snapshot) => {
      this.recorder(store).record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId,
        principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.policyRevision, atMs: now,
        subject: { kind: 'run-lifecycle', action: 'park-progression', runId: command.runId, commandId: command.commandId,
          taskId: null, revision: snapshot.revision, evidence: null } });
    });
  }
  async execute(input: unknown, credential?: unknown) {
    const command = runLifecycleCommandSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    if (!['hold', 'resume'].includes(command.action) && principal.assurance !== 'os-user') throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    if (command.action === 'accept' || command.action === 'reject' || command.action === 'answer') {
      const replay = command.action === 'answer' ? await this.store.loadRunReceipt?.(command.scopeId, command.commandId) : null;
      const run = runSnapshotSchema.parse(await this.store.loadRun(command.scopeId, command.runId));
      const source = replay ? runSnapshotSchema.parse(replay.snapshot).progress.find(task => task.taskId === command.taskId)?.inputAnswer?.source
        : run.bindings.find(value => value.identity.taskId === command.taskId)?.identity;
      if (!source) throw new RunStoreError('RUN_STORE_CONFLICT');
      await this.taskAuthorization.authorize(source, principal);
    } else {
      await this.runAuthorization.authorize(command.action === 'close' || command.action === 'hold' ? 'cancel' : 'reserve', command, principal);
      if (command.action === 'resume' && principal.assurance !== 'os-user') {
        const replay = await this.store.loadRunReceipt?.(command.scopeId, command.commandId);
        if (replay) {
          const payload = JSON.parse(replay.command); delete payload.operation;
          const write = runLifecycleWriteSchema.parse(payload);
          if (write.action !== 'resume') throw new RunStoreError('RUN_COMMAND_CONFLICT');
        } else {
          const run = runSnapshotSchema.parse(await this.store.loadRun(command.scopeId, command.runId));
          if (run.state.kind !== 'parked' || run.state.reason !== 'operator-hold') throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
        }
      }
    }
    const now = counterSchema.parse(this.now());
    return this.store.commitRunLifecycle({ ...command, actor: { id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance }, now, timeoutMs: this.timeoutMs }, (store, snapshot) => {
      this.recorder(store).record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId,
        principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.policyRevision, atMs: now,
        subject: { kind: 'run-lifecycle', action: command.action, runId: command.runId, commandId: command.commandId,
          ...(command.action === 'hold' || command.action === 'answer' ? { inputDigest: createHash('sha256').update(command.action === 'hold' ? command.holdReason : command.answer).digest('hex') } : {}),
          taskId: 'taskId' in command ? command.taskId : null, revision: snapshot.revision,
          evidence: command.action === 'accept' ? 'model-unverified' : null } });
    });
  }
}
