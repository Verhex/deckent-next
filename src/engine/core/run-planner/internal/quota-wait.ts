import { encodeCommandProjection, type BrainAttemptLink, type BrainPlanCommand, type HeadlessRejectionBody } from '#domain/index.js';
import { ErrorRegistry, sha256 } from '#platform/index.js';

/** f3 (owner Q-H4): the `brain_planner.quotaWait` registry values (defaults in the planner's templates.json). */
export type BrainQuotaWaitPolicy = Readonly<{ maxWaitMs: number; marginMs: number; maxAttempts: number }>;
/**
 * The command id of planning attempt `attempt` (2, 3, …) after a quota refusal: a new identity derived from the plan command, the attempt number
 * and the refused call's command and invocation ids. It is never the refused call's id, so the invocation store records a new call instead of
 * replaying the refusal, and anyone holding the refused receipt can recompute the chain (the lineage is sealed in the id itself; nothing stored
 * changes shape). Attempt 1 keeps `brainInvocationCommandId` byte for byte.
 */
export const brainQuotaAttemptCommandId = (command: Pick<BrainPlanCommand, 'scopeId' | 'commandId'>, attempt: number, after: BrainAttemptLink) =>
  sha256(encodeCommandProjection('brain-invocation-after-quota:1', { scopeId: command.scopeId, commandId: command.commandId, attempt,
    after: { commandId: after.commandId, invocationId: after.invocationId } }));

/**
 * When the next attempt may start, or null for the typed refusal: only a quota refusal that names its reset, while attempts remain, and only when
 * the reset (never before the refusal was observed) plus the margin is at most `maxWaitMs` away. `maxWaitMs` 0 never waits.
 */
export function brainQuotaWaitUntil(body: HeadlessRejectionBody | null, refusedAtMs: number, nowMs: number, attemptsUsed: number, policy: BrainQuotaWaitPolicy): number | null {
  if (body?.refusal !== 'quota' || typeof body.resetsAtMs !== 'number' || policy.maxWaitMs === 0 || attemptsUsed >= policy.maxAttempts) return null;
  const untilMs = Math.max(body.resetsAtMs, refusedAtMs) + policy.marginMs;
  return untilMs - nowMs <= policy.maxWaitMs ? untilMs : null;
}

/** Resolves at `untilMs` (re-checked against the clock when the timer fires; the schema bounds the delay below the timer limit); an abort ends
 * the wait at once as BRAIN_CANCELLED and leaves no timer behind. */
export function waitUntil(untilMs: number, now: () => number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(ErrorRegistry.createError('BRAIN_CANCELLED')); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { clearTimeout(timer); reject(ErrorRegistry.createError('BRAIN_CANCELLED')); };
    const arm = () => {
      const left = untilMs - now();
      if (left <= 0) { signal?.removeEventListener('abort', abort); resolve(); return; }
      timer = setTimeout(arm, left);
    };
    signal?.addEventListener('abort', abort, { once: true });
    arm();
  });
}
