import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { attemptSnapshotSchema, sameAttemptIdentity } from '#domain/core/attempt/index.js';
import { checkedRun, runSnapshotSchema, RunError, type RunSnapshot } from './contract.js';
import { reconcileRunLifecycle } from './lifecycle.js';
import { projectRunAttempt } from './reduce.js';
import registry from './environment-requirements.json' with { type: 'json' };
const limits = registry.limits;
/** PRE-7: a task environment requirement as versioned registry data in one generic form: `kind` names a probe kind an adapter registers
 * (coding kinds in the native-coding adapter, business-process kinds in their own adapters), `target` what it probes and `expect` an optional
 * expectation. The declaration never carries a command: probe commands come only from the adapter's probe-kind registry. */
export const environmentRequirementSchema = z.object({ id: identitySchema, kind: identitySchema,
  target: z.string().min(1).max(limits.targetChars).refine(value => !value.includes('\0')), expect: z.string().min(1).max(limits.expectChars).refine(value => !value.includes('\0')).optional() }).strict().readonly();
export const environmentRequirementsSchema = z.object({ schemaVersion: z.literal(1), requirements: z.array(environmentRequirementSchema).min(1).max(limits.requirements).readonly() })
  .strict().refine(value => new Set(value.requirements.map(row => row.id)).size === value.requirements.length).readonly();
export type EnvironmentRequirement = z.infer<typeof environmentRequirementSchema>;

/** The timed projection of an attempt that closed without a launch. A refusal by Deckent's own environment preflight parks the Run for the
 * operator (`environment-not-ready`, the requirement as its failure code, bounded by `timeoutMs`): the task stays pending for a NEW attempt
 * after an explicit resume, nothing fails and no acceptance is offered. Any other refusal, or one on a cancelled Run, fails its task as before. */
export function observeRunAttemptClosure(input: unknown, expectedRevision: number, attemptInput: unknown, now: number, timeoutMs: number): RunSnapshot {
  const run = checkedRun(input, expectedRevision), attempt = attemptSnapshotSchema.parse(attemptInput), result = attempt.lastObservation?.result;
  if (result?.kind !== 'launch-refused' || result.requirement === undefined || run.cancelRequested) return reconcileRunLifecycle(projectRunAttempt(run, expectedRevision, attempt, true), now, timeoutMs);
  const task = run.progress.find(row => row.taskId === attempt.identity.taskId), binding = run.bindings.find(row => sameAttemptIdentity(row.identity, attempt.identity));
  if (!task || !binding || binding.observedKind !== null || task.phase !== 'active' || task.unresolvedEffects || run.state.kind === 'terminal') throw new RunError('RUN_ATTEMPT_CONFLICT');
  const prior = run.state.kind === 'parked' ? run.state : null;
  const hold = prior?.reason === 'operator-hold' ? { operatorHold: { schemaVersion: 1 as const, note: prior.note! } } : prior?.operatorHold ? { operatorHold: prior.operatorHold } : {};
  // The first unmet requirement keeps naming the park; a later refusal of another task joins it.
  const state = prior?.reason === 'environment-not-ready' ? prior : { kind: 'parked' as const, reason: 'environment-not-ready' as const, failureCode: result.requirement,
    since: counterSchema.parse(now), deadline: counterSchema.parse(now + counterSchema.positive().parse(timeoutMs)), ...hold };
  return reconcileRunLifecycle(runSnapshotSchema.parse({ ...run, revision: run.revision + 1, state,
    progress: run.progress.map(row => row === task ? { ...row, phase: 'pending' } : row),
    bindings: run.bindings.map(row => row === binding ? { ...row, observedKind: 'launch-refused', observedRevision: attempt.revision } : row) }), now, timeoutMs);
}
