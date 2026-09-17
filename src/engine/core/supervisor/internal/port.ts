import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/index.js';

export const sandboxRequestSchema = z.object({
  protocolVersion: z.literal(1), identity: attemptIdentitySchema,
  workspace: z.string().min(1), argv: z.array(z.string()).min(1).readonly(),
}).strict().readonly();
export type SandboxRequest = z.infer<typeof sandboxRequestSchema>;
export interface SandboxResult {
  readonly handle: string;
  readonly result: Readonly<{ kind: 'exited'; exitCode: number } | { kind: 'unknown'; reasonCode: string }>;
  readonly stdout: string;
  readonly stderr: string;
  readonly interrupted: boolean;
}
export interface ExecutionSupervisor {
  /** Read-only daemon evidence; never creates, starts, kills or releases a process. */
  observe(request: SandboxRequest): Promise<Pick<SandboxResult, 'handle' | 'result'>>;
  execute(request: SandboxRequest, signal?: AbortSignal): Promise<SandboxResult>;
  /** Release only after the application durably records terminal evidence. */
  release(request: SandboxRequest): Promise<void>;
}
export class SupervisorError extends Error {
  constructor(readonly code: 'SUPERVISOR_REQUEST_INVALID' | 'SUPERVISOR_WORKSPACE_INVALID' | 'SUPERVISOR_IDENTITY_CONFLICT'
    | 'SUPERVISOR_OPTIONS_INVALID' | 'SUPERVISOR_CANCELLED' | 'SUPERVISOR_CONTROL_FAILED' | 'SUPERVISOR_NOT_TERMINAL') {
    super(code); this.name = 'SupervisorError';
  }
}
