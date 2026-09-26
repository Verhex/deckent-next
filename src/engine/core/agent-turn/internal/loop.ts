import { createHash } from 'node:crypto';
import { AGENT_COMPACTION_HIGH_WATER, planAgentCompaction, renderAgentCompaction, type AgentCompactionSummary } from './compaction.js';
import type { AgentContextQuality, AgentToolCall, AgentToolOutcome, AgentToolSpec, AgentToolCallStatus, AgentTurnEvent, AgentTurnFinish,
  AgentTurnMessage } from '#domain/index.js';

/** One governed model round as the loop sees it: the provider-neutral answer, or why there is none. */
export type AgentRoundOutcome =
  | { readonly status: 'responded'; readonly content: string; readonly reasoning: string; readonly toolCalls: readonly AgentToolCall[];
    readonly finish: string; readonly usage: { readonly promptTokens: number; readonly completionTokens: number } | null }
  | { readonly status: 'failed'; readonly state: string };

/**
 * The loop's only ways to act. Rounds are governed invocations (policy, activation, allocation, spending, receipts) whose command
 * id the composition derives from the turn id and round, so a replay never bills twice; tools are authorized per call before they
 * run. The loop itself holds no authority and no provider or storage knowledge.
 */
export interface AgentTurnPorts {
  invokeRound(input: { readonly round: number; readonly messages: readonly AgentTurnMessage[]; readonly tools: readonly AgentToolSpec[] },
    onDelta: (delta: { readonly kind: 'text' | 'reasoning'; readonly text: string }) => void, signal: AbortSignal): Promise<AgentRoundOutcome>;
  /** Per call, with its checked arguments so a resource floor (e.g. writes to CI or hooks) can raise `allow` to `require-approval`. */
  authorize(tool: AgentToolSpec, args?: Record<string, unknown>): Promise<'allow' | 'deny' | 'require-approval'>;
  /** Optional validation before authority is asked (an edit that cannot apply is an error, never an approval prompt). */
  prepare?(tool: AgentToolSpec, args: Record<string, unknown>, signal: AbortSignal): Promise<{ readonly ok: true; readonly requireApproval?: boolean } | { readonly ok: false; readonly text: string }>;
  /** Short display target of a call (a workspace path or pattern), never used for authority. */
  describe(tool: AgentToolSpec, args: Record<string, unknown>): string | null;
  execute(tool: AgentToolSpec, args: Record<string, unknown>, signal: AbortSignal): Promise<AgentToolOutcome>;
  now(): number;
  /**
   * The prompt of a round as the provider will see it (T-L5): its own token count, or a tagged conservative upper bound, and the
   * served window when known. One measurement per round drives admission, the surface's context line and (T-L5b) compaction.
   */
  measure?(input: { readonly round: number; readonly messages: readonly AgentTurnMessage[]; readonly tools: readonly AgentToolSpec[] },
    signal: AbortSignal): Promise<{ readonly promptTokens: number; readonly windowTokens: number | null; readonly quality: AgentContextQuality }>;
  /**
   * The model's summary of older messages for compaction (T-L5b): a governed, tools-off invocation whose command id derives from the
   * turn and `sequence`. Null when it failed; the loop then keeps the history and closes the turn with a typed note.
   */
  summarize?(input: { readonly sequence: number; readonly messages: readonly AgentTurnMessage[] }, signal: AbortSignal): Promise<AgentCompactionSummary | null>;
  /**
   * The owner's decision on one approval-gated call (T-L4, C12): opens a single-use approval bound to exactly this call and waits.
   * `allow` means approved and re-authorized just now (policy re-evaluated); anything else never runs the call.
   */
  requestApproval?(input: { readonly round: number; readonly index: number; readonly call: AgentToolCall; readonly tool: AgentToolSpec;
    readonly args: Record<string, unknown>; readonly argsDigest: string; readonly target: string | null }, signal: AbortSignal):
    Promise<'allow' | 'deny' | 'expired' | 'cancelled'>;
  /** Durable projection of every settled call (optional for pure tests; the runtime composition always records). */
  settled?(call: { readonly round: number; readonly index: number; readonly call: AgentToolCall; readonly tool: AgentToolSpec | null;
    readonly argsDigest: string | null; readonly target: string | null; readonly status: AgentToolCallStatus; readonly content: string }): Promise<void>;
}

