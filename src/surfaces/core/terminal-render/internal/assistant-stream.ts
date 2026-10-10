import { describeAgentToolCallTarget, summarizeAgentToolResult, trackedChangesOfToolResult, type AgentChatMessage, type ToolResultSummary, type ToolTrackedChanges,
  type TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { EMPTY_KNOWN_SECRETS, EMPTY_RECORD_STREAM, feedRecordStream, finishRecordStream, previewRecordStream, type RecordStreamState, type KnownSecretSnapshot, terminalLineEnd, terminalSafeText } from '#platform/index.js';
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
/** The part of a turn that was running (TL-A): summarizing older messages, the model's answer, or a tool call. */
export type TurnStage = 'compaction' | 'model' | 'tool';
/** `cancelledDuring` (TL-A D5): only a cancelled turn carries it, derived here because the engine's note never reaches the surface on Esc. */
export type FooterUnit = Readonly<{ kind: 'footer'; elapsedMs: number; promptTokens: number | null; completionTokens: number | null;
  reasoningTokens: number | null; finish: TurnFinish; note?: string | null; context?: ContextView; cancelledDuring?: TurnStage }>;
type ToolDelta = Extract<TurnDelta, { kind: 'tool' }>;
/** One finished agent tool call: a single visible line (legacy defect: silent tool rounds). `cleanup` (Astra 2124) only ever
 * arrives on a host shell call; the row shows a suffix for `group-ended`/`unverified` and nothing for `clean` or absent.
 * `summary` (TL-B D2) is set only for a finished read-class call whose own result text matched a known shape. */
export type ToolUnit = Readonly<{ kind: 'tool'; name: string; target: string | null; status: NonNullable<ToolDelta['status']>; ms: number;
  cleanup?: ToolDelta['cleanup']; summary?: ToolResultSummary;
  /** FA-TRACKED-WARN: a full-access shell call deleted or overwrote git-tracked files (counts from its result's trusted leading metadata;
   * the result text names them). */
  trackedChanges?: ToolTrackedChanges;
  /** DENY-WORDING (T2-FOLLOWUP): a `denied` call whose approval the owner declined on the card (`approval.settled` deny for this call), not a
   * policy rule's refusal. */
  declined?: true }>;
/** The running call; `output` is the sanitized tail of its streamed output (T-L4 slice 3c-ii), shown live and never printed after. */
export type ActiveTool = Readonly<{ callId: string; name: string; target: string | null; startedAtMs: number; output: string }>;
/** Characters of a running call's streamed output kept for the live region. */
export const LIVE_OUTPUT_TAIL_CHARS = 2_048;

/** The one terminal sanitizer (platform output): untrusted text loses every escape sequence and control character but newline/tab. */
export { terminalSafeText };
/** The history was compacted during the turn (T-L5b): one visible line, never a silent change. */
export type CompactionUnit = Readonly<{ kind: 'compaction'; replacedMessages: number }>;
export type AssistantUnit = AnswerUnit | ReasoningUnit | ToolUnit | CompactionUnit | FooterUnit;
export type Narration = Readonly<{ tokens: number; approximate: boolean; startedAtMs: number }>;
/** A silent wait of the turn (TL-A D1): the model preparing its answer (measurement, prompt processing) or the service summarizing. */
export type WaitingView = Readonly<{ kind: 'model' | 'compaction'; sinceMs: number }>;
/** Raw reasoning kept for the preview (TL-A D6); it is sanitized only when shown, so a sequence split across deltas is still removed. */
export const REASONING_PREVIEW_CHARS = 2_048;
/** Lines of the reasoning preview under the narration. */
export const REASONING_PREVIEW_LINES = 2;

const EMPTY_TOOL_RECORD = Object.freeze({ stdout: EMPTY_RECORD_STREAM, stderr: EMPTY_RECORD_STREAM });

type Usage = Readonly<{ promptTokens: number; completionTokens: number; reasoningTokens: number | null }>;
export type AssistantStreamState = Readonly<{
  startedAtMs: number;
  known: KnownSecretSnapshot;
  answerRecord: RecordStreamState;
  reasoningRecord: RecordStreamState;
  outputRecord: Readonly<Record<'stdout' | 'stderr', RecordStreamState>>;
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
  /** What a `waiting` phase waits for, and since when (TL-A D1). */
  waitingFor: WaitingView['kind'];
  waitingSinceMs: number;
  /** The current round's reasoning tail, unsanitized and bounded (TL-A D6). */
  reasoningTail: string;
  /** Tool-line display derived from the turn's `message` deltas (TL-B D2), by call id until the call's line is printed: a grep/glob
   * call's pattern-first target, a call's result summary (null when its text matched no known shape). Only these small values are kept. */
  toolLineTargets: ReadonlyMap<string, string>;
  toolLineSummaries: ReadonlyMap<string, ToolResultSummary | null>;
  /** FA-TRACKED-WARN: a finished shell call's tracked-file counts, read from the same result message (only calls that have them). */
  toolLineTracked: ReadonlyMap<string, ToolTrackedChanges>;
  /** Calls whose approval the owner declined this turn (settled `deny`), until their line is printed. */
  toolLineDeclined: ReadonlySet<string>;
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
  /** The silent wait shown in the live region, when nothing else is running (TL-A D1). */
  waiting: WaitingView | null;
  /** Last lines of the reasoning while it streams, sanitized; empty once the answer or a tool call starts (TL-A D6). */
  reasoningPreview: readonly string[];
}>;

/** Roughly four characters per token until the provider reports reasoning usage. */
const approxTokens = (chars: number): number => Math.ceil(chars / 4);

export function startAssistantStream(nowMs: number, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS): AssistantStreamState {
  return Object.freeze({ startedAtMs: nowMs, known, answerRecord: EMPTY_RECORD_STREAM, reasoningRecord: EMPTY_RECORD_STREAM, outputRecord: EMPTY_TOOL_RECORD, phase: 'waiting', segmenter: EMPTY_SEGMENTER, reasoningChars: 0, reasoningStartedAtMs: null, answered: false, usage: null,
    earlierCompletionTokens: 0, activeTool: null, context: null, waitingFor: 'model', waitingSinceMs: nowMs, reasoningTail: '', toolLineTargets: new Map(),
    toolLineSummaries: new Map(), toolLineTracked: new Map(), toolLineDeclined: new Set<string>() });
}

/** The first step of a turn, before any delta: the model is being prepared (TL-A D1). */
export function openAssistantStream(nowMs: number, known?: KnownSecretSnapshot): AssistantStreamStep {
  return step(startAssistantStream(nowMs, known), []);
}

/** The last non-empty lines of reasoning text, sanitized like any untrusted output (TL-A D6). */
export function reasoningPreviewLines(raw: string, lines = REASONING_PREVIEW_LINES): string[] {
  return terminalSafeText(raw).split('\n').map(line => line.replace(/\s+/gu, ' ').trim()).filter(line => line.length > 0).slice(-lines);
}

function waitingOf(state: AssistantStreamState): WaitingView | null {
  return state.phase === 'waiting' && state.activeTool === null ? Object.freeze({ kind: state.waitingFor, sinceMs: state.waitingSinceMs }) : null;
}

/** The part of the turn running now (TL-A D5): a tool call, a summary still being written, or else the model. */
function stageOf(state: AssistantStreamState): TurnStage {
  if (state.activeTool) return 'tool';
  return state.phase === 'waiting' && state.waitingFor === 'compaction' ? 'compaction' : 'model';
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
  const tail = segmenterTail(state.segmenter);
  const pending = previewRecordStream(state.answerRecord, state.known, terminalSafeText);
  const joiner = pending && state.segmenter.partial === '' && state.segmenter.block.length > 0 ? '\n' : '';
  const liveTail = { ...tail, markdown: tail.markdown + joiner + pending };
  const activeTool = state.activeTool ? { ...state.activeTool, output: (state.activeTool.output + previewRecordStream(state.outputRecord.stdout, state.known, terminalSafeText) + previewRecordStream(state.outputRecord.stderr, state.known, terminalSafeText)).slice(-LIVE_OUTPUT_TAIL_CHARS) } : null;
  return Object.freeze({ state, staticUnits: Object.freeze([...staticUnits]), liveTail, narration: narrationOf(state), footer,
    activeTool, waiting: waitingOf(state),
    reasoningPreview: Object.freeze(state.phase === 'reasoning' ? reasoningPreviewLines(state.reasoningTail + previewRecordStream(state.reasoningRecord, state.known, terminalSafeText)) : []) });
}

/** A tool call's display target comes from the model's arguments (a path, pattern or command line): shown sanitized, on one line. */
const safeTarget = (target: string | null) => target === null ? null : terminalSafeText(target).replace(/\s*\n\s*/gu, ' ');

/**
 * TL-B D2 from what the turn already streams (never a wire field, never the C12 approval resource, which stays the engine's target):
 * the assistant message's own call arguments give grep/glob their pattern-first target, the call's result message (always right before
 * `tool.finished`) its summary.
 */
function noteToolLine(state: AssistantStreamState, message: AgentChatMessage): AssistantStreamState {
  if (message.role === 'tool') {
    const tracked = trackedChangesOfToolResult(message.name, message.content);
    return Object.freeze({ ...state, toolLineSummaries: new Map(state.toolLineSummaries).set(message.toolCallId, summarizeAgentToolResult(message.name, message.content)),
      ...(tracked ? { toolLineTracked: new Map(state.toolLineTracked).set(message.toolCallId, tracked) } : {}) });
  }
  if (message.role !== 'assistant' || message.toolCalls.length === 0) return state;
  const targets = new Map(state.toolLineTargets);
  for (const call of message.toolCalls) { const target = describeAgentToolCallTarget(call.name, call.argumentsJson); if (target !== null) targets.set(call.id, target); }
  return Object.freeze({ ...state, toolLineTargets: targets });
}

export function renderAssistantStream(state: AssistantStreamState, delta: TurnDelta, nowMs: number): AssistantStreamStep {
  if (state.phase === 'done') return step(state, []);
  if (delta.kind === 'output') {
    const active = state.activeTool;
    if (!active || active.callId !== delta.callId) return step(state, []);
    const fed = feedRecordStream(state.outputRecord[delta.stream], delta.text, state.known, terminalSafeText, terminalLineEnd);
    const output = `${active.output}${fed.text}`.slice(-LIVE_OUTPUT_TAIL_CHARS);
    return step(Object.freeze({ ...state, outputRecord: Object.freeze({ ...state.outputRecord, [delta.stream]: fed.state }), activeTool: Object.freeze({ ...active, output }) }), []);
  }
  if (delta.kind === 'message') return step(noteToolLine(state, delta.message), []);
  // DENY-WORDING: the card's settlement says who refused a call; the line then says "you declined", not a policy refusal.
  if (delta.kind === 'approval') return step(delta.phase === 'settled' && delta.outcome === 'deny'
    ? Object.freeze({ ...state, toolLineDeclined: new Set(state.toolLineDeclined).add(delta.callId) }) : state, []);
  // The summary landed: the round is prepared again, counted from now.
  if (delta.kind === 'compacted') {
    return step(Object.freeze({ ...state, waitingFor: 'model' as const, waitingSinceMs: nowMs }), [Object.freeze({ kind: 'compaction' as const, replacedMessages: delta.replacedMessages })]);
  }
  if (delta.kind === 'context') {
    const view = Object.freeze({ promptTokens: delta.promptTokens, windowTokens: delta.windowTokens, quality: delta.quality });
    // A measurement after which the service summarizes starts that wait; a plain one is part of preparing the round.
    return step(Object.freeze({ ...state, context: view, ...(delta.compacting ? { waitingFor: 'compaction' as const, waitingSinceMs: nowMs } : {}) }), []);
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
    const settled = feedSegmenter(state.segmenter, finishRecordStream(state.answerRecord, state.known, terminalSafeText));
    const flushed = flushSegmenter(settled.state);
    const segments = [...settled.segments, ...flushed.segments];
    const text = answerUnits(segments, state.answered);
    const base = { ...state, phase: 'waiting' as const, segmenter: flushed.state, answerRecord: EMPTY_RECORD_STREAM, reasoningRecord: EMPTY_RECORD_STREAM, outputRecord: EMPTY_TOOL_RECORD, reasoningChars: 0, reasoningStartedAtMs: null, reasoningTail: '',
      answered: state.answered || text.length > 0, waitingFor: 'model' as const, waitingSinceMs: nowMs };
    const target = safeTarget(state.toolLineTargets.get(delta.callId) ?? delta.target);
    if (delta.phase === 'started') {
      return step(Object.freeze({ ...base, activeTool: Object.freeze({ callId: delta.callId, name: delta.name, target, startedAtMs: nowMs, output: '' }) }),
        [...pending, ...text]);
    }
    // The engine sends every call's result message before `tool.finished`; without one there is nothing to summarize.
    const summary = state.toolLineSummaries.get(delta.callId) ?? null, tracked = state.toolLineTracked.get(delta.callId);
    const unit: ToolUnit = Object.freeze({ kind: 'tool', name: delta.name, target, status: delta.status ?? 'error',
      ms: delta.ms ?? Math.max(0, nowMs - (state.activeTool?.startedAtMs ?? nowMs)),
      ...(delta.cleanup !== undefined ? { cleanup: delta.cleanup } : {}), ...(summary !== null ? { summary } : {}),
      ...(tracked ? { trackedChanges: tracked } : {}), ...(delta.status === 'denied' && state.toolLineDeclined.has(delta.callId) ? { declined: true as const } : {}) });
    const targets = new Map(state.toolLineTargets), summaries = new Map(state.toolLineSummaries), trackedLines = new Map(state.toolLineTracked), declined = new Set(state.toolLineDeclined);
    targets.delete(delta.callId); summaries.delete(delta.callId); trackedLines.delete(delta.callId); declined.delete(delta.callId);
    return step(Object.freeze({ ...base, activeTool: null, toolLineTargets: targets, toolLineSummaries: summaries, toolLineTracked: trackedLines, toolLineDeclined: declined }),
      [...pending, ...text, unit]);
  }
  if (delta.kind === 'reasoning') {
    const reasoning = state.phase === 'answering' ? {} : { phase: 'reasoning' as const, reasoningStartedAtMs: state.reasoningStartedAtMs ?? nowMs };
    const fed = feedRecordStream(state.reasoningRecord, delta.text, state.known, terminalSafeText, terminalLineEnd);
    return step(Object.freeze({ ...state, ...reasoning, reasoningRecord: fed.state, reasoningChars: state.reasoningChars + delta.text.length,
      reasoningTail: `${state.reasoningTail}${fed.text}`.slice(-REASONING_PREVIEW_CHARS) }), []);
  }
  const summary = state.phase === 'reasoning' ? [reasoningSummary(state, nowMs)] : [];
  if (delta.kind === 'text') {
    // Model text is untrusted too (it may quote files or command output): it is sanitized before it reaches the renderer.
    const record = feedRecordStream(state.answerRecord, delta.text, state.known, terminalSafeText, terminalLineEnd);
    const fed = feedSegmenter(state.segmenter, record.text);
    const units = answerUnits(fed.segments, state.answered);
    return step(Object.freeze({ ...state, phase: 'answering', answerRecord: record.state, reasoningRecord: EMPTY_RECORD_STREAM, segmenter: fed.state, answered: state.answered || units.length > 0 }), [...summary, ...units]);
  }
  const settled = feedSegmenter(state.segmenter, finishRecordStream(state.answerRecord, state.known, terminalSafeText));
  const flushed = flushSegmenter(settled.state);
  const usage = state.usage;
  const footer: FooterUnit = Object.freeze({ kind: 'footer', elapsedMs: Math.max(0, nowMs - state.startedAtMs), promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage ? state.earlierCompletionTokens + usage.completionTokens : null, reasoningTokens: usage?.reasoningTokens ?? null, finish: delta.finish,
    ...(delta.note ? { note: delta.note } : {}), ...(state.context ? { context: state.context } : {}),
    ...(delta.finish === 'cancelled' ? { cancelledDuring: stageOf(state) } : {}) });
  const done = Object.freeze({ ...state, phase: 'done' as const, answerRecord: EMPTY_RECORD_STREAM, reasoningRecord: EMPTY_RECORD_STREAM, outputRecord: EMPTY_TOOL_RECORD, segmenter: flushed.state, answered: true, activeTool: null });
  return step(done, [...summary, ...answerUnits([...settled.segments, ...flushed.segments], state.answered)], footer);
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
