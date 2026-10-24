import { attemptSnapshotSchema, type AttemptSnapshot } from '#domain/core/attempt/index.js';
import { readWorkerModelPin } from '#domain/core/worker-event/index.js';
import { z } from 'zod';
import { counterSchema } from '#domain/core/primitives/index.js';
import { checkedRun, runSnapshotSchema, RunError, type RunSnapshot } from './contract.js';
import { heldRunState, readRunHold } from './hold.js';
export type RunQuotaWait = NonNullable<RunSnapshot['quotaWaits']>[number];
/** The ask has no expiry: its stored deadline is the largest safe counter, so no deadline-driven rule can ever cancel it (owner L-A: never auto-cancel). */
export const QUOTA_ASK_OPEN = Number.MAX_SAFE_INTEGER;
/** Host-proven exit classification, not a worker grant. Application verifies artifacts and model evidence first. */
export function parkRunQuota(input: unknown, expectedRevision: number, attempt: AttemptSnapshot, wait: RunQuotaWait) {
  const run = checkedRun(input, expectedRevision), task = run.progress.find(row => row.taskId === attempt.identity.taskId);
  const binding = run.bindings.find(row => row.identity.attemptId === attempt.identity.attemptId);
  const pin = readWorkerModelPin(run.execution.tasks.find(row => row.taskId === attempt.identity.taskId)?.profile.parameters);
  if (run.cancelRequested || attempt.cancelRequested || task?.unresolvedEffects || task?.phase !== 'evaluating' || binding?.observedKind !== 'exited'
    || binding.observedRevision !== attempt.revision || attempt.lastObservation?.result.kind !== 'exited' || !pin || pin.pin.channelId !== wait.channelId
    || JSON.stringify(wait.identity) !== JSON.stringify(attempt.identity) || wait.deadline <= wait.since) throw new RunError('RUN_ATTEMPT_CONFLICT');
  // S9 (owner L-A): a reset known to be beyond the wait bound is not waited for; the person is asked at once.
  const askNow = wait.resetBoundExceeded === true && wait.quota.resetsAtMs !== null && wait.quota.resetsAtMs > wait.since;
  const result = attempt.lastObservation.result;
  const classified = attemptSnapshotSchema.parse({ ...attempt, revision: attempt.revision + 1, lastObservation: { ...attempt.lastObservation,
    sequence: attempt.lastObservation.sequence + 1, eventId: 'quota-exhausted', result: { ...result, kind: 'quota-exhausted', quota: wait.quota, evidenceDigest: wait.evidenceDigest, ...(wait.resetBoundExceeded ? { resetBoundExceeded: true } : {}) } } });
  const snapshot = runSnapshotSchema.parse({ ...run, revision: run.revision + 1, quotaWaits: [...(run.quotaWaits ?? []), wait],
    state: run.state.kind === 'parked' && run.state.reason === 'operator-hold' ? run.state : askNow || run.state.kind === 'parked' && run.state.reason === 'quota-ask'
      ? { kind: 'parked', reason: 'quota-ask', ...(run.state.kind === 'parked' && run.state.operatorHold ? { operatorHold: run.state.operatorHold } : {}), since: wait.since, deadline: QUOTA_ASK_OPEN }
      : { kind: 'parked', reason: 'quota-exhausted', ...(run.state.kind === 'parked' && run.state.operatorHold ? { operatorHold: run.state.operatorHold } : {}), since: wait.since, deadline: Math.max(wait.deadline, run.state.kind === 'parked' && run.state.reason === 'quota-exhausted' ? run.state.deadline : 0) },
    progress: run.progress.map(row => row === task ? { ...row, phase: 'pending' } : row),
    bindings: run.bindings.map(row => row === binding ? { ...row, observedKind: 'quota-exhausted', observedRevision: classified.revision } : row) });
  return { snapshot, attempt: classified };
}
/** Time alone is not reset evidence. Unknown reset remains parked and uses ordinary bounded expiry. */
export function resetRunQuota(run: RunSnapshot, now: number): RunSnapshot | null {
  const held = run.bindings.filter(row => row.observedKind === 'quota-exhausted');
  if (!held.length || run.cancelRequested || run.state.kind !== 'parked' || run.state.reason !== 'quota-exhausted' || run.state.operatorHold) return null;
  const waits = held.map(row => run.quotaWaits?.find(wait => wait.identity.attemptId === row.identity.attemptId));
  if (waits.some(wait => !wait || wait.quota.source !== 'claude-rate-limit' || wait.resetBoundExceeded || wait.quota.resetsAtMs === null || wait.quota.resetsAtMs <= wait.since || wait.deadline > now
    || (run.quotaWaits ?? []).filter(prior => prior.identity.taskId === wait.identity.taskId).length > wait.maxResumes)) return null;
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1, state: { kind: 'running' },
    bindings: run.bindings.filter(row => !held.includes(row)), previousBindings: [...(run.previousBindings ?? []), ...held] });
}

