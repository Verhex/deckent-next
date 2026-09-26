import { randomUUID } from 'node:crypto';
import type { AgentTurnMessage, AgentTurnStreamEvent, ChatTurnCancellation, ChatTurnCommand, ChatTurnResult } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { TurnDelta } from '#surfaces/index.js';

/** Runtime `chatTurn` / `cancelChatTurn` (v12); the shipped executable wires the local runtime client. */
export interface TerminalAgentTurnPorts {
  chatTurn(projectRoot: string, command: ChatTurnCommand, onEvent: (event: AgentTurnStreamEvent) => void, options: ConfigLoadOptions,
    signal?: AbortSignal): Promise<ChatTurnResult>;
  cancelChatTurn(projectRoot: string, command: ChatTurnCancellation, options: ConfigLoadOptions): Promise<unknown>;
  /** Local configuration check before contacting the service (a missing `terminal.chat` is named, not a transport error). */
  preflight?(projectRoot: string, options: ConfigLoadOptions): Promise<void>;
}
export interface TerminalAgentTurnInput {
  readonly projectRoot: string;
  readonly scopeId: string;
  readonly messages: readonly AgentTurnMessage[];
  readonly options: ConfigLoadOptions;
  readonly signal?: AbortSignal;
}
type Outcome = { readonly result: ChatTurnResult } | { readonly error: unknown };

/**
 * One terminal agent turn (T-L3) as the surface's `TurnDelta` stream: the service runs the loop; tool calls arrive as one started and
 * one finished line; `message` deltas carry the history the next turn continues from; exactly one `done` ends it, with the engine's
 * closure note. A replayed turn shows its stored answer. Aborting (or leaving the loop early) cancels this exact turn at once.
 */
export async function* streamTerminalAgentTurn(input: TerminalAgentTurnInput, ports: TerminalAgentTurnPorts): AsyncGenerator<TurnDelta> {
  await ports.preflight?.(input.projectRoot, input.options);
  const command: ChatTurnCommand = { schemaVersion: 1, scopeId: input.scopeId, turnId: randomUUID(), messages: [...input.messages] };
  const cancel = () => ports.cancelChatTurn(input.projectRoot, { schemaVersion: 1, scopeId: command.scopeId, turnId: command.turnId }, input.options)
    .catch(() => undefined);
  const local = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, local.signal]) : local.signal;
  const queue: TurnDelta[] = [], targets = new Map<string, string | null>();
  let outcome: Outcome | null = null, wake: (() => void) | null = null, roundText = '';
  const notify = () => { const resume = wake; wake = null; resume?.(); };
  const onEvent = (event: AgentTurnStreamEvent) => {
    if (event.kind === 'text') roundText += event.text;
    if (event.kind === 'tool.started') { roundText = ''; targets.set(event.callId, event.target); }
    queue.push(toDelta(event, targets)); notify();
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

function toDelta(event: AgentTurnStreamEvent, targets: ReadonlyMap<string, string | null>): TurnDelta {
  switch (event.kind) {
    case 'text': case 'reasoning': return { kind: event.kind, text: event.text };
    case 'usage': return { kind: 'usage', promptTokens: event.promptTokens, completionTokens: event.completionTokens, reasoningTokens: null };
    case 'message': return { kind: 'message', message: event.message };
    case 'context': return { kind: 'context', promptTokens: event.promptTokens, windowTokens: event.windowTokens, quality: event.quality };
    case 'compacted': return { kind: 'compacted', messages: event.messages, replacedMessages: event.replacedMessages };
    case 'approval.requested': return { kind: 'approval', phase: 'requested', callId: event.callId, approvalId: event.approvalId, revision: event.revision,
      summary: event.summary, preview: event.preview, expiresAt: event.expiresAt };
    case 'approval.settled': return { kind: 'approval', phase: 'settled', callId: event.callId, approvalId: event.approvalId, outcome: event.outcome };
    case 'tool.output': return { kind: 'output', callId: event.callId, stream: event.stream, text: event.text };
    case 'tool.started': return { kind: 'tool', phase: 'started', callId: event.callId, name: event.name, target: event.target, status: null, ms: null };
    case 'tool.finished': return { kind: 'tool', phase: 'finished', callId: event.callId, name: event.name, target: targets.get(event.callId) ?? null,
      status: event.status, ms: event.ms };
  }
}
