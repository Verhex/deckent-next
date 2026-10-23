import { z } from 'zod';
import { containerEvidenceSchema } from './container.js';
import type { CollectedOutputFile } from './output-files.js';
import { attemptIdentitySchema, sameAttemptIdentity, identitySchema, processExitCauseShape, isValidExitCause } from '#domain/index.js';

export const sandboxRequestSchema = z.object({
  protocolVersion: z.literal(1), identity: attemptIdentitySchema,
  workspace: z.string().min(1), argv: z.array(z.string()).min(1).readonly(),
}).strict().readonly();
export type SandboxRequest = z.infer<typeof sandboxRequestSchema>;
export const workerIncarnationSchema = z.object({ kind: z.literal('container'), id: z.string().regex(/^[a-f0-9]{64}$/), startedAt: z.string().min(1).max(40).refine(value => Number.isFinite(Date.parse(value)) && !value.startsWith('0001-')) }).strict().readonly();
const supervisorResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exited'), ...processExitCauseShape }).strict(),
  z.object({ kind: z.literal('unknown'), reasonCode: identitySchema }).strict(),
]).superRefine((result, context) => {
  if (result.kind === 'exited' && !isValidExitCause(result)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'ATTEMPT_EXIT_CAUSE_INVALID' });
  }
});
export const sandboxObservationSchema = z.object({ handle: identitySchema, result: supervisorResultSchema, worker: workerIncarnationSchema.optional(), container: containerEvidenceSchema.optional() }).strict().readonly();
export const sandboxOutputSchema = z.object({ stdout: z.string(), stderr: z.string(), completeness: z.literal('partial') }).strict().readonly();
export const sandboxResultSchema = z.object({ handle: identitySchema, result: supervisorResultSchema, worker: workerIncarnationSchema.optional(), container: containerEvidenceSchema.optional(),
  outputCompleteness: z.enum(['complete', 'partial', 'unavailable']), stdout: z.string(), stderr: z.string(), interrupted: z.boolean(),
  interruptCause: z.enum(['deadline', 'inactivity', 'cancel']).optional(),
}).strict().readonly();
export type SandboxResult = z.infer<typeof sandboxResultSchema>;
/** R3 (Astra 2642 F1): the one mapping of the FIRST stop the supervisor saw (its own deadline, or the execute signal with its reason) to
 * the recorded cause. Supervisors call it where they decide to stop, before any cleanup, so a later abort can never relabel the stop. */
export function sandboxInterruptCause(stop: 'deadline' | 'signal', reason?: unknown): NonNullable<SandboxResult['interruptCause']> {
  return stop === 'deadline' ? 'deadline' : reason === 'inactivity' ? 'inactivity' : 'cancel';
}
/** S6R-1: launch progress the application makes durable. `created` receives the container's immutable id once it exists and its mounts are
 * checked, before anything starts; when it throws, the supervisor starts nothing (the created container stays as evidence). */
export interface SupervisorLaunchHooks { created(containerId: string): Promise<void> }
export type SupervisorTermination = Readonly<{ worker: import('#domain/index.js').WorkerIncarnation } & ({ kind: 'worker-absent' } | { kind: 'supervisor-exit'; result: import('#domain/index.js').ProcessExitCause })>;
export interface ExecutionSupervisor {
  /** Exact retained incarnation lookup; missing names/PIDs cannot certify termination. */
  observeTermination?(request: SandboxRequest, worker: import('#domain/index.js').WorkerIncarnation): Promise<SupervisorTermination | null>;
  /** S6R-3: absence of the exact container id `create` returned (no incarnation retained); null while that container exists. */
  observeCreatedAbsence?(request: SandboxRequest, containerId: string): Promise<Readonly<{ kind: 'created-container-absent'; containerId: string }> | null>;
  /** S6R-4 (lead on s6r3 Q3): removes the never-started container of a lost dispatch by the exact id `create` returned, only while it is `created`
   * under this request; `not-created` when it ever started (a stop, never a removal, ends that), `absent` when it is gone. */
  removeCreatedContainer?(request: SandboxRequest, containerId: string): Promise<'removed' | 'absent' | 'not-created'>;
  /** Optional local data port; only stopped workers, never a launch or acceptance operation. */
  collectOutputFiles?(request: SandboxRequest): Promise<readonly CollectedOutputFile[]>;
  cancel(request: SandboxRequest): Promise<Pick<SandboxResult, 'handle' | 'result' | 'container' | 'worker'>>;
  recoverOutput(request: SandboxRequest): Promise<Readonly<{ stdout: string; stderr: string; completeness: 'partial' }>>;
  /** Read-only daemon evidence; never creates, starts, kills or releases a process. */
  observe(request: SandboxRequest): Promise<Pick<SandboxResult, 'handle' | 'result' | 'container' | 'worker'>>;
  execute(request: SandboxRequest, signal?: AbortSignal, hooks?: SupervisorLaunchHooks): Promise<SandboxResult>;
  /** Release only after the application durably records terminal evidence. Absent = already released; a removal whose absence is not
   * observed afterwards is `SUPERVISOR_RELEASE_UNCONFIRMED` (retryable), never success. `removed`/`absent` tell an executed removal from
   * an already absent container; an adapter that cannot tell returns nothing. */
  release(request: SandboxRequest): Promise<'removed' | 'absent' | void>;
}
export class SupervisorError extends Error {
  constructor(readonly code: 'SUPERVISOR_REQUEST_INVALID' | 'SUPERVISOR_WORKSPACE_INVALID' | 'SUPERVISOR_IDENTITY_CONFLICT'
    | 'SUPERVISOR_PROFILE_INVALID' | 'SUPERVISOR_PROFILE_ORIGIN_MISMATCH'
    | 'SUPERVISOR_OPTIONS_INVALID' | 'SUPERVISOR_CANCELLED' | 'SUPERVISOR_CONTROL_FAILED' | 'SUPERVISOR_NOT_TERMINAL' | 'SUPERVISOR_RELEASE_UNCONFIRMED') {
    super(code); this.name = 'SupervisorError';
  }
}

export function sameSandboxRequest(a: SandboxRequest, b: SandboxRequest): boolean {
  return a.protocolVersion === b.protocolVersion && sameAttemptIdentity(a.identity, b.identity) && a.workspace === b.workspace
    && a.argv.length === b.argv.length && a.argv.every((value, index) => value === b.argv[index]);
}
