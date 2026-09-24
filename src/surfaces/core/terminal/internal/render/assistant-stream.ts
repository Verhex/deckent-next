import type { TurnDelta } from '../turn-stream.js';
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
export type FooterUnit = Readonly<{ kind: 'footer'; elapsedMs: number; promptTokens: number | null; completionTokens: number | null;
  reasoningTokens: number | null; finish: TurnFinish }>;
export type AssistantUnit = AnswerUnit | ReasoningUnit | FooterUnit;
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
}>;
export type AssistantStreamStep = Readonly<{
  state: AssistantStreamState;
  /** Units finished by this delta only (never cumulative), in print order. */
  staticUnits: readonly AssistantUnit[];
  liveTail: LiveTail;
  narration: Narration | null;
  footer: FooterUnit | null;
}>;

/** Roughly four characters per token until the provider reports reasoning usage. */
const approxTokens = (chars: number): number => Math.ceil(chars / 4);

export function startAssistantStream(nowMs: number): AssistantStreamState {
  return Object.freeze({ startedAtMs: nowMs, phase: 'waiting', segmenter: EMPTY_SEGMENTER, reasoningChars: 0, reasoningStartedAtMs: null, answered: false, usage: null });
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
  return Object.freeze({ state, staticUnits: Object.freeze([...staticUnits]), liveTail: segmenterTail(state.segmenter), narration: narrationOf(state), footer });
}

export function renderAssistantStream(state: AssistantStreamState, delta: TurnDelta, nowMs: number): AssistantStreamStep {
  if (state.phase === 'done') return step(state, []);
  if (delta.kind === 'usage') {
    return step(Object.freeze({ ...state, usage: Object.freeze({ promptTokens: delta.promptTokens, completionTokens: delta.completionTokens, reasoningTokens: delta.reasoningTokens }) }), []);
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
    completionTokens: usage?.completionTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null, finish: delta.finish });
  const done = Object.freeze({ ...state, phase: 'done' as const, segmenter: flushed.state, answered: true });
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
