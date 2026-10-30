import type { KnownSecretSnapshot } from '#platform/index.js';
import { humanRecordText } from '#surfaces/core/terminal-render/index.js';
import type { CardCopyLabels } from '#surfaces/core/terminal-window/index.js';
import { CLIPBOARD_LIMITS, type ClipboardResult } from './clipboard.js';

/** `/copy` words (`tuicopy.*`); `{count}`, `{n}`, `{bytes}`, `{max}` are filled by {@link runCopyCommand}. `card`: the cards' Ctrl+Y copy (`tuicopy.card.*`). */
export type CopyLabels = Readonly<{ sent: string; none: string; range: string; usage: string; tooLarge: string; unavailable: string; card?: CardCopyLabels }>;
type HistoryMessage = Readonly<{ role: string; content: string }>;

/**
 * The answers of a conversation, newest first: one per user turn, the text of the turn's last assistant message that has any (the progress lines the model
 * writes between tool rounds are not answers). The history is the model-facing one, so the copy is what the person read, before any display wrapping.
 */
export function copyableAnswers(history: readonly HistoryMessage[]): readonly string[] {
  const answers: string[] = [];
  let current: string | null = null;
  for (const message of history) {
    if (message.role === 'user') { if (current !== null) answers.push(current); current = null; }
    else if (message.role === 'assistant' && message.content.trim()) current = message.content;
  }
  if (current !== null) answers.push(current);
  return answers.reverse();
}

const fill = (template: string, values: Readonly<Record<string, string | number>>) => template.replace(/\{(\w+)\}/g, (whole, key: string) => key in values ? String(values[key]) : whole);

/** `/copy [n]`: sends the n-th latest answer (default 1) to the terminal clipboard; secrets known to the process are masked exactly as the display masks them. */
export function runCopyCommand(args: string, history: readonly HistoryMessage[], clipboard: ((text: string) => ClipboardResult) | undefined, labels: CopyLabels,
  known?: KnownSecretSnapshot): Readonly<{ level: 'info' | 'error'; text: string }> {
  const word = args.trim();
  if (word !== '' && !/^[1-9][0-9]{0,3}$/.test(word)) return { level: 'error', text: labels.usage };
  const n = word === '' ? 1 : Number(word), answers = copyableAnswers(history);
  if (answers.length === 0) return { level: 'error', text: labels.none };
  if (n > Math.min(answers.length, CLIPBOARD_LIMITS.maxAnswerBack)) return { level: 'error', text: fill(labels.range, { max: Math.min(answers.length, CLIPBOARD_LIMITS.maxAnswerBack) }) };
  if (!clipboard) return { level: 'error', text: labels.unavailable };
  const text = humanRecordText(answers[n - 1]!, known), result = clipboard(text);
  if (result.ok) return { level: 'info', text: fill(labels.sent, { count: [...text].length, n }) };
  if (result.reason === 'too-large') return { level: 'error', text: fill(labels.tooLarge, { n, bytes: result.bytes, max: CLIPBOARD_LIMITS.maxBytes }) };
  return { level: 'error', text: result.reason === 'empty' ? labels.none : labels.unavailable };
}
