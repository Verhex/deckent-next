import type { ModelReference, PermissionModeChange, PermissionModeCommand, PermissionModeQuery, PermissionModeView } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { AgentChatMessage, TurnDelta, WorklineMentionAttachment } from '#surfaces/core/terminal/index.js';

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
 * Streamed agent turn (runtime `chatTurn`, T-L3): deltas in order (tool lines and history messages included), exactly one `done`
 * last. Aborting the signal or leaving the loop early cancels the turn.
 */
export type TerminalChatStreamHandler = (
  root: string,
  input: Readonly<{ scopeId: string; messages: readonly AgentChatMessage[] }>,
  options: ConfigLoadOptions,
  signal?: AbortSignal,
) => AsyncIterable<TurnDelta>;

export type TerminalChatPlanHandler = (root: string, options: ConfigLoadOptions) => Promise<TerminalChatPlanView>;

/** Composer `@file` candidates (runtime v15 `findWorkspaceFiles`): paths the service's scoped read port lists for the query. */
export type TerminalMentionFindHandler = (root: string, input: Readonly<{ scopeId: string; query: string }>, options: ConfigLoadOptions,
  signal?: AbortSignal) => Promise<readonly string[]>;
/** Attaches a line's `@path` mentions through the service (v15 `attachWorkspaceFile`): the message to send and one note per path. */
export type TerminalMentionAttachHandler = (root: string, input: Readonly<{ scopeId: string; text: string; paths: readonly string[] }>,
  options: ConfigLoadOptions, signal?: AbortSignal) => Promise<WorklineMentionAttachment>;
/** The caller's own permission mode (runtime v15 `inspectPermissionMode`, T-L4 slice 4c). */
export type TerminalPermissionModeInspectHandler = (root: string, input: PermissionModeQuery, options: ConfigLoadOptions, signal?: AbortSignal) => Promise<PermissionModeView>;
/** Sets the caller's own mode (v15 `setPermissionMode`), conditional on the revision read; the service writes, never the terminal. */
export type TerminalPermissionModeSetHandler = (root: string, input: PermissionModeCommand, options: ConfigLoadOptions) => Promise<PermissionModeChange>;
