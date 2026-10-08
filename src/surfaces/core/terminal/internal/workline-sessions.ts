import { randomUUID } from 'node:crypto';
import { useCallback, useRef } from 'react';
import { resolveSessionReference, type SessionRefusal, type ConversationSessionPort, type ConversationSessionSummary, type AgentChatMessage, type TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { CONTEXT_AUTO_SUMMARY_SHARE, CONTEXT_SUGGEST_SHARE, contextBreakdown, contextViewLines, fillTemplate, projectHumanPickerText, type ContextCompaction, type ContextMeasure,
  type ContextViewLabels } from '#surfaces/core/terminal-render/index.js';
import type { ContextInfoLabels, InfoSection, InfoWindowModel } from '#surfaces/core/terminal-window/index.js';
import type { LocalExecution, ResumePickerItem } from '#surfaces/core/terminal-work/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import { notice, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { systemSummaryLine } from './workline-summary.js';
import { resumedHistoryEntries, type ResumedHistoryLabels } from './workline-history.js';

export { bindSessionScope } from '#surfaces/core/terminal-kit/index.js';
export type { ConversationSessionSummary, ConversationSessionPort, TerminalSessionStoreView, SessionRefusal } from '#surfaces/core/terminal-kit/index.js';
export interface ConversationSessionLabels {
  /** `{index}. {session} · {when} · {count} messages · {preview}` */
  readonly entry: string;
  readonly hiddenCount?: string;
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
export type SessionCommandResult = Readonly<{ entries: readonly WorkLedgerEntry[]; resumePicker?: readonly ResumePickerItem[]; refusal?: SessionRefusal }>;
type ContextView = Omit<Extract<TurnDelta, { kind: 'context' }>, 'kind'>;
const LISTED = 10;
function done(entries: readonly WorkLedgerEntry[], resumePicker?: readonly ResumePickerItem[]): SessionCommandResult {
  return resumePicker && resumePicker.length > 0 ? { entries, resumePicker } : { entries };
}
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const BAR_CELLS = 20;

/**
 * `/context` as a window (SW-1): the window fill with a bar and a chip, where the runtime summarizes by itself, what fills it (a size
 * estimate of the client-visible history, as a table), the summaries so far and the suggestion — the same facts as the text view.
 */
export function contextInfoModel(input: Readonly<{ measured: ContextMeasure | null; history: readonly AgentChatMessage[]; compaction: ContextCompaction | null }>,
  labels: ContextInfoLabels, view: ContextViewLabels | undefined, ascii = false): InfoWindowModel {
  const { measured, compaction } = input, parts = contextBreakdown(input.history);
  const count = input.history.filter(message => message.role !== 'system').length;
  const percent = measured?.windowTokens ? Math.ceil(measured.promptTokens * 100 / measured.windowTokens) : null;
  const filling = percent !== null && percent >= CONTEXT_SUGGEST_SHARE * 100;
  const chip = percent === null ? { state: 'neutral' as const, text: labels.notMeasured } : filling ? { state: 'warn' as const, text: labels.chip.filling }
    : { state: 'ok' as const, text: labels.chip.room };
  const filled = percent === null ? 0 : Math.min(BAR_CELLS, Math.round(percent * BAR_CELLS / 100));
  const bar = `${(ascii ? '#' : '█').repeat(filled)}${(ascii ? '.' : '░').repeat(BAR_CELLS - filled)}`;
  const limit = measured?.windowTokens ? Math.floor(measured.windowTokens * CONTEXT_AUTO_SUMMARY_SHARE) : null;
  const share = (part: number) => `${parts.total ? Math.round(part * 100 / parts.total) : 0}%`;
  const sections: InfoSection[] = [
    { title: labels.section.window, chip, rows: [
      ...(percent === null ? [{ key: labels.key.fill, value: labels.notMeasured }] : [{ key: labels.key.fill, value: `${bar} ${percent}%` },
        { key: labels.key.used, value: fillTemplate(labels.used, { approx: measured!.quality === 'upper-bound' ? '~' : '', prompt: measured!.promptTokens, window: measured!.windowTokens ?? '?' }) }]),
      ...(limit !== null ? [{ key: labels.key.auto, value: fillTemplate(labels.auto, { tokens: limit, percent: Math.round(CONTEXT_AUTO_SUMMARY_SHARE * 100),
        remaining: Math.max(0, limit - measured!.promptTokens) }) }] : []),
      { key: labels.key.messages, value: String(count) }] },
    ...(parts.total > 0 ? [{ title: labels.section.split, table: { columns: [labels.column.part, labels.column.share], rows: [[labels.part.system, share(parts.system)],
      [labels.part.user, share(parts.user)], [labels.part.assistant, share(parts.assistant)], [labels.part.tools, share(parts.tools)], [labels.part.attachments, share(parts.attachments)]] },
    ...(parts.largest.length ? { rows: [{ key: labels.key.largest, value: parts.largest.map(item => `${item.name} (${share(item.size)})`).join(' · ') }] } : {}),
    notes: [labels.splitNote] }] : []),
    { title: labels.section.summaries, ...(compaction ? { rows: [{ key: labels.key.count, value: String(compaction.count) },
      { key: labels.key.last, value: fillTemplate(labels.last, { replaced: compaction.replacedMessages, when: when(compaction.atMs) }) }] }
      : { notes: [view?.compactedNone ?? '-'] }) },
    ...(filling && view ? [{ title: labels.section.suggestion, notes: [fillTemplate(parts.tools * 2 > parts.total ? view.suggestTools : view.suggestNew, { command: '/clear' })] }] : []),
  ];
  return { title: labels.title, chips: [chip], sections,
    summary: percent === null ? fillTemplate(labels.summaryNone, { count }) : fillTemplate(labels.summary, { percent, count }) };
}

/**
 * The workline's conversation session (T-L5c): a fresh id per view (or per `/clear`), the whole history saved after every turn,
 * `/resume` with no argument opens an arrow-key picker (a typed `/resume <n|id>` still loads one), `/context` for the latest measured prompt. A failed save is shown once
 * and never blocks the conversation.
 */
export function useConversationSession(port: ConversationSessionPort | undefined, labels: ConversationSessionLabels | undefined, id: () => string, known?: KnownSecretSnapshot) {
  const saveFailed = useRef(false), listed = useRef<readonly ConversationSessionSummary[]>([]), context = useRef<ContextView | null>(null), compaction = useRef<ContextCompaction | null>(null);
  const noteContext = useCallback((delta: TurnDelta) => {
    if (delta.kind === 'context') context.current = { promptTokens: delta.promptTokens, windowTokens: delta.windowTokens, quality: delta.quality };
    if (delta.kind === 'compacted') compaction.current = { count: (compaction.current?.count ?? 0) + 1, replacedMessages: delta.replacedMessages, atMs: Date.now() };
  }, []);
  const save = useCallback(async (history: readonly AgentChatMessage[]): Promise<WorkLedgerEntry[]> => {
    if (!port || !labels) return [];
    try { await port.save({ sessionId: id(), messages: history.filter(message => message.role !== 'system') }); listed.current = []; return []; }
    catch {
      if (saveFailed.current) return [];
      saveFailed.current = true;
      return [notice('error', labels.saveFailed)];
    }
  }, [labels, port, id]);
  const run = useCallback(async (command: 'resume' | 'context' | 'clear', args: string,
    history: { current: readonly AgentChatMessage[] }, execution: LocalExecution): Promise<SessionCommandResult> => {
    if (!labels) return done([]);
    const count = history.current.filter(message => message.role !== 'system').length;
    if (command === 'clear') {
      if (!execution.selectSession({ ...execution.input.context, sessionId: randomUUID() })) return done([]);
      history.current = history.current.slice(0, 1); context.current = null; compaction.current = null; listed.current = [];
      // The single summary line of a cleared screen (SLASH-WINDOWS); the caller wipes the screen when this is non-empty.
      return done([systemSummaryLine(labels.started)]);
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
    const freshList = async () => (await port.list()).filter(summary => summary.sessionId !== id()).slice(0, LISTED);
    const refuse = (refusal: SessionRefusal, text: string): SessionCommandResult => ({ refusal, entries: [notice('error', text)] });
    if (!args) {
      listed.current = (await freshList()).map(summary => ({ ...summary }));
      if (!listed.current.length) return done([systemSummaryLine(labels.none)]);
      // The index stays filled so a later typed `/resume 2` still resolves. The rows are the picker, not ledger lines.
      return done([], listed.current.map((summary, index) => ({ sessionId: summary.sessionId,
        ...projectHumanPickerText(fillTemplate(labels.entry, { index: index + 1, session: summary.sessionId.slice(0, 8), when: when(summary.updatedAtMs),
          count: summary.messages, preview: summary.preview }), known, labels.hiddenCount) })));
    }
    const reference = resolveSessionReference(args, listed.current, /^\d+$/.test(args) && listed.current.length ? await freshList() : []);
    if ('refusal' in reference) {
      if (reference.refusal === 'SESSION_LIST_STALE') listed.current = [];
      return refuse(reference.refusal, (reference.refusal === 'SESSION_LIST_STALE' ? labels.listStale : labels.exactRequired) ?? reference.refusal);
    }
    const target = reference.target;
    const messages = await port.load(target);
    if (!messages) return refuse('SESSION_NOT_FOUND', labels.notFound);
    if (!execution.selectSession({ ...execution.input.context, sessionId: target })) return done([]);
    history.current = [history.current[0]!, ...messages.filter(message => message.role !== 'system')];
    context.current = null; compaction.current = null; listed.current = [];
    return done([systemSummaryLine(fillTemplate(labels.resumed, { count: messages.length, session: target.slice(0, 8) })), ...resumedHistoryEntries(messages, labels.history, known)]);
  }, [labels, port, known, id]);
  /** SW-1: `/context` as a window model from the same measured state the text view reads. */
  const contextView = useCallback((history: readonly AgentChatMessage[], info: ContextInfoLabels, ascii: boolean): InfoWindowModel =>
    contextInfoModel({ measured: context.current, history, compaction: compaction.current }, info, labels?.view, ascii), [labels]);
  return { noteContext, save, run, id, contextView };
}
