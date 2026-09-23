import type { ModelReference } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { TurnDelta } from '#surfaces/core/terminal/index.js';

export type TerminalChatMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;
export type TerminalChatPlanView = Readonly<{
  schemaVersion: 1;
  status: 'ready' | 'not-configured' | 'model-not-declared';
  reference: ModelReference | null;
  catalogRevision: string | null;
  maxCompletionTokens: number | null;
  historyMessages: number | null;
}>;

/** One governed model invocation per turn in the caller's scope; abort requests cancellation of that invocation. */
export type TerminalChatTurnHandler = (
  root: string,
  input: Readonly<{ scopeId: string; messages: readonly TerminalChatMessage[] }>,
  options: ConfigLoadOptions,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * Streamed form of the same governed turn (runtime `invokeModelStream`): deltas in order, exactly one `done` last.
 * Aborting the signal or leaving the loop early disconnects and requests cancellation of that invocation.
 */
export type TerminalChatStreamHandler = (
  root: string,
  input: Readonly<{ scopeId: string; messages: readonly TerminalChatMessage[] }>,
  options: ConfigLoadOptions,
  signal?: AbortSignal,
) => AsyncIterable<TurnDelta>;

export type TerminalChatPlanHandler = (root: string, options: ConfigLoadOptions) => Promise<TerminalChatPlanView>;
