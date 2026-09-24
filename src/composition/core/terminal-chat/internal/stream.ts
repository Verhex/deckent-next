import type { ModelInvocationCancellationCommand, ModelInvocationCommand, ModelInvocationDelta, ModelInvocationDeltaSink } from '#domain/index.js';
import type { ModelInvocationResult } from '#engine/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import type { TurnDelta } from '#surfaces/index.js';
import { openAiChatMessageFromInvocation, openAiChatUsageFromInvocation } from './extract-text.js';
import { prepareTerminalChatCommand, terminalChatCancellation, type TerminalChatTurnInput } from './turn.js';

/** Streamed governed invocation (runtime `invokeModelStream`) and the same governed cancellation as the plain turn. */
export interface TerminalChatStreamPorts {
  invokeStream(projectRoot: string, command: ModelInvocationCommand, onDelta: ModelInvocationDeltaSink, options: ConfigLoadOptions,
    signal?: AbortSignal): Promise<ModelInvocationResult>;
  cancel(projectRoot: string, command: ModelInvocationCancellationCommand, options: ConfigLoadOptions): Promise<unknown>;
}

type Outcome = { readonly result: ModelInvocationResult } | { readonly error: unknown };
const turnDelta = (delta: ModelInvocationDelta): TurnDelta => ({ kind: delta.kind, text: delta.text });

/**
 * One streamed chat turn is one governed model invocation (S-STREAM): the same scope, policy, activation, reservation
 * and settlement as `completeTerminalChatTurn`. Deltas are yielded in wire order as presentation; the governed result
 * then completes the answer (a replay or an exhausted delta budget shows only a prefix) and exactly one `done` ends it.
 * Aborting (or leaving the loop early) disconnects and sends the turn's governed cancellation, as the plain turn does.
 */
export async function* streamTerminalChatTurn(input: TerminalChatTurnInput, ports: TerminalChatStreamPorts): AsyncGenerator<TurnDelta> {
  const { command } = await prepareTerminalChatCommand(input, true);
  const local = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, local.signal]) : local.signal;
  const queue: TurnDelta[] = [];
  let outcome: Outcome | null = null, wake: (() => void) | null = null, shownText = '', shownReasoning = '';
  const notify = () => { const resume = wake; wake = null; resume?.(); };
  void ports.invokeStream(input.projectRoot, command, delta => {
    if (delta.kind === 'text') shownText += delta.text; else shownReasoning += delta.text;
    queue.push(turnDelta(delta)); notify();
  }, input.options, signal).then(result => { outcome = { result }; }, (error: unknown) => { outcome = { error }; }).finally(notify);
  let finished = false;
  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (outcome) break;
      await new Promise<void>(resolve => { wake = resolve; if (queue.length > 0 || outcome) notify(); });
    }
    const settled = outcome as Outcome;
    if ('error' in settled) {
      if (!signal.aborted) throw settled.error;
      await ports.cancel(input.projectRoot, terminalChatCancellation(command), input.options).catch(() => undefined);
      finished = true; yield { kind: 'done', finish: 'cancelled' }; return;
    }
    finished = true;
    yield* settle(settled.result, shownText, shownReasoning, input.signal);
  } finally {
    if (!finished && !outcome) {
      // The consumer stopped early: disconnect and request cancellation of this exact invocation.
      local.abort();
      await ports.cancel(input.projectRoot, terminalChatCancellation(command), input.options).catch(() => undefined);
    }
  }
}

function* settle(result: ModelInvocationResult, shownText: string, shownReasoning: string, signal?: AbortSignal): Generator<TurnDelta> {
  const state = result.receipt.outcome?.state ?? 'pending';
  if (state === 'not-sent') { yield { kind: 'done', finish: 'cancelled' }; return; }
  const message = state === 'responded' ? openAiChatMessageFromInvocation(result) : null;
  if (!message) {
    if (signal?.aborted) { yield { kind: 'done', finish: 'cancelled' }; return; }
    throw ErrorRegistry.createError('TERMINAL_CHAT_INVOCATION_FAILED', { params: { state } });
  }
  // What was shown is always a prefix of the governed result; anything else is an integrity failure, never merged.
  if (!message.reasoning.startsWith(shownReasoning) || !message.content.startsWith(shownText)) {
    throw ErrorRegistry.createError('TERMINAL_CHAT_STREAM_MISMATCH');
  }
  if (message.reasoning.length > shownReasoning.length) yield { kind: 'reasoning', text: message.reasoning.slice(shownReasoning.length) };
  if (message.content.length > shownText.length) yield { kind: 'text', text: message.content.slice(shownText.length) };
  const usage = openAiChatUsageFromInvocation(result);
  if (usage) yield { kind: 'usage', ...usage };
  if (message.finish === 'length') { yield { kind: 'done', finish: 'length' }; return; }
  if (message.finish !== 'stop') { yield { kind: 'done', finish: 'error' }; return; }
  if (!message.content.trim()) throw ErrorRegistry.createError('TERMINAL_CHAT_EMPTY');
  yield { kind: 'done', finish: 'stop' };
}
