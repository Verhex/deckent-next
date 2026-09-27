import type { AgentContextQuality, AgentToolApprovalSettlement, AgentToolCallStatus, AgentTurnMessage, AgentTurnStreamEvent } from '#domain/index.js';

/** `tool.finished`'s optional `cleanup` (Astra 2124), derived from the agent-turn event rather than importing the agent-tool
 * module directly (`terminal-kit`'s declared dependency is `agent-turn`; `AgentToolCleanup` itself is declared in `agent-tool`). */
type FinishedToolCleanup = Extract<AgentTurnStreamEvent, { readonly kind: 'tool.finished' }>['cleanup'];

/** One chat message as sent to the model for a plain (tool-less) turn. */
export type ChatTurnMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;
/** One message of an agent turn's history: assistant tool calls and tool results included (T-L3). */
export type AgentChatMessage = AgentTurnMessage;

/** A finished read-class tool call's short result summary (TL-B D2), derived by composition from the call's own
 * recorded result text (never a protocol addition — `AgentTurnStreamEvent` carries no such field). */
export type ToolResultSummary =
  | { readonly kind: 'lines'; readonly shown: number; readonly total: number; readonly more: boolean }
  | { readonly kind: 'headings'; readonly shown: number; readonly total: number; readonly more: boolean }
  | { readonly kind: 'matches'; readonly count: number; readonly more: boolean }
  | { readonly kind: 'entries'; readonly count: number };

/**
 * Surface-facing streaming turn contract (S-STREAM, Jev 1370d942). The producer (composition over the runtime protocol)
 * yields deltas in order and ends with exactly one `done`. `reasoning` carries model thinking text for a collapsed,
 * narrated display; it is never treated as the answer. `usage` may arrive once, before `done`. Cancellation is the
 * caller's AbortSignal; a cancelled or failed stream ends with `done` (`cancelled` / `error`) or throws a typed error.
 * Deltas are presentation data: settlement, spend and invocation truth stay with the governed invocation record.
 */
export type TurnDelta =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'usage'; readonly promptTokens: number; readonly completionTokens: number; readonly reasoningTokens: number | null }
  /** An agent tool call: `started` with its display target, then `finished` with its typed status and duration (T-L3). `cleanup`
   * (Astra 2124) only ever arrives on a finished host shell call; every other call leaves it undefined. `summary` (TL-B D2)
   * only ever arrives on a finished read-class call whose result text matched a known shape; every other call leaves it
   * undefined (never a bare status word's replacement — the status line stays as it was). */
  | { readonly kind: 'tool'; readonly phase: 'started' | 'finished'; readonly callId: string; readonly name: string; readonly target: string | null;
    readonly status: AgentToolCallStatus | null; readonly ms: number | null; readonly cleanup?: FinishedToolCleanup; readonly summary?: ToolResultSummary }
  /** A message the turn appended: the caller's history continues from exactly these (not rendered). */
  | { readonly kind: 'message'; readonly message: AgentChatMessage }
  /** The round's measured prompt against the window (T-L5); `upper-bound` is shown as approximate. `compacting` (TL-A, derived on the
   * client from this measurement and the engine's own rule, not a wire field): the service summarizes older messages before the round. */
  | { readonly kind: 'context'; readonly promptTokens: number; readonly windowTokens: number | null; readonly quality: AgentContextQuality;
    readonly compacting?: boolean }
  /** The history was compacted (T-L5b): `messages` replaces every non-system message of the caller's history. */
  | { readonly kind: 'compacted'; readonly messages: readonly AgentChatMessage[]; readonly replacedMessages: number }
  /** A tool call waits for the owner's decision (T-L4): the surface shows a decision card; the approval binds the exact call. */
  | { readonly kind: 'approval'; readonly phase: 'requested'; readonly callId: string; readonly approvalId: string; readonly revision: number;
    readonly summary: string; readonly preview: string; readonly expiresAt: number }
  | { readonly kind: 'approval'; readonly phase: 'settled'; readonly callId: string; readonly approvalId: string;
    readonly outcome: AgentToolApprovalSettlement }
  /** Streamed output of a running call (shell): presentation only. */
  | { readonly kind: 'output'; readonly callId: string; readonly stream: 'stdout' | 'stderr'; readonly text: string }
  /** `note` is the engine's deterministic closure text when the turn ended without a model answer. */
  | { readonly kind: 'done'; readonly finish: 'stop' | 'length' | 'cancelled' | 'error'; readonly note?: string | null };

export type WorklineStreamTurn = (messages: readonly AgentChatMessage[], signal: AbortSignal) => AsyncIterable<TurnDelta>;

/** Collects a stream into the final answer text (for line mode and tests); reasoning is excluded. */
export async function collectTurnText(stream: AsyncIterable<TurnDelta>): Promise<{ readonly text: string; readonly finish: Extract<TurnDelta, { kind: 'done' }>['finish'] | null }> {
  let text = '', finish: Extract<TurnDelta, { kind: 'done' }>['finish'] | null = null;
  for await (const delta of stream) {
    if (delta.kind === 'text') text += delta.text;
    else if (delta.kind === 'done') finish = delta.finish;
  }
  return { text, finish };
}
