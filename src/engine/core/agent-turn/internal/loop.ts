import { createHash } from 'node:crypto';
import { AGENT_COMPACTION_HIGH_WATER, renderAgentCompaction, type AgentCompactionSummary } from './compaction.js';
import { createAgentContextCarry } from './carry.js';
import { agentContextFailureNote, agentHistoryBytes, createAgentCompactionGuard, type AgentContextFailure } from './pressure.js';
import { projectModelIngressField, type ModelIngressProjection } from './model-ingress-project.js';
import { agentTurnApproverNote, type AgentToolOwnerAnswer } from './approver-note.js';
import { LOCALES, t, type Locale } from '#platform/index.js';
import type { AgentContextQuality, AgentToolCall, AgentToolCleanup, AgentToolDiagnostic, AgentToolOutcome, AgentToolSpec, AgentToolCallStatus, AgentTurnEvent, AgentTurnFinish,
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
  /** Delivery failure reported by the host, retained in the same durable outcome rather than mislabeled as user cancellation. */
  contextFailure?(): AgentContextFailure | null;
  invokeRound(input: { readonly round: number; readonly messages: readonly AgentTurnMessage[]; readonly tools: readonly AgentToolSpec[] },
    onDelta: (delta: { readonly kind: 'text' | 'reasoning'; readonly text: string }) => void, signal: AbortSignal): Promise<AgentRoundOutcome>;
  /** Per call, with its checked arguments so a resource floor (e.g. writes to CI or hooks) can raise `allow` to `require-approval`. */
  authorize(tool: AgentToolSpec, args?: Record<string, unknown>): Promise<'allow' | 'deny' | 'require-approval'>;
  /** Optional validation before authority is asked (an edit that cannot apply is an error, never an approval prompt). */
  prepare?(tool: AgentToolSpec, args: Record<string, unknown>, signal: AbortSignal): Promise<{ readonly ok: true; readonly requireApproval?: boolean } | { readonly ok: false; readonly text: string }>;
  /** Short display target of a call (a workspace path or pattern), never used for authority. */
  describe(tool: AgentToolSpec, args: Record<string, unknown>): string | null;
  /**
   * `callId` correlates streamed output (e.g. a shell command's) with the call; the result stays the only history. `execution` is the
   * call's position in the turn (model round, index in its response): the identity of an effect it applies, unique within the turn and
   * the same on a replay of that call; the provider's call id is not (providers reuse ids across responses; Astra 2113).
   */
  execute(tool: AgentToolSpec, args: Record<string, unknown>, signal: AbortSignal, callId: string, execution: AgentToolExecution): Promise<AgentToolOutcome>;
  now(): number;
  /**
   * The prompt of a round as the provider will see it (T-L5): its own token count, or a tagged conservative upper bound, and the
   * served window when known. One measurement per round drives admission, the surface's context line and (T-L5b) compaction.
   */
  measure?(input: { readonly round: number; readonly messages: readonly AgentTurnMessage[]; readonly tools: readonly AgentToolSpec[] },
    signal: AbortSignal): Promise<{ readonly promptTokens: number; readonly windowTokens: number | null; readonly quality: AgentContextQuality }>;
  /**
   * The model's summary of older messages for compaction (T-L5b): a governed, tools-off invocation whose command id derives from the
   * turn and `sequence`. Null when the call failed (no answer): the loop then keeps the history and closes the turn with a typed note.
   * `unreadable` when it answered with no usable summary (TERM-FEEDBACK-1): the loop compacts with Deckent's labelled mechanical
   * excerpt instead, and the turn's note says so.
   */
  summarize?(input: { readonly sequence: number; readonly messages: readonly AgentTurnMessage[] }, signal: AbortSignal):
    Promise<AgentCompactionSummary | 'unreadable' | null>;
  /**
   * The owner's decision on one approval-gated call (T-L4, C12): opens a single-use approval bound to exactly this call and waits.
   * `allow` means approved and re-authorized just now (policy re-evaluated); anything else never runs the call. APPROVER-NOTE: a decision
   * the owner explained in their own words comes as `{ outcome, note }`; the note reaches the model with the call's result or refusal.
   * `policy-deny`: the owner allowed, but policy denies the call now (re-evaluated after the approval) — a policy refusal, not the owner's.
   */
  requestApproval?(input: { readonly round: number; readonly index: number; readonly call: AgentToolCall; readonly tool: AgentToolSpec;
    readonly args: Record<string, unknown>; readonly argsDigest: string; readonly target: string | null }, signal: AbortSignal):
    Promise<'allow' | 'deny' | 'expired' | 'cancelled' | 'policy-deny' | AgentToolOwnerAnswer>;
  /** Durable projection of every settled call (optional for pure tests; the runtime composition always records). */
  settled?(call: { readonly round: number; readonly index: number; readonly call: AgentToolCall; readonly tool: AgentToolSpec | null;
    readonly argsDigest: string | null; readonly target: string | null; readonly status: AgentToolCallStatus; readonly content: string;
    /** B4: where a workspace path failed (step, errno), when the tool said so; kept on the durable tool-call record. */
    readonly diagnostic?: AgentToolDiagnostic }): Promise<void>;
  /** Sealed digests of a marked field. A failure withholds the field; the decoded payload is not an argument. */
  recordIngress?(notice: ModelIngressProjection): Promise<void>;
}