/** Explicit installation operator release; retained quota evidence/reset timestamps never change. */
export function releaseRunQuota(run: RunSnapshot, channelId: string, now: number): RunSnapshot | null {
  const selected = (run.quotaWaits ?? []).filter(wait => wait.channelId === channelId && wait.deadline > now && wait.releasedAtMs === undefined);
  if (!selected.length) return null;
  const ids = new Set(selected.map(wait => wait.identity.attemptId));
  const held = run.bindings.filter(row => ids.has(row.identity.attemptId) && run.progress.some(task => task.taskId === row.identity.taskId && task.phase === 'pending'));
  const movable = !run.cancelRequested && run.state.kind !== 'terminal';
  const resume = !run.cancelRequested && run.state.kind === 'parked' && run.state.reason === 'quota-exhausted';
  const remaining = (run.quotaWaits ?? []).filter(wait => !ids.has(wait.identity.attemptId) && run.bindings.some(row => row.identity.attemptId === wait.identity.attemptId));
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1,
    quotaWaits: run.quotaWaits!.map(wait => ids.has(wait.identity.attemptId) ? { ...wait, releasedAtMs: now } : wait),
    ...(movable ? { bindings: run.bindings.filter(row => !held.includes(row)), previousBindings: [...(run.previousBindings ?? []), ...held] } : {}),
    ...(resume ? { state: remaining.length ? { kind: 'parked', reason: 'quota-exhausted', ...(run.state.kind === 'parked' && run.state.operatorHold ? { operatorHold: run.state.operatorHold } : {}), since: Math.min(...remaining.map(wait => wait.since)), deadline: Math.max(...remaining.map(wait => wait.deadline)) } : run.state.kind === 'parked' && run.state.operatorHold ? heldRunState(readRunHold(run.state)!, run.state.since, run.state.deadline) : { kind: 'running' } } : {}) });
}

/** S9: an expired quota wait becomes a question for a person. The Run keeps its tasks, bindings and waits; only a person's answer or an explicit close changes it. */
export function askRunQuota(run: RunSnapshot, now: number): RunSnapshot | null {
  if (run.cancelRequested || run.state.kind !== 'parked' || run.state.reason !== 'quota-exhausted' || run.state.operatorHold || run.state.deadline > now) return null;
  if (!run.bindings.some(row => row.observedKind === 'quota-exhausted')) return null;
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1, state: { kind: 'parked', reason: 'quota-ask', since: run.state.since, deadline: QUOTA_ASK_OPEN } });
}
export type RunQuotaChoice = 'wait' | 'next-candidate';
export type RunQuotaAskPolicy = Readonly<{ maxWaitMs: number; maxRewaits: number }>;
/** S9: the person's answer. `wait` re-arms the wait (until the known reset, else a fresh bounded wait) up to `maxRewaits` times; `next-candidate`
 * releases the held attempts so the task is reserved again. Neither cancels; closing the Run stays the separate explicit control. */
