import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/index.js';
export const workspaceRequestSchema = z.object({
  schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
}).strict().readonly();
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;
export interface WorkspaceLease {
  readonly schemaVersion: 1; readonly id: string; readonly workspace: string;
  readonly baseCommit: string; readonly identity: WorkspaceRequest['identity'];
}
export interface WorkspaceBroker {
  allocate(request: WorkspaceRequest): Promise<WorkspaceLease>;
  /** Caller must have stopped the worker and durably retained its artifacts before release. */
  release(request: WorkspaceRequest): Promise<void>;
}
export class WorkspaceError extends Error {
  constructor(readonly code: 'WORKSPACE_REQUEST_INVALID' | 'WORKSPACE_OPTIONS_INVALID' | 'WORKSPACE_UNSAFE'
    | 'WORKSPACE_IDENTITY_CONFLICT' | 'WORKSPACE_ALLOCATION_INCOMPLETE' | 'WORKSPACE_CUSTODY_UNCONVERTIBLE' | 'WORKSPACE_GIT_FAILED') {
    super(code); this.name = 'WorkspaceError';
  }
}