/**
 * Engine note after the second consecutive round that made no progress (TL-C D7): every call of the round was a duplicate, had
 * invalid arguments or failed, and the model wrote no text. Once per such streak; the turn goes on (no counter, no limit). In the turn's
 * language (the service-resolved locale), like the context notes: the user reads it in the conversation too.
 */
export const agentTurnNoProgressNote = (language: Locale = LOCALES[0]): string => `[deckent] ${t('agent.turn.noProgress', {}, language)}`;
/** The English note (the catalog's default locale); the loop sends the turn's own language (owner terminal test 2026-10-07). */
export const AGENT_TURN_NO_PROGRESS_NOTE = agentTurnNoProgressNote();
/**
 * Closure-note sentence of a turn that compacted without a model summary (TERM-FEEDBACK-1): the model answered the summary call with
 * nothing readable, so the older messages became Deckent's labelled mechanical excerpt.
 */
export const AGENT_TURN_MECHANICAL_COMPACTION_NOTE = '[deckent] Earlier messages were compacted without a model summary (its summary could'
  + ' not be read): they are kept as a shortened excerpt, and details from them may be missing. Repeat what still matters, or start a new conversation.';
/** Final line of the partial assistant text kept in the history when a round is cancelled after text had streamed. */
const AGENT_TURN_CANCELLED_MID_ANSWER = '[deckent] cancelled mid-answer';
const NO_PROGRESS_STATUSES: ReadonlySet<AgentToolCallStatus> = new Set(['duplicate', 'invalid-arguments', 'error']);
/**
 * What the model is told about a call of a round that reached its output limit (TRUNCATED-TOOLCALL, live 2026-09-30: large write_file / run_shell
 * arguments cut at exactly 8192 completion tokens, streamed by vLLM v0.30.0 as finish_reason "tool_calls"). Protocol text like every `[deckent]`
 * result: English, in code; the call is labelled `invalid-arguments` (its arguments are incomplete; Jev 6192a348, safest reversible option).
 */
export function agentTurnTruncatedCallResult(name: string, limitTokens: number | null): string {
  return `[deckent] ${name}: error=output-limit (this answer reached the output limit${limitTokens === null ? '' : ` of ${limitTokens} tokens`} while writing the call,`
    + ' so its arguments are incomplete; nothing ran). Do not send the same call again. Write large content in parts: create the file with its first'
    + ' part, then add each next part with edit_file (old_string = the current last lines), or write the parts with scratch_write and join them with'
    + ' one run_shell command. Keep each call well below the limit.';
}
/** Closure-note sentence of a turn in which calls were refused because their round reached the output limit (TRUNCATED-TOOLCALL). */
export function agentTurnTruncatedCallsNote(count: number, limitTokens: number | null): string {
  return `[deckent] ${count} tool call${count === 1 ? ' was' : 's were'} cut at the model's output limit${limitTokens === null ? '' : ` (${limitTokens} tokens)`}`
    + ' and not run; the model was asked to write in smaller parts.';
}

