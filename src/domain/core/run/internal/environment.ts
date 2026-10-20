import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { attemptIdentitySchema, attemptSnapshotSchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/core/attempt/index.js';
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
  const attempt = attemptSnapshotSchema.parse(attemptInput), result = attempt.lastObservation?.result;
  // REVISE 2695: an environment answer (the probe path ended) is the one closure that transitions from the custody written before the probe.
  const run = result?.kind === 'launch-refused' && result.requirement !== undefined ? withoutCustody(checkedRun(input, expectedRevision), attempt.identity) : checkedRun(input, expectedRevision);
  // REVISE 2693: an uncertain probe (its container not proven gone) keeps the task's slot as an unresolved effect, also on a cancelled Run.
  const uncertain = result?.kind === 'launch-refused' && result.probe !== undefined;
  if (result?.kind !== 'launch-refused' || result.requirement === undefined || (run.cancelRequested && !uncertain)) return reconcileRunLifecycle(projectRunAttempt(run, expectedRevision, attempt, true), now, timeoutMs);
  const task = run.progress.find(row => row.taskId === attempt.identity.taskId), binding = run.bindings.find(row => sameAttemptIdentity(row.identity, attempt.identity));
  if (!task || !binding || binding.observedKind !== null || task.phase !== 'active' || task.unresolvedEffects || run.state.kind === 'terminal') throw new RunError('RUN_ATTEMPT_CONFLICT');
  const prior = run.state.kind === 'parked' ? run.state : null;
  const hold = prior?.reason === 'operator-hold' ? { operatorHold: { schemaVersion: 1 as const, note: prior.note! } } : prior?.operatorHold ? { operatorHold: prior.operatorHold } : {};
  // The first unmet requirement keeps naming the park; a later refusal of another task joins it.
  const state = run.cancelRequested ? run.state : prior?.reason === 'environment-not-ready' ? prior : { kind: 'parked' as const, reason: 'environment-not-ready' as const, failureCode: result.requirement,
    since: counterSchema.parse(now), deadline: counterSchema.parse(now + counterSchema.positive().parse(timeoutMs)), ...hold };
  return reconcileRunLifecycle(runSnapshotSchema.parse({ ...run, revision: run.revision + 1, state,
    progress: run.progress.map(row => row === task ? { ...row, phase: 'pending', unresolvedEffects: uncertain } : row),
    bindings: run.bindings.map(row => row === binding ? { ...row, observedKind: 'launch-refused', observedRevision: attempt.revision } : row) }), now, timeoutMs);
}
/** REVISE 2693: the one release of an uncertain probe's hold, after the adapter proved its container gone (by the recorded probe name). The task
 * stays pending for an explicit resume (or closes as cancelled when cancellation was requested); a second settlement is a conflict. */
export function settleEnvironmentProbe(input: unknown, expectedRevision: number, identityInput: unknown, now: number, timeoutMs: number): RunSnapshot {
  const run = checkedRun(input, expectedRevision), identity = attemptIdentitySchema.parse(identityInput);
  const binding = run.bindings.find(row => sameAttemptIdentity(row.identity, identity)), task = run.progress.find(row => row.taskId === identity.taskId);
  if (!binding || binding.observedKind !== 'launch-refused' || task?.phase !== 'pending' || !task.unresolvedEffects) throw new RunError('RUN_ATTEMPT_CONFLICT');
  return reconcileRunLifecycle({ ...run, revision: run.revision + 1,
    progress: run.progress.map(row => row === task ? { ...row, unresolvedEffects: false, ...(run.cancelRequested ? { phase: 'cancelled' as const } : {}) } : row) }, now, timeoutMs);
}
const withoutCustody = (run: RunSnapshot, identity: AttemptIdentity): RunSnapshot => {
  const binding = run.bindings.find(row => sameAttemptIdentity(row.identity, identity) && row.probes); if (!binding) return run;
  const { probes, ...plain } = binding; void probes;
  return { ...run, progress: run.progress.map(row => row.taskId === identity.taskId ? { ...row, unresolvedEffects: false } : row), bindings: run.bindings.map(row => row === binding ? plain : row) };
};
/** REVISE 2695: durable custody before the first probe container can start: the active, unobserved task holds its slot as an unresolved
 * effect naming every probe it covers, so cancellation (Run or attempt) cannot settle, prevent or close it while the probe may run. */
export function holdEnvironmentProbes(input: unknown, expectedRevision: number, identityInput: unknown, probes: readonly string[]): RunSnapshot {
  const run = checkedRun(input, expectedRevision), identity = attemptIdentitySchema.parse(identityInput);
  if (run.cancelRequested) throw new RunError('RUN_CANCEL_REQUESTED');
  const binding = run.bindings.find(row => sameAttemptIdentity(row.identity, identity)), task = run.progress.find(row => row.taskId === identity.taskId);
  if (!binding || binding.observedKind !== null || binding.probes || task?.phase !== 'active' || task.unresolvedEffects) throw new RunError('RUN_ATTEMPT_CONFLICT');
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1, progress: run.progress.map(row => row === task ? { ...row, unresolvedEffects: true } : row),
    bindings: run.bindings.map(row => row === binding ? { ...row, probes } : row) });
}
/** REVISE 2695: the probe path ended with every covered probe proven gone (all met, or a failure whose removal was proven): the custody clears
 * once; a cancel requested meanwhile (Run or attempt) closes the task cancelled in the same transition. An answer the attempt already recorded
 * (a death between its two writes) completes that answer's own projection instead. */
export function releaseEnvironmentProbes(input: unknown, expectedRevision: number, attemptInput: unknown, now: number, timeoutMs: number): RunSnapshot {
  const run = checkedRun(input, expectedRevision), attempt = attemptSnapshotSchema.parse(attemptInput), result = attempt.lastObservation?.result;
  const binding = run.bindings.find(row => sameAttemptIdentity(row.identity, attempt.identity)), task = run.progress.find(row => row.taskId === attempt.identity.taskId);
  if (!binding?.probes || task?.phase !== 'active' || !task.unresolvedEffects) throw new RunError('RUN_ATTEMPT_CONFLICT');
  if (result?.kind === 'launch-refused' && result.requirement !== undefined) return observeRunAttemptClosure(run, expectedRevision, attempt, now, timeoutMs);
  if (result) throw new RunError('RUN_ATTEMPT_CONFLICT');
  const cleared = withoutCustody(run, attempt.identity), cancel = run.cancelRequested || attempt.cancelRequested;
  return reconcileRunLifecycle({ ...cleared, revision: run.revision + 1, progress: cleared.progress.map(row => row.taskId === task.taskId && cancel ? { ...row, phase: 'cancelled' as const } : row) }, now, timeoutMs);
}
