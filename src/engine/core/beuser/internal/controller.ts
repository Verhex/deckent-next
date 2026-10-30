import { BeuserContractError, BEUSER_WALK_RULES, assertBeuserAccess, pinBeuserLimits, type BeuserLimits, type BeuserContext, type BeuserScreen, type BeuserSurfaceCommand, type BeuserWalkerHistory, type BeuserCorrection } from '#engine/core/beuser-contract/index.js';
import type { BeuserWalkerSummary } from '#domain/index.js';
import { sha256 } from '#platform/index.js';

// Node's signed timer representation is a platform invariant, never a configurable walk policy.
const NODE_SIGNED_INTEGER_CEILING = 2_147_483_647;
/** The one loop-equivalence of screens (walk18): numbers masked, so a cycle that only bumps a revision or counter returns to the same screen. */
export const beuserSettledScreen = (screen: BeuserScreen): string => sha256(screen.text.replace(/\p{Nd}+/gu, '#'));

export class BeuserWalkStopped extends Error {
  constructor(readonly reason: 'bound' | 'loop' | 'observing' | 'patience' | 'drift' | 'leak' | 'unknown' | 'cancelled' | 'deadline') { super(reason); }
}
/** A timeout stops waiting even if a broken adapter ignores cancellation. Its effect then remains uncertain. */
export async function beuserBounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const stopped = () => new BeuserWalkStopped(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'deadline' : 'cancelled');
  if (signal.aborted) throw stopped();
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => { stop = () => reject(stopped()); signal.addEventListener('abort', stop, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw stopped(); return work(); }), aborted]); }
  finally { signal.removeEventListener('abort', stop); }
}
/** Node timers have a signed 32-bit delay; long configured deadlines are scheduled in chunks, never clamped to 1ms. */
export function beuserDeadline(ms: number): { signal: AbortSignal; close(): void } {
  const controller = new AbortController(), end = performance.now() + ms;
  let timer: ReturnType<typeof setTimeout>;
  const next = () => { const left = end - performance.now(); if (left <= 0) controller.abort(new DOMException('BeUser deadline', 'TimeoutError')); else timer = setTimeout(next, Math.min(left, NODE_SIGNED_INTEGER_CEILING)); };
  next();
  return { signal: controller.signal, close: () => { clearTimeout(timer); controller.abort(); } };
}
/** One envelope is created before the first walk and retained across reliability reruns. */
export class BeuserExecutionBudget {
  readonly limits: BeuserLimits;
  private readonly deadline;
  private steps = 0;
  private waits = 0;
  private calls = 0;
  private bytes = 0;
  constructor(limits: BeuserLimits) { this.limits = pinBeuserLimits(limits); this.deadline = beuserDeadline(limits.maxWallMs); }
  get signal(): AbortSignal { return this.deadline.signal; }
  close(): void { this.deadline.close(); }
  step(): void { this.signal.throwIfAborted(); if (++this.steps > this.limits.maxSteps) throw new BeuserWalkStopped('bound'); }
  wait(ms: number): void { if ((this.waits += ms) > this.limits.maxWaitMs) throw new BeuserWalkStopped('bound'); }
  call(): void { if (++this.calls > this.limits.maxCalls) throw new BeuserWalkStopped('bound'); }
  transcript(bytes: number): void { if ((this.bytes += bytes) > this.limits.maxTranscriptBytes) throw new BeuserWalkStopped('bound'); }
}
export class BeuserController {
  readonly context: BeuserContext;
  readonly budget: BeuserExecutionBudget;
  private readonly ownsBudget: boolean;
  private steps = 0;
  private waited = 0;
  private bytes = 0;
  private sequence = 0;
  private calls = 0;
  private readonly visited = new Map<string, number>();
  private readonly recent: unknown[] = [];
  private actedOn: string | null = null;
  private previous: string | null = null;
  private idle = 0;
  /** The digit-masked screen last observed and when it first appeared (walk19R: a fast walker reads a screen the product has not redrawn yet). */
  private observed: string | null = null;
  private changedAt = performance.now();
  constructor(context: BeuserContext, readonly summary: BeuserWalkerSummary, budget?: BeuserExecutionBudget) {
    this.budget = budget ?? new BeuserExecutionBudget(context.limits); this.ownsBudget = budget === undefined;
    if (JSON.stringify(this.budget.limits) !== JSON.stringify(pinBeuserLimits(context.limits))) throw new BeuserContractError('BEUSER_LIMITS_UNAVAILABLE');
    this.context = Object.freeze({ ...context, signal: AbortSignal.any([context.signal, this.budget.signal]) });
  }
  close(): void { if (this.ownsBudget) this.budget.close(); }
  guard(kind: 'run' | 'attempt' | 'beuser-transcript' | 'beuser-sandbox', action: string): void {
    const b = this.context.binding;
    const id = kind === 'run' ? b.identity.runId : kind === 'attempt' ? b.identity.attemptId : kind === 'beuser-transcript' ? b.transcriptId : b.realmId;
    assertBeuserAccess(this.context, b, this.context.principal, { kind, id }, action);
  }
  async call<T>(kind: Parameters<BeuserController['guard']>[0], action: string, work: (context: BeuserContext) => Promise<T>, attentive = false): Promise<T> {
    this.guard(kind, action);
    const attention = attentive ? beuserDeadline(this.summary.attentionMs) : null;
    const context = attention ? { ...this.context, signal: AbortSignal.any([this.context.signal, attention.signal]) } : this.context;
    try { return await beuserBounded(context.signal, () => work(context)); }
    finally { attention?.close(); }
  }
  step(): void {
    this.context.signal.throwIfAborted();
    this.budget.step();
    if (++this.steps > Math.min(this.context.limits.maxSteps, this.summary.patience.maxSteps)) throw new BeuserWalkStopped('bound');
  }
  /** Walk20: a wait is charged the time it actually took (the driver returns once the product redrew and settled), never more than asked. */
  wait(requested: number, elapsed: number): void {
    const ms = Math.min(requested, Math.max(0, Math.ceil(elapsed)));
    this.budget.wait(ms); if ((this.waited += ms) > this.waitPatience()) throw new BeuserWalkStopped('bound');
  }
  private waitPatience(): number { return Math.min(this.context.limits.maxWaitMs, this.summary.patience.maxWaitMs); }
  modelCall(): void { this.budget.call(); if (++this.calls > this.context.limits.maxCalls) throw new BeuserWalkStopped('bound'); }
  screen(screen: BeuserScreen): void {
    assertBeuserAccess(this.context, screen.binding, this.context.principal, { kind: 'beuser-sandbox', id: screen.binding.realmId }, 'create');
    if (!Number.isSafeInteger(screen.sequence) || screen.sequence <= this.sequence || !/^[a-f0-9]{64}$/u.test(screen.digest)) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    this.sequence = screen.sequence;
    const settled = beuserSettledScreen(screen);
    if (settled !== this.observed) { this.observed = settled; this.changedAt = performance.now(); }
    const bytes = new TextEncoder().encode(screen.text).byteLength;
    this.budget.transcript(bytes); this.bytes += bytes;
    if (this.bytes > this.context.limits.maxTranscriptBytes) throw new BeuserWalkStopped('bound');
  }
  /** The walker's own last actions (typed text withheld, as in the loop friction row), whether its last one left the screen as it was, and
   * the persona's model decisions (this one included) and wait patience left. */
  history(screen: BeuserScreen): BeuserWalkerHistory {
    return { recentActions: [...this.recent], screenUnchanged: this.actedOn === screen.digest,
      remainingSteps: Math.min(this.context.limits.maxSteps, this.summary.patience.maxSteps) - this.steps,
      remainingWaitMs: Math.max(0, this.waitPatience() - this.waited) };
  }
  /**
   * Before the effect (walk17 S2, walk18; thresholds from the limits registry): the `loopStop`th identical key or text on one screen is a loop,
   * exactly or after a cycle through other screens that only changed numbers (a stepper's consecutive presses are not a cycle); the
   * `observeStop`th consecutive look/wait on one settled screen is `observing`. Both are RED persona-stuck. Walk19R: on a screen unchanged since
   * the last action either holds only once that screen has stayed unchanged for `settleMs`; before that the action proceeds. A cycle through
   * other screens is the product answering, so it is not delayed. Walk20: a wait beyond the wait patience left is refused before any effect
   * (a correction); with no wait patience left the persona has run out of patience (`patience`, RED persona-patience).
   */
  action(screen: BeuserScreen, action: BeuserSurfaceCommand['action']): void {
    const settled = beuserSettledScreen(screen), unchanged = this.previous === settled;
    const waiting = unchanged && performance.now() - this.changedAt < BEUSER_WALK_RULES.settleMs;
    if (action.kind === 'look' || action.kind === 'wait') {
      if (unchanged && !waiting && this.idle + 1 >= BEUSER_WALK_RULES.observeStop) throw new BeuserWalkStopped('observing');
      const left = this.waitPatience() - this.waited;
      if (action.kind === 'wait' && action.ms > left) throw left <= 0 ? new BeuserWalkStopped('patience') : new BeuserContractError('BEUSER_ACTION_INVALID');
      return;
    }
    const exact = this.visited.get(JSON.stringify([screen.digest, action])) ?? 0, cycle = this.visited.get(JSON.stringify([settled, action])) ?? 0;
    if (!waiting && exact + 1 >= BEUSER_WALK_RULES.loopStop || !unchanged && cycle + 1 >= BEUSER_WALK_RULES.loopStop) throw new BeuserWalkStopped('loop');
  }
  /** After the surface took (or refused, before any input) the action. A refused action is history for the correction, never a loop count. */
  acted(screen: BeuserScreen, action: BeuserSurfaceCommand['action'], refused?: BeuserCorrection): void {
    this.recent.push({ ...(action.kind === 'type' ? { kind: 'type' } : action), ...(refused ? { refused } : {}) });
    if (this.recent.length > BEUSER_WALK_RULES.loopStop) this.recent.shift();
    this.actedOn = screen.digest;
    if (refused) return;
    const settled = beuserSettledScreen(screen), observed = action.kind === 'look' || action.kind === 'wait';
    this.idle = observed ? (this.previous === settled ? this.idle : 0) + 1 : 0;
    if (!observed) for (const key of new Set([JSON.stringify([screen.digest, action]), ...(this.previous === settled ? [] : [JSON.stringify([settled, action])])]))
      this.visited.set(key, (this.visited.get(key) ?? 0) + 1);
    this.previous = settled;
  }
}