export function answerRunQuota(input: unknown, expectedRevision: number, choice: RunQuotaChoice, now: number, policy: RunQuotaAskPolicy): RunSnapshot {
  const run = checkedRun(input, expectedRevision); counterSchema.parse(now);
  if (run.state.kind !== 'parked' || run.state.reason !== 'quota-ask') throw new RunError('RUN_NOT_PARKED');
  if (run.cancelRequested) throw new RunError('RUN_CANCEL_REQUESTED');
  const held = run.bindings.filter(row => row.observedKind === 'quota-exhausted');
  const open = (run.quotaWaits ?? []).filter(wait => held.some(row => row.identity.attemptId === wait.identity.attemptId) && wait.releasedAtMs === undefined);
  if (!open.length) throw new RunError('RUN_NOT_PARKED');
  const overlay = run.state.operatorHold ? { operatorHold: run.state.operatorHold } : {};
  if (choice === 'wait') {
    if (open.some(wait => (wait.rewaits ?? 0) >= policy.maxRewaits)) throw new RunError('RUN_QUOTA_WAIT_LIMIT');
    const known = open.map(wait => wait.quota.resetsAtMs).filter((reset): reset is number => reset !== null && reset > now);
    const deadline = known.length === open.length ? Math.max(...known) : now + policy.maxWaitMs;
    const ids = new Set(open.map(wait => wait.identity.attemptId));
    return runSnapshotSchema.parse({ ...run, revision: run.revision + 1,
      quotaWaits: run.quotaWaits!.map(wait => ids.has(wait.identity.attemptId) ? { ...wait, deadline, rewaits: (wait.rewaits ?? 0) + 1, resetBoundExceeded: undefined } : wait),
      state: { kind: 'parked', reason: 'quota-exhausted', ...overlay, since: run.state.since, deadline } });
  }
  const ids = new Set(open.map(wait => wait.identity.attemptId));
  const moved = held.filter(row => ids.has(row.identity.attemptId));
  return runSnapshotSchema.parse({ ...run, revision: run.revision + 1,
    quotaWaits: run.quotaWaits!.map(wait => ids.has(wait.identity.attemptId) ? { ...wait, releasedAtMs: now } : wait),
    bindings: run.bindings.filter(row => !moved.includes(row)), previousBindings: [...(run.previousBindings ?? []), ...moved],
    state: run.state.operatorHold ? heldRunState(readRunHold(run.state)!, run.state.since, run.state.deadline) : { kind: 'running' } });
}

/** The write fields of a person's quota answer (the choice and the configured bounds the application read), spread into the lifecycle write schema. */
export const quotaAnswerFields = { quotaChoice: z.enum(['wait', 'next-candidate']).optional(), quotaWaitMs: counterSchema.positive().optional(), quotaMaxRewaits: counterSchema.optional() };
type QuotaAnswerShape = Readonly<{ action: string; quotaChoice?: unknown; quotaWaitMs?: unknown; quotaMaxRewaits?: unknown }>;
/** The three fields exist exactly on a `quota-answer` write. */
export const quotaAnswerShapeInvalid = (write: QuotaAnswerShape) => (write.action === 'quota-answer') !== (write.quotaChoice !== undefined && write.quotaWaitMs !== undefined && write.quotaMaxRewaits !== undefined)
  || write.action !== 'quota-answer' && (write.quotaChoice !== undefined || write.quotaWaitMs !== undefined || write.quotaMaxRewaits !== undefined);
/** The ledger transition of a quota answer: a person (never an AI actor, policy cell or forged decision class) chose; the bounds are the ones the application read. */
export function answerRunQuotaWrite(run: RunSnapshot, write: Readonly<{ expectedRevision: number; now: number; quotaChoice?: RunQuotaChoice | undefined; quotaWaitMs?: number | undefined; quotaMaxRewaits?: number | undefined; decision?: Readonly<{ deciderClass: string }> | undefined }>, aiActor: boolean): RunSnapshot {
  if (aiActor || write.decision?.deciderClass !== 'human-tty') throw new RunError('RUN_QUOTA_PERSON_REQUIRED');
  return answerRunQuota(run, write.expectedRevision, write.quotaChoice!, write.now, { maxWaitMs: write.quotaWaitMs!, maxRewaits: write.quotaMaxRewaits! });
}
/** The lifecycle write of a quota answer: the command's `choice` becomes the choice plus the configured bounds the application read; any other command passes unchanged. */
export function withQuotaAnswer<T extends { choice?: 'wait' | 'next-candidate' }>(command: T, policy?: RunQuotaAskPolicy): Omit<T, 'choice'> {
  const { choice, ...rest } = command;
  return choice && policy ? { ...rest, quotaChoice: choice, quotaWaitMs: policy.maxWaitMs, quotaMaxRewaits: policy.maxRewaits } : rest;
}
