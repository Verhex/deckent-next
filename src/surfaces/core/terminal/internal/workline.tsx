import { useCallback, useEffect, useLayoutEffect, useRef, useState, createElement, type ComponentProps } from 'react';
import { render, Box, Static, Text, useApp, type Instance } from 'ink';
import { useWorklinePanel, type LocalExecution, LedgerEntryRow, type LedgerEntryLabels, immediateSlashAction, runLedgerCommand, type WatchState, type WorklineActionLabels, useWorkSurface } from '#surfaces/core/terminal-work/index.js';
import { WorklinePaletteProvider, useWorklinePalette, parseSlashLine, isInspectSlashCommand, addSessionUsage, bindInspectPorts, EMPTY_SESSION_USAGE, type InspectSlashPorts, type SessionUsageView, useWorklineWatch, surfaceDeliveryValues, surfaceFollowLine, useSurfacePushFeed,
  type TerminalLocalContext, type WorklineInkPalette, type WorklineStreamTurn } from '#surfaces/core/terminal-kit/index.js';
import { StatusStrip } from './status-strip.js';
import { AssistantLive, openAssistantStream, renderAssistantStream, renderCompleteReply, type AssistantStreamStep, type AssistantRenderLabels } from '#surfaces/core/terminal-render/index.js';
import { HumanTextContext, humanRecordText, projectHumanPickerText, RenderGlyphsContext, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import { assistantLedgerEntries, streamStepEntries, workerReportToLedgerEntries, WORK_LEDGER_SCHEMA_VERSION, type WorkLedgerEntry, ledgerEntriesForWorkers, ledgerEntriesForRuns, type WorklineLedgerPorts, fillTemplate, newWorkerTaskIds, freshRunCards, newRunLedgerEntries, agentHistory, appendLedger, boundAgentHistory, compactLedger, EMPTY_LEDGER, plainChatHistory, type AgentChatMessage, type ChatTurnMessage, type LedgerBuffer, notice } from '#surfaces/core/terminal-ledger/index.js';
import { useConversationSession, type ConversationSessionLabels, type ConversationSessionPort } from './workline-sessions.js';
import { ArrowPicker, ARROW_PICKER_ROWS } from '#surfaces/core/terminal-picker/index.js';
import { Window, WindowStackProvider, useFocusOwner } from '#surfaces/core/terminal-window/index.js';
import { span } from '#surfaces/core/terminal-render/index.js';
import { Composer, type ComposerLabels, type ComposerHistoryPort, type ComposerMentionPort } from '#surfaces/core/terminal-composer/index.js';
import { messageWithMentions, type WorklineAttachMentions, type WorklineMentionLabels } from './workline-mentions.js';
import { useWorklineMode, type WorklineModeLabels, type WorklinePermissionModePort } from './workline-mode.js';
import { useReasoningPreview, type WorklineReasoningLabels } from './workline-reasoning.js';
import { useWorklineScratch, type WorklineScratchLabels, type WorklineScratchPort } from './workline-scratch.js';

export interface WorklineLabels extends WorklineActionLabels {
  readonly banner: string;
  readonly prompt: string;
  readonly statusReady: string;
  readonly statusBusy: string;
  readonly statusCancelling: string;
  readonly selfSourceFloor?: string;
  readonly hint: string;
  readonly roleUser: string;
  readonly roleAssistant: string;
  readonly runCard: string;
  readonly workerCard: string;
  readonly watchFailed: string; readonly commandUnavailable: string; // a slash command without a port here; `{part}` = command (terminal.admin.partUnavailable)
  /** Rendered-answer strings (terminal.render.*): narration, footer, code label, status facts. */
  readonly render: AssistantRenderLabels;
  readonly composer: ComposerLabels;
  /** `/resume`, `/context`, `/clear` strings (T-L5c); absent when the surface has no session port. */
  readonly sessions?: ConversationSessionLabels;
  /** `@file` attachment notices (T-L5); without them the notice is language-neutral (path, bytes, refusal code). */
  readonly mentions?: WorklineMentionLabels;
  /** `/mode` notices (T-L4 slice 4c); without them the notice is language-neutral (command, catalog mode, policy field). */
  readonly mode?: WorklineModeLabels;
  /** `/reasoning` notices (TL-A D6); optional until the catalog carries `terminal.reasoning.*` (`i18n-delta.json`), neutral text meanwhile. */
  readonly reasoning?: WorklineReasoningLabels;
  /** `/scratch` notices (SCR-A); neutral text until the catalog carries `terminal.scratch.*` (`i18n-delta.json`). */
  readonly scratch?: WorklineScratchLabels;
}

export type WorklineCompleteTurn = (messages: readonly ChatTurnMessage[], signal: AbortSignal) => Promise<string>;
export type WorklineErrorText = (error: unknown) => string;

export interface WorklineProps {
  readonly labels: WorklineLabels;
  /** Trusted persistent identities from CLI composition; session identity is generated once by the local adapter. */
  readonly context: Omit<TerminalLocalContext, 'kind' | 'sessionId'>;
  readonly target: string;
  readonly systemPrompt: string;
  /** Window of the plain (non-streaming) path only; the agent path sends the whole conversation (T-L5, Astra 2091 R1). */
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
  /** Attaches the `@path` mentions of a chat line through the service (bounded, labelled); without it mentions stay plain text. */
  readonly attachMentions?: WorklineAttachMentions;
  /** Composer mention lookup quiet time (tests). */
  readonly mentionDelayMs?: number;
  /** Conversation snapshots of this scope for `/resume` (T-L5c). */
  readonly sessions?: ConversationSessionPort;
  /** Opaque provenance of the config already resolved for this operation; display only. */
  readonly knownSecrets?: KnownSecretSnapshot;
  /** The person's permission mode through the runtime service (status row segment and `/mode`, T-L4 slice 4c). */
  readonly permissionMode?: WorklinePermissionModePort;
  /** MODES-3: the session was launched in full access (the launch checked the company grant); every turn says so until `/mode` tightens it. */
  readonly fullAccess?: boolean;
  readonly selfSource?: boolean;
  /** The conversation's scratch area through the runtime service (`/scratch`, SCR-A, protocol v16). */
  readonly scratch?: WorklineScratchPort;
  /** Notice-line commands: `/mcp` (MCP-CLIENT: servers and trust — list, approve, reconnect, remove); `/monitor` (MONITOR: text snapshot). */
  /** Read-only management (S09): `/status` (fresh), `/model`, `/usage`, `/doctor`, `/scope`; each port re-reads its typed query per call. */ readonly inspect?: InspectSlashPorts;
  readonly config?: (args: string) => Promise<readonly string[]>; readonly mcp?: (args: string) => Promise<readonly string[]>; readonly monitor?: (args: string) => Promise<readonly string[]>;
  /** The project root the approval window names under "where" (display only; T-APPROVAL-WINDOW). */
  readonly projectRoot?: string;
}

/** The composer listens only while no window is open (TS-WINDOW: one input owner, the window stack's top). */
function StackComposer(props: ComponentProps<typeof Composer>) {
  const owner = useFocusOwner();
  return <Composer {...props} active={(props.active ?? true) && owner.idle} />;
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
  const { panel, state, execute, decide } = useWorklinePanel(props.context, props.sessions);
  const busy = state.phase === 'running' || state.phase === 'cancelling', cancelling = state.phase === 'cancelling';
  // A chat turn is running: Esc cancels it now (TL-A D5).
  const [turnRunning, setTurnRunning] = useState(false);
  const [live, setLive] = useState<{ readonly step: AssistantStreamStep; readonly lead: boolean } | null>(null);
  const usage = useRef<SessionUsageView>(EMPTY_SESSION_USAGE);
  const [watch, setWatch] = useState<WatchState>({ workers: false, runs: false });
  const watchRef = useRef(watch);
  const history = useRef<readonly AgentChatMessage[]>([{ role: 'system', content: systemPrompt }]);
  const sessionId = useCallback(() => panel.controller.snapshot().context.sessionId, [panel]);
  const session = useConversationSession(props.sessions, labels.sessions, sessionId, props.knownSecrets);
  const presentation = panel.presentation(state);
  const resumePicker = presentation?.kind === 'resume' && state.picker ? presentation.rows : null;
  const seenWorkers = useRef(new Set<string>()), seenRuns = useRef(new Map<string, string>()), snapshotOpened = useRef(false);
  const pollMs = props.pollMs ?? ledger?.workerHeartbeatMs ?? 5000;
  const workRef = useRef<ReturnType<typeof useWorkSurface> | null>(null), activeWorkers = useRef(false);
  const pushMode = useSurfacePushFeed(ledger?.followEvents, ledger?.scopeId ?? '', pollMs, step => {
    if (step.status === 'denied' || step.status === 'not-initialized') workRef.current?.observeWorkers([]);
    // With snapshots, publications are invalidations, never a substitute for typed surface state.
    if (ledger?.readSurfaceSnapshot && step.status === 'applied') return;
    const text = surfaceFollowLine(step, watchRef.current, labels.watchStep, step.status === 'denied' && step.stopped ? labels.watchAccessStopped : labels.watchAccessDenied, labels.watchNotInitialized);
    if (text) push([notice(step.status === 'applied' ? 'info' : 'error', text)]);
  }, mode => { if (labels.watchDelivery) push([notice('info', fillTemplate(labels.watchDelivery, surfaceDeliveryValues(mode, pollMs)))]); },
  ledger?.readSurfaceSnapshot ? async (kinds, signal) => {
    const snapshot = await ledger.readSurfaceSnapshot!(kinds, signal);
    if (signal.aborted) return [];
    if (snapshot.scopeId !== ledger.scopeId) return kinds; const opening = !snapshotOpened.current; snapshotOpened.current = true;
    if (snapshot.workers) {
      activeWorkers.current = snapshot.workers.sources.some(source => source.workers.some(worker => !worker.terminal &&
        (['running', 'created', 'paused'].includes(worker.process) || (worker.identity !== null && worker.process === 'unknown' && worker.files?.heartbeat.phase !== 'exited'))));
      const workers = workerReportToLedgerEntries(snapshot.workers, 'watch').filter(entry => entry.kind === 'worker');
      workRef.current?.observeWorkers(workers);
      if (opening || watchRef.current.workers) { const { seen, fresh } = newWorkerTaskIds(seenWorkers.current, workers); seenWorkers.current = seen; push(fresh); }
    }
    if (snapshot.runs && (opening || watchRef.current.runs)) { const { seen, fresh } = newRunLedgerEntries(seenRuns.current, snapshot.runs, 'watch'); seenRuns.current = seen; push(fresh); }
    if (snapshot.approvals) workRef.current?.observeApprovals(snapshot.approvals);
    return snapshot.denied;
  } : undefined, ledger?.readSurfaceSnapshot ? `${watch.workers}:${watch.runs}` : '', { heartbeatMs: ledger?.workerHeartbeatMs ?? pollMs, active: () => watchRef.current.workers && activeWorkers.current });
  const pushLive = pushMode !== 'poll'; // A refused feed must not restart through fallback polling.
  const followWorkers = ledger?.followEvents ? undefined : ledger?.followWorkers, followRuns = ledger?.followEvents ? undefined : ledger?.followRuns;
  const failed = useCallback((error: unknown) => push([notice('error', `${labels.watchFailed}: ${errorText(error)}`)]), [errorText, labels.watchFailed, push]);
  const mode = useWorklineMode(props.permissionMode, push, errorText, labels.work?.unavailable ?? labels.ledgerUnavailable, labels.mode, props.fullAccess === true);
  const work = useWorkSurface({ panel, state, ledger, labels, push, errorText, pollMs, pushLive, watchingWorkers: watch.workers,
    context: { ...(props.projectRoot ? { project: props.projectRoot } : {}), ...(mode.mode ? { mode: mode.mode } : {}) },
    ...(props.approvalPollMs === undefined ? {} : { approvalPollMs: props.approvalPollMs }) });
  workRef.current = work; decide.current = work.decideApproval;
  const refreshMode = mode.refresh;
  const reasoning = useReasoningPreview(push, labels.reasoning);
  const scratch = useWorklineScratch(props.scratch, session.id, push, errorText, labels.work?.unavailable ?? labels.ledgerUnavailable, labels.scratch);
  useEffect(() => { void refreshMode(); }, [refreshMode]);

  const opening = useRef(props.openingNotices);
  useEffect(() => {
    const notices = opening.current;
    if (notices?.length) push(notices.map(item => notice(item.level, item.text)));
  }, [push]);
  useWorklineWatch(watch.workers && Boolean(ledger) && !pushLive && !ledger?.readSurfaceSnapshot, followWorkers, pollMs, () => ledgerEntriesForWorkers(ledger!, 'watch'), batch => {
    const workers = batch.filter(entry => entry.kind === 'worker').map(entry => ({ ...entry, observedAtMs: Date.now() }));
    work.observeWorkers(workers);
    const { seen, fresh } = newWorkerTaskIds(seenWorkers.current, workers); seenWorkers.current = seen; push(fresh);
  }, failed);
  useWorklineWatch(watch.runs && Boolean(ledger) && !pushLive && !ledger?.readSurfaceSnapshot, followRuns, pollMs, () => ledgerEntriesForRuns(ledger!, 'watch'), batch => {
    const runs = batch.filter(entry => entry.kind === 'run').map(entry => ({ ...entry, observedAtMs: Date.now() }));
    const { seen, fresh } = freshRunCards(seenRuns.current, runs); seenRuns.current = seen; push(fresh);
  }, failed);
  const runTurn = useCallback(async (text: string, mentioned: readonly string[], execution: LocalExecution) => {
    push([chat('user', text)]);
    const startedAtMs = Date.now();
    const signal = execution.signal;
    const stream = panel.stream(execution);
    // T-L5 `@file`: the service attaches the mentioned files (bounded, labelled) to this message; a failure leaves the text as typed.
    const content = await messageWithMentions(text, mentioned, props.attachMentions, signal, push, errorText, labels.mentions);
    // Agent history stays whole for runtime compaction; only plain turns use the message window.
    const system: AgentChatMessage = { role: 'system', content: systemPrompt }, asked = [...history.current, { role: 'user' as const, content }];
    const messages = props.streamTurn ? agentHistory(system, asked) : boundAgentHistory(system, asked, historyMessages);
    try {
      // Cancelled while the files were being attached: nothing is sent.
      if (signal.aborted) return;
      if (props.streamTurn) {
        // Completed units enter scrollback; the open tail names what the active turn waits for.
        const opened = openAssistantStream(startedAtMs);
        let state = opened.state, answer = '';
        setLive({ step: opened, lead: true }); setTurnRunning(true);
        let base: readonly AgentChatMessage[] = messages, appended: AgentChatMessage[] = [];
        // Forward the session and reasoning choices with the composition's generated binding callback.
        for await (const delta of props.streamTurn(messages, signal, { ...(reasoning.current.current ? {} : { reasoning: 'off' as const }), sessionId: execution.input.context.sessionId, onTurnBound: stream.onTurnBound,
          ...(mode.fullAccess.current ? { fullAccess: true as const } : {}) })) {
          if (delta.kind === 'text') answer += delta.text;
          if (delta.kind === 'message') appended.push(delta.message);
          session.noteContext(delta); if (delta.kind === 'usage') usage.current = addSessionUsage(usage.current, delta);
          if (delta.kind === 'approval') {
            stream.approval(delta);
            if (delta.phase === 'settled' && delta.outcome === 'unsettled') work.noteUnsettled(delta.approvalId);
          }
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
        history.current = next.length || base !== messages ? agentHistory(base[0]!, [...base, ...next]) : messages;
        push(await session.save(history.current));
      } else {
        const reply = await completeTurn(plainChatHistory(messages), signal);
        history.current = boundAgentHistory(messages[0]!, [...messages, { role: 'assistant', content: reply, toolCalls: [] }], historyMessages);
        push(await session.save(history.current));
        // Render seam (P3): the complete reply is one turn of text deltas + `done`, printed as finished markdown units.
        push(assistantLedgerEntries(renderCompleteReply(humanRecordText(reply, props.knownSecrets), startedAtMs, Date.now())));
      }
    } catch (error) {
      history.current = messages;
      push([notice('error', errorText(error))]); throw error;
    } finally {
      setLive(null); setTurnRunning(false);
      // The mode may have been changed elsewhere meanwhile; the status row follows the service.
      void refreshMode();
    }
  }, [completeTurn, errorText, historyMessages, labels.mentions, mode.fullAccess, props.attachMentions, props.streamTurn, push, refreshMode, session, systemPrompt, work, panel]);

  // Runs exactly one line: a chat turn, an immediate slash command or an awaited slash operation. `false` means the view is closing.
  const perform = useCallback(async (line: string, mentioned: readonly string[], execution: LocalExecution): Promise<boolean> => {
    const slash = parseSlashLine(line);
    if (!slash) { await runTurn(line, mentioned, execution); return true; }
    if (slash.command === 'reasoning') { reasoning.run(slash.args); return true; }
    if (slash.command === 'mode' || slash.command === 'scratch') { await (slash.command === 'mode' ? mode.run : scratch)(slash.args); return true; }
    const lineCommands: Readonly<Record<string, ((args: string) => Promise<readonly string[]>) | undefined>> = { ...bindInspectPorts(props.inspect, () => usage.current), mcp: props.mcp, monitor: props.monitor, config: props.config };
    if (slash.command === 'mcp' || slash.command === 'monitor' || slash.command === 'config' || (isInspectSlashCommand(slash.command) && (slash.command !== 'status' || lineCommands['status']))) {
      const lines = lineCommands[slash.command];
      try { push((lines ? await lines(slash.args) : [fillTemplate(labels.commandUnavailable, { part: slash.command })]).map(line => notice('info', line))); }
      catch (error) { push([notice('error', errorText(error))]); }
      return true;
    }
    if (slash.command === 'resume' || slash.command === 'context' || slash.command === 'clear') {
      try {
        const result = await session.run(slash.command, slash.args, history, execution);
        if (result.resumePicker) {
          // The drain stays inside this call, so a line queued while the list loads cannot run under the picker.
          const choice = await panel.pick(execution, { kind: 'resume', rows: result.resumePicker }, result.resumePicker.map((_, index) => String(index)));
          if (choice !== null && !execution.signal.aborted) push((await session.run('resume', String(Number(choice) + 1), history, execution)).entries);
        } else push(result.entries);
      }
      catch (error) { push([notice('error', errorText(error))]); }
      return true;
    }
    const action = immediateSlashAction(slash.command, { ledger, labels, watch: watchRef.current, canRestartService: Boolean(props.restartService), pollMs, ...(ledger?.followEvents ? { followDelivery: pushMode } : {}) });
    // Close the controller before exit so queued work cannot dispatch.
    if (action?.exit) { panel.close(); exit(); return false; }
    if (action) {
      push(action.entries);
      // Queued watch commands see the transition even before React renders.
      if (action.watch) { watchRef.current = action.watch; setWatch(action.watch); }
      return true;
    }
    try {
      if (slash.command === 'service-restart') {
        // TS-WINDOW: a restart interrupts the service's running work, so it asks first (y; n, Enter and Esc keep it running).
        const window = labels.work?.window;
        if (!window) { push([notice('error', labels.serviceRestartUnavailable)]); return true; }
        const answer = await panel.pick(execution, { kind: 'window', title: window.restartTitle, body: [window.restartDetail], hints: window.restartPrompt, confirm: true }, ['allow', 'deny']);
        if (execution.signal.aborted || answer === null) return true;
        push([notice('info', answer === 'allow' ? await props.restartService!() : window.restartKept)]);
      }
      else if (slash.command === 'approvals' || slash.command === 'cancel') await work.run(slash.command, slash.args, execution);
      else push(await runLedgerCommand(slash.command as 'workers' | 'run' | 'runs' | 'transcript', slash.args, ledger!, labels));
    }
    catch (error) { push([notice('error', errorText(error))]); }
    return true;
  }, [errorText, exit, labels, ledger, mode.run, props.inspect, props.mcp, props.monitor, props.config, props.restartService, pollMs, pushMode, push, reasoning.run, runTurn, scratch, session, work.run, panel]);

  execute.current = async execution => {
    await perform(execution.input.text, execution.input.mentions, execution);
  };
  const inputSequence = useRef(0);
  const submit = (text: string, mentions: readonly string[] = []) => {
    const before = panel.controller.snapshot();
    if (panel.controller.send({ kind: 'submit', context: before.context, inputId: `input-${++inputSequence.current}`, text, mentions }) && before.active)
      push([notice('info', `${labels.queued}: ${text.trim()}`)]);
  };
  const cancel = () => {
    const current = panel.controller.snapshot(), active = current.active;
    if (active) panel.controller.send(active.binding
      ? { kind: 'cancel', context: current.context, turnId: active.binding.turnId }
      : { kind: 'cancel-input', context: current.context, inputId: active.inputId });
  };

  const ledgerLabels: LedgerEntryLabels = { runCard: labels.runCard, workerCard: labels.workerCard, chatUser: labels.roleUser, chatAssistant: labels.roleAssistant,
    render: labels.render, ...(labels.work ? { workerLine: labels.work.workerLine } : {}) };
  const choosing = resumePicker !== null || work.pickerOpen;
  const finishResume = (choice: number | null) => { panel.choose(state.picker?.pickerHandle, choice === null ? null : String(choice)); };
  return (
    <HumanTextContext.Provider value={props.knownSecrets}>
    <WindowStackProvider>
    <Box flexDirection="column">
      <Static key={buffer.epoch} items={[...buffer.pending]}>
        {row => <LedgerEntryRow key={row.seq} entry={row.entry} labels={ledgerLabels} />}
      </Static>
      {live ? <AssistantLive tail={live.step.liveTail} narration={live.step.narration} labels={labels.render} lead={live.lead} activeTool={live.step.activeTool}
        waiting={live.step.waiting} reasoningPreview={reasoning.show ? live.step.reasoningPreview : []} /> : null}
      {work.region}
      {resumePicker && !work.modalOpen && !work.pickerOpen
        ? <Window title={[span(labels.work?.window.resumeTitle ?? '/resume')]} status={[span(String(resumePicker.length))]} hints={labels.work?.window.pick ?? ''}
          position={labels.work?.window.position ?? '{from}-{to}/{total}'} footerRows={ARROW_PICKER_ROWS + 2}
          footer={focused => <ArrowPicker rows={resumePicker.map(item => item.label)} styledRows={resumePicker.map(item => item.spans ?? [])} active={focused}
            details={resumePicker.map(item => item.hiddenNotice)} onSelect={finishResume} onCancel={() => finishResume(null)} />} /> : null}
      <Text {...palette.accent}>{labels.banner}</Text>
      <StatusStrip target={target} state={cancelling ? labels.statusCancelling : busy && !choosing ? labels.statusBusy : labels.statusReady} busy={busy && !choosing}
        queued={state.queued.length} labels={{ ...labels.render, selfSourceFloor: labels.selfSourceFloor }} mode={mode.mode} selfSource={props.selfSource} cancellable={turnRunning && !cancelling} />
      {/* The composer owns input: Enter submits (queued FIFO while busy), Esc/Ctrl+C cancel a turn, exit is two Ctrl+C or Ctrl+D.
          An open decision card or arrow picker takes the keyboard away from it. */}
      <StackComposer prompt={labels.prompt} labels={{ ...labels.composer,
        slash: Object.fromEntries(Object.entries(labels.composer.slash).map(([key, text]) => [key, projectHumanPickerText(text, props.knownSecrets).label])) }}
        busy={busy} active={!work.modalOpen && !work.pickerOpen && resumePicker === null}
        onSubmit={(text, mentioned) => void submit(text, mentioned)} onCancel={cancel} onExit={() => { panel.close(); exit(); }}
        {...(props.inputHistory ? { history: props.inputHistory } : {})} {...(props.mentions ? { mentions: props.mentions } : {})}
        {...(props.mentionDelayMs === undefined ? {} : { mentionDelayMs: props.mentionDelayMs })} />
      <Text {...palette.muted}>{labels.hint}</Text>
    </Box>
    </WindowStackProvider>
    </HumanTextContext.Provider>
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
  // Ink 7 treats CI env as non-interactive even on a TTY (ink.js resolveInteractiveOption); the workline runs on a TTY, so force it there.
  const instance: Instance = render(createElement(WorklinePaletteProvider, { palette, children: view }),
    { exitOnCtrlC: false, patchConsole: false, ...((stdout ?? process.stdout).isTTY === true ? { interactive: true } : {}), ...(stdin ? { stdin } : {}), ...(stdout ? { stdout } : {}) });
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
