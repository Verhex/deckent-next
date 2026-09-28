import { randomUUID } from 'node:crypto';
import type { AgentTurnMessage, AgentTurnStreamEvent, ChatTurnCancellation, ChatTurnCommand, ChatTurnResult } from '#domain/index.js';
import type { AgentTurnAdmission } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { TurnDelta } from '#surfaces/index.js';
import { terminalCompactionExpected } from './turn-phase.js';

/** Runtime `chatTurn` / `cancelChatTurn` (v12); the shipped executable wires the local runtime client. */
export interface TerminalAgentTurnPorts {
  chatTurn(projectRoot: string, command: ChatTurnCommand, onEvent: (event: AgentTurnStreamEvent) => void, options: ConfigLoadOptions,
    signal?: AbortSignal): Promise<ChatTurnResult>;
  cancelChatTurn(projectRoot: string, command: ChatTurnCancellation, options: ConfigLoadOptions): Promise<unknown>;
  /** Local configuration check before contacting the service (a missing `terminal.chat` is named, not a transport error); it may
   * return the service's admission from the same configuration, which lets the stream name the summarizing phase (TL-A). */
  preflight?(projectRoot: string, options: ConfigLoadOptions): Promise<AgentTurnAdmission | void>;
}
export interface TerminalAgentTurnInput {
  readonly projectRoot: string;
  readonly scopeId: string;
  readonly messages: readonly AgentTurnMessage[];
  readonly options: ConfigLoadOptions;
  readonly signal?: AbortSignal;
  /** `/reasoning off` (protocol v16): the turn asks the service to run every round without model thinking; absent otherwise. */
  readonly reasoning?: 'off';
  /** The terminal conversation (protocol v16, SCR-A): the service keeps its scratch area across the conversation's turns. */
  readonly sessionId?: string;
}
type Outcome = { readonly result: ChatTurnResult } | { readonly error: unknown };

/**
 * One terminal agent turn (T-L3) as the surface's `TurnDelta` stream: the service runs the loop; tool calls arrive as one started and
 * one finished line; `message` deltas carry the history the next turn continues from; exactly one `done` ends it, with the engine's
 * closure note. A replayed turn shows its stored answer. Aborting (or leaving the loop early) cancels this exact turn at once.
 */
export async function* streamTerminalAgentTurn(input: TerminalAgentTurnInput, ports: TerminalAgentTurnPorts): AsyncGenerator<TurnDelta> {
  const admission = await ports.preflight?.(input.projectRoot, input.options) ?? null;
  const command: ChatTurnCommand = { schemaVersion: 1, scopeId: input.scopeId, turnId: randomUUID(), messages: [...input.messages],
    ...(input.reasoning === 'off' ? { reasoning: 'off' as const } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
  const cancel = () => ports.cancelChatTurn(input.projectRoot, { schemaVersion: 1, scopeId: command.scopeId, turnId: command.turnId }, input.options)
    .catch(() => undefined);
  const local = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, local.signal]) : local.signal;
  // The engine's target only; the terminal derives its tool-line display (TL-B D2) from the `message` deltas itself, so composition
  // never loads the surface layer at runtime (COMPOSITION-BUDGET follow-up).
  const queue: TurnDelta[] = [], targets = new Map<string, string | null>();
  let outcome: Outcome | null = null, wake: (() => void) | null = null, roundText = '';
  // The history the service measures (TL-A): the sent messages, each appended message, a compaction's replacement. Protocol v15 has no
  // phase event, so a measurement after which the engine's rule compacts is marked `compacting` here; one round compacts at most once.
  const history: AgentTurnMessage[] = [...input.messages];
  let round = 0, compactedRound = 0;
  const notify = () => { const resume = wake; wake = null; resume?.(); };
  const onEvent = (event: AgentTurnStreamEvent) => {
    if (event.kind === 'text') roundText += event.text;
    if (event.kind === 'tool.started') { roundText = ''; targets.set(event.callId, event.target); }
    if (event.kind === 'message') history.push(event.message);
    if (event.kind === 'compacted') { history.splice(0, history.length, ...(history[0]?.role === 'system' ? [history[0]] : []), ...event.messages); compactedRound = round; }
    if (event.kind === 'context') round = event.round;
    const compacting = event.kind === 'context' && admission !== null && event.round !== compactedRound && terminalCompactionExpected(history, event, admission);
    queue.push(toDelta(event, targets, compacting)); notify();
  };
  // Cancel at once when the caller aborts; the transport disconnect alone is only seen at the service's next write.
  const onAbort = () => { void cancel(); };
  signal.addEventListener('abort', onAbort, { once: true });
  void ports.chatTurn(input.projectRoot, command, onEvent, input.options, signal)
    .then(result => { outcome = { result }; }, (error: unknown) => { outcome = { error }; }).finally(notify);
  let finished = false;
  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (outcome) break;
      await new Promise<void>(resolve => { wake = resolve; if (queue.length > 0 || outcome) notify(); });
    }
    const settled = outcome as Outcome;
    finished = true;
    if ('error' in settled) {
      if (!signal.aborted) throw settled.error;
      yield { kind: 'done', finish: 'cancelled', note: null }; return;
    }
    const { result } = settled;
    // The answer came as text events; a replay or a lost tail is completed from the bounded result, never merged when it differs.
    if (result.answer !== null && result.answer.startsWith(roundText) && result.answer.length > roundText.length) {
      yield { kind: 'text', text: result.answer.slice(roundText.length) };
    }
    yield { kind: 'done', finish: result.finish, note: result.note };
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!finished && !outcome) { local.abort(); await cancel(); }
  }
}

function toDelta(event: AgentTurnStreamEvent, targets: ReadonlyMap<string, string | null>, compacting: boolean): TurnDelta {
  switch (event.kind) {
    case 'text': case 'reasoning': return { kind: event.kind, text: event.text };
    case 'usage': return { kind: 'usage', promptTokens: event.promptTokens, completionTokens: event.completionTokens, reasoningTokens: null };
    case 'message': return { kind: 'message', message: event.message };
    case 'context': return { kind: 'context', promptTokens: event.promptTokens, windowTokens: event.windowTokens, quality: event.quality,
      ...(compacting ? { compacting } : {}) };
    case 'compacted': return { kind: 'compacted', messages: event.messages, replacedMessages: event.replacedMessages };
    case 'approval.requested': return { kind: 'approval', phase: 'requested', callId: event.callId, approvalId: event.approvalId, revision: event.revision,
      summary: event.summary, preview: event.preview, expiresAt: event.expiresAt };
    case 'approval.settled': return { kind: 'approval', phase: 'settled', callId: event.callId, approvalId: event.approvalId, outcome: event.outcome };
    case 'tool.output': return { kind: 'output', callId: event.callId, stream: event.stream, text: event.text };
    case 'tool.started': return { kind: 'tool', phase: 'started', callId: event.callId, name: event.name, target: event.target, status: null, ms: null };
    case 'tool.finished': return { kind: 'tool', phase: 'finished', callId: event.callId, name: event.name, target: targets.get(event.callId) ?? null,
      status: event.status, ms: event.ms, ...(event.cleanup !== undefined ? { cleanup: event.cleanup } : {}) };
  }
}
