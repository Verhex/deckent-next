import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/index.js';

export const workspaceSourceSchema = z.object({ schemaVersion: z.literal(1),
  adapter: z.object({ id: identitySchema, version: counterSchema.positive() }).strict().readonly(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().readonly();
export const runWorkspaceCustodySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema,
  source: workspaceSourceSchema, baseRevision: z.string().trim().min(1),
}).strict().readonly();
export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;
export type RunWorkspaceCustody = z.infer<typeof runWorkspaceCustodySchema>;
export interface RunWorkspaceCustodyStore {
  loadRunWorkspaceCustody(scopeId: string, runId: string): Promise<RunWorkspaceCustody | null>;
  /** Immutable first writer wins. A same-source base race returns the recorded winner. */
  resolveRunWorkspaceCustody(candidate: RunWorkspaceCustody): Promise<RunWorkspaceCustody>;
}
export class RunWorkspaceCustodyError extends Error {
  constructor(readonly code: 'RUN_WORKSPACE_CUSTODY_CONFLICT' | 'RUN_WORKSPACE_CUSTODY_CORRUPT') { super(code); this.name = 'RunWorkspaceCustodyError'; }
}
