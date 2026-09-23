import type { ChatTurnMessage } from './ledger-buffer.js';

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
  | { readonly kind: 'done'; readonly finish: 'stop' | 'length' | 'cancelled' | 'error' };

export type WorklineStreamTurn = (messages: readonly ChatTurnMessage[], signal: AbortSignal) => AsyncIterable<TurnDelta>;

/** Collects a stream into the final answer text (for line mode and tests); reasoning is excluded. */
export async function collectTurnText(stream: AsyncIterable<TurnDelta>): Promise<{ readonly text: string; readonly finish: Extract<TurnDelta, { kind: 'done' }>['finish'] | null }> {
  let text = '', finish: Extract<TurnDelta, { kind: 'done' }>['finish'] | null = null;
  for await (const delta of stream) {
    if (delta.kind === 'text') text += delta.text;
    else if (delta.kind === 'done') finish = delta.finish;
  }
  return { text, finish };
}