/** A tool call's position in its turn: the model round and its index in that round's response. */
export interface AgentToolExecution { readonly round: number; readonly index: number }

export interface AgentTurnInput {
  /** Service-resolved locale; the existing wire carries the resulting note. */
  readonly language?: Locale;
  readonly messages: readonly AgentTurnMessage[];
  readonly tools: readonly AgentToolSpec[];
  readonly signal: AbortSignal;
  readonly emit: (event: AgentTurnEvent) => void;
  /**
   * Tokens a round must leave free in the window: the completion limit it asks for and a safety margin (T-L5). `requestMaxBytes`: the
   * bound of the client's next request (the service input bound); past the high-water mark of it the history is compacted too, so a
   * long conversation keeps fitting even when the window is unknown (Astra 2091 R1).
   */
  readonly admission?: { readonly outputReserveTokens: number; readonly safetyReserveTokens: number; readonly requestMaxBytes?: number;
    /** Bytes the client's next request adds after this round: the longest answer and one user message (owner 2026-09-26, Astra 2106 R2). */
    readonly requestReserveBytes?: number;
    /**
     * The completion limit every round requests (TRUNCATED-TOOLCALL). A round whose reported completion count reaches it, or whose finish is
     * `length`, is truncated: none of its tool calls runs (a provider may report such a round as `tool_calls`, vLLM v0.30.0 does). Absent: only
     * `length` marks a round.
     */
    readonly completionLimitTokens?: number };
  /** MODES-3: a quarantined tool result does not wait. The model still receives only the withheld sentence. */
  readonly fullAccess?: boolean;
  /** APPROVER-NOTE: the most code points of an approver's note the model receives (`approvals.approverNoteMaxChars`). Absent: no note is sent. */
  readonly approverNoteMaxChars?: number;
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
    // Owner terminal test 2026-10-07: grep got `maxMatches` twice; the refusal names the arguments the tool takes, so the next call can be right.
    if (type === undefined) return { ok: false, detail: `unknown argument "${key}"; valid arguments: ${Object.keys(properties).join(', ') || 'none'}` };
    const matches = type === 'string' ? typeof value === 'string' : type === 'integer' ? Number.isSafeInteger(value) : type === 'boolean' ? typeof value === 'boolean'
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : true;
    if (!matches) return { ok: false, detail: `argument "${key}" must be ${String(type)}` };
  }
  return { ok: true, args };
}

type IngressPause = { readonly call: AgentToolCall; readonly tool: AgentToolSpec; readonly index: number;
  readonly args: Record<string, unknown>; readonly argsDigest: string; readonly target: string | null };
/** The model and the approval card share this text. Decode stays on the projection and is not returned here. */
async function presentModelIngress(content: string, pause: IngressPause | null, input: AgentTurnInput, ports: AgentTurnPorts, round: number): Promise<string> {
  const projected = projectModelIngressField(content);
  if (projected.disposition === 'unchanged') return content;
  try { await ports.recordIngress?.(projected); } catch { return projected.withheld; }
  if (projected.disposition === 'note') return projected.modelText;
  if (!pause || input.fullAccess || !ports.requestApproval) return projected.withheld;
  let answer: 'allow' | 'deny' | 'expired' | 'cancelled' | 'policy-deny' | null;
  try { answer = ownerOutcome(await ports.requestApproval({ round, index: pause.index, call: pause.call, tool: pause.tool, args: pause.args,
    argsDigest: pause.argsDigest, target: pause.target }, input.signal)).outcome; }
  catch { answer = null; }
  if (answer === 'allow') return projected.modelText;
  return projected.withheld;
}

