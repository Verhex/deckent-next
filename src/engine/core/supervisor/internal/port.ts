import { z } from 'zod';
import { containerEvidenceSchema } from './container.js';
import type { CollectedOutputFile } from './output-files.js';
import { attemptIdentitySchema, sameAttemptIdentity, identitySchema, processExitCauseShape, isValidExitCause } from '#domain/index.js';

export const sandboxRequestSchema = z.object({
  protocolVersion: z.literal(1), identity: attemptIdentitySchema,
  workspace: z.string().min(1), argv: z.array(z.string()).min(1).readonly(),
}).strict().readonly();
export type SandboxRequest = z.infer<typeof sandboxRequestSchema>;
const supervisorResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exited'), ...processExitCauseShape }).strict(),
  z.object({ kind: z.literal('unknown'), reasonCode: identitySchema }).strict(),
]).superRefine((result, context) => {
  if (result.kind === 'exited' && !isValidExitCause(result)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'ATTEMPT_EXIT_CAUSE_INVALID' });
  }
});
export const sandboxObservationSchema = z.object({ handle: identitySchema, result: supervisorResultSchema, container: containerEvidenceSchema.optional() }).strict().readonly();
export const sandboxOutputSchema = z.object({ stdout: z.string(), stderr: z.string(), completeness: z.literal('partial') }).strict().readonly();
export const sandboxResultSchema = z.object({ handle: identitySchema, result: supervisorResultSchema, container: containerEvidenceSchema.optional(),
  outputCompleteness: z.enum(['complete', 'partial', 'unavailable']), stdout: z.string(), stderr: z.string(), interrupted: z.boolean(),
}).strict().readonly();
export type SandboxResult = z.infer<typeof sandboxResultSchema>;
export interface ExecutionSupervisor {
  /** Optional local data port; only stopped workers, never a launch or acceptance operation. */
  collectOutputFiles?(request: SandboxRequest): Promise<readonly CollectedOutputFile[]>;
  cancel(request: SandboxRequest): Promise<Pick<SandboxResult, 'handle' | 'result' | 'container'>>;
  recoverOutput(request: SandboxRequest): Promise<Readonly<{ stdout: string; stderr: string; completeness: 'partial' }>>;
  /** Read-only daemon evidence; never creates, starts, kills or releases a process. */
  observe(request: SandboxRequest): Promise<Pick<SandboxResult, 'handle' | 'result' | 'container'>>;
  execute(request: SandboxRequest, signal?: AbortSignal): Promise<SandboxResult>;
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
