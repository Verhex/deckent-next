import { BeuserContractError, assertBeuserAccess, pinBeuserLimits, type BeuserLimits, type BeuserContext, type BeuserScreen, type BeuserSurfaceCommand, type BeuserWalkerHistory } from '#engine/core/beuser-contract/index.js';
import type { BeuserWalkerSummary } from '#domain/index.js';

// Node's signed timer representation is a platform invariant, never a configurable walk policy.
const NODE_SIGNED_INTEGER_CEILING = 2_147_483_647;
/** Walk17 S2 (lead 2026-10-29): the same key or text on the same screen a third time is a loop (a first repeat may be a key the product
 * swallowed); the walker sees as many of its own last actions. Observation (`look`, `wait`) never counts. */
const LOOP_STOP = 3;

export class BeuserWalkStopped extends Error {
  constructor(readonly reason: 'bound' | 'loop' | 'drift' | 'leak' | 'unknown' | 'cancelled' | 'deadline') { super(reason); }
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
  private acted: string | null = null;
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
  wait(ms: number): void { this.budget.wait(ms); if ((this.waited += ms) > Math.min(this.context.limits.maxWaitMs, this.summary.patience.maxWaitMs)) throw new BeuserWalkStopped('bound'); }
  modelCall(): void { this.budget.call(); if (++this.calls > this.context.limits.maxCalls) throw new BeuserWalkStopped('bound'); }
  screen(screen: BeuserScreen): void {
    assertBeuserAccess(this.context, screen.binding, this.context.principal, { kind: 'beuser-sandbox', id: screen.binding.realmId }, 'create');
    if (!Number.isSafeInteger(screen.sequence) || screen.sequence <= this.sequence || !/^[a-f0-9]{64}$/u.test(screen.digest)) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    this.sequence = screen.sequence;
    const bytes = new TextEncoder().encode(screen.text).byteLength;
    this.budget.transcript(bytes); this.bytes += bytes;
    if (this.bytes > this.context.limits.maxTranscriptBytes) throw new BeuserWalkStopped('bound');
  }
  /** The walker's own last actions (typed text withheld, as in the loop friction row) and whether its last one left the screen as it was. */
  history(screen: BeuserScreen): BeuserWalkerHistory { return { recentActions: [...this.recent], screenUnchanged: this.acted === screen.digest }; }
  action(screen: BeuserScreen, action: BeuserSurfaceCommand['action']): void {
    this.recent.push(action.kind === 'type' ? { kind: 'type' } : action); if (this.recent.length > LOOP_STOP) this.recent.shift();
    this.acted = screen.digest;
    if (action.kind === 'look' || action.kind === 'wait') return;
    const key = JSON.stringify([screen.digest, action]), count = (this.visited.get(key) ?? 0) + 1;
    if (count >= LOOP_STOP) throw new BeuserWalkStopped('loop');
    this.visited.set(key, count);
  }
}