type ApprovalAnswer = Awaited<ReturnType<NonNullable<AgentTurnPorts['requestApproval']>>>;
const ownerOutcome = (answer: ApprovalAnswer) => typeof answer === 'string' ? { outcome: answer, note: null } : answer;
/** The approver's note line (empty without one or without a bound), its ingress recorded like any marked field; an unrecordable mark withholds it. */
async function approverNoteLine(note: string | null, input: AgentTurnInput, ports: AgentTurnPorts): Promise<string> {
  if (note === null || input.approverNoteMaxChars === undefined) return '';
  const { text, ingress } = agentTurnApproverNote(note, input.approverNoteMaxChars);
  if (ingress.disposition !== 'unchanged') {
    try { await ports.recordIngress?.(ingress); } catch { return `\n${ingress.withheld}`; }
  }
  return `\n${text}`;
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
  const messages: AgentTurnMessage[] = [];
  for (const message of input.messages) {
    if (message.role === 'user' || message.role === 'tool') messages.push({ ...message, content: await presentModelIngress(message.content, null, input, ports, 0) });
    else messages.push(message);
  }
  // The carry is built from the projected request, so a hidden payload never enters the carried context.
  const carry = createAgentContextCarry(messages);
  const compactionGuard = createAgentCompactionGuard();
  const byName = new Map(input.tools.map(tool => [tool.name, tool]));
  // Read dedupe answers only with a result the model can still see: entries leave with compaction and after a successful edit. An
  // entry is bound to the result message itself, never to the provider's call id (providers reuse ids across rounds; Astra 2106 R1).
  const seenReads = new Map<string, { readonly callId: string; readonly message: AgentTurnMessage }>();
  let rounds = 0, toolCalls = 0, compactions = 0, mechanical = 0, cut = 0, appendedCount = 0, stalled = 0, last: AgentTurnMessage | null = null;
  const limitTokens = input.admission?.completionLimitTokens ?? null;
  // Same value as sha256('agent-turn-appended:1\0' + JSON.stringify(appended)), built incrementally.
  const appendedHash = createHash('sha256').update('agent-turn-appended:1\0[');
  const push = (message: AgentTurnMessage) => {
    messages.push(message); appendedHash.update(`${appendedCount++ ? ',' : ''}${JSON.stringify(message)}`); last = message;
    emit({ kind: 'message', message });
    return message;
  };
  const finish = (value: AgentTurnFinish, closure: string | null): AgentTurnResult => {
    const deliveryFailure = ports.contextFailure?.();
    if (deliveryFailure) { value = 'error'; closure = agentContextFailureNote(deliveryFailure, input.language); }
    if ((value === 'stop' || value === 'length') && input.admission?.requestMaxBytes !== undefined
      && agentHistoryBytes(messages) > input.admission.requestMaxBytes) {
      value = 'error'; closure = agentContextFailureNote('AGENT_CONTEXT_REQUEST_TOO_LARGE', input.language);
    }
    // A mechanical compaction and refused truncated calls are never silent: the turn's note says what happened and what to do.
    const extra = [...(cut ? [agentTurnTruncatedCallsNote(cut, limitTokens)] : []), ...(mechanical ? [AGENT_TURN_MECHANICAL_COMPACTION_NOTE] : [])];
    const note = extra.length ? [closure, ...extra].filter(Boolean).join(' ') : closure;
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
    const historyBytes = byteBound === undefined ? 0 : agentHistoryBytes(messages);
    // Past the high-water mark, or when this round's longest answer plus the next user message would not fit the next request.
    const bytePressure = byteBound !== undefined && (historyBytes > byteBound * AGENT_COMPACTION_HIGH_WATER
      || historyBytes + (input.admission?.requestReserveBytes ?? 0) > byteBound);
    const plan = ports.summarize && (tokenPressure || bytePressure) ? compactionGuard.plan(messages) : null;
    if (plan && ports.summarize) {
      const canonical = carry.fold(plan.older, byteBound);
      if (!canonical) return finish('error', agentContextFailureNote('AGENT_CONTEXT_CARRY_TOO_LARGE', input.language));
      compactions++;
      let summaryOf: AgentCompactionSummary | 'unreadable' | null;
      try { summaryOf = await ports.summarize({ sequence: compactions, messages: plan.older }, signal); } catch { summaryOf = null; }
      if (signal.aborted) return finish('cancelled', `Cancelled. ${summary()}.`);
      if (!summaryOf) {
        const reached = tokenPressure && current ? `${current.promptTokens} of ${current.windowTokens} context tokens` : `the request size bound (${byteBound} bytes)`;
        return finish('error', `The conversation reached ${reached} and could not be`
          + ` compacted (the summary call failed). Nothing more was sent and the history is unchanged. ${summary()}.`
          + ' Send the message again to retry, or start a new conversation (this one stays saved).');
      }
      if (summaryOf === 'unreadable') mechanical++;
      const next = [...(plan.system ? [plan.system] : []), renderAgentCompaction(plan, summaryOf === 'unreadable' ? null : summaryOf, canonical), ...plan.tail];
      if (byteBound !== undefined && agentHistoryBytes(next) > byteBound) return finish('error',
        agentContextFailureNote('AGENT_CONTEXT_CARRY_TOO_LARGE', input.language));
      compactionGuard.applied(messages, next);
      messages.splice(0, messages.length, ...next);
      const visible = new Set<AgentTurnMessage>(plan.tail);
      for (const [digest, seen] of seenReads) if (!visible.has(seen.message)) seenReads.delete(digest);
      emit({ kind: 'compacted', messages: next.filter(message => message.role !== 'system'), replacedMessages: plan.older.length });
      await measure();
      if (signal.aborted) return finish('cancelled', `Cancelled. ${summary()}.`);
    }
    const admitted = measured as Awaited<ReturnType<NonNullable<AgentTurnPorts['measure']>>> | null;
    // Admission before any send: a prompt that cannot fit is never sent (the provider would reject it after a billed attempt).
    if (admitted && admitted.windowTokens !== null && admitted.promptTokens + reserve > admitted.windowTokens) {
      return finish('error', agentContextFailureNote('AGENT_CONTEXT_WINDOW_EXCEEDED', input.language, {
        prompt: admitted.promptTokens, reserve, window: admitted.windowTokens, quality: admitted.quality }));
    }
    if (byteBound !== undefined && agentHistoryBytes(messages) > byteBound) {
      return finish('error', agentContextFailureNote('AGENT_CONTEXT_REQUEST_TOO_LARGE', input.language));
    }
    let outcome: AgentRoundOutcome;
    let streamed = '';
    try { outcome = await ports.invokeRound({ round: rounds, messages, tools: input.tools }, delta => { if (delta.kind === 'text') streamed += delta.text; emit(delta); }, signal); }
    catch { outcome = { status: 'failed', state: signal.aborted ? 'cancelled' : 'unavailable' }; }
    if (outcome.status === 'failed') {
      if (signal.aborted || outcome.state === 'cancelled') {
        // The user already saw the streamed text: keep it in the history so the next turn sees it too.
        if (streamed) push({ role: 'assistant', content: `${streamed}\n${AGENT_TURN_CANCELLED_MID_ANSWER}`, toolCalls: [] });
        return finish('cancelled', `Cancelled. ${summary()}.`);
      }
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
    let progressed = outcome.content.trim() !== '';
    // A round that reached its output limit carries incomplete calls, whatever its finish says and whether or not the arguments parse.
    const truncated = outcome.finish === 'length' || (limitTokens !== null && outcome.usage !== null && outcome.usage.completionTokens >= limitTokens);
    for (const [index, call] of outcome.toolCalls.entries()) {
      const tool = byName.get(call.name), started = ports.now();
      let digestOf: string | null = null, targetOf: string | null = null, invoked = false, pauseArgs: Record<string, unknown> = {}, noteOf: string | null = null;
      // `cleanup` (Astra 2124): only the host shell tool's outcome ever carries it; the event omits the field otherwise.
      const result = async (status: AgentToolCallStatus, content: string, cleanup?: AgentToolCleanup, diagnostic?: AgentToolDiagnostic) => {
        if (!NO_PROGRESS_STATUSES.has(status)) progressed = true;
        const shown = tool && digestOf !== null ? await presentModelIngress(content, { call, tool, index, args: pauseArgs, argsDigest: digestOf, target: targetOf }, input, ports, rounds) : content;
        const message = push({ role: 'tool', toolCallId: call.id, name: call.name, content: shown });
        carry.observed(message, call, rounds, index, invoked, status, cleanup);
        emit({ kind: 'tool.finished', callId: call.id, name: call.name, status, ms: Math.max(0, ports.now() - started), bytes: Buffer.byteLength(shown, 'utf8'),
          ...(cleanup !== undefined ? { cleanup } : {}) });
        await ports.settled?.({ round: rounds, index, call, tool: tool ?? null, argsDigest: digestOf, target: targetOf, status, content: shown, ...(diagnostic ? { diagnostic } : {}) });
        return message;
      };
      if (signal.aborted) { emit({ kind: 'tool.started', callId: call.id, name: call.name, target: null }); await result('cancelled', `[deckent] ${call.name}: error=cancelled`); continue; }
      // Never run a cut call (no partial effect): no argument check, no policy question, no approval, no execution.
      if (truncated) { cut++; emit({ kind: 'tool.started', callId: call.id, name: call.name, target: null }); await result('invalid-arguments', agentTurnTruncatedCallResult(call.name, limitTokens)); continue; }
      if (!tool) { emit({ kind: 'tool.started', callId: call.id, name: call.name, target: null }); await result('error', `[deckent] ${call.name}: error=unknown-tool`); continue; }
      const checked = checkArguments(tool, call.argumentsJson);
      targetOf = checked.ok ? ports.describe(tool, checked.args) : null;
      emit({ kind: 'tool.started', callId: call.id, name: call.name, target: targetOf });
      if (!checked.ok) { await result('invalid-arguments', `[deckent] ${call.name}: error=invalid-arguments (${checked.detail})`); continue; }
      const digest = agentToolArgumentsDigest(tool.name, checked.args); digestOf = digest; pauseArgs = checked.args;
      if (tool.toolClass === 'read' && seenReads.has(digest)) {
        await result('duplicate', `[deckent] ${call.name}: same call as ${seenReads.get(digest)!.callId} earlier in this turn; its result is above. Change the arguments to read something else.`);
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
        let answer: 'allow' | 'deny' | 'expired' | 'cancelled' | 'policy-deny' | null;
        try { const owner = ownerOutcome(await ports.requestApproval({ round: rounds, index, call, tool, args: checked.args, argsDigest: digest, target: targetOf }, signal));
          answer = owner.outcome; noteOf = owner.note; }
        catch { answer = null; }
        if (answer === null && !signal.aborted) { await result('approval-required', `[deckent] ${call.name}: error=approval-unavailable (nothing ran)`); continue; }
        if (signal.aborted || answer === 'cancelled') { await result('cancelled', `[deckent] ${call.name}: error=cancelled`); continue; }
        if (answer === 'deny') { await result('denied', `[deckent] ${call.name}: error=denied-by-owner${await approverNoteLine(noteOf, input, ports)}`); continue; }
        if (answer === 'policy-deny') { await result('denied', `[deckent] ${call.name}: error=denied-by-policy (approved, but policy denies it now; nothing ran)`); continue; }
        if (answer === 'expired') { await result('approval-expired', `[deckent] ${call.name}: error=approval-expired (nothing ran)`); continue; }
      }
      toolCalls++;
      invoked = true;
      let outcomeText: AgentToolOutcome;
      try { outcomeText = await ports.execute(tool, checked.args, signal, call.id, { round: rounds, index }); } catch { outcomeText = { status: 'error', text: `[deckent] ${call.name}: error=failed` }; }
      // An executed non-read call may have changed files even when it ended in error (e.g. a non-zero exit after `sed -i`): earlier reads run again.
      if (tool.toolClass !== 'read') seenReads.clear();
      // APPROVER-NOTE: an allowed call's note follows its result (bound to this call, never a separate instruction message).
      const resultMessage = await result(signal.aborted ? 'cancelled' : outcomeText.status, `${outcomeText.text}${await approverNoteLine(noteOf, input, ports)}`,
        tool.toolClass === 'shell' ? outcomeText.cleanup : undefined, outcomeText.diagnostic);
      if (tool.toolClass === 'read' && outcomeText.status === 'ok' && !signal.aborted) seenReads.set(digest, { callId: call.id, message: resultMessage });
    }
    stalled = progressed ? 0 : stalled + 1;
    if (stalled === 2 && !signal.aborted) push({ role: 'user', content: agentTurnNoProgressNote(input.language) });
  }
}
