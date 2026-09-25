import type { AgentContextQuality, AgentToolCallStatus, AgentTurnMessage } from '#domain/index.js';

/** One chat message as sent to the model for a plain (tool-less) turn. */
export type ChatTurnMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;
/** One message of an agent turn's history: assistant tool calls and tool results included (T-L3). */
export type AgentChatMessage = AgentTurnMessage;

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
  /** An agent tool call: `started` with its display target, then `finished` with its typed status and duration (T-L3). */
  | { readonly kind: 'tool'; readonly phase: 'started' | 'finished'; readonly callId: string; readonly name: string; readonly target: string | null;
    readonly status: AgentToolCallStatus | null; readonly ms: number | null }
  /** A message the turn appended: the caller's history continues from exactly these (not rendered). */
  | { readonly kind: 'message'; readonly message: AgentChatMessage }
  /** The round's measured prompt against the window (T-L5); `upper-bound` is shown as approximate. */
  | { readonly kind: 'context'; readonly promptTokens: number; readonly windowTokens: number | null; readonly quality: AgentContextQuality }
  /** The history was compacted (T-L5b): `messages` replaces every non-system message of the caller's history. */
  | { readonly kind: 'compacted'; readonly messages: readonly AgentChatMessage[]; readonly replacedMessages: number }
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
