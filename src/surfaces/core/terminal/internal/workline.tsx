import { useCallback, useEffect, useLayoutEffect, useRef, useState, createElement } from 'react';
import { render, Box, Static, Text, useApp, type Instance } from 'ink';
import type { WorklineInkPalette } from '#surfaces/core/terminal-kit/index.js';
import { WorklinePaletteProvider, useWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { StatusStrip } from './status-strip.js';
import { AssistantLive, renderAssistantStream, renderCompleteReply, startAssistantStream, type AssistantStreamStep } from '#surfaces/core/terminal-render/index.js';
import type { WorklineStreamTurn } from '#surfaces/core/terminal-kit/index.js';
import type { AssistantRenderLabels } from '#surfaces/core/terminal-render/index.js';
import { RenderGlyphsContext, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { assistantLedgerEntries, streamStepEntries } from './ledger-units.js';
import { parseSlashLine } from '#surfaces/core/terminal-kit/index.js';
import type { WorkLedgerEntry } from './work-ledger.js';
import { WORK_LEDGER_SCHEMA_VERSION } from './work-ledger.js';
import { LedgerEntryRow, type LedgerEntryLabels } from './ledger-entry.js';
import type { WorklineLedgerPorts } from './workline-ledger.js';
import { ledgerEntriesForWorkers, loadRunViewsForWatch } from './workline-ledger.js';
import { newWorkerTaskIds } from './worker-watch.js';
import { freshRunCards, newRunLedgerEntries } from './run-watch.js';
import { useConversationSession, type ConversationSessionLabels, type ConversationSessionPort } from './workline-sessions.js';
import { appendLedger, boundAgentHistory, compactLedger, EMPTY_LEDGER, plainChatHistory, type AgentChatMessage, type ChatTurnMessage, type LedgerBuffer } from './ledger-buffer.js';
import { immediateSlashAction, notice, runLedgerCommand, type WatchState, type WorklineActionLabels } from './workline-actions.js';
import { useSingleFlightPoll } from './use-poll.js';
import { useWorkSurface } from './work-surface.js';
import { Composer, type ComposerLabels } from '#surfaces/core/terminal-composer/index.js';
import type { ComposerHistoryPort } from '#surfaces/core/terminal-composer/index.js';
import type { ComposerMentionPort } from '#surfaces/core/terminal-composer/index.js';

export interface WorklineLabels extends WorklineActionLabels {
  readonly banner: string;
  readonly prompt: string;
  readonly statusReady: string;
  readonly statusBusy: string;
  readonly statusCancelling: string;
  readonly hint: string;
  readonly roleUser: string;
  readonly roleAssistant: string;
  readonly runCard: string;
  readonly workerCard: string;
  readonly watchFailed: string;
  /** Rendered-answer strings (terminal.render.*): narration, footer, code label, status facts. */
  readonly render: AssistantRenderLabels;
  readonly composer: ComposerLabels;
  /** `/resume`, `/context`, `/new` strings (T-L5c); absent when the surface has no session port. */
  readonly sessions?: ConversationSessionLabels;
}

export type WorklineCompleteTurn = (messages: readonly ChatTurnMessage[], signal: AbortSignal) => Promise<string>;
export type WorklineErrorText = (error: unknown) => string;

export interface WorklineProps {
  readonly labels: WorklineLabels;
  readonly target: string;
  readonly systemPrompt: string;
  readonly historyMessages: number;
  readonly completeTurn: WorklineCompleteTurn;
  readonly errorText: WorklineErrorText;
  readonly ledger?: WorklineLedgerPorts;
  readonly pollMs?: number;
  /** Streamed form of the governed turn (S-STREAM); when present it replaces `completeTurn` for chat. */
  readonly streamTurn?: WorklineStreamTurn;
  /** Approval notification cadence override (tests); production uses max(pollMs, 10 s). */
  readonly approvalPollMs?: number;
  /** Governed restart of the runtime service onto the current build; returns the line to show. */
  readonly restartService?: () => Promise<string>;
  /** Shown once at the top of the ledger when the view opens (e.g. the runtime service state). */
  readonly openingNotices?: ReadonlyArray<{ readonly level: 'info' | 'error'; readonly text: string }>;
  /** Composer history persistence and `@` mention candidates; both optional ports (no surface file access). */
  readonly inputHistory?: ComposerHistoryPort;
  readonly mentions?: ComposerMentionPort;
  /** Conversation snapshots of this scope for `/resume` (T-L5c). */
  readonly sessions?: ConversationSessionPort;
}

function chat(role: 'user' | 'assistant', text: string): WorkLedgerEntry {
  return Object.freeze({ schemaVersion: WORK_LEDGER_SCHEMA_VERSION, kind: 'chat' as const, id: 'chat', role, text });
}

function useLedgerBuffer() {
  const [buffer, setBuffer] = useState<LedgerBuffer>(EMPTY_LEDGER);
  const push = useCallback((entries: readonly WorkLedgerEntry[]) => setBuffer(current => appendLedger(current, entries)), []);
  // Every pending row was printed by `Static` in this commit; compaction keeps rows appended after it.
  useLayoutEffect(() => {
    const printed = buffer.pending.length;
    setBuffer(current => compactLedger(current, printed));
  }, [buffer.pending.length]);
  return { buffer, push };
}

export function WorklineApp(props: WorklineProps) {
  const { labels, target, systemPrompt, historyMessages, completeTurn, errorText, ledger } = props;
  const palette = useWorklinePalette();
  const { exit } = useApp();
  const { buffer, push } = useLedgerBuffer();
  const [busy, setBusyState] = useState(false);
  // Input typed while a turn runs is queued in order and never dropped (legacy input-queue contract).
  const busyRef = useRef(false);
  const queue = useRef<string[]>([]);
  const setBusy = useCallback((next: boolean) => { busyRef.current = next; setBusyState(next); }, []);
  const [cancelling, setCancelling] = useState(false);
  const [live, setLive] = useState<{ readonly step: AssistantStreamStep; readonly lead: boolean } | null>(null);
  const [watch, setWatch] = useState<WatchState>({ workers: false, runs: false });
  const watchRef = useRef(watch);
  const history = useRef<readonly AgentChatMessage[]>([{ role: 'system', content: systemPrompt }]);
  const session = useConversationSession(props.sessions, labels.sessions);
  const turn = useRef<AbortController | null>(null);
  const seenWorkers = useRef(new Set<string>());
  const seenRuns = useRef(new Map<string, string>());
  const pollMs = props.pollMs ?? ledger?.workerHeartbeatMs ?? 5000;
  const failed = useCallback((error: unknown) => push([notice('error', `${labels.watchFailed}: ${errorText(error)}`)]), [errorText, labels.watchFailed, push]);
  // P4 work surface: live worker panel, approval notifications/cards and run-cancel confirmation (dynamic region only).
  const work = useWorkSurface({ ledger, labels, push, errorText, pollMs, watchingWorkers: watch.workers,
    ...(props.approvalPollMs === undefined ? {} : { approvalPollMs: props.approvalPollMs }) });

  // Unmount aborts the running turn and stops the drain: a queued line never starts a governed turn after the view closed.
  const closed = useRef(false);
  useEffect(() => { closed.current = false; return () => { closed.current = true; turn.current?.abort(); }; }, []);
  const opening = useRef(props.openingNotices);
  useEffect(() => {
    const notices = opening.current;
    if (notices?.length) push(notices.map(item => notice(item.level, item.text)));
  }, [push]);
  useEffect(() => {
    const follow = ledger?.followWorkers;
    if (!watch.workers || !follow) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        for await (const batch of follow(controller.signal)) {
          if (cancelled || controller.signal.aborted) return;
          const workers = batch.filter(entry => entry.kind === 'worker').map(entry => ({ ...entry, observedAtMs: Date.now() }));
          work.observeWorkers(workers);
          const { seen, fresh } = newWorkerTaskIds(seenWorkers.current, workers);
          seenWorkers.current = seen;
          push(fresh);
        }
      } catch (error) { if (!cancelled) failed(error); }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [failed, ledger, push, watch.workers, work.observeWorkers]);
  useEffect(() => {
    const follow = ledger?.followRuns;
    if (!watch.runs || !follow) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        for await (const batch of follow(controller.signal)) {
          if (cancelled || controller.signal.aborted) return;
          const runs = batch.filter(entry => entry.kind === 'run').map(entry => ({ ...entry, observedAtMs: Date.now() }));
          const { seen, fresh } = freshRunCards(seenRuns.current, runs);
          seenRuns.current = seen;
          push(fresh);
        }
      } catch (error) { if (!cancelled) failed(error); }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [failed, ledger, push, watch.runs]);
  useSingleFlightPoll(watch.workers && Boolean(ledger) && !ledger?.followWorkers, pollMs, async current => {
    const workers = (await ledgerEntriesForWorkers(ledger!, 'watch')).filter(entry => entry.kind === 'worker');
    if (!current()) return;
    work.observeWorkers(workers);
    const { seen, fresh } = newWorkerTaskIds(seenWorkers.current, workers);
    seenWorkers.current = seen;
    push(fresh);
  }, failed);
  useSingleFlightPoll(watch.runs && Boolean(ledger?.listRunIds) && !ledger?.followRuns, pollMs, async current => {
    const runs = await loadRunViewsForWatch(ledger!);
    if (!current()) return;
    const { seen, fresh } = newRunLedgerEntries(seenRuns.current, runs, 'watch');
    seenRuns.current = seen;
    push(fresh);
  }, failed);

  const runTurn = useCallback(async (text: string) => {
    push([chat('user', text)]);
    const startedAtMs = Date.now();
    const controller = new AbortController();
    turn.current = controller;
    setBusy(true);
    const messages = boundAgentHistory({ role: 'system', content: systemPrompt }, [...history.current, { role: 'user', content: text }], historyMessages);
    try {
      if (props.streamTurn) {
        // S-STREAM: finished units go to scrollback as they complete; only the open tail and the reasoning narration stay live.
        let state = startAssistantStream(startedAtMs), answer = '';
        let base: readonly AgentChatMessage[] = messages, appended: AgentChatMessage[] = [];
        for await (const delta of props.streamTurn(messages, controller.signal)) {
          if (delta.kind === 'text') answer += delta.text;
          if (delta.kind === 'message') appended.push(delta.message);
          session.noteContext(delta);
          // A compaction replaces every non-system message the turn started from, including what it appended so far.
          if (delta.kind === 'compacted') { base = [messages[0]!, ...delta.messages.filter(message => message.role !== 'system')]; appended = []; }
          const step: AssistantStreamStep = renderAssistantStream(state, delta, Date.now());
          state = step.state;
          const entries = streamStepEntries(step);
          if (entries.length) push(entries);
          setLive(delta.kind === 'done' ? null : { step, lead: !state.answered });
        }
        // An agent turn's history is exactly its message events (tool calls and results included); a plain stream adds its answer.
        const next = appended.length ? appended : answer ? [{ role: 'assistant' as const, content: answer, toolCalls: [] }] : [];
        history.current = next.length || base !== messages ? boundAgentHistory(base[0]!, [...base, ...next], historyMessages) : messages;
        push(await session.save(history.current));
      } else {
        const reply = await completeTurn(plainChatHistory(messages), controller.signal);
        history.current = boundAgentHistory(messages[0]!, [...messages, { role: 'assistant', content: reply, toolCalls: [] }], historyMessages);
        push(await session.save(history.current));
        // Render seam (P3): the complete reply is one turn of text deltas + `done`, printed as finished markdown units.
        push(assistantLedgerEntries(renderCompleteReply(reply, startedAtMs, Date.now())));
      }
    } catch (error) {
      history.current = messages;
      push([notice('error', errorText(error))]);
    } finally {
      setLive(null);
      turn.current = null;
      setBusy(false);
      setCancelling(false);
    }
  }, [completeTurn, errorText, historyMessages, props.streamTurn, push, session, systemPrompt]);

  // Runs exactly one line: a chat turn, an immediate slash command or an awaited slash operation. `false` means the view is closing.
  const perform = useCallback(async (line: string): Promise<boolean> => {
    const slash = parseSlashLine(line);
    if (!slash) { await runTurn(line); return true; }
    if (slash.command === 'resume' || slash.command === 'context' || slash.command === 'new') {
      setBusy(true);
      try { push(await session.run(slash.command, slash.args, history)); }
      catch (error) { push([notice('error', errorText(error))]); }
      finally { setBusy(false); }
      return true;
    }
    const action = immediateSlashAction(slash.command, { ledger, labels, watch: watchRef.current, canRestartService: Boolean(props.restartService) });
    // Quit before any setState: a render scheduled beside unmount leaves the TTY ref'd after a governed turn.
    if (action?.exit) { exit(); return false; }
    if (action) {
      push(action.entries);
      // The ref moves with the state so a queued `/watch-stop` behind `/watch-workers` sees the new watch before any render.
      if (action.watch) { watchRef.current = action.watch; setWatch(action.watch); }
      return true;
    }
    setBusy(true);
    try {
      if (slash.command === 'service-restart') push([notice('info', await props.restartService!())]);
      else if (slash.command === 'approvals' || slash.command === 'cancel') await work.run(slash.command, slash.args);
      else push(await runLedgerCommand(slash.command as 'workers' | 'run' | 'runs' | 'transcript', slash.args, ledger!, labels));
    }
    catch (error) { push([notice('error', errorText(error))]); }
    finally { setBusy(false); }
    return true;
  }, [errorText, exit, labels, ledger, props.restartService, push, runTurn, session, setBusy, work.run]);

  // The one FIFO drain: after every line (turn, immediate or awaited slash) the next queued entry runs here, in order, once.
  // Serialized without a flag: a turn or awaited slash holds `busyRef`, so Enter only enqueues; the hop from one line to the
  // next `shift()` is microtask-only, so no keystroke can interleave. An open decision card keeps the keys (Composer inactive).
  const submit = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (busyRef.current) {
      queue.current.push(trimmed);
      push([notice('info', `${labels.queued}: ${trimmed}`)]);
      return;
    }
    let next: string | undefined = trimmed;
    while (next !== undefined && !closed.current) {
      if (!(await perform(next))) return;
      next = queue.current.shift();
    }
  }, [labels.queued, perform, push]);

  // A running turn is cancelled, never abandoned: the governed invocation receives a cancellation request.
  const cancel = useCallback(() => {
    if (turn.current && !cancelling) { setCancelling(true); turn.current.abort(); }
  }, [cancelling]);

  const ledgerLabels: LedgerEntryLabels = { runCard: labels.runCard, workerCard: labels.workerCard, chatUser: labels.roleUser, chatAssistant: labels.roleAssistant,
    render: labels.render, ...(labels.work ? { workerLine: labels.work.workerLine } : {}) };
  return (
    <Box flexDirection="column">
      <Static key={buffer.epoch} items={[...buffer.pending]}>
        {row => <LedgerEntryRow key={row.seq} entry={row.entry} labels={ledgerLabels} />}
      </Static>
      {live ? <AssistantLive tail={live.step.liveTail} narration={live.step.narration} labels={labels.render} lead={live.lead} activeTool={live.step.activeTool} /> : null}
      {work.region}
      <Text {...palette.accent}>{labels.banner}</Text>
      <StatusStrip target={target} state={cancelling ? labels.statusCancelling : busy ? labels.statusBusy : labels.statusReady} busy={busy}
        queued={queue.current.length} labels={labels.render} />
      {/* The composer owns input: Enter submits (queued FIFO while busy), Esc/Ctrl+C cancel a turn, exit is two Ctrl+C or Ctrl+D.
          An open decision card (P4) takes the keyboard away from it. */}
      <Composer prompt={labels.prompt} labels={labels.composer} busy={busy} active={!work.modalOpen} onSubmit={text => void submit(text)} onCancel={cancel} onExit={exit}
        {...(props.inputHistory ? { history: props.inputHistory } : {})} {...(props.mentions ? { mentions: props.mentions } : {})} />
      <Text {...palette.muted}>{labels.hint}</Text>
    </Box>
  );
}

