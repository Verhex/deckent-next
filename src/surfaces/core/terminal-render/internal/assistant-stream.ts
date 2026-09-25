import type { TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { EMPTY_SEGMENTER, feedSegmenter, flushSegmenter, segmenterTail, type LiveTail, type Segment, type SegmenterState } from './stream-segmenter.js';

/**
 * Pure assistant-turn presentation state machine: (state, delta, now) → finished units for `Static`, the live tail, the
 * reasoning narration and, on `done`, the turn footer. Reasoning text is only counted, never shown as the answer; the
 * narration collapses into one summary unit when the answer starts (legacy 7108 collapsed reasoning fact). The clock is
 * injected so the machine stays deterministic.
 */
export type TurnFinish = Extract<TurnDelta, { kind: 'done' }>['finish'];
export type AnswerUnit = Readonly<{ kind: Segment['kind']; markdown: string; lead: boolean }>;
export type ReasoningUnit = Readonly<{ kind: 'reasoning'; tokens: number; approximate: boolean; elapsedMs: number }>;
export type ContextView = Readonly<{ promptTokens: number; windowTokens: number | null; quality: Extract<TurnDelta, { kind: 'context' }>['quality'] }>;
export type FooterUnit = Readonly<{ kind: 'footer'; elapsedMs: number; promptTokens: number | null; completionTokens: number | null;
  reasoningTokens: number | null; finish: TurnFinish; note?: string | null; context?: ContextView }>;
type ToolDelta = Extract<TurnDelta, { kind: 'tool' }>;
/** One finished agent tool call: a single visible line (legacy defect: silent tool rounds). */
export type ToolUnit = Readonly<{ kind: 'tool'; name: string; target: string | null; status: NonNullable<ToolDelta['status']>; ms: number }>;
export type ActiveTool = Readonly<{ name: string; target: string | null; startedAtMs: number }>;
export type AssistantUnit = AnswerUnit | ReasoningUnit | ToolUnit | FooterUnit;
export type Narration = Readonly<{ tokens: number; approximate: boolean; startedAtMs: number }>;

type Usage = Readonly<{ promptTokens: number; completionTokens: number; reasoningTokens: number | null }>;
export type AssistantStreamState = Readonly<{
  startedAtMs: number;
  phase: 'waiting' | 'reasoning' | 'answering' | 'done';
  segmenter: SegmenterState;
  reasoningChars: number;
  reasoningStartedAtMs: number | null;
  answered: boolean;
  usage: Usage | null;
  /** Completion tokens of earlier rounds of the same turn (a tool round starts a new model round). */
  earlierCompletionTokens: number;
  activeTool: ActiveTool | null;
  /** The latest round's measured prompt against the window (T-L5). */
  context: ContextView | null;
}>;
export type AssistantStreamStep = Readonly<{
  state: AssistantStreamState;
  /** Units finished by this delta only (never cumulative), in print order. */
  staticUnits: readonly AssistantUnit[];
  liveTail: LiveTail;
  narration: Narration | null;
  footer: FooterUnit | null;
  /** The tool call running now, for the live region; null otherwise. */
  activeTool: ActiveTool | null;
}>;

/** Roughly four characters per token until the provider reports reasoning usage. */
const approxTokens = (chars: number): number => Math.ceil(chars / 4);

export function startAssistantStream(nowMs: number): AssistantStreamState {
  return Object.freeze({ startedAtMs: nowMs, phase: 'waiting', segmenter: EMPTY_SEGMENTER, reasoningChars: 0, reasoningStartedAtMs: null, answered: false, usage: null,
    earlierCompletionTokens: 0, activeTool: null, context: null });
}

function reasoningSummary(state: AssistantStreamState, nowMs: number): ReasoningUnit {
  const reported = state.usage?.reasoningTokens ?? null;
  return Object.freeze({ kind: 'reasoning', tokens: reported ?? approxTokens(state.reasoningChars), approximate: reported === null,
    elapsedMs: Math.max(0, nowMs - (state.reasoningStartedAtMs ?? nowMs)) });
}

function answerUnits(segments: readonly Segment[], answered: boolean): AnswerUnit[] {
  return segments.map((segment, index) => Object.freeze({ kind: segment.kind, markdown: segment.markdown, lead: !answered && index === 0 }));
}

export function narrationOf(state: AssistantStreamState): Narration | null {
  if (state.phase !== 'reasoning') return null;
  const reported = state.usage?.reasoningTokens ?? null;
  return Object.freeze({ tokens: reported ?? approxTokens(state.reasoningChars), approximate: reported === null, startedAtMs: state.reasoningStartedAtMs ?? state.startedAtMs });
}

function step(state: AssistantStreamState, staticUnits: readonly AssistantUnit[], footer: FooterUnit | null = null): AssistantStreamStep {
  return Object.freeze({ state, staticUnits: Object.freeze([...staticUnits]), liveTail: segmenterTail(state.segmenter), narration: narrationOf(state), footer,
    activeTool: state.activeTool });
}

export function renderAssistantStream(state: AssistantStreamState, delta: TurnDelta, nowMs: number): AssistantStreamStep {
  if (state.phase === 'done') return step(state, []);
  if (delta.kind === 'message' || delta.kind === 'compacted') return step(state, []);
  if (delta.kind === 'context') {
    return step(Object.freeze({ ...state, context: Object.freeze({ promptTokens: delta.promptTokens, windowTokens: delta.windowTokens, quality: delta.quality }) }), []);
  }
  if (delta.kind === 'usage') {
    // Each round reports its own usage: the prompt is the latest context, completions add up over the turn.
    const earlier = state.earlierCompletionTokens + (state.usage?.completionTokens ?? 0);
    return step(Object.freeze({ ...state, earlierCompletionTokens: state.usage ? earlier : state.earlierCompletionTokens,
      usage: Object.freeze({ promptTokens: delta.promptTokens, completionTokens: delta.completionTokens, reasoningTokens: delta.reasoningTokens }) }), []);
  }
  if (delta.kind === 'tool') {
    // Text before a tool call is printed first; the call is one line; the next round starts a fresh reasoning narration.
    const pending = state.phase === 'reasoning' ? [reasoningSummary(state, nowMs)] : [];
    const flushed = flushSegmenter(state.segmenter);
    const text = answerUnits(flushed.segments, state.answered);
    const base = { ...state, phase: 'waiting' as const, segmenter: flushed.state, reasoningChars: 0, reasoningStartedAtMs: null, answered: state.answered || text.length > 0 };
    if (delta.phase === 'started') {
      return step(Object.freeze({ ...base, activeTool: Object.freeze({ name: delta.name, target: delta.target, startedAtMs: nowMs }) }), [...pending, ...text]);
    }
    const unit: ToolUnit = Object.freeze({ kind: 'tool', name: delta.name, target: delta.target, status: delta.status ?? 'error',
      ms: delta.ms ?? Math.max(0, nowMs - (state.activeTool?.startedAtMs ?? nowMs)) });
    return step(Object.freeze({ ...base, activeTool: null }), [...pending, ...text, unit]);
  }
  if (delta.kind === 'reasoning') {
    const reasoning = state.phase === 'answering' ? {} : { phase: 'reasoning' as const, reasoningStartedAtMs: state.reasoningStartedAtMs ?? nowMs };
    return step(Object.freeze({ ...state, ...reasoning, reasoningChars: state.reasoningChars + delta.text.length }), []);
  }
  const summary = state.phase === 'reasoning' ? [reasoningSummary(state, nowMs)] : [];
  if (delta.kind === 'text') {
    const fed = feedSegmenter(state.segmenter, delta.text);
    const units = answerUnits(fed.segments, state.answered);
    return step(Object.freeze({ ...state, phase: 'answering', segmenter: fed.state, answered: state.answered || units.length > 0 }), [...summary, ...units]);
  }
  const flushed = flushSegmenter(state.segmenter);
  const usage = state.usage;
  const footer: FooterUnit = Object.freeze({ kind: 'footer', elapsedMs: Math.max(0, nowMs - state.startedAtMs), promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage ? state.earlierCompletionTokens + usage.completionTokens : null, reasoningTokens: usage?.reasoningTokens ?? null, finish: delta.finish,
    ...(delta.note ? { note: delta.note } : {}), ...(state.context ? { context: state.context } : {}) });
  const done = Object.freeze({ ...state, phase: 'done' as const, segmenter: flushed.state, answered: true, activeTool: null });
  return step(done, [...summary, ...answerUnits(flushed.segments, state.answered)], footer);
}

/** Non-streaming adapter: a complete reply is the text deltas of one turn followed by `done`. */
export function renderCompleteReply(reply: string, startedAtMs: number, nowMs: number, finish: TurnFinish = 'stop'): readonly AssistantUnit[] {
  let state = startAssistantStream(startedAtMs);
  const out: AssistantUnit[] = [];
  for (const delta of [{ kind: 'text', text: reply }, { kind: 'done', finish }] as const) {
    const next = renderAssistantStream(state, delta, nowMs);
    out.push(...next.staticUnits, ...(next.footer ? [next.footer] : []));
    state = next.state;
  }
  return Object.freeze(out);
}
