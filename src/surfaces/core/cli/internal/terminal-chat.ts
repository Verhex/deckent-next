import type { ModelReference } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';

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

export type TerminalChatPlanHandler = (root: string, options: ConfigLoadOptions) => Promise<TerminalChatPlanView>;
