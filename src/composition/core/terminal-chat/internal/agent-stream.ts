import { randomUUID } from 'node:crypto';
import type { AgentTurnMessage, AgentTurnStreamEvent, ChatTurnCancellation, ChatTurnCommand, ChatTurnResult } from '#domain/index.js';
import type { AgentTurnAdmission } from '#engine/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import type { PanelTurnBinding, TurnDelta } from '#surfaces/index.js';
import { terminalCompactionExpected } from './turn-phase.js';

/** Runtime `chatTurn` / `cancelChatTurn` (v12); the shipped executable wires the local runtime client. */
export interface TerminalAgentTurnPorts {
  chatTurn(projectRoot: string, command: ChatTurnCommand, onEvent: (event: AgentTurnStreamEvent) => void, options: ConfigLoadOptions,
    signal?: AbortSignal): Promise<ChatTurnResult>;
  cancelChatTurn(projectRoot: string, command: ChatTurnCancellation, options: ConfigLoadOptions): Promise<unknown>;
  /** Local preflight; returns service admission for the summarizing phase when available. */
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
  /** MODES-3 (v17): the terminal was launched in full access; the service admits it only on the company grant. */
  readonly fullAccess?: true;
  readonly onTurnBound?: (binding: PanelTurnBinding) => void;
}
type Outcome = { readonly result: ChatTurnResult } | { readonly error: unknown };

/** Streams the service-owned turn/history and one final done; abort or early exit cancels the same command exactly once. */
export async function* streamTerminalAgentTurn(input: TerminalAgentTurnInput, ports: TerminalAgentTurnPorts): AsyncGenerator<TurnDelta> {
  input.signal?.throwIfAborted();
  const admission = await ports.preflight?.(input.projectRoot, input.options) ?? null;
  input.signal?.throwIfAborted();
  const command: ChatTurnCommand = { schemaVersion: 1, scopeId: input.scopeId, turnId: randomUUID(), messages: [...input.messages],
    ...(input.reasoning === 'off' ? { reasoning: 'off' as const } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.fullAccess === true ? { fullAccess: true as const } : {}) };
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => cancellation ??= ports.cancelChatTurn(input.projectRoot, { schemaVersion: 1, scopeId: command.scopeId, turnId: command.turnId }, input.options)
    .catch(() => undefined);
  const local = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, local.signal]) : local.signal;
  // Preserve engine targets; the renderer derives display targets from message events.
  const queue: TurnDelta[] = [], targets = new Map<string, string | null>();
  let outcome: Outcome | null = null, wake: (() => void) | null = null, roundText = '';
  // Follow measured history and mark at most one compaction per round using the service admission.
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
  input.onTurnBound?.({ scopeId: command.scopeId, sessionId: command.sessionId ?? null, turnId: command.turnId, phase: 'command-generated' });
  signal.throwIfAborted();
  signal.addEventListener('abort', onAbort, { once: true });
  let finished = false;
  try {
    void ports.chatTurn(input.projectRoot, command, onEvent, input.options, signal)
      .then(result => { outcome = { result }; }, (error: unknown) => { outcome = { error }; }).finally(notify);
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
    if (result.turnId !== command.turnId) throw ErrorRegistry.createError('AGENT_TURN_INVALID');
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
    case 'approval.requested': return { kind: 'approval', phase: 'requested', callId: event.callId, approvalId: event.approvalId, revision: event.revision, summary: event.summary, preview: event.preview,
      expiresAt: event.expiresAt, ...(event.decisionCapability ? { decisionCapability: event.decisionCapability } : {}), ...(event.risk !== undefined ? { risk: event.risk } : {}), ...(event.requiredAssurance ? { requiredAssurance: event.requiredAssurance } : {}) };
    case 'approval.settled': return { kind: 'approval', phase: 'settled', callId: event.callId, approvalId: event.approvalId, outcome: event.outcome };
    case 'tool.output': return { kind: 'output', callId: event.callId, stream: event.stream, text: event.text };
    case 'tool.started': return { kind: 'tool', phase: 'started', callId: event.callId, name: event.name, target: event.target, status: null, ms: null };
    case 'tool.finished': return { kind: 'tool', phase: 'finished', callId: event.callId, name: event.name, target: targets.get(event.callId) ?? null,
      status: event.status, ms: event.ms, ...(event.cleanup !== undefined ? { cleanup: event.cleanup } : {}) };
  }
}