export interface AgentTurnInput {
  readonly messages: readonly AgentTurnMessage[];
  readonly tools: readonly AgentToolSpec[];
  readonly signal: AbortSignal;
  readonly emit: (event: AgentTurnEvent) => void;
  /**
   * Tokens a round must leave free in the window: the completion limit it asks for and a safety margin (T-L5). `requestMaxBytes`: the
   * bound of the client's next request (the service input bound); past the high-water mark of it the history is compacted too, so a
   * long conversation keeps fitting even when the window is unknown (Astra 2091 R1).
   */
  readonly admission?: { readonly outputReserveTokens: number; readonly safetyReserveTokens: number; readonly requestMaxBytes?: number };
}

export interface AgentTurnResult {
  readonly finish: AgentTurnFinish;
  /**
   * The appended messages are streamed as `message` events (the caller's history); the result keeps only their count, the digest of
   * their canonical JSON array and the final answer, so a long turn holds no copy of earlier tool results (Astra 2091 R2).
   */
  readonly answer: string | null;
  readonly appendedCount: number;
  readonly appendedDigest: string | null;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly note: string | null;
}

/** Canonical JSON (sorted keys) so equal arguments have one digest regardless of the model's key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const agentToolArgumentsDigest = (name: string, args: Record<string, unknown>) => createHash('sha256').update(`agent-tool-args:1\0${name}\0${canonical(args)}`).digest('hex');

/** Arguments against the tool's declared JSON schema subset: an object, required keys present, declared primitive types. */
function checkArguments(tool: AgentToolSpec, raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; detail: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw === '' ? '{}' : raw); } catch { return { ok: false, detail: 'arguments are not valid JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, detail: 'arguments must be a JSON object' };
  const args = parsed as Record<string, unknown>, properties = tool.inputSchema.properties as Record<string, { type?: unknown }>;
  for (const key of tool.inputSchema.required ?? []) if (args[key] === undefined) return { ok: false, detail: `missing required argument "${key}"` };
  for (const [key, value] of Object.entries(args)) {
    const type = Object.hasOwn(properties, key) ? properties[key]?.type : undefined;
    if (type === undefined) return { ok: false, detail: `unknown argument "${key}"` };
    const matches = type === 'string' ? typeof value === 'string' : type === 'integer' ? Number.isSafeInteger(value) : type === 'boolean' ? typeof value === 'boolean'
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : true;
    if (!matches) return { ok: false, detail: `argument "${key}" must be ${String(type)}` };
  }
  return { ok: true, args };
}

/**
 * One agent turn (T-L3, engine-owned): model round → declared tool calls authorized and executed one by one → results back to the
 * model → next round, until the model answers without tools, the user cancels, or a round has no answer. There is no round, call
 * or time budget (owner 2026-09-24); what bounds a turn is cancellation, policy and the resources of each call. Every tool call is
 * visible as started/finished events; a turn that ends without a model answer gets a deterministic closure note instead of silence.
 * Read-class calls repeated with identical arguments in the same turn are answered with a reference to the earlier result, not
 * re-executed blindly; other classes are never deduplicated here.
 */
export async function runAgentTurn(input: AgentTurnInput, ports: AgentTurnPorts): Promise<AgentTurnResult> {
  const { signal, emit } = input;
  const messages: AgentTurnMessage[] = [...input.messages];
  const byName = new Map(input.tools.map(tool => [tool.name, tool]));
  // Read dedupe answers only with a result the model can still see: entries leave with compaction and after a successful edit.
  const seenReads = new Map<string, string>();
  let rounds = 0, toolCalls = 0, compactions = 0, appendedCount = 0, last: AgentTurnMessage | null = null;
  // Same value as sha256('agent-turn-appended:1\0' + JSON.stringify(appended)), built incrementally.
  const appendedHash = createHash('sha256').update('agent-turn-appended:1\0[');
  const push = (message: AgentTurnMessage) => {
    messages.push(message); appendedHash.update(`${appendedCount++ ? ',' : ''}${JSON.stringify(message)}`); last = message;
    emit({ kind: 'message', message });
  };
  const finish = (value: AgentTurnFinish, note: string | null): AgentTurnResult => {
    emit({ kind: 'done', finish: value, note });
    const final = last as AgentTurnMessage | null;
    const answer = final?.role === 'assistant' && final.toolCalls.length === 0 && final.content ? final.content : null;
    return Object.freeze({ finish: value, answer, appendedCount, appendedDigest: appendedCount ? appendedHash.update(']').digest('hex') : null,
      rounds, toolCalls, note });
  };
  const summary = () => toolCalls === 0 ? 'no tool call ran' : `${toolCalls} tool call(s) ran in ${rounds} round(s); their results are above`;

  for (;;) {
    if (signal.aborted) return finish('cancelled', `Cancelled. ${summary()}.`);
    rounds++;
    // One measurement per round (when a counter port exists) drives the context line, compaction and admission.
    let measured: Awaited<ReturnType<NonNullable<AgentTurnPorts['measure']>>> | null = null;
    const measure = async () => {
      if (!ports.measure) return;
      try { measured = await ports.measure({ round: rounds, messages, tools: input.tools }, signal); } catch { measured = null; }
      if (measured && !signal.aborted) emit({ kind: 'context', round: rounds, ...measured });
    };
    await measure();
    if (signal.aborted) return finish('cancelled', `Cancelled. ${summary()}.`);
    const reserve = (input.admission?.outputReserveTokens ?? 0) + (input.admission?.safetyReserveTokens ?? 0);
    // Compaction (T-L5b) past the high-water mark of the measured window, or of the request byte bound (exact bytes of the history
    // the client will send next; needs no measurement): older messages become one labelled summary.
    const current = measured as Awaited<ReturnType<NonNullable<AgentTurnPorts['measure']>>> | null;
    const tokenPressure = current !== null && current.windowTokens !== null && current.promptTokens + reserve > current.windowTokens * AGENT_COMPACTION_HIGH_WATER;
    const byteBound = input.admission?.requestMaxBytes;
    const bytePressure = byteBound !== undefined && Buffer.byteLength(JSON.stringify(messages), 'utf8') > byteBound * AGENT_COMPACTION_HIGH_WATER;
    const plan = ports.summarize && (tokenPressure || bytePressure) ? planAgentCompaction(messages) : null;
    if (plan && ports.summarize) {
      compactions++;
      let summaryOf: AgentCompactionSummary | null;
      try { summaryOf = await ports.summarize({ sequence: compactions, messages: plan.older }, signal); } catch { summaryOf = null; }
      if (signal.aborted) return finish('cancelled', `Cancelled. ${summary()}.`);
      if (!summaryOf) {
        const reached = tokenPressure && current ? `${current.promptTokens} of ${current.windowTokens} context tokens` : `the request size bound (${byteBound} bytes)`;
        return finish('error', `The conversation reached ${reached} and could not be`
          + ` compacted (the summary call failed). Nothing more was sent and the history is unchanged. ${summary()}.`);
      }
      const next = [...(plan.system ? [plan.system] : []), renderAgentCompaction(plan, summaryOf), ...plan.tail];
      messages.splice(0, messages.length, ...next);
      const visible = new Set(plan.tail.flatMap(message => message.role === 'tool' ? [message.toolCallId] : []));
      for (const [digest, callId] of seenReads) if (!visible.has(callId)) seenReads.delete(digest);
      emit({ kind: 'compacted', messages: next.filter(message => message.role !== 'system'), replacedMessages: plan.older.length });
      await measure();
      if (signal.aborted) return finish('cancelled', `Cancelled. ${summary()}.`);
    }
    const admitted = measured as Awaited<ReturnType<NonNullable<AgentTurnPorts['measure']>>> | null;
    // Admission before any send: a prompt that cannot fit is never sent (the provider would reject it after a billed attempt).
    if (admitted && admitted.windowTokens !== null && admitted.promptTokens + reserve > admitted.windowTokens) {
      return finish('error', `The conversation no longer fits the model's context window: ${admitted.promptTokens} prompt tokens`
        + `${admitted.quality === 'upper-bound' ? ' (upper bound)' : ''} + ${reserve} reserved > ${admitted.windowTokens}. Nothing was sent for`
        + ` this round. ${summary()}. Start a new conversation or ask a shorter question.`);
    }
    let outcome: AgentRoundOutcome;
    try { outcome = await ports.invokeRound({ round: rounds, messages, tools: input.tools }, delta => emit(delta), signal); }
    catch { outcome = { status: 'failed', state: signal.aborted ? 'cancelled' : 'unavailable' }; }
    if (outcome.status === 'failed') {
      if (signal.aborted || outcome.state === 'cancelled') return finish('cancelled', `Cancelled. ${summary()}.`);
      return finish('error', `The model round ended without an answer (${outcome.state}); it is recorded and not retried. ${summary()}.`);
    }
    if (outcome.usage) emit({ kind: 'usage', round: rounds, ...outcome.usage });
    push({ role: 'assistant', content: outcome.content, toolCalls: outcome.toolCalls });
    if (outcome.toolCalls.length === 0) {
      if (outcome.content.trim()) return finish(outcome.finish === 'length' ? 'length' : 'stop', null);
      // Legacy RC1: reasoning spent the whole completion budget and left no answer. Close deterministically, no extra round.
      return finish(outcome.finish === 'length' ? 'length' : 'error', outcome.finish === 'length'
        ? `The model reached its output limit before answering (reasoning used the budget). ${summary()}.`
        : `The model returned no answer. ${summary()}.`);
    }
    for (const [index, call] of outcome.toolCalls.entries()) {
      const tool = byName.get(call.name), started = ports.now();
      let digestOf: string | null = null, targetOf: string | null = null;
      const result = async (status: AgentToolCallStatus, content: string) => {
        push({ role: 'tool', toolCallId: call.id, name: call.name, content });
        emit({ kind: 'tool.finished', callId: call.id, name: call.name, status, ms: Math.max(0, ports.now() - started), bytes: Buffer.byteLength(content, 'utf8') });
        await ports.settled?.({ round: rounds, index, call, tool: tool ?? null, argsDigest: digestOf, target: targetOf, status, content });
      };
      if (signal.aborted) { emit({ kind: 'tool.started', callId: call.id, name: call.name, target: null }); await result('cancelled', `[deckent] ${call.name}: error=cancelled`); continue; }
      if (!tool) { emit({ kind: 'tool.started', callId: call.id, name: call.name, target: null }); await result('error', `[deckent] ${call.name}: error=unknown-tool`); continue; }
      const checked = checkArguments(tool, call.argumentsJson);
      targetOf = checked.ok ? ports.describe(tool, checked.args) : null;
      emit({ kind: 'tool.started', callId: call.id, name: call.name, target: targetOf });
      if (!checked.ok) { await result('invalid-arguments', `[deckent] ${call.name}: error=invalid-arguments (${checked.detail})`); continue; }
      const digest = agentToolArgumentsDigest(tool.name, checked.args); digestOf = digest;
      if (tool.toolClass === 'read' && seenReads.has(digest)) {
        await result('duplicate', `[deckent] ${call.name}: same call as ${seenReads.get(digest)} earlier in this turn; its result is above. Change the arguments to read something else.`);
        continue;
      }
      // Policy first: a denied call learns nothing from the target (a plan error would reveal content).
      let decision = await ports.authorize(tool, checked.args);
      if (decision === 'deny') { await result('denied', `[deckent] ${call.name}: error=denied-by-policy`); continue; }
      if (ports.prepare) {
        let prepared: Awaited<ReturnType<NonNullable<AgentTurnPorts['prepare']>>>;
        try { prepared = await ports.prepare(tool, checked.args, signal); } catch { prepared = { ok: false, text: `[deckent] ${call.name}: error=failed` }; }
        if (!prepared.ok) { await result('error', prepared.text); continue; }
        if (prepared.requireApproval && decision === 'allow') decision = 'require-approval';
      }
      if (decision === 'require-approval') {
        // No bypass: without an approval port the call stays blocked; with one it runs only on an explicit, call-exact allow.
        if (!ports.requestApproval) { await result('approval-required', `[deckent] ${call.name}: error=approval-required (tool approvals are not available here)`); continue; }
        let answer: 'allow' | 'deny' | 'expired' | 'cancelled' | null;
        try { answer = await ports.requestApproval({ round: rounds, index, call, tool, args: checked.args, argsDigest: digest, target: targetOf }, signal); }
        catch { answer = null; }
        if (answer === null && !signal.aborted) { await result('approval-required', `[deckent] ${call.name}: error=approval-unavailable (nothing ran)`); continue; }
        if (signal.aborted || answer === 'cancelled') { await result('cancelled', `[deckent] ${call.name}: error=cancelled`); continue; }
        if (answer === 'deny') { await result('denied', `[deckent] ${call.name}: error=denied-by-owner`); continue; }
        if (answer === 'expired') { await result('approval-expired', `[deckent] ${call.name}: error=approval-expired (nothing ran)`); continue; }
      }
      toolCalls++;
      let outcomeText: AgentToolOutcome;
      try { outcomeText = await ports.execute(tool, checked.args, signal); } catch { outcomeText = { status: 'error', text: `[deckent] ${call.name}: error=failed` }; }
      if (tool.toolClass === 'read' && outcomeText.status === 'ok') seenReads.set(digest, call.id);
      // A successful write may change what any earlier read saw: those reads run again.
      if (tool.toolClass !== 'read' && outcomeText.status === 'ok') seenReads.clear();
      await result(signal.aborted ? 'cancelled' : outcomeText.status, outcomeText.text);
    }
  }
}
