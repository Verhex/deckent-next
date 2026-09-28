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
/** The installation's bar (config `execution.adoption.verification`): the verifying task kind, whether adoption requires it, and
 * the criteria each verification Run's acceptance must meet. Policy data; the comparison rules below stay code. */
export interface AdoptionVerificationRequirement {
  readonly kind: string; readonly required: boolean;
  readonly criteria: readonly Readonly<{ evaluator: Readonly<{ id: string; version: number }>; parameters: unknown }>[];
}
/** Evaluator-implementation rule: true when a criterion with `actual` parameters accepts nothing the `required` parameters reject.
 * Unknown implementations must answer false (fail-closed). */
export type CriterionWithin = (implementation: Readonly<{ id: string; version: number }>, required: unknown, actual: unknown) => boolean;
/** Trusted composition data: never from the wire. */
export interface AdoptionVerificationPolicy {
  /** The installation's verification bar, or null when none is configured (then the command's kind is used and no bar applies). */
  readonly requirement: AdoptionVerificationRequirement | null;
  readonly criterionWithin: CriterionWithin;
  /** Reading the verification Run is `run:inspect` on it for the adopting principal. */
  authorizeRun(scopeId: string, runId: string, principal: VerifiedPrincipal): Promise<void>;
  /** The installation's current execution registry (`admission.registry`), or null when admission is not configured. */
  readonly registry: unknown;
  /** The adoption's own Git source: the delivered commit captured there names the source the verification Run must have used. */
  readonly source: Pick<RunWorkspaceProvider, 'captureSource'>;
}
export interface AdoptionVerificationRequest { readonly scopeId: string; readonly runId: string; readonly kind: string; readonly commit: string }

/** Every required criterion is met by one of the task's acceptance criteria of the same evaluator that is not weaker under the Run's
 * pinned evaluator implementation. Extra task criteria only add conditions (all must pass), so they never weaken the bar. */
export function adoptionCriteriaMeet(requirement: AdoptionVerificationRequirement, run: RunSnapshot, taskId: string, within: CriterionWithin): boolean {
  const task = run.graph.tasks.find(candidate => candidate.id === taskId);
  const actual = (task?.acceptanceCriteria ?? []).map(id => ({ definition: run.graph.criterionDefinitions.find(candidate => candidate.id === id),
    pinned: run.execution.criteria.find(candidate => candidate.criterionId === id) }));
  return requirement.criteria.every(required => actual.some(({ definition, pinned }) => definition !== undefined && pinned !== undefined
    && definition.evaluator.id === required.evaluator.id && definition.evaluator.version === required.evaluator.version
    && pinned.evaluator.id === required.evaluator.id && pinned.evaluator.version === required.evaluator.version
    && within(pinned.evaluator.implementation, required.parameters, definition.parameters)));
}

/** B06-2c precondition, one owner: no verification Run named → refused when the installation requires one, otherwise not verified;
 * a named Run must be of the installation's kind and meet its bar before its evidence counts. */
export async function verifyAdoption(store: AdoptionVerificationStore, policy: AdoptionVerificationPolicy, principal: VerifiedPrincipal,
  request: Omit<AdoptionVerificationRequest, 'runId' | 'kind'> & Partial<Pick<AdoptionVerificationRequest, 'runId' | 'kind'>>): Promise<AdoptionVerification | null> {
  const { runId, kind } = request;
  if (runId === undefined || kind === undefined) {
    if (policy.requirement?.required) throw new WorkspaceAdoptionError('ADOPTION_NOT_VERIFIED');
    return null;
  }
  if (policy.requirement && kind !== policy.requirement.kind) throw new WorkspaceAdoptionError('ADOPTION_VERIFICATION_MISMATCH');
  return verifyDeliveredCommit(store, policy, principal, { ...request, runId, kind });
}

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
  // The bar is about what this evidence could prove, so it is decided before the phase: a weak Run is never verification.
  if (policy.requirement && !adoptionCriteriaMeet(policy.requirement, run, task.id, policy.criterionWithin)) {
    throw new WorkspaceAdoptionError('ADOPTION_VERIFICATION_CRITERIA_WEAKER');
  }
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
