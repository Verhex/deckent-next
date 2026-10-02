import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUDIT_EVENT_SCHEMA_VERSION, counterSchema, identitySchema, runSnapshotSchema, type AttemptIdentity, type VerifiedPrincipal, type TaskProgress, type RunSnapshot } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { AuditStore } from '#engine/core/audit/index.js';
interface TaskDecisionAuthorization { authorize(identity: AttemptIdentity, principal: VerifiedPrincipal): Promise<void> }
import { runQuerySchema, type RunQuery, type RunAuthorization } from './application.js';
import { RunStoreError, type RunReceipt, type RunStore } from './store.js';
const base = z.object({ schemaVersion: z.literal(1), commandId: identitySchema, scopeId: identitySchema, runId: identitySchema,
  expectedRevision: counterSchema });
/** Human-only decisions. Timing, actor, evaluation and evidence never come from the caller. */
export const runLifecycleCommandSchema = z.discriminatedUnion('action', [
  base.extend({ action: z.enum(['close', 'resume']) }).strict(),
  base.extend({ action: z.enum(['accept', 'reject']), taskId: identitySchema }).strict(),
]);
export type RunLifecycleCommand = z.infer<typeof runLifecycleCommandSchema>;
/** Trusted, freshly authenticated application-to-ledger transition. */
export const runLifecycleWriteSchema = base.extend({ action: z.enum(['close', 'resume', 'expire', 'park-task', 'accept', 'reject']),
  taskId: identitySchema.optional(), reason: z.enum(['evaluation-unknown', 'evaluation-not-ready']).optional(),
  actor: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema,
    assurance: z.enum(['os-user', 'token-verified', 'workload-verified']) }).strict(),
  now: counterSchema, timeoutMs: counterSchema.positive(),
}).strict().superRefine((value, context) => {
  if ((['accept', 'reject', 'park-task'].includes(value.action) !== (value.taskId !== undefined))
    || ((value.action === 'park-task') !== (value.reason !== undefined))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'RUN_INVALID' });
});
export type RunLifecycleWrite = z.infer<typeof runLifecycleWriteSchema>;
export interface RunLifecycleStore extends Pick<RunStore, 'loadRun'> {
  hasTaskEvaluation?(identity: AttemptIdentity, revision: number): Promise<boolean>;
  commitRunLifecycle(input: RunLifecycleWrite, audit?: (store: AuditStore, snapshot: RunSnapshot) => void): Promise<RunReceipt>;
}
export type RunLifecycleAuditRecorder = (store: AuditStore) => { record(event: unknown): unknown };
export class RunLifecycleError extends Error {
  constructor(readonly code: 'TASK_DECISION_HUMAN_REQUIRED') { super(code); this.name = 'RunLifecycleError'; }
}
/** CLI and MCP-free SDK share this ingress. A verified workload/token alone cannot attest a person. */
export class RunLifecycleApplication {
  constructor(private readonly store: RunLifecycleStore, private readonly verifier: PrincipalVerifier,
    private readonly runAuthorization: RunAuthorization, private readonly taskAuthorization: TaskDecisionAuthorization,
    private readonly recorder: RunLifecycleAuditRecorder, private readonly now: () => number, private readonly timeoutMs: number, private readonly policyRevision: string) {}
  async advance(input: unknown, credential?: unknown) {
    const query: RunQuery = runQuerySchema.parse(input), principal = await authenticate(this.verifier, credential, query.scopeId);
    // Maintenance can close the Run at its deadline, so it needs the same write grant as close.
    await this.runAuthorization.authorize('cancel', query, principal);
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
    return this.store.commitRunLifecycle({ ...query, commandId: randomUUID(), expectedRevision: run.revision, action: 'expire', actor,
      now, timeoutMs: this.timeoutMs });
  }
  async execute(input: unknown, credential?: unknown) {
    const command = runLifecycleCommandSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    if (principal.assurance !== 'os-user') throw new RunLifecycleError('TASK_DECISION_HUMAN_REQUIRED');
    if (command.action === 'accept' || command.action === 'reject') {
      const run = runSnapshotSchema.parse(await this.store.loadRun(command.scopeId, command.runId));
      const binding = run.bindings.find(value => value.identity.taskId === command.taskId);
      if (!binding) throw new RunStoreError('RUN_STORE_CONFLICT');
      await this.taskAuthorization.authorize(binding.identity, principal);
    } else await this.runAuthorization.authorize(command.action === 'close' ? 'cancel' : 'reserve', command, principal);
    const now = counterSchema.parse(this.now());
    return this.store.commitRunLifecycle({ ...command, actor: { id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance }, now, timeoutMs: this.timeoutMs }, (store, snapshot) => {
      this.recorder(store).record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: command.scopeId,
        principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: this.policyRevision, atMs: now,
        subject: { kind: 'run-lifecycle', action: command.action, runId: command.runId, commandId: command.commandId,
          taskId: 'taskId' in command ? command.taskId : null, revision: snapshot.revision,
          evidence: command.action === 'accept' ? 'model-unverified' : null } });
    });
  }
}
