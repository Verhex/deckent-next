import { randomUUID } from 'node:crypto';
import { useCallback, useRef } from 'react';
import { resolveSessionReference, type SessionRefusal, type ConversationSessionPort, type ConversationSessionSummary, type AgentChatMessage, type TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { contextViewLines, fillTemplate, type ContextCompaction, type ContextViewLabels } from '#surfaces/core/terminal-render/index.js';
import { notice } from './workline-actions.js';
import type { WorkLedgerEntry } from './work-ledger.js';
import { resumedHistoryEntries, type ResumedHistoryLabels } from './workline-history.js';

export { bindSessionScope } from '#surfaces/core/terminal-kit/index.js';
export type { ConversationSessionSummary, ConversationSessionPort, TerminalSessionStoreView, SessionRefusal } from '#surfaces/core/terminal-kit/index.js';
export interface ConversationSessionLabels {
  /** `{index}. {session} · {when} · {count} messages · {preview}` */
  readonly entry: string;
  readonly none: string; readonly notFound: string; readonly unavailable: string; readonly saveFailed: string;
  readonly exactRequired?: string; readonly listStale?: string;
  /** `{count}` messages resumed from `{session}`. */
  readonly resumed: string;
  readonly started: string;
  /** `{approx}{prompt}` of `{window}` tokens (`{percent}%`) · `{count}` messages */
  readonly context: string;
  /** No measurement yet · `{count}` messages */
  readonly contextNone: string;
  /** TERM-UX-1 b/d: resume replay (`terminal.session.history*`) and `/context` lines (`terminal.context.*`); neutral until the catalog carries them. */
  readonly history?: ResumedHistoryLabels; readonly view?: ContextViewLabels;
}
/** One row of the arg-less `/resume` picker. Enter loads `sessionId` through the same path as `/resume <id>`. */
export interface ResumePickerItem { readonly sessionId: string; readonly label: string }
export type SessionCommandResult = Readonly<{ entries: readonly WorkLedgerEntry[]; resumePicker?: readonly ResumePickerItem[]; refusal?: SessionRefusal }>;
type ContextView = Omit<Extract<TurnDelta, { kind: 'context' }>, 'kind'>;
const LISTED = 10;
function done(entries: readonly WorkLedgerEntry[], resumePicker?: readonly ResumePickerItem[]): SessionCommandResult {
  return resumePicker && resumePicker.length > 0 ? { entries, resumePicker } : { entries };
}
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/**
 * The workline's conversation session (T-L5c): a fresh id per view (or per `/clear`), the whole history saved after every turn,
 * `/resume` with no argument opens an arrow-key picker (a typed `/resume <n|id>` still loads one), `/context` for the latest measured prompt. A failed save is shown once
 * and never blocks the conversation.
 */
export function useConversationSession(port: ConversationSessionPort | undefined, labels: ConversationSessionLabels | undefined) {
  const sessionId = useRef<string>(randomUUID());
  const saveFailed = useRef(false), listed = useRef<readonly ConversationSessionSummary[]>([]), context = useRef<ContextView | null>(null), compaction = useRef<ContextCompaction | null>(null);
  const noteContext = useCallback((delta: TurnDelta) => {
    if (delta.kind === 'context') context.current = { promptTokens: delta.promptTokens, windowTokens: delta.windowTokens, quality: delta.quality };
    if (delta.kind === 'compacted') compaction.current = { count: (compaction.current?.count ?? 0) + 1, replacedMessages: delta.replacedMessages, atMs: Date.now() };
  }, []);
  const save = useCallback(async (history: readonly AgentChatMessage[]): Promise<WorkLedgerEntry[]> => {
    if (!port || !labels) return [];
    try { await port.save({ sessionId: sessionId.current, messages: history.filter(message => message.role !== 'system') }); listed.current = []; return []; }
    catch {
      if (saveFailed.current) return [];
      saveFailed.current = true;
      return [notice('error', labels.saveFailed)];
    }
  }, [labels, port]);
  const run = useCallback(async (command: 'resume' | 'context' | 'clear', args: string,
    history: { current: readonly AgentChatMessage[] }): Promise<SessionCommandResult> => {
    if (!labels) return done([]);
    const count = history.current.filter(message => message.role !== 'system').length;
    if (command === 'clear') {
      history.current = history.current.slice(0, 1); sessionId.current = randomUUID(); context.current = null; compaction.current = null; listed.current = [];
      return done([notice('info', labels.started)]);
    }
    if (command === 'context') {
      const measured = context.current;
      const head = !measured ? fillTemplate(labels.contextNone, { count })
        : fillTemplate(labels.context, { approx: measured.quality === 'upper-bound' ? '~' : '', prompt: measured.promptTokens, window: measured.windowTokens ?? '?',
          percent: measured.windowTokens ? Math.ceil(measured.promptTokens * 100 / measured.windowTokens) : '?', count });
      const view = contextViewLines({ measured, history: history.current, compaction: compaction.current, now: Date.now(), when }, labels.view);
      return done([notice('info', head), ...view.map(line => notice('info', line))]);
    }
    if (!port) return done([notice('error', labels.unavailable)]);
    const freshList = async () => (await port.list()).filter(summary => summary.sessionId !== sessionId.current).slice(0, LISTED);
    const refuse = (refusal: SessionRefusal, text: string): SessionCommandResult => ({ refusal, entries: [notice('error', text)] });
    if (!args) {
      listed.current = (await freshList()).map(summary => ({ ...summary }));
      if (!listed.current.length) return done([notice('info', labels.none)]);
      // The index stays filled so a later typed `/resume 2` still resolves. The rows are the picker, not ledger lines.
      return done([], listed.current.map((summary, index) => ({ sessionId: summary.sessionId, label: fillTemplate(labels.entry, {
        index: index + 1, session: summary.sessionId.slice(0, 8), when: when(summary.updatedAtMs), count: summary.messages, preview: summary.preview }) })));
    }
    const reference = resolveSessionReference(args, listed.current, /^\d+$/.test(args) && listed.current.length ? await freshList() : []);
    if ('refusal' in reference) {
      if (reference.refusal === 'SESSION_LIST_STALE') listed.current = [];
      return refuse(reference.refusal, (reference.refusal === 'SESSION_LIST_STALE' ? labels.listStale : labels.exactRequired) ?? reference.refusal);
    }
    const target = reference.target;
    const messages = await port.load(target);
    if (!messages) return refuse('SESSION_NOT_FOUND', labels.notFound);
    history.current = [history.current[0]!, ...messages.filter(message => message.role !== 'system')];
    sessionId.current = target; context.current = null; compaction.current = null; listed.current = [];
    return done([notice('info', fillTemplate(labels.resumed, { count: messages.length, session: target.slice(0, 8) })), ...resumedHistoryEntries(messages, labels.history)]);
  }, [labels, port]);
  const id = useCallback(() => sessionId.current, []);
  return { noteContext, save, run, id };
}
