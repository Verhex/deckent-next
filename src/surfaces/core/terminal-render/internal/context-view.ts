import type { AgentChatMessage } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate } from './status-row.js';

/** The last automatic summary the workline saw in this conversation (`compacted` delta). */
export interface ContextCompaction { readonly count: number; readonly replacedMessages: number; readonly atMs: number }
export interface ContextMeasure { readonly promptTokens: number; readonly windowTokens: number | null; readonly quality: 'provider-count' | 'upper-bound' }

/**
 * Share of the window after which the runtime summarizes the earlier conversation by itself. Display constant: the rule is the engine's
 * `AGENT_COMPACTION_HIGH_WATER` (the surface may not import the engine; the contract test in `terminal-context-view.test.ts` keeps them equal).
 */
export const CONTEXT_AUTO_SUMMARY_SHARE = 0.75;
/** From this share of the window the view suggests making room; a person is told before the runtime acts, not only after. */
export const CONTEXT_SUGGEST_SHARE = 0.6;
const LARGEST = 3;

/** Templates (`terminal.context.*`); every line is optional so the neutral fallback keeps working until the catalog carries them. */
export interface ContextViewLabels {
  /** `{tokens}` `{percent}` `{remaining}` */
  readonly threshold: string;
  /** `{system}` `{user}` `{assistant}` `{tools}` `{attachments}` percentages of the counted bytes */
  readonly split: string;
  /** `{count}` summaries · `{replaced}` messages of the last · `{when}` */
  readonly compacted: string;
  readonly compactedNone: string;
  /** `{items}` = `name (share%)` list */
  readonly largest: string;
  /** Room is running out: `{command}` frees it. */
  readonly suggestNew: string;
  /** Tool results dominate. */
  readonly suggestTools: string;
  /** `{filled}`: the bar (filled and empty cells of `{width}`), `{percent}` */
  readonly bar: string;
}
const NEUTRAL: ContextViewLabels = { threshold: 'auto {tokens} ({percent}%) · {remaining} left', split: 'system {system}% · you {user}% · bot {assistant}% · tools {tools}% · files {attachments}%',
  compacted: 'summaries {count} · last {replaced} msgs · {when}', compactedNone: 'summaries 0', largest: '{items}', suggestNew: '/clear', suggestTools: '/clear', bar: '{filled} {percent}%' };

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const ATTACHED = '\n\n--- attached file ';

interface Item { readonly name: string; readonly size: number }
export interface ContextBreakdown {
  readonly system: number; readonly user: number; readonly assistant: number; readonly tools: number; readonly attachments: number;
  readonly total: number; readonly largest: readonly Item[];
}
/** Sizes of the client-visible history by kind (UTF-8 bytes): an estimate of what fills the window, never a token count. */
export function contextBreakdown(history: readonly AgentChatMessage[]): ContextBreakdown {
  let system = 0, user = 0, assistant = 0, tools = 0, attachments = 0;
  const items: Item[] = [];
  for (const message of history) {
    if (message.role === 'system') { system += bytes(message.content); continue; }
    if (message.role === 'user') {
      const at = message.content.indexOf(ATTACHED);
      const typed = at >= 0 ? message.content.slice(0, at) : message.content, files = at >= 0 ? message.content.slice(at) : '';
      user += bytes(typed); attachments += bytes(files);
      if (files) items.push({ name: 'attachments', size: bytes(files) });
    } else if (message.role === 'assistant') assistant += bytes(message.content) + message.toolCalls.reduce((sum, call) => sum + bytes(call.argumentsJson), 0);
    else { const size = bytes(message.content); tools += size; items.push({ name: message.name, size }); }
  }
  const total = system + user + assistant + tools + attachments;
  return Object.freeze({ system, user, assistant, tools, attachments, total, largest: Object.freeze(items.sort((a, b) => b.size - a.size).slice(0, LARGEST)) });
}

const pct = (part: number, total: number) => total ? Math.round(part * 100 / total) : 0;
const BAR_WIDTH = 20;

/**
 * The `/context` management view: window fill and bar, where the runtime summarizes by itself and how far that is, how the counted
 * history divides (size estimate, marked), the last summary, the largest items and what to do. Lines only for facts that exist.
 */
export function contextViewLines(input: { readonly measured: ContextMeasure | null; readonly history: readonly AgentChatMessage[];
  readonly compaction: ContextCompaction | null; readonly now: number; readonly when: (ms: number) => string }, labels: ContextViewLabels = NEUTRAL): readonly string[] {
  const parts = contextBreakdown(input.history), lines: string[] = [];
  const { measured } = input;
  if (measured?.windowTokens) {
    const percent = Math.ceil(measured.promptTokens * 100 / measured.windowTokens);
    const filled = Math.min(BAR_WIDTH, Math.round(percent * BAR_WIDTH / 100));
    lines.push(fillTemplate(labels.bar, { filled: '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled), width: BAR_WIDTH, percent }));
    const limit = Math.floor(measured.windowTokens * CONTEXT_AUTO_SUMMARY_SHARE);
    lines.push(fillTemplate(labels.threshold, { tokens: limit, percent: Math.round(CONTEXT_AUTO_SUMMARY_SHARE * 100), remaining: Math.max(0, limit - measured.promptTokens) }));
  }
  if (parts.total > 0) lines.push(fillTemplate(labels.split, { system: pct(parts.system, parts.total), user: pct(parts.user, parts.total),
    assistant: pct(parts.assistant, parts.total), tools: pct(parts.tools, parts.total), attachments: pct(parts.attachments, parts.total) }));
  lines.push(input.compaction ? fillTemplate(labels.compacted, { count: input.compaction.count, replaced: input.compaction.replacedMessages, when: input.when(input.compaction.atMs) })
    : labels.compactedNone);
  if (parts.largest.length) lines.push(fillTemplate(labels.largest, { items: parts.largest.map(item => `${item.name} (${pct(item.size, parts.total)}%)`).join(' · ') }));
  const fill = measured?.windowTokens ? measured.promptTokens / measured.windowTokens : 0;
  if (fill >= CONTEXT_SUGGEST_SHARE) lines.push(fillTemplate(parts.tools * 2 > parts.total ? labels.suggestTools : labels.suggestNew, { command: '/clear' }));
  return lines;
}