export interface WorklineRunOptions extends Omit<WorklineProps, 'labels'> {
  readonly labels: WorklineLabels;
  readonly palette: WorklineInkPalette;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly signal?: AbortSignal;
  /** ASCII decoration for terminals that cannot be assumed to draw Unicode. */
  readonly ascii?: boolean;
}

/** Ctrl+C is handled by the composer (cancel a running turn, clear a draft, or exit on a second press); the outer signal unmounts the view. */
export async function runTerminalWorkline(options: WorklineRunOptions): Promise<void> {
  const { palette, stdin, stdout, signal, ascii, ...props } = options;
  const view = createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(ascii === true) }, createElement(WorklineApp, props));
  const instance: Instance = render(createElement(WorklinePaletteProvider, { palette, children: view }),
    { exitOnCtrlC: false, patchConsole: false, ...(stdin ? { stdin } : {}), ...(stdout ? { stdout } : {}) });
  const stop = () => instance.unmount();
  signal?.addEventListener('abort', stop, { once: true });
  try { await instance.waitUntilExit(); }
  finally {
    signal?.removeEventListener('abort', stop);
    const input = stdin ?? process.stdin;
    try { if (input.isTTY && input.isRaw) input.setRawMode(false); } catch { /* already restored */ }
    input.unref?.();
  }
}
