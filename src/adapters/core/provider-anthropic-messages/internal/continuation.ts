import { createHash } from 'node:crypto';

/**
 * Checkpoint B interim (see proof review.md): within one tool-use turn the API requires the assistant's `thinking` /
 * `redacted_thinking` blocks back, complete and unmodified, but the provider-neutral agent message has no slot for an opaque
 * provider block. The adapter therefore remembers the exact content it received, per scope, keyed by its first tool_use id, in a
 * bounded process-local map (never persisted, never in the native response), and replays it verbatim only when the neutral
 * assistant message still equals what those blocks say. Loss (restart, expiry, edited history) degrades to blocks without thinking.
 */
export type AnthropicContentBlock = Readonly<Record<string, unknown>> & { readonly type: string };
const MAX_ENTRIES = 256, MAX_BLOCK_BYTES = 256 * 1024, TTL_MS = 60 * 60 * 1000;
const entries = new Map<string, { at: number; blocks: readonly AnthropicContentBlock[] }>();
const keyOf = (scopeId: string, toolUseId: string) => createHash('sha256').update(`${scopeId}\0${toolUseId}`).digest('hex');

export function rememberAnthropicContent(scopeId: string, blocks: readonly AnthropicContentBlock[], now = Date.now()): void {
  const first = blocks.find(block => block.type === 'tool_use');
  if (!first || typeof first['id'] !== 'string' || !blocks.some(block => block.type === 'thinking' || block.type === 'redacted_thinking')) return;
  if (Buffer.byteLength(JSON.stringify(blocks), 'utf8') > MAX_BLOCK_BYTES) return;
  for (const [key, value] of entries) if (now - value.at > TTL_MS) entries.delete(key);
  while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  entries.set(keyOf(scopeId, first['id']), { at: now, blocks });
}
export function recallAnthropicContent(scopeId: string, firstToolUseId: string, now = Date.now()): readonly AnthropicContentBlock[] | null {
  const found = entries.get(keyOf(scopeId, firstToolUseId));
  return found && now - found.at <= TTL_MS ? found.blocks : null;
}
export function forgetAnthropicContentForTests(): void { entries.clear(); }
