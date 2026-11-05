import { z } from 'zod';
import { persistedString, counterSchema, identitySchema } from '#domain/index.js';

export const workspaceSourceSchema = z.strictObject({ schemaVersion: z.literal(1),
  adapter: z.strictObject({ id: identitySchema, version: counterSchema.positive() }).readonly(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).readonly();
export const runWorkspaceCustodySchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema,
  source: workspaceSourceSchema, baseRevision: persistedString(z.string().trim().min(1)),
}).readonly();
export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;
/** Owner 2026-11-05 (R9n): a Run whose base is a commit of the person's current files in Deckent's private Run repository (git adapter version 2).
 * The Run keeps this mode for its whole life (mode pinning): integration, delivery and its card read it from the patch or the custody, never config. */
export const workingTreeSource = (source: WorkspaceSource | null | undefined) => source?.adapter.id === 'git' && source.adapter.version === 2;
export type RunWorkspaceCustody = z.infer<typeof runWorkspaceCustodySchema>;
export interface RunWorkspaceCustodyStore {
  loadRunWorkspaceCustody(scopeId: string, runId: string): Promise<RunWorkspaceCustody | null>;
  /** Immutable first writer wins. A same-source base race returns the recorded winner. */
  resolveRunWorkspaceCustody(candidate: RunWorkspaceCustody): Promise<RunWorkspaceCustody>;
}
export class RunWorkspaceCustodyError extends Error {
  constructor(readonly code: 'RUN_WORKSPACE_CUSTODY_CONFLICT' | 'RUN_WORKSPACE_CUSTODY_CORRUPT',
    readonly reason?: 'adapter-version-mismatch') { super(code); this.name = 'RunWorkspaceCustodyError'; }
}

/** Classify an already rejected identity; never expose source fingerprints or filesystem paths. */
export function workspaceCustodyConflict(recorded: WorkspaceSource, candidate: WorkspaceSource): RunWorkspaceCustodyError {
  return new RunWorkspaceCustodyError('RUN_WORKSPACE_CUSTODY_CONFLICT',
    recorded.adapter.id === candidate.adapter.id && recorded.adapter.version !== candidate.adapter.version
      ? 'adapter-version-mismatch' : undefined);
}
