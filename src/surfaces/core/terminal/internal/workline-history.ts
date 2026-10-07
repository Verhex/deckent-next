import type { AgentChatMessage } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate, humanRecordText } from '#surfaces/core/terminal-render/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import { notice, type WorkLedgerEntry, WORK_LEDGER_SCHEMA_VERSION } from '#surfaces/core/terminal-ledger/index.js';

/** Templates: `{count}` earlier messages not shown / tool results folded. */
export interface ResumedHistoryLabels {
  readonly omitted: string;
  readonly toolResults: string;
  readonly summarized: string;
}
// Until the catalog carries the templates the lines stay language-neutral (`i18n-delta.json`, TERM-UX-1).
const NEUTRAL: ResumedHistoryLabels = { omitted: '… {count}', toolResults: '· {count} tool', summarized: '· summary' };
/** Newest messages replayed and longest user text shown: the model still receives the whole history (context, not display). */
export const RESUME_SHOWN_MESSAGES = 24, RESUME_USER_TEXT_CHARS = 600;
const SUMMARY_MARK = '[Deckent context summary:', EXCERPT_MARK = '[Deckent context excerpt:', RENDER_MARK = '[Deckent context render v', ATTACHED = '\n\n--- attached file ';

const chat = (role: 'user' | 'assistant', text: string): WorkLedgerEntry =>
  Object.freeze({ schemaVersion: WORK_LEDGER_SCHEMA_VERSION, kind: 'chat' as const, id: 'chat', role, text });

/**
 * The resumed conversation as scrollback rows (TERM-UX-1 b): the newest bounded part of it, user lines shortened (attached file
 * bodies and long pastes are not replayed), assistant answers as they were rendered, tool traffic as one count line, a compaction
 * summary as one marker. Display only: the model context is the history itself.
 */
export function resumedHistoryEntries(messages: readonly AgentChatMessage[], labels: ResumedHistoryLabels = NEUTRAL, known?: KnownSecretSnapshot): readonly WorkLedgerEntry[] {
  const shown = messages.filter(message => message.role !== 'system');
  const start = Math.max(0, shown.length - RESUME_SHOWN_MESSAGES);
  const rows: WorkLedgerEntry[] = start > 0 ? [notice('info', fillTemplate(labels.omitted, { count: start }))] : [];
  let tools = 0;
  const flush = () => { if (tools) rows.push(notice('info', fillTemplate(labels.toolResults, { count: tools }))); tools = 0; };
  for (const message of shown.slice(start)) {
    if (message.role === 'tool') { tools++; continue; }
    flush();
    if (message.role === 'user') {
      if ([SUMMARY_MARK, EXCERPT_MARK, RENDER_MARK].some(mark => message.content.startsWith(mark))) { rows.push(notice('info', labels.summarized)); continue; }
      const safe = humanRecordText(message.content, known);
      const attached = safe.indexOf(ATTACHED);
      const text = (attached >= 0 ? safe.slice(0, attached) : safe).trim();
      rows.push(chat('user', text.length > RESUME_USER_TEXT_CHARS ? `${text.slice(0, RESUME_USER_TEXT_CHARS)} …` : text));
    } else if (message.content.trim()) rows.push(chat('assistant', message.content));
  }
  flush();
  return rows;
}
