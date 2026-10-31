import { randomUUID } from 'node:crypto';
import { useCallback, useRef, useState } from 'react';
import { resolveSessionReference, type SessionRefusal, type ConversationSessionPort, type ConversationSessionSummary, type AgentChatMessage, type TurnDelta } from '#surfaces/core/terminal-kit/index.js';
import { CONTEXT_SUGGEST_SHARE, contextBreakdown, contextViewLines, contextCompactionThreshold, fillTemplate, projectHumanPickerText, type ContextCompaction, type ContextMeasure,
  formatContextTokens, type ContextViewLabels } from '#surfaces/core/terminal-render/index.js';
import type { ContextInfoLabels, InfoSection, InfoWindowModel } from '#surfaces/core/terminal-window/index.js';
import type { LocalExecution, ResumePickerItem } from '#surfaces/core/terminal-work/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import { notice, type WorkLedgerEntry } from '#surfaces/core/terminal-ledger/index.js';
import { systemSummaryEntry } from '#surfaces/core/terminal-work/index.js';
import { resumedHistoryEntries, type ResumedHistoryLabels } from '#surfaces/core/terminal-conversation/index.js';

export { bindSessionScope } from '#surfaces/core/terminal-kit/index.js';
export type { ConversationSessionSummary, ConversationSessionPort, TerminalSessionStoreView, SessionRefusal } from '#surfaces/core/terminal-kit/index.js';
export interface ConversationSessionLabels {
  readonly locale?: 'en' | 'tr';
  /** `{index}. {session} · {when} · {count} messages · {preview}` */
  readonly entry: string;
  /** BeUser AYSE-22: the line printed after the terminal closes when conversations are saved (how to come back). */
  readonly exitHint?: string;
  readonly hiddenCount?: string;
  readonly none: string; readonly notFound: string; readonly unavailable: string; readonly saveFailed: string;
  readonly exactRequired?: string; readonly listStale?: string;
  /** `{count}` messages resumed from `{session}`. */
  readonly resumed: string;
  readonly started: string;
  /** T5 `/rename`: `usage` when no title was typed, `done` after naming, `nothingSaved` when the conversation has no saved snapshot yet. */
  /** T5 picker filter: `prompt` carries `{text}` (the typed filter, may be empty), `none` is shown when no conversation matches. */
  readonly filter?: { readonly prompt: string; readonly none: string };
  readonly folders?: { readonly all: string; readonly current: string };
  readonly rename?: { readonly usage: string; readonly done: string; readonly nothingSaved: string };
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
function done(entries: readonly WorkLedgerEntry[], resumePicker?: readonly ResumePickerItem[]): SessionCommandResult {
  return resumePicker && resumePicker.length > 0 ? { entries, resumePicker } : { entries };
}
// BeUser AYSE-24: the person's own clock (this machine's time zone), never UTC without a zone.
const when = (ms: number) => { const d = new Date(ms), two = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
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
  const threshold = contextCompactionThreshold(measured);
  const share = (part: number) => `${parts.total ? Math.round(part * 100 / parts.total) : 0}%`;
  const sections: InfoSection[] = [
    { title: labels.section.window, chip, rows: [
      ...(percent === null ? [{ key: labels.key.fill, value: labels.notMeasured }] : [{ key: labels.key.fill, value: `${bar} ${percent}%` },
        { key: labels.key.used, value: fillTemplate(labels.used, { approx: measured!.quality === 'upper-bound' ? '~' : '', prompt: formatContextTokens(measured!.promptTokens, labels.locale), window: measured!.windowTokens === null ? '?' : formatContextTokens(measured!.windowTokens, labels.locale) }) }]),
      ...(threshold ? [{ key: labels.key.auto, value: fillTemplate(labels.auto, threshold) }] : []),
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
  const allFolders = useRef(false);
  // The same measurement `/context` reads, kept as state too so the information row under the bar follows it (harness gap item 1).
  const [measured, setMeasured] = useState<ContextView | null>(null);
  const remember = useCallback((value: ContextView | null) => { context.current = value; setMeasured(value); }, []);
  const noteContext = useCallback((delta: TurnDelta) => {
    if (delta.kind === 'context') remember({ promptTokens: delta.promptTokens, windowTokens: delta.windowTokens, quality: delta.quality, ...(delta.compactionThresholdTokens === undefined ? {} : { compactionThresholdTokens: delta.compactionThresholdTokens }) });
    if (delta.kind === 'compacted') compaction.current = { count: (compaction.current?.count ?? 0) + 1, replacedMessages: delta.replacedMessages, atMs: Date.now() };
  }, [remember]);
  const save = useCallback(async (history: readonly AgentChatMessage[]): Promise<WorkLedgerEntry[]> => {
    if (!port || !labels) return [];
    try { await port.save({ sessionId: id(), messages: history.filter(message => message.role !== 'system') }); listed.current = []; return []; }
    catch {
      if (saveFailed.current) return [];
      saveFailed.current = true;
      return [notice('error', labels.saveFailed)];
    }
  }, [labels, port, id]);
  const run = useCallback(async (command: 'resume' | 'context' | 'clear' | 'rename', args: string,
    history: { current: readonly AgentChatMessage[] }, execution: LocalExecution): Promise<SessionCommandResult> => {
    if (!labels) return done([]);
    const count = history.current.filter(message => message.role !== 'system').length;
    if (command === 'clear') {
      if (!execution.selectSession({ ...execution.input.context, sessionId: randomUUID() })) return done([]);
      history.current = history.current.slice(0, 1); remember(null); compaction.current = null; listed.current = [];
      // The single summary line of a cleared screen (SLASH-WINDOWS); the caller wipes the screen when this is non-empty.
      return done([systemSummaryEntry(labels.started)]);
    }
    if (command === 'context') {
      const measured = context.current;
      const head = !measured ? fillTemplate(labels.contextNone, { count })
        : fillTemplate(labels.context, { approx: measured.quality === 'upper-bound' ? '~' : '', prompt: formatContextTokens(measured.promptTokens, labels.locale), window: measured.windowTokens === null ? '?' : formatContextTokens(measured.windowTokens, labels.locale),
          percent: measured.windowTokens ? Math.ceil(measured.promptTokens * 100 / measured.windowTokens) : '?', count });
      const view = contextViewLines({ measured, history: history.current, compaction: compaction.current, now: Date.now(), when }, labels.view);
      return done([notice('info', head), ...view.map(line => notice('info', line))]);
    }
    if (!port) return done([notice('error', labels.unavailable)]);
    if (command === 'rename') {
      const title = args.trim();
      if (!title) return done([notice('error', labels.rename?.usage ?? labels.unavailable)]);
      if (!port.rename || !labels.rename) return done([notice('error', labels.unavailable)]);
      try { return done([(await port.rename(id(), title)) ? systemSummaryEntry(labels.rename.done) : notice('error', labels.rename.nothingSaved)]); }
      catch { return done([notice('error', labels.rename.nothingSaved)]); }
    }
    // The store bounds the list (its own `maxSessions`); the picker filters it by typed text.
    const freshList = async () => (await port.list(allFolders.current)).filter(summary => summary.sessionId !== id());
    const refuse = (refusal: SessionRefusal, text: string): SessionCommandResult => ({ refusal, entries: [notice('error', text)] });
    if (!args || args === '--all-folders' || args === '--this-folder') {
      if (args) allFolders.current = args === '--all-folders';
      listed.current = (await freshList()).map(summary => ({ ...summary }));
      if (!listed.current.length && !labels.folders) return done([systemSummaryEntry(labels.none)]);
      // The index stays filled so a later typed `/resume 2` still resolves. The rows are the picker, not ledger lines.
      const rows: ResumePickerItem[] = listed.current.map((summary, index) => ({ sessionId: summary.sessionId,
        ...projectHumanPickerText(fillTemplate(labels.entry, { index: index + 1, session: summary.sessionId.slice(0, 8), when: when(summary.updatedAtMs),
          count: summary.messages, preview: summary.title ?? summary.preview }), known, labels.hiddenCount) }));
      if (labels.folders) rows.push({ sessionId: allFolders.current ? '--this-folder' : '--all-folders',
        ...projectHumanPickerText(allFolders.current ? labels.folders.current : labels.folders.all, known, labels.hiddenCount) });
      return done([], rows);
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
    remember(null); compaction.current = null; listed.current = [];
    return done([systemSummaryEntry(fillTemplate(labels.resumed, { count: messages.length, session: target.slice(0, 8) })), ...resumedHistoryEntries(messages, labels.history, known)]);
  }, [labels, port, known, id]);
  /** SW-1: `/context` as a window model from the same measured state the text view reads. */
  const contextView = useCallback((history: readonly AgentChatMessage[], info: ContextInfoLabels, ascii: boolean, sources: readonly string[] = []): InfoWindowModel => {
    const model = contextInfoModel({ measured: context.current, history, compaction: compaction.current }, info, labels?.view, ascii);
    return { ...model, sections: model.sections.map((section, index) => index === 0 ? { ...section, notes: [...(section.notes ?? []), ...sources] } : section) };
  }, [labels]);
  /** CACHE-SLICE1: the latest measured prompt of this conversation (null: none yet), and forgetting it when a new context replaces the history. */
  const measuredPrompt = useCallback(() => context.current?.promptTokens ?? null, []);
  const forgetContext = useCallback(() => { remember(null); compaction.current = null; }, [remember]);
  return { noteContext, save, run, id, contextView, measuredPrompt, forgetContext, measured };
}
