import { clientCommandIdSchema } from '#domain/index.js';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, workerReportLimits, parkRunProgression, holdRun, answerRunQuotaWrite, quotaAnswerFields, quotaAnswerShapeInvalid, withQuotaAnswer, answerTaskInput, closeParkedRun, resumeParkedRun, expireParkedRun, parkTaskAwaitingDecision, resolveTaskDecision,
  deciderClassSchema, isAiPrincipal, aiAuthorityFloor, readRunHold, safetyHoldSourceSchema, counterSchema, identitySchema, runSnapshotSchema, type AttemptIdentity, type VerifiedPrincipal,
  type TaskProgress, type RunSnapshot, type SafetyHoldSource, type RunQuotaAskPolicy } from '#domain/index.js';
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
  base.extend({ action: z.literal('quota-answer'), choice: z.enum(['wait', 'next-candidate']) }).strict(),
]);
export const runProgressionParkCommandSchema = base.extend({ failureCode: identitySchema }).strict();
/** S5b: a safety hold's input; its source is bound by composition to the producer (Nervous pause, Auditor park), never by a caller. */
export const runSafetyHoldCommandSchema = base.extend({ holdReason }).strict();
/** S6R-3: the broker's hold input; the revision is read at write time (`holdOnce`). */
export const runSafetyHoldOnceSchema = runSafetyHoldCommandSchema.omit({ expectedRevision: true });
export type RunLifecycleCommand = z.infer<typeof runLifecycleCommandSchema>;
/** Trusted, freshly authenticated application-to-ledger transition. */
export const runLifecycleWriteSchema = base.extend({ action: z.enum(['close', 'resume', 'hold', 'answer', 'expire', 'park-task', 'park-progression', 'accept', 'reject', 'quota-answer']),
  holdReason: holdReason.optional(), holdSource: safetyHoldSourceSchema.optional(), answer: answer.optional(), failureCode: identitySchema.optional(),
  ...quotaAnswerFields, taskId: identitySchema.optional(), reason: z.enum(['evaluation-unknown', 'evaluation-not-ready']).optional(),
  actor: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema,
    assurance: z.enum(['os-user', 'token-verified', 'workload-verified']) }).strict(),
  decision: z.object({ schemaVersion: z.literal(1), deciderClass: deciderClassSchema, policyRevision: identitySchema,
    step: z.enum(['operator-control', 'human-step']).optional(), ruleId: identitySchema.optional(), approvalId: identitySchema.optional() }).strict().optional(),
  now: counterSchema, timeoutMs: counterSchema.positive(),
}).strict().superRefine((value, context) => {
  if ((['accept', 'reject', 'answer', 'park-task'].includes(value.action) !== (value.taskId !== undefined))
    || ((value.action === 'hold') !== (value.holdReason !== undefined)) || (value.holdSource !== undefined && value.action !== 'hold') || ((value.action === 'answer') !== (value.answer !== undefined))
    || ((value.action === 'park-progression') !== (value.failureCode !== undefined))
    || ((value.action === 'park-task') !== (value.reason !== undefined)) || quotaAnswerShapeInvalid(value)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'RUN_INVALID' });
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
  constructor(readonly code: 'TASK_DECISION_HUMAN_REQUIRED' | 'TASK_DECISION_APPROVAL_REQUIRED' | 'RUN_HOLD_PERSON_REQUIRED' | 'RUN_QUOTA_PERSON_REQUIRED', readonly approvalId?: string) { super(code); this.name = 'RunLifecycleError'; }
}
export type RunDecisionEvidence = NonNullable<RunLifecycleWrite['decision']>;
export interface RunDecisionAuthorization {
  authorize(command: RunLifecycleCommand, principal: VerifiedPrincipal, run: RunSnapshot, replay?: RunLifecycleWrite): Promise<RunDecisionEvidence>;
}
/** Trusted ledger transition proposal; the adapter owns CAS, receipt and atomic audit persistence. */
export function proposeRunLifecycleWrite(current: RunSnapshot, write: RunLifecycleWrite, audited: boolean, evidence?: readonly string[]): RunSnapshot {
  const { action, expectedRevision, now, timeoutMs } = write;
  // S5b (Auditor owner decision 6): every resume is a decision, an operator hold's included; an AI actor needs its explicit cell (MCP1).
  const needsDecision = ['accept', 'reject', 'answer', 'close', 'resume', 'quota-answer'].includes(action);
  // A safety hold is lifted only by a person at a terminal, whatever a policy cell or a forged decision says (the Y4 floor, here at the ledger).
  const hold = action === 'resume' ? readRunHold(current.state) : null;
  if (hold && (aiAuthorityFloor(write.actor, { kind: 'run-hold', id: hold.source }, 'resume') || hold.source !== 'operator' && write.decision?.deciderClass !== 'human-tty'))
    throw new RunLifecycleError('RUN_HOLD_PERSON_REQUIRED');
  if (needsDecision && isAiPrincipal(write.actor) && (!write.decision || write.decision.deciderClass !== 'ai-policy' && !write.decision.approvalId || !write.decision.ruleId && !write.decision.approvalId))
    throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
  if (needsDecision && !audited) throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
  if (action === 'park-progression') {
    if (!audited) throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    return parkRunProgression(current, expectedRevision, write.failureCode!, now, timeoutMs);
  }
  if (action === 'hold') return holdRun(current, expectedRevision, write.holdReason!, now, timeoutMs, write.holdSource);
  if (action === 'quota-answer') return answerRunQuotaWrite(current, write, aiAuthorityFloor(write.actor, { kind: 'run-quota', id: 'ask' }, 'answer'));
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
    private readonly recorder: RunLifecycleAuditRecorder, private readonly now: () => number, private readonly timeoutMs: number, private readonly policyRevision: string, private readonly decisions?: RunDecisionAuthorization, private readonly quota?: RunQuotaAskPolicy) {}
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
  /** S5b: the trusted safety-hold ingress (Nervous pause, Auditor park). Composition binds `source` to its producer; no surface carries it.
   * Same fresh cancel policy, CAS, receipt and atomic audit as the operator hold; only a person at a terminal resumes it. */
  async holdFrom(source: SafetyHoldSource, input: unknown, credential?: unknown) {
    const command = runSafetyHoldCommandSchema.parse(input), holdSource = safetyHoldSourceSchema.parse(source);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.runAuthorization.authorize('cancel', command, principal);
    const now = counterSchema.parse(this.now());
    return this.store.commitRunLifecycle({ ...command, action: 'hold', holdSource, actor: { id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance }, now, timeoutMs: this.timeoutMs }, (store, snapshot) => {
      this.recorder(store).record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId,
        principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.policyRevision, atMs: now,
        subject: { kind: 'run-lifecycle', action: 'hold', deciderClass: 'system', holdSource, runId: command.runId, commandId: command.commandId,
          inputDigest: createHash('sha256').update(command.holdReason).digest('hex'), taskId: null, revision: snapshot.revision, evidence: null } });
    });
  }
  /** S6R-3: the Nervous broker's hold of one Run, replay-safe by its case-derived command id: a committed receipt is the result, a Run this source
   * already holds stays as it is (null), otherwise the hold is written at the current revision (a CAS loss is retried by the next replay). */
  async holdOnce(source: SafetyHoldSource, input: unknown, credential?: unknown) {
    const command = runSafetyHoldOnceSchema.parse(input);
    const prior = await this.store.loadRunReceipt?.(command.scopeId, command.commandId);
    if (prior) return prior;
    const run = runSnapshotSchema.parse(await this.store.loadRun(command.scopeId, command.runId));
    if (readRunHold(run.state)?.source === source) return null;
    return this.holdFrom(source, { ...command, expectedRevision: run.revision }, credential);
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
    if (!decision && command.action === 'resume' && isAiPrincipal(principal)) throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    const lifted = command.action === 'resume' ? readRunHold(run.state)?.source : undefined;
    const now = counterSchema.parse(this.now());
    return this.store.commitRunLifecycle({ ...withQuotaAnswer(command as typeof command & { choice?: 'wait' | 'next-candidate' }, this.quota), ...(decision ? { decision } : {}), actor: { id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance }, now, timeoutMs: this.timeoutMs }, (store, snapshot) => {
      this.recorder(store).record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId,
        principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: decision?.policyRevision ?? this.policyRevision, atMs: now,
        subject: { kind: 'run-lifecycle', action: command.action, deciderClass: decision?.deciderClass ?? 'system',
          ...(decision?.ruleId ? { decisionRuleId: decision.ruleId } : {}), ...(decision?.approvalId ? { approvalId: decision.approvalId } : {}),
          ...(lifted && lifted !== 'operator' ? { holdSource: lifted } : {}), runId: command.runId, commandId: command.commandId,
          ...(command.action === 'hold' || command.action === 'answer' ? { inputDigest: createHash('sha256').update(command.action === 'hold' ? command.holdReason : command.answer).digest('hex') } : {}),
          taskId: 'taskId' in command ? command.taskId : null, revision: snapshot.revision,
          evidence: command.action === 'accept' ? 'model-unverified' : null } });
    });
  }
}
