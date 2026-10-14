import { clientCommandIdSchema } from '#domain/index.js';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, workerReportLimits, parkRunProgression, holdRun, answerTaskInput, closeParkedRun, resumeParkedRun, expireParkedRun, parkTaskAwaitingDecision, resolveTaskDecision,
  deciderClassSchema, isAiPrincipal, counterSchema, identitySchema, runSnapshotSchema, type AttemptIdentity, type VerifiedPrincipal, type TaskProgress, type RunSnapshot } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
interface TaskDecisionAuthorization { authorize(identity: AttemptIdentity, principal: VerifiedPrincipal): Promise<void> }
import { runQuerySchema, type RunQuery, type RunAuthorization } from './application.js';
import { RunStoreError, type RunReceipt, type RunStore } from './store.js';
const base = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema, scopeId: identitySchema, runId: identitySchema,
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
  decision: z.object({ schemaVersion: z.literal(1), deciderClass: deciderClassSchema, policyRevision: identitySchema,
    step: z.enum(['operator-control', 'human-step']).optional(), ruleId: identitySchema.optional(), approvalId: identitySchema.optional() }).strict().optional(),
  now: counterSchema, timeoutMs: counterSchema.positive(),
}).strict().superRefine((value, context) => {
  if ((['accept', 'reject', 'answer', 'park-task'].includes(value.action) !== (value.taskId !== undefined))
    || ((value.action === 'hold') !== (value.holdReason !== undefined)) || ((value.action === 'answer') !== (value.answer !== undefined))
    || ((value.action === 'park-progression') !== (value.failureCode !== undefined))
    || ((value.action === 'park-task') !== (value.reason !== undefined))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'RUN_INVALID' });
});
export type RunLifecycleWrite = z.infer<typeof runLifecycleWriteSchema>;
/** Dual command reader: old receipts did not carry decision evidence; replay never rewrites their payload. */
export function matchRunLifecycleCommand(prior: string, current: string): boolean {
  const read = (encoded: string) => {
    const source = JSON.parse(encoded);
    if (source.operation !== 'run-lifecycle') throw new RunStoreError('RUN_COMMAND_CONFLICT');
    delete source.operation; return runLifecycleWriteSchema.parse(source);
  };
  const previous = read(prior), next = read(current);
  const fingerprint = (value: RunLifecycleWrite) => {
    const data: Partial<RunLifecycleWrite> = { ...value }; delete data.now; delete data.timeoutMs;
    if (previous.decision === undefined) delete data.decision;
    return JSON.stringify(data);
  };
  return fingerprint(previous) === fingerprint(next);
}
export interface RunLifecycleStore extends Pick<RunStore, 'loadRun'> {
  loadRunReceipt?(scopeId: string, commandId: string): Promise<RunReceipt | null>;
  hasTaskEvaluation?(identity: AttemptIdentity, revision: number): Promise<boolean>;
  commitRunLifecycle(input: RunLifecycleWrite, audit?: (store: AuditStore, snapshot: RunSnapshot) => void): Promise<RunReceipt>;
}
export type RunLifecycleAuditRecorder = (store: AuditStore) => { record(event: unknown): unknown };
export class RunLifecycleError extends Error {
  constructor(readonly code: 'TASK_DECISION_HUMAN_REQUIRED' | 'TASK_DECISION_APPROVAL_REQUIRED', readonly approvalId?: string) { super(code); this.name = 'RunLifecycleError'; }
}
export type RunDecisionEvidence = NonNullable<RunLifecycleWrite['decision']>;
export interface RunDecisionAuthorization {
  authorize(command: RunLifecycleCommand, principal: VerifiedPrincipal, run: RunSnapshot, replay?: RunLifecycleWrite): Promise<RunDecisionEvidence>;
}
/** Trusted ledger transition proposal; the adapter owns CAS, receipt and atomic audit persistence. */
export function proposeRunLifecycleWrite(current: RunSnapshot, write: RunLifecycleWrite, audited: boolean, evidence?: readonly string[]): RunSnapshot {
  const { action, expectedRevision, now, timeoutMs } = write;
  const needsDecision = ['accept', 'reject', 'answer', 'close'].includes(action)
    || action === 'resume' && (current.state.kind !== 'parked' || current.state.reason !== 'operator-hold');
  if (needsDecision && isAiPrincipal(write.actor) && (!write.decision || write.decision.deciderClass !== 'ai-policy' && !write.decision.approvalId || !write.decision.ruleId && !write.decision.approvalId))
    throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
  if ((needsDecision || action === 'resume') && !audited) throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
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
    private readonly recorder: RunLifecycleAuditRecorder, private readonly now: () => number, private readonly timeoutMs: number, private readonly policyRevision: string, private readonly decisions?: RunDecisionAuthorization) {}
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
        subject: { kind: 'run-lifecycle', action: 'park-progression', deciderClass: 'system', runId: command.runId, commandId: command.commandId,
          taskId: null, revision: snapshot.revision, evidence: null } });
    });
  }
  async execute(input: unknown, credential?: unknown) {
    const command = runLifecycleCommandSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    if (!this.decisions && isAiPrincipal(principal) && command.action !== 'hold' && command.action !== 'resume') throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    if (command.action === 'accept' || command.action === 'reject' || command.action === 'answer') {
      const replay = command.action === 'answer' ? await this.store.loadRunReceipt?.(command.scopeId, command.commandId) : null;
      const run = runSnapshotSchema.parse(await this.store.loadRun(command.scopeId, command.runId));
      const source = replay ? runSnapshotSchema.parse(replay.snapshot).progress.find(task => task.taskId === command.taskId)?.inputAnswer?.source
        : run.bindings.find(value => value.identity.taskId === command.taskId)?.identity;
      if (!source) throw new RunStoreError('RUN_STORE_CONFLICT');
      await this.taskAuthorization.authorize(source, principal);
    } else {
      await this.runAuthorization.authorize(command.action === 'close' || command.action === 'hold' ? 'cancel' : 'reserve', command, principal);
    }
    const loaded = await this.store.loadRun(command.scopeId, command.runId);
    const run = runSnapshotSchema.parse(loaded);
    const receipt = await this.store.loadRunReceipt?.(command.scopeId, command.commandId);
    let replay: RunLifecycleWrite | undefined;
    if (receipt) { const payload = JSON.parse(receipt.command); delete payload.operation; replay = runLifecycleWriteSchema.parse(payload); }
    if (!this.decisions && command.action !== 'hold' && !(command.action === 'resume' && run.state.kind === 'parked' && run.state.reason === 'operator-hold'))
      throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    const decision = this.decisions ? await this.decisions.authorize(command, principal, run, replay) : undefined;
    if (!decision && command.action === 'resume' && isAiPrincipal(principal)
      && (run.state.kind !== 'parked' || run.state.reason !== 'operator-hold')) throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    const now = counterSchema.parse(this.now());
    return this.store.commitRunLifecycle({ ...command, ...(decision ? { decision } : {}), actor: { id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance }, now, timeoutMs: this.timeoutMs }, (store, snapshot) => {
      this.recorder(store).record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId,
        principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: decision?.policyRevision ?? this.policyRevision, atMs: now,
        subject: { kind: 'run-lifecycle', action: command.action, deciderClass: decision?.deciderClass ?? 'system',
          ...(decision?.ruleId ? { decisionRuleId: decision.ruleId } : {}), ...(decision?.approvalId ? { approvalId: decision.approvalId } : {}), runId: command.runId, commandId: command.commandId,
          ...(command.action === 'hold' || command.action === 'answer' ? { inputDigest: createHash('sha256').update(command.action === 'hold' ? command.holdReason : command.answer).digest('hex') } : {}),
          taskId: 'taskId' in command ? command.taskId : null, revision: snapshot.revision,
          evidence: command.action === 'accept' ? 'model-unverified' : null } });
    });
  }
}
