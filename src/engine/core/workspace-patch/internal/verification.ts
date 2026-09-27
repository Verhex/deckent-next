import { createHash } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, encodeExecutionProfileDefinition, executionRegistrySchema, identitySchema, type RunSnapshot,
  type VerifiedPrincipal } from '#domain/index.js';
import type { RunWorkspaceCustody, RunWorkspaceProvider } from '#engine/core/workspaces/index.js';
import { WorkspaceAdoptionError, type WorkspaceAdoptionErrorCode } from './adoption-error.js';

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
/** What a verified adoption binds (B06-2b): one Task of the named kind, run on this exact commit with the installation's current
 * profile for that kind, accepted by its recorded criteria. Not independent review, live activation or product acceptance. */
export const adoptionVerificationSchema = z.object({ runId: identitySchema, taskId: identitySchema, attemptId: identitySchema, kind: identitySchema,
  runRevision: counterSchema, commit: oid, profileFingerprint: digest, criteria: z.array(digest).min(1).readonly() }).strict().readonly();
export type AdoptionVerification = z.infer<typeof adoptionVerificationSchema>;

/** Design §5.4: only `accepted` verifies; an unfinished, uncertain or cancelled verification is never acceptance. */
export function adoptionVerificationPhaseOutcome(phase: RunSnapshot['progress'][number]['phase']): WorkspaceAdoptionErrorCode | null {
  switch (phase) {
    case 'accepted': return null;
    case 'failed': return 'ADOPTION_VERIFICATION_FAILED';
    case 'reconciling': return 'ADOPTION_VERIFICATION_UNSETTLED';
    case 'cancelled': return 'ADOPTION_VERIFICATION_CANCELLED';
    default: return 'ADOPTION_VERIFICATION_PENDING';
  }
}
export function executionProfileFingerprint(profile: unknown): string {
  return createHash('sha256').update(encodeExecutionProfileDefinition(profile), 'utf8').digest('hex');
}
export interface AdoptionVerificationStore {
  loadRun(scopeId: string, runId: string): Promise<RunSnapshot | null>;
  loadRunWorkspaceCustody(scopeId: string, runId: string): Promise<RunWorkspaceCustody | null>;
}
/** Trusted composition data: never from the wire. */
export interface AdoptionVerificationPolicy {
  /** Reading the verification Run is `run:inspect` on it for the adopting principal. */
  authorizeRun(scopeId: string, runId: string, principal: VerifiedPrincipal): Promise<void>;
  /** The installation's current execution registry (`admission.registry`), or null when admission is not configured. */
  readonly registry: unknown;
  /** The adoption's own Git source: the delivered commit captured there names the source the verification Run must have used. */
  readonly source: Pick<RunWorkspaceProvider, 'captureSource'>;
}
export interface AdoptionVerificationRequest { readonly scopeId: string; readonly runId: string; readonly kind: string; readonly commit: string }

/** Evidence identity first (same scope, one Task of the kind, custody on this commit from this source, current profile), then the
 * phase: a failed Run on another commit is a mismatch, not a failed verification of this commit. */
export async function verifyDeliveredCommit(store: AdoptionVerificationStore, policy: AdoptionVerificationPolicy, principal: VerifiedPrincipal,
  request: AdoptionVerificationRequest): Promise<AdoptionVerification> {
  const { scopeId, runId, kind, commit } = request;
  const mismatch = () => new WorkspaceAdoptionError('ADOPTION_VERIFICATION_MISMATCH');
  await policy.authorizeRun(scopeId, runId, principal);
  const run = await store.loadRun(scopeId, runId);
  const task = run?.graph.tasks.length === 1 ? run.graph.tasks[0] : undefined;
  if (!run || !task || task.kind !== kind) throw mismatch();
  const custody = await store.loadRunWorkspaceCustody(scopeId, runId);
  const captured = await policy.source.captureSource(commit);
  if (!custody || custody.baseRevision !== commit || captured.baseRevision !== commit
    || JSON.stringify(custody.source) !== JSON.stringify(captured.source)) throw mismatch();
  const registry = policy.registry === null ? null : executionRegistrySchema.parse(policy.registry);
  const entry = registry?.kinds.find(candidate => candidate.kind === kind);
  const expected = entry && registry?.profiles.find(profile => profile.id === entry.profile.id && profile.version === entry.profile.version);
  const pinned = run.execution.tasks.find(candidate => candidate.taskId === task.id)?.profile;
  if (!expected || !pinned || executionProfileFingerprint(pinned) !== executionProfileFingerprint(expected)) throw mismatch();
  const progress = run.progress.find(candidate => candidate.taskId === task.id);
  if (!progress) throw mismatch();
  const outcome = adoptionVerificationPhaseOutcome(progress.phase);
  if (outcome) throw new WorkspaceAdoptionError(outcome);
  const binding = run.bindings.find(candidate => candidate.identity.taskId === task.id);
  if (!binding) throw mismatch();
  return adoptionVerificationSchema.parse({ runId, taskId: task.id, attemptId: binding.identity.attemptId, kind, runRevision: run.revision, commit,
    profileFingerprint: executionProfileFingerprint(pinned),
    criteria: task.acceptanceCriteria.map(id => run.execution.criteria.find(criterion => criterion.criterionId === id)?.fingerprint) });
}
