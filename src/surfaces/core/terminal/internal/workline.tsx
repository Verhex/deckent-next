import { useOnboardingHandoff, type OnboardingFocus, type OnboardingHandoff } from '#surfaces/core/terminal-onboarding/index.js';
import { useInstructionContext, type ProjectInstructionLabels } from '#surfaces/core/project-instructions/index.js';
import type { ProjectInstructionPort } from '#engine/index.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, createElement, type ComponentProps } from 'react';
import { renderToString, Box, Static, Text, useApp, useStdout, useWindowSize } from 'ink';
import { cardCopy, runCopyCommand, runTerminalHost, type TerminalHostContext, type TerminalShell, type TerminalThemeRequest, useAttentionNotice, useDraftHandoffs, type ClipboardResult, type CopyLabels, type DraftHandoffLabels, type ExternalEditorPort, type TerminalHandover } from '#surfaces/core/terminal-host/index.js';
import { useWorklinePanel, type LocalExecution, LedgerEntryRow, liveRunEntry, dispatchWorkCommand, openingWorkText, systemSummaryEntry, useRunCompletion, type LedgerEntryLabels, immediateSlashAction, type WatchState, type MonitorWindowLoader, type WorklineActionLabels, useWorkSurface,
  ActiveWorkStrip, ActiveWorkSummary, activeWorkItems, activeWorkModelNote, activeWorkRows, useActiveWorkClock, type ActiveDo, type ActiveWorkItem, isToolStep, rowSpaceBefore } from '#surfaces/core/terminal-work/index.js';
import { WorklinePaletteProvider, useWorklinePalette, parseSlashLine, keepsTypedArgument, WORKLINE_SLASH_COMMANDS, isInspectSlashCommand, addSessionUsage, bindInspectPorts, EMPTY_SESSION_USAGE, type InspectSlashPorts, type SessionUsageView, useWorklineWatch, surfaceFollowLine, useSurfacePushFeed,
  type TerminalLocalContext, type WorklineInkPalette, type WorklineStreamTurn, nearestSlashCommand, secretGrantTurn, offerMcpGrants, treeChangeLine, openingGate, type SecretGrantCardPort, type SecretGrantQuestion } from '#surfaces/core/terminal-kit/index.js';
import { StatusStrip } from './status-strip.js';
import { useLiveWindows } from './workline-live.js';
import { AssistantLive, openAssistantStream, renderAssistantStream, renderCompleteReply, type AssistantStreamStep, type AssistantRenderLabels, type ToolGroupView } from '#surfaces/core/terminal-render/index.js';
import { HumanTextContext, humanRecordText, projectHumanPickerText, RenderGlyphsContext, useRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { ErrorRegistry, redactForRecord, type KnownSecretSnapshot } from '#platform/index.js';
import { isRunIntentResult, type RunPlanningResult } from '#engine/index.js';
import type { BrainPlanProgress } from '#domain/index.js';
import { assistantLedgerEntries, streamStepEntries, workerReportToLedgerEntries, WORK_LEDGER_SCHEMA_VERSION, type WorkLedgerEntry, ledgerEntriesForWorkers, loadRunViewsForWatch, type WorklineLedgerPorts, fillTemplate, agentHistory, appendLedger, boundAgentHistory, compactLedger, EMPTY_LEDGER, LEDGER_TAIL_LIMIT, plainChatHistory, type AgentChatMessage, type ChatTurnMessage, type LedgerBuffer, type LedgerRow, notice } from '#surfaces/core/terminal-ledger/index.js';
import { useConversationSession, type ConversationSessionLabels, type ConversationSessionPort } from '#surfaces/core/terminal-session/index.js';
import { freshContextHistory } from '#surfaces/core/terminal-conversation/index.js';
import MODEL_SWITCH from './model-switch.json' with { type: 'json' };
import { ArrowPicker, ARROW_PICKER_ROWS } from '#surfaces/core/terminal-picker/index.js';
import { CardCopyContext, Window, WindowDecideHintContext, WindowOpeningContext, WindowNoteContext, PinnedWorkline, WindowFocusHint, useFocusOwner, type WindowNote,
  FullscreenWorkline, ChatViewport, fullscreenFrameRows, fullscreenInfoRows, type ChatViewportLabels, DecisionArmContext, DECISION_ARM_DEFAULT, DecisionArmLabelsContext, type DecisionArmLabels,
  WheelContext, PointerContext, usePointerCopy, CopiedNotice, type PointerSource, type WheelSource } from '#surfaces/core/terminal-window/index.js';
import { INFO_WINDOW_COMMANDS, useInfoWindow, type WorklineInfo } from './workline-info.js';
import { formatContextTokens, span } from '#surfaces/core/terminal-render/index.js';
import { Composer, type ComposerLabels, type ComposerHistoryEntry, type ComposerHistoryPort, type ComposerMentionPort } from '#surfaces/core/terminal-composer/index.js';
import { messageWithMentions, type WorklineAttachMentions, type WorklineMentionLabels } from '#surfaces/core/terminal-conversation/index.js';
import { PermissionModeKeys, useWorklineMode, type WorklineModeLabels, type WorklinePermissionModePort } from './workline-mode.js';
import { useReasoningPreview, type WorklineReasoningLabels } from './workline-reasoning.js';
import { runScratchWindow, useWorklineScratch, type WorklineScratchLabels, type WorklineScratchPort } from '#surfaces/core/terminal-session/index.js';
import { askGrantWindow, askSlashWindow, isReasoningChoice, reasoningSpec, reasoningStatus, unknownCommandSpec, useWindowSlot, type SlashPickSpec, type SlashWindowLabels } from '#surfaces/core/terminal-session/index.js';
import { CLEAR_SCREEN_AND_SCROLLBACK, CLEAR_SCROLLBACK, startupFrame, writeStartup, type WorklineStartup } from '#surfaces/core/terminal-host/index.js';
import { useTranscriptBlocks } from './workline-transcript.js';
import { useWorklineSettings, type WorklinePanels } from './workline-settings.js';
import type { ModelPanelChoice, ModelPanelReference } from '#surfaces/core/terminal-panels/index.js';
import { openTaskAction, type TaskWindowAction } from '#surfaces/core/terminal-work/index.js';
import { useDeliveryWindows, type DeliveryWindowLabels, type TerminalDeliveryPort } from '#surfaces/core/terminal-delivery/index.js';
import { shortId } from '#platform/index.js';
import { QueuedLines, useTurnSteer, type QueueLabels, type QueueReason } from './workline-queue.js';

export interface WorklineLabels extends WorklineActionLabels {
  readonly banner: string;
  readonly prompt: string;
  readonly statusReady: string;
  readonly statusBusy: string;
  readonly statusCancelling: string;
  readonly selfSourceFloor?: string;
  /** T3/T4 (Alt+Up, Ctrl+G): the words for a message taken back out of the queue and for an editor that left the draft as it was. */
  readonly handoff?: DraftHandoffLabels;
  readonly hint: string;
  readonly focus?: { readonly composer: string; readonly window: string; readonly decide?: string };
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
  /** T1 `/copy` words (`tuicopy.*`); without them `/copy` is unavailable. */
  readonly copy?: CopyLabels;
  /** SLASH-WINDOWS (owner 2026-10-08): the words of the `/reasoning`, `/scratch` and unknown-command windows. Present = the rich terminal takes no typed slash arguments. */
  readonly windows?: SlashWindowLabels;
  /** TESLIM-PENCERESI: the delivery window's words (terminal.delivery.*); without them (or without the port) `/deliver` is unavailable. */
  readonly delivery?: DeliveryWindowLabels;
  /** Full-window chat viewport words (terminal.viewport.*): the row shown while scrolled back. */
  readonly viewport?: ChatViewportLabels;
  /** A decision's hint row before its keys count (terminal.decision.*); neutral marks without them. */
  readonly decisionArm?: DecisionArmLabels;
  /** Journey queued-messages: why queued lines wait (`queued` names a running turn), the withdraw key and the added-line words; neutral without them. */
  readonly queue?: QueueLabels;
  /** Owner S4: the `/uninstall` window — what removal does, why it runs in the shell, and the copyable command (`summary`/`copied`: `{command}`). */
  readonly uninstall?: Readonly<{ title: string; lines: readonly string[]; label: string; copy: string; close: string; summary: string; copied: string }>;
  /** ADAYLAR 16b: the configured model cannot use tools here (said once at the start). */
  readonly toolsNone?: string;
}
export type WorklineCompleteTurn = (messages: readonly ChatTurnMessage[], signal: AbortSignal) => Promise<string>;
export type WorklineErrorText = (error: unknown) => string;
export interface WorklineProps {
  readonly onboarding?: OnboardingHandoff;
  readonly doPlan?: { readonly planning: string; readonly cancelHint: string; readonly requestHint: string;
    readonly localFallback?: string; readonly localNoTools?: string; // owner option A (2026-10-28, LAW-AUDIT-DR2-01 K1-K8): run here only on "nothing set up", always behind the card
    readonly dirty?: Readonly<{ check: () => Promise<boolean>; title: string; body: string; go: string; cancel: string; prompt: string; cancelled: string }>; readonly offerHere?: (code: unknown) => Promise<boolean>; readonly chatReady?: () => Promise<boolean>; readonly tree?: () => Promise<Readonly<{ state: string; files: ReadonlyMap<string, string> }>>;
    readonly here?: Readonly<{ title: string; effect: string; run: string; setup: string; cancel: string; noWorkers: string; noModel: string; prompt: string; cancelled: string; changed: string; unchanged: string; unread: string; canSetup?: () => Promise<boolean> }>;
    /** f3 (owner Q-H4): the shown texts of a quota wait — the window body, its cancel hint and the strip's local reset time. */
    readonly billingSwitch: string;
    readonly quotaWait?: (progress: Extract<BrainPlanProgress, { kind: 'quota-wait' }>) => Readonly<{ body: string; hint: string; untilText: string }>;
    readonly plan: (intent: string, commandId: string, signal: AbortSignal, reference?: ModelPanelReference, observe?: (progress: BrainPlanProgress) => void, pending?: import('#engine/index.js').RunIntentRecord) => Promise<RunPlanningResult>;
    readonly lines: (result: RunPlanningResult) => readonly string[] };
  readonly labels: WorklineLabels;
  /** Trusted persistent identities from CLI composition; session identity is generated once by the local adapter. */
  readonly context: Omit<TerminalLocalContext, 'kind' | 'sessionId'>;
  readonly target: string;
  readonly systemPrompt: string;
  readonly projectInstructions?: { readonly port: ProjectInstructionPort; readonly labels: ProjectInstructionLabels };
  /** Window of the plain (non-streaming) path only; the agent path sends the whole conversation (T-L5, Astra 2091 R1). */
  readonly historyMessages: number;
  readonly maxTrackedRuns?: number | undefined;
  readonly model?: string;
  readonly provider?: string;
  readonly completeTurn: WorklineCompleteTurn;
  readonly errorText: WorklineErrorText;
  readonly ledger?: WorklineLedgerPorts;
  readonly pollMs?: number;
  /** Streamed form of the governed turn (S-STREAM); when present it replaces `completeTurn` for chat. */
  readonly streamTurn?: WorklineStreamTurn;
  /** PRE-8: the first-use card of a main-vault key without a grant in this project (streamed turns; absent: the typed refusal only). */
  readonly secretGrant?: SecretGrantCardPort;
  /** Approval notification cadence override (tests); production uses max(pollMs, 10 s). */
  readonly approvalPollMs?: number;
  /** Governed restart of the runtime service onto the current build; returns the line to show. */
  readonly restartService?: () => Promise<string>; readonly restartNotes?: () => Promise<readonly string[]>; // D-01: e.g. a running image build the restart stops
  readonly startService?: () => Promise<string>; readonly mcpGrants?: Readonly<{ keys: () => Promise<readonly Readonly<{ name: string; project: string }>[]>; given: (name: string) => string }>; readonly serviceLost?: (listener: (text: string) => void) => () => void; // BeUser M-09: starts the absent runtime service (the terminal's autostart, never a stop), returns the line; D-05: hears, once per absence, that it stopped under this terminal
  /** Shown once at the top of the ledger when the view opens. alpha.60 B (draw first): `opening` is what the launch settles after the frame — `ready` (the runtime service answered; rejects with the typed start failure), the later `notices` (service state; read once the view is mounted) and the one `wait` line of a line sent before it. */
  readonly openingNotices?: ReadonlyArray<{ readonly level: 'info' | 'warning' | 'error'; readonly text: string }>; readonly opening?: Readonly<{ ready: Promise<unknown>; notices: () => Promise<NonNullable<WorklineProps['openingNotices']>>; wait: string }>;
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
  /** Display-only home prefix for approval paths; the real project root remains the operation context. */
  readonly homeDirectory?: string;
  /** `/monitor` as a window (T3 L5): loads the monitor body from the host, which owns it (this unit never imports the monitor). Without it `/monitor` answers as notice lines. */
  readonly monitorWindow?: MonitorWindowLoader;
  /** T3 L4: the `/config` and `/mcp` window ports and every panel's words; `/mode`'s port is this view's own mode port. Absent: text commands only. */
  readonly panels?: WorklinePanels;
  /** SW-1: bare `/help`, `/status`, `/usage`, `/doctor`, `/scope`, `/context` open information windows (typed models; one summary line on close). Absent: text. */
  readonly info?: WorklineInfo;
  /** Spend refusal recovery, through the host's governed account/management ports. */
  readonly spending?: () => Promise<import('#surfaces/core/terminal-window/index.js').InfoView>;
  /** `/clear` erases the screen and the terminal's scrollback; false where escape sequences must not be sent (TERM=dumb, NO_COLOR — owner
   *  2026-10-08). A non-TTY output is never cleared. */
  readonly clearScreen?: boolean;
  /** TESLIM-PENCERESI: check → prepare → deliver (and adopt) through the trusted composition's verified-terminal confirmation port.
   *  `confirmTimeoutMs`: how long the port's exact card waits for a fresh y (the session approval time). */
  readonly delivery?: { readonly port: TerminalDeliveryPort; readonly confirmTimeoutMs: number };
  /** TERMINAL-SABIT-DUZEN (owner 2026-10-18): the full-window layout on the alternate screen (`runTerminalWorkline` sets it on a TTY unless
   *  `terminal.layout` is `inline`). Absent: the inline main-screen layout. */
  readonly fullscreen?: boolean;
  /** Rows the full-window conversation keeps to scroll back through (`terminal.viewportRows`). */
  readonly viewportRows?: number;
  /** Decision arming override (tests); production uses the registry value (`terminal-window` decision.json). */
  readonly decisionArmMs?: number;
  /** The full window's mouse wheel (SGR reports taken out of the input by `runTerminalWorkline`). */
  readonly wheel?: WheelSource;
  /** TERM-POLISH: the full window's left-button pointer (click-and-drag selection) and the clipboard write of the selection (OSC 52). */ readonly pointer?: PointerSource; readonly copyText?: (text: string) => void;
  /** T4 (Ctrl+G): the person's editor (an adapter) and the host's switch of its mouse and focus reports while it runs. */
  readonly externalEditor?: ExternalEditorPort; readonly handover?: TerminalHandover;
  /** T2: rings the terminal bell while the window is in the background (the host decides); absent when the setting is off. */
  readonly notify?: () => void;
  /** T1 `/copy`: the clipboard request writer of the host (any real TTY); absent = `/copy` says it is unavailable. */ readonly clipboard?: (text: string) => ClipboardResult;
  /** The opening frame drawn as the first block of the full-window conversation (until `/clear`). */
  readonly startup?: WorklineStartup;
  /** The full-window conversation as text, read once after the view closes so it is left in the terminal's own scrollback. */
  readonly transcriptExit?: { current: (() => string) | null };
  /** T2: ask for terminal focus reports and ring BEL when work finishes or a card waits while the window is unfocused (`terminal.notify`). */
  readonly attention?: boolean;
  /** alpha.60 C: what the launch shell kept while the host loaded — the draft as typed and the lines sent meanwhile, sent in order after mount
   *  through the opening's send gate. */
  readonly initialDraft?: ComposerHistoryEntry | null; readonly armedAt?: number | null; // a first idle Ctrl+C in the shell: the next one quits
  readonly queuedInputs?: readonly Readonly<{ text: string; mentions: readonly string[]; entry: ComposerHistoryEntry }>[];
  /** ADAYLAR 16b (QW): whether the configured model takes tools (`describeTerminalChat` `tools`); `none` is said once as a system line. */
  readonly modelTools?: 'available' | 'none' | 'unknown';
}
/** The stack routes input by the window's opening cause; Ctrl+O transfers the one input owner. */
function StackComposer({ elsewhere, ...props }: ComponentProps<typeof Composer> & { readonly elsewhere?: () => boolean }) {
  const owner = useFocusOwner();
  return <Composer {...props} active={(props.active ?? true) && owner.composing} acceptsInput={() => owner.inputAllowed() && !elsewhere?.()} />;
}
function chat(role: 'user' | 'assistant', text: string): WorkLedgerEntry {
  return Object.freeze({ schemaVersion: WORK_LEDGER_SCHEMA_VERSION, kind: 'chat' as const, id: 'chat', role, text });
}
function useLedgerBuffer(historyLimit: number) {
  const [buffer, setBuffer] = useState<LedgerBuffer>(EMPTY_LEDGER);
  const held = useRef<WorkLedgerEntry[] | null>(null);
  const push = useCallback((entries: readonly WorkLedgerEntry[]) => { if (held.current) held.current.push(...entries); else setBuffer(current => appendLedger(current, entries, LEDGER_TAIL_LIMIT, historyLimit)); }, [historyLimit]);
  const hold = useCallback(() => { held.current ??= []; return () => { const rows = held.current ?? []; held.current = null; if (rows.length) push(rows); }; }, [push]);
  const reset = useCallback(() => setBuffer(current => Object.freeze({ epoch: current.epoch + 1, nextSeq: current.nextSeq, pending: Object.freeze([]), tail: Object.freeze([]), history: Object.freeze([]) })), []);
  useLayoutEffect(() => {
    const printed = buffer.pending.length;
    setBuffer(current => compactLedger(current, printed));
  }, [buffer.pending.length]);
  return { buffer, push, reset, hold };
}
export function WorklineApp(props: WorklineProps) {
  const { labels, target, systemPrompt, historyMessages, completeTurn, errorText, ledger } = props;
  const palette = useWorklinePalette();
  const { exit } = useApp();
  const { buffer, push, reset, hold } = useLedgerBuffer(props.fullscreen === true ? props.viewportRows ?? LEDGER_TAIL_LIMIT : 0);
  const stdout = useStdout();
  const [pinnedMode] = useState(() => stdout.stdout.isTTY === true && props.clearScreen !== false);
  const size = useWindowSize(), pinned = pinnedMode && size.rows > 0 && size.columns > 0;
  const [fullscreenMode] = useState(() => pinnedMode && props.fullscreen === true);
  const [searchOpen, setSearchOpen] = useState(false), searchFocus = useRef(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const onSearch = useCallback((open: boolean) => { searchFocus.current = open; setSearchOpen(open); }, []);
  const { selection: pointerSelection, copied } = usePointerCopy(props.pointer, props.copyText);
  const [bannerShown, setBannerShown] = useState(true);
  const { panel, state, execute, decide } = useWorklinePanel(props.context, props.sessions);
  const handoffs = useDraftHandoffs<TerminalLocalContext, ComposerHistoryEntry>({ controller: panel.controller, say: (level, text) => push([notice(level, text)]), labels: labels.handoff,
    editor: props.externalEditor, handover: props.handover, hold });
  const busy = state.phase === 'running' || state.phase === 'cancelling', cancelling = state.phase === 'cancelling';
  const [turnRunning, setTurnRunning] = useState(false), [chatting, setChatting] = useState(false); // `chatting`: a chat line runs (either path), for the queue's reason
  const [planning, setPlanning] = useState(false);
  const [planWait, setPlanWait] = useState<Readonly<{ body: string; hint: string }> | null>(null);
  const [doRunning, setDoRunning] = useState(false);
  const [activeDo, setActiveDo] = useState<ActiveDo | null>(null);
  const [stripFocused, setStripFocused] = useState(false), stripFocus = useRef(false);
  const [live, setLive] = useState<{ readonly step: AssistantStreamStep; readonly lead: boolean } | null>(null);
  const usages = useRef(new Map<string, SessionUsageView>());
  const [watch, setWatch] = useState<WatchState>({ workers: false, runs: false });
  const watchRef = useRef(watch);
  const instructions = useInstructionContext(props.projectInstructions?.port, props.projectInstructions?.labels);
  const history = useRef<readonly AgentChatMessage[]>([{ role: 'system', content: systemPrompt }]);
  const sessionId = useCallback(() => panel.controller.snapshot().context.sessionId, [panel]);
  const usage = () => usages.current.get(sessionId()) ?? EMPTY_SESSION_USAGE;
  const session = useConversationSession(props.sessions, labels.sessions, sessionId, props.knownSecrets);
  const sessionNow = useRef(session); sessionNow.current = session;
  const presentation = panel.presentation(state);
  const resumePicker = presentation?.kind === 'resume' && state.picker ? presentation.rows : null;
  const pollMs = props.pollMs ?? ledger?.workerHeartbeatMs ?? 5000;
  const workRef = useRef<ReturnType<typeof useWorkSurface> | null>(null), activeWorkers = useRef(false);
  const [watchStatus, setWatchStatus] = useState('');
  const [watchStatusLines, setWatchStatusLines] = useState<readonly string[]>([]);
  const liveRef = useRef<ReturnType<typeof useLiveWindows> | null>(null);
  const taskActionRef = useRef<(action: TaskWindowAction) => void>(() => undefined), taskActions = useRef(new Map<string, TaskWindowAction>());
  const announced = useRef(new Set<string>()), openingTold = useRef(false);
  const [completionRefused, setCompletionRefused] = useState(false);
  const completion = useRunCompletion({ limit: props.maxTrackedRuns, labels: labels.work?.jobs, ledger, pollMs, refused: completionRefused, push, errorText });
  const trackedRuns = useMemo(() => completion.tracked.map(item => item.run), [completion.tracked]);
  const deliveries = useDeliveryWindows({ port: props.delivery?.port, labels: labels.delivery, runs: trackedRuns, summary: (text, level) => push([systemSummaryEntry(text, level)]),
    errorText, position: labels.work?.window.position ?? '{from}-{to}/{total}', known: props.knownSecrets, confirmTimeoutMs: props.delivery?.confirmTimeoutMs ?? 0 });
  const workNote = useRef({ active: activeDo, runs: completion.tracked, deliveries: deliveries.pending });
  workNote.current = { active: activeDo, runs: completion.tracked, deliveries: deliveries.pending };
  const pushMode = useSurfacePushFeed(ledger?.followEvents, ledger?.scopeId ?? '', pollMs, step => {
    if (step.status === 'denied' || step.status === 'not-initialized') setCompletionRefused(true);
    if (step.status === 'denied' || step.status === 'not-initialized') workRef.current?.observeWorkers([]);
    // A stopped follow leaves nothing to update: the window closes (its single summary line records the access refusal).
    // With snapshots, publications are invalidations, never a substitute for typed surface state.
    if (ledger?.readSurfaceSnapshot && step.status === 'applied') return;
    const text = surfaceFollowLine(step, watchRef.current, labels.watchStep, step.status === 'denied' && step.stopped ? labels.watchAccessStopped : labels.watchAccessDenied, labels.watchNotInitialized);
    if (text) setWatchStatusLines(lines => [...lines.filter(line => line !== text), text].slice(-4));
    // SLASH-WINDOWS (integration): an access refusal or a missing identity is a system event the person must see even with no watch window open:
    // one system line in the error tone, once per distinct text. A stopped follow with an open window says it in that window's closing line instead.
    if (text && (step.status === 'denied' || step.status === 'not-initialized') && !announced.current.has(text)) {
      announced.current.add(text);
      if (!(step.status === 'denied' && step.stopped && liveRef.current?.isOpen())) push([systemSummaryEntry(text, 'error')]);
    }
    if (step.status === 'denied' && step.stopped) liveRef.current?.close(text ?? undefined);
  }, delivery => {
    // A refused or uninitialized feed delivers nothing: the window names no delivery mode then (its status lines carry the refusal).
    if (labels.work?.jobs) setWatchStatus(delivery === 'push' || delivery === 'poll' ? fillTemplate(labels.work.jobs.watchStatus, { mode: delivery === 'poll' ? labels.work.jobs.poll : labels.work.jobs.push }) : '');
  },
  ledger?.readSurfaceSnapshot ? async (kinds, signal) => {
    const snapshot = await ledger.readSurfaceSnapshot!(kinds, signal);
    if (signal.aborted) return [];
    if (snapshot.scopeId !== ledger.scopeId) return kinds;
    let active = 0;
    if (snapshot.workers) {
      active = snapshot.workers.sources.reduce((sum, source) => sum + source.workers.filter(worker => !worker.terminal &&
        (['running', 'created', 'paused'].includes(worker.process) || (worker.identity !== null && worker.process === 'unknown' && worker.files?.heartbeat.phase !== 'exited'))).length, 0);
      activeWorkers.current = active > 0;
      const workers = workerReportToLedgerEntries(snapshot.workers, 'watch').filter(entry => entry.kind === 'worker');
      workRef.current?.observeWorkers(workers);
    }
    if (snapshot.runs) {
      completion.observe(snapshot.runs);
      if (watchRef.current.runs) liveRef.current?.setRuns(snapshot.runs.map((run, index) => liveRunEntry(run, `watch-run-${index}`)));
    }
    if (snapshot.approvals) workRef.current?.observeApprovals(snapshot.approvals);
    // I-5: the opening snapshot says once whether work is running (one system line from what it was allowed to read; nothing when idle).
    if (!openingTold.current) {
      openingTold.current = true;
      const text = labels.work?.jobs ? openingWorkText(snapshot.runs, active, labels.work.jobs) : null;
      if (text) push([systemSummaryEntry(text)]);
    }
    return snapshot.denied;
  } : undefined, ledger?.readSurfaceSnapshot ? `${watch.workers}:${watch.runs}:${completion.generation}` : '', { heartbeatMs: ledger?.workerHeartbeatMs ?? pollMs, active: () => watchRef.current.workers && activeWorkers.current });
  const pushLive = pushMode !== 'poll'; // A refused feed must not restart through fallback polling.
  const followWorkers = ledger?.followEvents ? undefined : ledger?.followWorkers, followRuns = ledger?.followEvents ? undefined : ledger?.followRuns;
  const failed = useCallback((error: unknown) => setWatchStatusLines([`${labels.watchFailed}: ${errorText(error)}`]), [errorText, labels.watchFailed]);
  const slot = useWindowSlot(), slotNow = useRef(slot); slotNow.current = slot;
  // FIX8a R25/R26/R28: the mode port must not change with the window slot; its identity keys the mode refresh and the `/mode`/`/model` reads.
  const permissionMode = useMemo(() => props.permissionMode ? { ...props.permissionMode,
    ...(props.permissionMode.open ? { open: (target: Exclude<import('#domain/index.js').PermissionMode, 'standart'>) => props.permissionMode!.open!(target,
      (question, signal) => askGrantWindow(slotNow.current, labels.work?.window.position ?? '{from}-{to}/{total}', question, signal)) } : {}) } : undefined,
  [props.permissionMode, labels.work?.window.position]);
  const mode = useWorklineMode(permissionMode, push, errorText, labels.work?.unavailable ?? labels.ledgerUnavailable, labels.mode, props.fullAccess === true, sessionId, props.opening?.ready);
  const work = useWorkSurface({ panel, state, ledger, labels, push, errorText, pollMs, pushLive, watchingWorkers: watch.workers,
    context: { ...(props.projectRoot ? { project: props.projectRoot } : {}), ...(props.homeDirectory ? { home: props.homeDirectory } : {}), ...(mode.stop ? { mode: mode.stop } : {}) },
    ...(props.approvalPollMs === undefined ? {} : { approvalPollMs: props.approvalPollMs }) });
  workRef.current = work; decide.current = work.decideApproval;
  const liveWin = useLiveWindows({ work: labels.work, workers: work.workers, watch, watchRef, setWatch, push, errorText, monitorWindow: props.monitorWindow, status: humanRecordText(watchStatus, props.knownSecrets), statusLines: watchStatusLines.map(text => humanRecordText(text, props.knownSecrets)), positionLabel: labels.work?.window.position ?? '{from}-{to}/{total}', onTaskAction: action => taskActionRef.current(action) });
  liveRef.current = liveWin;
  const refreshMode = mode.refresh, [opened] = useState(() => Promise.all([props.opening?.ready, mode.read])), [gate] = useState(() => openingGate(opened)); // B: no line goes before the service and the first mode read
  const [serviceReady, setServiceReady] = useState(false);
  useEffect(() => { let live = true; const ready = () => { if (live) setServiceReady(true); }; opened.then(ready, ready); return () => { live = false; }; }, [opened]);
  const reasoning = useReasoningPreview(push, labels.reasoning);
  // SLASH-WINDOWS: the one local window slot (information and list windows); `ask` shows a list window in it.
  const windows = { ask: (spec: SlashPickSpec) => askSlashWindow(slot, labels.windows, spec) };
  // T4 MODEL-SWITCH (S19): the model this session pinned with `/model`; read when a turn starts, so the next turn carries it (protocol v23).
  // Astra 2452 P1: the pin belongs to one conversation (sessionId → pin). `/clear` starts a conversation without one; `/resume` finds the resumed
  // conversation's own pin, or none (the configured model) — never another conversation's.
  const [, setModelGeneration] = useState(0);
  const [configuredLabels, setConfiguredLabels] = useState<{ model?: string; provider?: string } | null>(null);
  const pinnedModels = useRef(new Map<string, ModelPanelReference>());
  const pinnedLabels = useRef(new Map<string, { model: string; provider: string }>());
  // CACHE-SLICE1: a switch over a large context asks first (registry threshold); "new context" keeps the person's own instructions, never silently.
  const sessionModel = useMemo(() => ({ pinned: () => pinnedModels.current.get(sessionId()) ?? null,
    largeContext: () => { const tokens = sessionNow.current.measuredPrompt(); return tokens !== null && tokens >= MODEL_SWITCH.askFreshContextAtTokens ? tokens : null; },
    pin: (choice: ModelPanelChoice, fresh?: boolean) => {
      if (fresh) history.current = freshContextHistory(history.current);
      sessionNow.current.forgetContext();
      pinnedModels.current.set(sessionId(), choice.reference);
      pinnedLabels.current.set(sessionId(), { model: choice.label, provider: choice.providerLabel ?? choice.group }); setModelGeneration(value => value + 1);
    } }), [sessionId]);
  const scratch = useWorklineScratch(props.scratch, session.id, push, errorText, labels.work?.unavailable ?? labels.ledgerUnavailable, labels.scratch);
  // T3 L4: `/mode`, `/config`, `/mcp` windows; `/mode`'s port is this view's mode hook (the same service set, grant check and audit as Shift+Tab).
  const settings = useWorklineSettings({ panels: props.panels, permissionMode, mode, panel, state, push, errorText, blocked: work.modalOpen,
    // The pin rides only on the streamed turn (v23); a plain turn could not carry it, so no `/model` window is offered there.
    ...(props.streamTurn ? { sessionModel: { ...sessionModel, reasoning: () => reasoning.current.current ? undefined : 'off' as const } } : {}),
    openApprovals: (approvalId, execution) => work.openApproval(approvalId, execution) });
  // SW-1: bare information commands answer in a window; `/help` answers the command picked in it, which then runs here.
  const infoWindow = useInfoWindow({ info: props.info, slot, push, errorText, slash: labels.composer.slash, ascii: useRenderGlyphs().ascii,
    context: (info, ascii) => session.contextView(history.current, info, ascii, instructions.sourceLines()), input: () => ({ usage: usage(), sessionFullAccess: mode.fullAccess.current }) });
  const performRef = useRef<(line: string, mentioned: readonly string[], execution: LocalExecution) => Promise<boolean>>(async () => true);
  const opening = useRef(props.openingNotices), later = useRef(props.opening?.notices), tools = useRef(props.modelTools);
  useEffect(() => {
    const said = (notices: WorklineProps['openingNotices']) => { if (notices?.length) push(notices.map(item => notice(item.level, item.text))); };
    said(opening.current); void later.current?.().then(said, () => undefined);
    // ADAYLAR 16b: a configured model without tool use is said once, before the person asks it to read or change anything.
    if (tools.current === 'none' && labels.toolsNone) push([systemSummaryEntry(labels.toolsNone, 'warning')]);
  }, [push]); useEffect(() => props.serviceLost?.(text => push([notice('error', text)])), [props.serviceLost, push]);
  useWorklineWatch(watch.workers && Boolean(ledger) && !pushLive && !ledger?.readSurfaceSnapshot, followWorkers, pollMs, () => ledgerEntriesForWorkers(ledger!, 'watch'), batch => {
    const workers = batch.filter(entry => entry.kind === 'worker').map(entry => ({ ...entry, observedAtMs: Date.now() }));
    work.observeWorkers(workers);
  }, failed);
  useWorklineWatch(watch.runs && Boolean(ledger) && !pushLive && !ledger?.readSurfaceSnapshot, followRuns, pollMs, async () => (await loadRunViewsForWatch(ledger!)).map((run, index) => liveRunEntry(run, `watch-${index}`)), batch => {
    const runs = batch.filter(entry => entry.kind === 'run').map(entry => ({ ...entry, observedAtMs: Date.now() }));
    liveRef.current?.setRuns(runs);
  }, failed);
  /** The turn's conversation's own pin (the session the turn is sent under), or nothing: the configured model. */
  const pinnedFor = (id: string | undefined) => { const reference = id ? pinnedModels.current.get(id) : undefined; return reference ? { reference } : {}; };
  const openSetup = useRef<(signal: AbortSignal, focus?: OnboardingFocus) => Promise<void>>(async () => undefined);
  const serviceStarted = useRef(false), offeredGrants = useRef(new Set<string>()); // BeUser M-09: one automatic start per absence, until a turn completes
  const submitRef = useRef<(text: string, mentions: readonly string[], entry: ComposerHistoryEntry) => void>(() => undefined);
  const turnSteer = useTurnSteer({ labels: labels.queue, push, errorText, submit: (text, mentions, entry) => submitRef.current(text, mentions, entry),
    restore: text => setDraft(last => ({ seq: (last?.seq ?? 0) + 1, entry: { text, pastes: [] } })), joined: text => push([chat('user', text)]) });
  const runTurn = useCallback(async (text: string, mentioned: readonly string[], execution: LocalExecution) => {
    push([chat('user', text)]); setChatting(true);
    const startedAtMs = Date.now();
    const signal = execution.signal;
    const stream = panel.stream(execution);
    // T-L5 `@file`: the service attaches the mentioned files (bounded, labelled) to this message; a failure leaves the text as typed.
    const content = await messageWithMentions(text, mentioned, props.attachMentions, signal, push, errorText, labels.mentions);
    // Agent history stays whole for runtime compaction (Astra 2091 R1; the registry token threshold bounds growth); only plain turns use the window.
    const system: AgentChatMessage = { role: 'system', content: systemPrompt + await instructions.prepare(signal) },
      asked = [...history.current, { role: 'user' as const, content: content + activeWorkModelNote({ ...workNote.current, nowMs: Date.now() }) }];
    const messages = props.streamTurn ? agentHistory(system, asked) : boundAgentHistory(system, asked, historyMessages);
    try {
      // Cancelled while the files were being attached: nothing is sent.
      if (signal.aborted) return;
      if (props.streamTurn) {
        // Completed units enter scrollback; the open tail names what the active turn waits for.
        const opened = openAssistantStream(startedAtMs, props.knownSecrets);
        let state = opened.state, answer = '';
        setLive({ step: opened, lead: true }); setTurnRunning(true);
        let base: readonly AgentChatMessage[] = messages, appended: AgentChatMessage[] = [], noted = false;
        const turnIdentity = pinnedLabels.current.get(execution.input.context.sessionId)
          ?? (props.model && props.provider ? { model: props.model, provider: props.provider } : undefined);
        // Forward the session and reasoning choices with the composition's generated binding callback.
        // PRE-8: a turn refused by its local preflight (never bound to the service) may start once more after the first-use grant card.
        let bound = false;
        const start = () => props.streamTurn!(messages, signal, { ...(reasoning.current.current ? {} : { reasoning: 'off' as const }), sessionId: execution.input.context.sessionId,
          onTurnBound: (binding, steer) => { bound = true; stream.onTurnBound(binding); turnSteer.bind(steer ?? null); }, ...(mode.fullAccess.current ? { fullAccess: true as const } : {}), ...pinnedFor(execution.input.context.sessionId) });
        // While the card waits the turn waits for the person, not the model: the open tail is hidden and comes back for the restarted turn.
        const position = labels.work?.window.position ?? '{from}-{to}/{total}', ask = (question: SecretGrantQuestion, cancel: AbortSignal) => {
          setLive(null); return askGrantWindow(slot, position, question, cancel).finally(() => setLive({ step: opened, lead: true })); };
        for await (const delta of props.secretGrant ? secretGrantTurn(start, props.secretGrant, ask, signal, () => bound) : start()) {
          if (delta.kind === 'text') answer += delta.text; if (delta.kind === 'done' && delta.note) noted = true;
          if (delta.kind === 'message') appended.push(delta.message);
          session.noteContext(delta); if (delta.kind === 'usage') { const id = execution.input.context.sessionId;
            usages.current.set(id, addSessionUsage(usages.current.get(id) ?? EMPTY_SESSION_USAGE, { ...delta, identity: turnIdentity })); }
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
          turnSteer.observe(delta); // after the step's rows: a joined line follows the round it joined, a notice follows the answer's footer
          setLive(delta.kind === 'done' ? null : { step, lead: !state.answered });
        }
        // An agent turn's history is exactly its message events (tool calls and results included); a plain stream adds its answer.
        const next = appended.length ? appended : answer ? [{ role: 'assistant' as const, content: answer, toolCalls: [] }] : [];
        history.current = next.length || base !== messages ? agentHistory(base[0]!, [...base, ...next]) : messages;
        push(await session.save(history.current));
        if (props.secretGrant && props.mcpGrants && noted) for (const message of await offerMcpGrants(props.mcpGrants.keys, props.secretGrant, question => askGrantWindow(slot, position, question, signal), offeredGrants.current, props.mcpGrants.given)) push([notice('info', message)]);
      } else {
        const reply = await completeTurn(plainChatHistory(messages), signal);
        history.current = boundAgentHistory(messages[0]!, [...messages, { role: 'assistant', content: reply, toolCalls: [] }], historyMessages);
        push(await session.save(history.current));
        // Render seam (P3): the complete reply is one turn of text deltas + `done`, printed as finished markdown units.
        push(assistantLedgerEntries(renderCompleteReply(humanRecordText(reply, props.knownSecrets), startedAtMs, Date.now())));
      } serviceStarted.current = false;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      const waitsForModel = code === 'TERMINAL_CHAT_NOT_CONFIGURED' && !signal.aborted && await onboarding.usable();
      history.current = (code === 'LOCAL_RUNTIME_UNAVAILABLE' && props.startService) || waitsForModel ? messages.slice(0, -1) : messages; // D11-M2: the resent line is added once, by its own turn
      // Owner 2026-10-30: in a person's terminal a message sent without a model is not sent; it stays the draft and the model card opens (/setup).
      if (waitsForModel) { push([notice('info', props.onboarding!.modelDraft)]); await openSetup.current(signal, 'model'); setDraft(last => ({ seq: (last?.seq ?? 0) + 1, entry: { text, pastes: [] } })); return; }
      if (code === 'LOCAL_RUNTIME_UNAVAILABLE' && props.startService && !signal.aborted && !serviceStarted.current) { serviceStarted.current = true; // BeUser M-09: absent (nothing reached it) → start it as at open, send the line again as a new turn
        const line = await props.startService().catch((failure: unknown) => { push([notice('error', errorText(error)), notice('error', errorText(failure))]); return null; });
        if (line) { push([notice('info', line)]); panel.controller.send({ kind: 'submit', context: panel.controller.snapshot().context, inputId: `input-${++inputSequence.current}`, text, mentions: mentioned }); return; } throw error; }
      push([notice('error', errorText(error))]);
      if (props.spending && props.info && !signal.aborted && (code === 'PROVIDER_SPEND_EXHAUSTED' || code === 'PROVIDER_SPEND_FROZEN')) {
        try { await infoWindow.show(await props.spending(), props.info.labels, signal); }
        catch (failure) { push([notice('error', errorText(failure))]); }
      }
      throw error;
    } finally {
      setLive(null); setTurnRunning(false); setChatting(false); turnSteer.bind(null, true); // a line no result settled goes back into the input
      // The mode may have been changed elsewhere meanwhile; the status row follows the service.
      void refreshMode();
    }
  }, [completeTurn, errorText, historyMessages, labels.mentions, mode.fullAccess, props.attachMentions, props.streamTurn, props.startService, props.onboarding, props.spending, props.info, infoWindow.show, push, refreshMode, session, systemPrompt, work, panel]);

  const [remember, setRemember] = useState<Readonly<{ seq: number; entry: ComposerHistoryEntry }> | null>(null); // AYSE-R3-02: the first job is recalled with Up
  const [draft, setDraft] = useState<Readonly<{ seq: number; entry: ComposerHistoryEntry }> | null>(() => props.initialDraft ? { seq: 1, entry: props.initialDraft } : null);
  const onboarding = useOnboardingHandoff({ port: props.onboarding, submit: (inputId, text) => (setRemember(last => ({ seq: (last?.seq ?? 0) + 1, entry: { text: bareSlash(text), pastes: [] } })), panel.controller.send({ kind: 'submit', context: panel.controller.snapshot().context, inputId, text, mentions: [] })), release: () => props.handover?.release(), reclaim: () => props.handover?.reclaim(), hold, typed: Boolean(props.initialDraft || props.queuedInputs?.length), say: (level, text) => push([notice(level, text)]),
    // /setup (whole, or only the model card) and the opening's card may connect a model: the status row then names the configured one instead of the startup label.
    opened: async () => { const configured = props.panels?.ports.model ? (await props.panels.ports.model.inspect().catch(() => null))?.choices.find(choice => choice.configured) : undefined; if (configured) setConfiguredLabels({ model: configured.label, provider: configured.providerLabel ?? configured.group }); } });
  openSetup.current = onboarding.open;
  // Owner S4: removal runs in the shell with the service stopped and the person's confirmation; here only its explanation and the command.
  const uninstallWindow = async () => {
    const words = labels.uninstall, rich = labels.windows, command = WORKLINE_SLASH_COMMANDS.find(entry => entry.name === 'uninstall')?.shellCommand;
    if (!words || !command) { push([notice('error', fillTemplate(labels.commandUnavailable, { part: 'uninstall' }))]); return; }
    const summary = fillTemplate(words.summary, { command });
    const choice = rich ? await windows.ask({ title: words.title, hints: rich.hints, card: true, body: () => [...words.lines.map(text => ({ spans: [span(text)] })),
      { label: [span(words.label)], spans: [span(command, { bold: true })] }], tree: { title: words.title, items: [{ id: 'copy', label: words.copy, detail: command }, { id: 'close', label: words.close }] } }) : null;
    const copied = choice === 'copy' ? props.clipboard?.(command) : undefined;
    push([copied?.ok ? notice('info', fillTemplate(words.copied, { command })) : systemSummaryEntry(summary)]);
  };
  // Runs exactly one line: a chat turn, an immediate slash command or an awaited slash operation. `false` means the view is closing.
  const performLine = useCallback(async (line: string, mentioned: readonly string[], execution: LocalExecution): Promise<boolean> => {
    const slash = parseSlashLine(line);
    if (!slash) { await runTurn(line, mentioned, execution); return true; }
    if (slash.command === 'setup') { if (await onboarding.usable()) await openSetup.current(execution.signal); else push([notice('error', fillTemplate(labels.commandUnavailable, { part: 'setup' }))]); return true; }
    if (slash.command === 'do') {
      if (!props.doPlan) { push([notice('error', fillTemplate(labels.commandUnavailable, { part: slash.command }))]); return true; }
      const show = (body: readonly string[]) => panel.pick(execution, { kind: 'window', title: '/do', body,
        hints: labels.work?.jobs?.hints ?? props.doPlan!.cancelHint, confirm: false }, ['close']);
      if (!slash.args.trim()) { await show([props.doPlan.requestHint]); return true; }
      const observe = (progress: BrainPlanProgress) => {
        if (progress.kind === 'billing-switch') { push([notice('info', fillTemplate(props.doPlan!.billingSwitch, { model: progress.reference.modelId }))]); return; }
        if (progress.kind === 'planning' || !props.doPlan!.quotaWait) { setPlanWait(null); setActiveDo(current => current && { ...current, phase: 'planning', untilText: undefined }); return; }
        const shown = props.doPlan!.quotaWait(progress);
        setPlanWait({ body: shown.body, hint: shown.hint }); setActiveDo(current => current && { ...current, phase: 'quota-wait', untilText: shown.untilText });
      };
      const selectedIntent = onboarding.intent(execution.input.inputId), commandId = selectedIntent?.commandId ?? globalThis.crypto.randomUUID(), plan = () => props.doPlan!.plan(slash.args, commandId, execution.signal, sessionModel.pinned() ?? undefined,
        props.doPlan!.quotaWait ? observe : undefined, selectedIntent?.pending);
      const dirty = props.doPlan.dirty && !selectedIntent?.pending && await props.doPlan.dirty.check().catch(() => false) ? props.doPlan.dirty : null; if (dirty &&  await windows.ask({ title: dirty.title, hints: dirty.prompt, body: () => [{ spans: [span(dirty.body)] }], bodyRows: 2, tree: { title: dirty.title, items: [{ id: 'continue', label: dirty.go }, { id: 'cancel', label: dirty.cancel }] } }) !== 'continue') { push([notice('info', dirty.cancelled)]); return true; } // BeUser M-32: the worker starts from the last commit
      setDoRunning(true); setPlanning(true);
      setActiveDo({ title: redactForRecord(slash.args.trim(), props.knownSecrets), phase: 'planning', sinceMs: Date.now() });
      try {
        let result = await plan(); if (!isRunIntentResult(result) && result.proposal.status === 'rejected' && result.proposal.reason && ErrorRegistry.has(result.proposal.reason)) throw ErrorRegistry.createError(result.proposal.reason!, { ...(result.reasonParams ? { params: result.reasonParams } : {}) }); // BeUser M-07: no worker can run it → as a refused /do
        if (result.run) completion.register(result.run);
        setPlanning(false); onboarding.settled(execution.input.inputId);
        if (execution.signal.aborted) { push([systemSummaryEntry(props.doPlan.lines(result).join('\n'))]); return true; }
        if (!isRunIntentResult(result) && result.proposal.status === 'pending' && result.proposal.approval) {
          const expiresAtMs = result.proposal.approval.expiresAt;
          setActiveDo(current => current && { ...current, phase: 'waiting', expiresAtMs });
          await work.run('approvals', '', execution, result.proposal.approval.approvalId, undefined, props.doPlan.lines(result).join('\n'));
          if (execution.signal.aborted) return true;
          result = await plan();
          if (result.run) completion.register(result.run);
        }
        setActiveDo(null);
        await show(props.doPlan.lines(result));
        if (result.run && !execution.signal.aborted) await performRef.current('/tasks', [], execution);
      } catch (error) {
        setPlanning(false); setActiveDo(null); // a refused /do is no longer active work (BeUser M-02)
        if (!execution.signal.aborted && props.doPlan.localFallback && props.doPlan.here && await props.doPlan.offerHere?.((error as { code?: unknown })?.code)) { // owner option A: K1 data, K4 card, K5 every time
          onboarding.settled(execution.input.inputId); setDoRunning(false); workNote.current = { ...workNote.current, active: null }; const here = props.doPlan.here, tools = await props.panels?.ports.model?.toolsDeclared?.(sessionModel.pinned()).catch(() => null) ?? null;
          const body = [errorText(error), here.effect, ...(tools === false && props.doPlan.localNoTools ? [props.doPlan.localNoTools] : [])], workers = await here.canSetup?.().catch(() => false) ?? false, chat = Boolean(sessionModel.pinned()) || (await props.doPlan.chatReady?.().catch(() => true) ?? true); // DR3-01
          const answer = await windows.ask({ title: here.title, hints: here.prompt, body: () => body.map(text => ({ spans: [span(text)] })), card: true, tree: { title: here.title, items: [{ id: 'run', label: here.run, ...(chat ? {} : { blocked: { reason: here.noModel } }) }, { id: 'setup', label: here.setup, ...(workers && await onboarding.usable() ? {} : { blocked: { reason: here.noWorkers } }) }, { id: 'cancel', label: here.cancel }] } });
          if (answer === 'setup' && !execution.signal.aborted) { await onboarding.open(execution.signal, 'workers'); return true; } else if (answer !== 'run' || execution.signal.aborted) { push([notice('info', here.cancelled)]); return true; } // /setup worker steps; Esc = Cancel: nothing runs
          if (!await props.doPlan.offerHere?.((error as { code?: unknown })?.code)) { push([notice('info', here.cancelled)]); return true; }
          push([notice('info', props.doPlan.localFallback)]); const before = await props.doPlan.tree?.().catch(() => null) ?? null; // K5: partial folder observations, not attributed effects
          await runTurn(slash.args.trim(), mentioned, execution).finally(async () => push([notice('info', treeChangeLine(before, before?.state === 'unknown' ? null : await props.doPlan!.tree?.().catch(() => null) ?? null, here))])); return true;
        }
        if (!execution.signal.aborted) await show([errorText(error)]); else if ((error as { code?: unknown })?.code !== 'BRAIN_CANCELLED') push([notice('error', errorText(error))]);
      }
      finally { setPlanning(false); setPlanWait(null); setDoRunning(false); setActiveDo(null); }
      return true;
    }
    if (slash.command === 'deliver') {
      // TESLIM-PENCERESI: a picker of tasks awaiting delivery (fresh /runs read model plus this session's Runs); the chosen window takes focus.
      const words = labels.delivery;
      if (!deliveries.available || !words || !ledger) { push([notice('error', fillTemplate(labels.commandUnavailable, { part: slash.command }))]); return true; }
      try {
        const targets = await deliveries.offered(deliveries.candidates([...await loadRunViewsForWatch(ledger), ...completion.tracked.map(item => item.run)])); // M-33: set-aside rows last
        if (!targets.length) {
          await panel.pick(execution, { kind: 'window', title: words.pickerTitle, body: [words.none], hints: labels.work?.jobs?.hints ?? '', confirm: false }, ['close']);
          push([systemSummaryEntry(words.none)]); return true;
        }
        const picked = targets.length === 1 && targets[0]!.setAside === undefined ? '0' : await panel.pick(execution, { kind: 'job-picker', title: words.pickerTitle, rows: targets.map(target =>
          [span(projectHumanPickerText(target.title, props.knownSecrets).label, { bold: target.setAside === undefined }), span(` · ${shortId(target.runId)} · ${target.taskId}`, { role: 'muted' })]) },
        targets.map((_, index) => String(index)));
        if (picked !== null && !execution.signal.aborted) deliveries.open(targets[Number(picked)]!, 'foreground');
      } catch (error) { push([notice('error', errorText(error))]); }
      return true;
    }
    if (slash.command === 'copy') {
      push([labels.copy ? (copied => notice(copied.level, copied.text))(runCopyCommand(slash.args, history.current, props.clipboard, labels.copy, props.knownSecrets)) : notice('error', fillTemplate(labels.commandUnavailable, { part: slash.command }))]);
      return true;
    }
    // SLASH-WINDOWS (owner 2026-10-08): with window words the rich terminal takes no typed arguments; a bare command opens its window or picker.
    const rich = labels.windows;
    if (slash.command === 'uninstall') { await uninstallWindow(); return true; }
    if (rich && !WORKLINE_SLASH_COMMANDS.some(command => command.name === slash.command)) {
      const typed = slash.command, nearest = nearestSlashCommand(typed); // owner S4: one nearest English command, never a guess
      const choice = await windows.ask(unknownCommandSpec(rich, typed, nearest ? [nearest] : [], command => labels.composer.slash[command.descriptionKey] ?? ''));
      if (choice !== null && !execution.signal.aborted) return performRef.current(`/${choice}`, [], execution);
      return true;
    }
    // SW-1 info windows; SLASH-WINDOWS D1 (integration): the rich terminal ignores a typed argument and opens the window, as every other slash
    // command there does; without window words (TERM=dumb) a typed argument keeps the text command.
    if (props.info && (rich || !slash.args) && INFO_WINDOW_COMMANDS.has(slash.command)) {
      const shown = await infoWindow.run(slash.command, execution);
      if (shown.handled) return shown.picked === null ? true : performRef.current(`/${shown.picked}`, [], execution);
    }
    if (slash.command === 'reasoning') {
      const offSupported = await props.panels?.ports.model?.reasoningOffSupported?.(sessionModel.pinned()).catch(() => false) ?? false;
      if (!rich) {
        const wantsOff = slash.args.trim().toLowerCase() === 'off' || (!slash.args.trim() && reasoning.current.current);
        if (wantsOff && !offSupported) { push([notice('error', labels.reasoning?.unsupported ?? labels.ledgerUnavailable)]); return true; }
        reasoning.run(slash.args); return true;
      }
      const choice = await windows.ask(reasoningSpec(rich, reasoning, offSupported));
      if (isReasoningChoice(choice)) reasoning.set(choice);
      return true;
    }
    if (await settings.open(slash.command, rich && slash.command === 'mode' ? '' : slash.args, execution)) return true;
    if (slash.command === 'scratch' && rich && props.scratch) {
      const port = props.scratch, words = rich.scratch;
      const confirm = async (summary: { count: number; bytes: number; path: string }) => (await panel.pick(execution, { kind: 'window', title: words.clearTitle,
        body: [fillTemplate(words.clearBody, summary)], hints: words.clearPrompt, confirm: true }, ['allow', 'deny'])) === 'allow';
      try { await runScratchWindow({ port, sessionId: session.id(), words: rich, ask: windows.ask, confirm, push, clearedText: labels.scratch?.cleared, signal: execution.signal }); }
      catch (error) { push([notice('error', errorText(error))]); }
      return true;
    }
    if (slash.command === 'mode' || slash.command === 'scratch') { await (slash.command === 'mode' ? mode.run : scratch)(slash.args); return true; }
    const lineCommands: Readonly<Record<string, ((args: string) => Promise<readonly string[]>) | undefined>> = { ...bindInspectPorts(props.inspect, usage, () => mode.fullAccess.current), mcp: props.mcp, monitor: props.monitor, config: props.config };
    const showLive = (kind: Parameters<typeof liveWin.show>[0]) => liveWin.show(kind, parseSlashLine(execution.input.text)?.command === 'do' ? 'background' : 'foreground');
    if (await dispatchWorkCommand(slash, { execution, panel, labels, ledger, push, errorText, pushMode, live: { ...liveWin, show: showLive }, monitor: props.monitor, watchRef, setWatch, setWatchStatus, runDecision: work.run, commandUnavailable: labels.commandUnavailable, onRunsSeen: completion.dismiss })) return true;
    // T4: `/provider` and `/hub` are windows only; without its port (TERM=dumb, no host) or with arguments it says the part is unavailable here.
    if (slash.command === 'mcp' || slash.command === 'monitor' || slash.command === 'config' || slash.command === 'provider' || slash.command === 'policy' || slash.command === 'hub' || (isInspectSlashCommand(slash.command) && (slash.command !== 'status' || lineCommands['status']))) {
      const lines = lineCommands[slash.command];
      // One notice for the whole answer, so its level words (`Info: `) open the answer once instead of every line.
      try { push([notice('info', (lines ? await lines(slash.args) : [fillTemplate(labels.commandUnavailable, { part: slash.command })]).join('\n'))]); }
      catch (error) { push([notice('error', errorText(error))]); }
      return true;
    }
    if (slash.command === 'resume' || slash.command === 'context' || slash.command === 'clear' || slash.command === 'rename') {
      try {
        const sessionResult = await session.run(slash.command, rich && slash.command === 'resume' ? '' : slash.args, history, execution);
        const result = slash.command === 'context' ? { ...sessionResult, entries: [...sessionResult.entries, ...instructions.sourceLines().map(line => notice('info', line))] } : sessionResult;
        // `/clear` really clears: the visible screen is wiped and Ink forgets the earlier conversation; only the summary line follows.
        // Owner 2026-10-08: the terminal's scrollback goes too (ED 3); only on a TTY that takes escape sequences (`clearScreen`, see the prop).
        // Full window: the view itself empties; ED 3 still drops the terminal's own scrollback (the screen is the view's, so no ED 2).
        if (slash.command === 'clear' && result.entries.length) {
          if (props.panels?.ports.model) {
            const current = await props.panels.ports.model.inspect().catch(() => null);
            const configured = current?.choices.find(choice => choice.configured);
            setConfiguredLabels(configured ? { model: configured.label, provider: configured.providerLabel ?? configured.group } : {});
          }
          if (fullscreenMode) { stdout.stdout.write(CLEAR_SCROLLBACK); setBannerShown(false); }
          else if (props.clearScreen !== false && stdout.stdout.isTTY) stdout.write(CLEAR_SCREEN_AND_SCROLLBACK);
          reset();
        }
        if (result.resumePicker) {
          // The drain stays inside this call, so a line queued while the list loads cannot run under the picker.
          let picker = result.resumePicker;
          while (!execution.signal.aborted) {
            const choice = await panel.pick(execution, { kind: 'resume', rows: picker }, picker.map((_, index) => String(index)));
            if (choice === null || execution.signal.aborted) break;
            const item = picker[Number(choice)], resumed = await session.run('resume', item?.sessionId.startsWith('--') ? item.sessionId : String(Number(choice) + 1), history, execution);
            push(resumed.entries);
            if (!resumed.resumePicker) break; else picker = resumed.resumePicker;
          }
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
      if (action.window !== undefined) showLive(action.window);
      return true;
    }
    try {
      if (slash.command === 'service-restart') {
        // TS-WINDOW: a restart interrupts the service's running work, so it asks first (y; n, Enter and Esc keep it running).
        const window = labels.work?.window;
        if (!window) { push([notice('error', labels.serviceRestartUnavailable)]); return true; }
        const answer = await panel.pick(execution, { kind: 'window', title: window.restartTitle, body: [window.restartDetail, ...await props.restartNotes?.().catch(() => []) ?? []], hints: window.restartPrompt, confirm: true }, ['allow', 'deny']);
        if (execution.signal.aborted || answer === null) return true;
        push([notice('info', answer === 'allow' ? await props.restartService!() : window.restartKept)]);
      }
    }
    catch (error) { push([notice('error', errorText(error))]); }
    return true;
  }, [errorText, exit, labels, ledger, mode.run, settings, windows, stdout, reset, props.inspect, props.info, props.mcp, props.monitor, props.config, props.restartService, props.doPlan, sessionModel, pollMs, pushMode, push, liveWin, reasoning.run, runTurn, scratch, session, infoWindow, work.run, panel, completion.register, completion.tracked, deliveries, props.knownSecrets]);
  // SLASH-WINDOWS I-1 (owner 2026-10-08, Jev b1e8286f): with window words a slash command typed with an argument runs bare — every host
  // (information/list slot, panel controller) opens its window as usual — and that window says once that the terminal takes no typed
  // argument. The typed text is never shown. Without window words (TERM=dumb) the line goes as typed; line mode and the CLI are elsewhere.
  const [argumentNote, setArgumentNote] = useState<WindowNote | null>(null);
  const perform = useCallback(async (line: string, mentioned: readonly string[], execution: LocalExecution, typedArgument = false): Promise<boolean> => {
    const slash = parseSlashLine(line), words = labels.windows;
    if (!slash || keepsTypedArgument(slash.command) || !words || (!slash.args && !typedArgument)) return performLine(line, mentioned, execution);
    const note: WindowNote = { text: words.typedArgument, consume: () => setArgumentNote(current => current === note ? null : current) };
    setArgumentNote(note);
    try { return await performLine(`/${slash.command}`, mentioned, execution); }
    // A watch window outlives its command (it is not awaited): it keeps the note until it closes; otherwise the note ends with the command.
    finally { if (!liveRef.current?.isOpen()) note.consume(); }
  }, [labels.windows, performLine]);
  performRef.current = perform;

  execute.current = async execution => {
    const action = taskActions.current.get(execution.input.inputId);
    taskActions.current.delete(execution.input.inputId);
    if (action && ledger && labels.work) {
      try { await openTaskAction(action, panel, execution, ledger, labels.work,
        runId => work.run('cancel', '', execution, undefined, runId)); }
      catch (error) { push([notice('error', errorText(error))]); }
      return;
    }
    // B: a line sent before the opening is ready waits behind one notice (Ctrl+C sends nothing); a failed start says its typed error and gives the line back as the draft.
    if (await gate(execution.input.text, execution.signal, () => { if (props.opening) push([notice('info', props.opening.wait)]); }).catch((error: unknown) => { push([notice('error', errorText(error))]); setDraft(last => ({ seq: (last?.seq ?? 0) + 1, entry: { text: execution.input.text, pastes: [] } })); return false; })) await perform(execution.input.text, execution.input.mentions, execution, typedArgumentInputs.current.delete(execution.input.inputId));
  };
  const inputSequence = useRef(0), typedArgumentInputs = useRef(new Set<string>());
  taskActionRef.current = action => {
    const inputId = `input-${++inputSequence.current}`, snapshot = panel.controller.snapshot();
    taskActions.current.set(inputId, action);
    if (!panel.controller.send({ kind: 'submit', context: snapshot.context, inputId, text: `/${action.action}`, mentions: [] })) taskActions.current.delete(inputId);
  };
  // I-1 (Astra 2456): in the rich terminal a slash argument is dropped before the line is queued, shown as queued or remembered in the
  // input history; only `/command` travels on, and the input id carries the fact that an argument was typed (for the window's one-time note).
  // A command no window replaces (`/do`, `/copy`, `/rename`; registry `typedArgument`) keeps it, redacted for the record (TRM-40).
  const bareSlash = (text: string): string => { const slash = parseSlashLine(text); return slash && keepsTypedArgument(slash.command) ? redactForRecord(text, props.knownSecrets) : labels.windows && slash?.args ? `/${slash.command}` : text; };
  // Journey queued-messages: a line sent while another runs waits in the FIFO and is listed above the composer (`QueuedLines`), not in the conversation.
  const waiting = useRef(new Map<string, string>());
  const submit = (typed: string, mentions: readonly string[] = [], entry?: ComposerHistoryEntry) => {
    const before = panel.controller.snapshot(), text = bareSlash(typed), inputId = `input-${++inputSequence.current}`;
    if (text !== typed) typedArgumentInputs.current.add(inputId);
    if (panel.controller.send({ kind: 'submit', context: before.context, inputId, text, mentions }) && before.active) {
      const kept = new Set(panel.controller.snapshot().queued.map(item => item.inputId));
      for (const id of waiting.current.keys()) if (!kept.has(id)) waiting.current.delete(id);
      waiting.current.set(inputId, text.trim()); handoffs.remember(inputId, entry ?? { text, pastes: [] });
    }
  };
  submitRef.current = submit;
  const handedOver = useRef(false); // alpha.60 C: the shell's sent lines go once, in order, through the same submit and send gate
  useEffect(() => { if (handedOver.current) return; handedOver.current = true; for (const line of props.queuedInputs ?? []) submit(line.text, line.mentions, line.entry); }, []);
  const withdraw = () => { const taken = handoffs.withdraw(); if (taken) typedArgumentInputs.current.delete(taken.inputId); return taken?.entry ?? null; };
  const cancel = () => {
    const current = panel.controller.snapshot(), active = current.active;
    if (active) panel.controller.send(active.binding
      ? { kind: 'cancel', context: current.context, turnId: active.binding.turnId }
      : { kind: 'cancel-input', context: current.context, inputId: active.inputId });
  };

  const localWindowOpen = slot.open;
  const othersOpen = planning || work.modalOpen || work.pickerOpen || resumePicker !== null || settings.openKind !== null || localWindowOpen;
  const deliveryShown = !othersOpen && deliveries.visible;
  // TERMINAL-SABIT slice 2: the strip is a view over this session's /do and completion records; its clock ticks at the inspection cadence.
  const activeLabels = labels.work?.activeWork, jobLabels = labels.work?.jobs;
  const stripTicking = activeDo !== null || deliveries.pending.length > 0 || completion.tracked.some(item => item.run.state.kind !== 'terminal');
  const stripNow = useActiveWorkClock(stripTicking, pollMs, `${activeDo?.phase ?? ''}:${completion.tracked.length}:${deliveries.pending.length}`);
  const stripItems = activeLabels && jobLabels && labels.work ? activeWorkItems({ active: activeDo, runs: completion.tracked, deliveries: deliveries.pending, nowMs: stripNow,
    labels: activeLabels, jobs: jobLabels, duration: labels.work.workerLine }) : [];
  const focusStrip = useCallback((focused: boolean) => { stripFocus.current = focused; setStripFocused(focused); }, []);
  const openActive = (item: ActiveWorkItem) => {
    // A waiting delivery: the person's selection opens its window in the foreground (it never answers it).
    if (item.target.kind === 'delivery') { const target = deliveries.target(item.target.key); if (target) deliveries.open(target, 'foreground'); return; }
    if (item.target.kind !== 'run') return;
    // A person's selection: the existing /run window through the out-of-band task action (foreground, FIFO behind a running line).
    taskActionRef.current({ action: 'run', target: liveRunEntry(item.target.run, 'active-work') });
    if (item.target.run.state.kind === 'terminal') completion.dismiss(item.target.run.runId);
  };
  const ledgerLabels: LedgerEntryLabels = { system: labels.work?.jobs?.system ?? props.info?.labels.systemLabel, runCard: labels.runCard, workerCard: labels.workerCard, chatUser: labels.roleUser, chatAssistant: labels.roleAssistant,
    render: labels.render, ...(labels.work ? { workerLine: labels.work.workerLine } : {}) };
  // A window a slash command opened waits for the person, so the status row says Ready, not Working (an approval card during a turn keeps Working).
  useAttentionNotice(props.notify, { working: turnRunning || doRunning, awaitingAnswer: Boolean(state.approval) || work.modalOpen });
  const choosing = resumePicker !== null || work.pickerOpen || (work.modalOpen && !turnRunning) || settings.openKind !== null || localWindowOpen || instructions.open;
  const fullAccessLine = mode.mode === 'full-access' ? labels.mode?.fullAccessLine : undefined, glyphs = useRenderGlyphs();
  // T2 T-MODE-CYCLE: Shift+Tab (Alt+M where the console cannot report Shift+Tab, e.g. Windows without VT input) steps the permission mode
  // while the composer owns the keyboard; an open card, picker or any window (stack not idle, `PermissionModeKeys`) owns Shift+Tab then. A running turn owns its
  // mode as `/mode` does (queued until it ends): the step waits for idle, so the status row never shows a mode the running turn is not in.
  const finishResume = (choice: number | null) => { panel.choose(state.picker?.pickerHandle, choice === null ? null : String(choice)); };
  // alpha.59 L6 (owner 2026-10-30): a settled read group shows one line; a click on it (the full window's mouse) shows or hides its calls. Without a
  // pointer, and in what is written to the main screen at exit, a group is open: its calls are never only behind a click.
  const groupViewOf = useCallback((row: LedgerRow, exit = false): ToolGroupView | undefined => row.entry.kind !== 'chat' || row.entry.assistant?.kind !== 'tool-group' ? undefined
    : exit || !props.pointer ? 'open' : expanded.has(row.seq) ? 'expanded' : 'collapsed', [expanded, props.pointer]);
  const variantOf = useCallback((row: LedgerRow, exit?: boolean) => groupViewOf(row, exit) ?? '', [groupViewOf]);
  const toggleGroup = useCallback((key: string) => {
    const seq = Number(key), row = buffer.history.find(item => item.seq === seq);
    if (!row || !groupViewOf(row)) return;
    setExpanded(current => { const next = new Set(current); if (!next.delete(seq)) next.add(seq); return next; });
  }, [buffer.history, groupViewOf]);
  // TERMINAL-SABIT-DUZEN: the full-window conversation, laid out per row with the providers `Static` gave each row.
  const renderRow = (row: LedgerRow, exit?: boolean) => { const groupView = groupViewOf(row, exit); return <WorklinePaletteProvider palette={palette}><RenderGlyphsContext.Provider value={glyphs}>
    <HumanTextContext.Provider value={props.knownSecrets}><LedgerEntryRow entry={row.entry} labels={ledgerLabels} spaceBefore={rowSpaceBefore(buffer, row)} {...(groupView ? { groupView } : {})} /></HumanTextContext.Provider></RenderGlyphsContext.Provider></WorklinePaletteProvider>; };
  // The conversation opens with the opening frame (until `/clear`) and the workline's own how-to line (how to cancel and quit), once, at its top.
  const startup = props.startup, bannerLine = labels.banner, bannerOf = useMemo(() => fullscreenMode ? (columns: number) => {
    const frame = bannerShown && startup && startup.banner !== 'off' ? startupFrame({ ...startup, clear: false }, palette, columns, 0) : '';
    return `${frame}${renderToString(<Text {...palette.accent}>{bannerLine}</Text>, { columns })}\n`;
  } : null, [fullscreenMode, bannerShown, startup, palette, bannerLine]);
  const transcript = useTranscriptBlocks(fullscreenMode ? buffer.history : EMPTY_ROWS, size.columns || 80, renderRow, bannerOf, palette, variantOf);
  const transcriptExit = props.transcriptExit;
  useLayoutEffect(() => { if (transcriptExit && fullscreenMode) transcriptExit.current = transcript.text; }, [transcriptExit, fullscreenMode, transcript]);
  const statusNode = <StatusStrip target={target} model={pinnedLabels.current.get(sessionId())?.model ?? (configuredLabels === null ? props.model : configuredLabels.model)} provider={pinnedLabels.current.get(sessionId())?.provider ?? (configuredLabels === null ? props.provider : configuredLabels.provider)}
    state={cancelling ? labels.statusCancelling : busy && !choosing ? labels.statusBusy : [labels.statusReady, work.approvalStatus].filter(Boolean).join(' · ')} busy={busy && !choosing}
    queued={state.queued.length} labels={{ ...labels.render, selfSourceFloor: labels.selfSourceFloor, modeStops: labels.mode?.stops }} mode={mode.mode} stop={mode.stop}
    selfSource={props.selfSource} cancellable={(turnRunning || planning) && !cancelling} reasoning={reasoningStatus(labels.windows, reasoning)}
    context={contextStatus(session.measured, labels.render, labels.sessions?.locale)} />;
  // The real reason the queue waits now: the opening's send gate, the running turn, an open window, else the command still running.
  const reason: QueueReason = !serviceReady ? 'service' : chatting ? 'turn' : othersOpen ? 'window' : 'command', words = labels.queue ?? NEUTRAL_QUEUE_LABELS;
  const queueNode = <QueuedLines queued={state.queued.flatMap(item => { const text = waiting.current.get(item.inputId); return text === undefined ? [] : [humanRecordText(text, props.knownSecrets)]; })}
    steered={turnSteer.steered.map(text => humanRecordText(text, props.knownSecrets))} reason={reason === 'turn' ? labels.queued : words[reason]} labels={words} />;
  const fullAccessNode = fullAccessLine ? <Text {...palette.warning} wrap="truncate-end">{`${glyphs.mode['full-access']} ${fullAccessLine}`}</Text> : null;
  const composerNode = <StackComposer elsewhere={() => stripFocus.current || searchFocus.current} active={!stripFocused && !searchOpen} prompt={labels.prompt} labels={{ ...labels.composer,
    slash: Object.fromEntries(Object.entries(labels.composer.slash).map(([key, text]) => [key, projectHumanPickerText(text, props.knownSecrets).label])) }}
    busy={busy} historyText={bareSlash} remember={remember} restore={draft} armedAt={props.armedAt ?? null} maxRows={pinned ? Math.max(1, Math.floor(size.rows / 3)) : undefined}
    onSubmit={(text, mentioned, entry) => void submit(text, mentioned, entry)} steer={turnSteer.steerable} onSteer={turnSteer.add} onWithdraw={withdraw} {...(handoffs.edit ? { onEditor: handoffs.edit } : {})} onCancel={cancel} onExit={() => { panel.close(); exit(); }}
    {...(props.inputHistory ? { history: props.inputHistory } : {})} {...(props.mentions ? { mentions: props.mentions } : {})}
    {...(props.mentionDelayMs === undefined ? {} : { mentionDelayMs: props.mentionDelayMs })} />;
  const hintNode = copied !== null ? <CopiedNotice count={copied} label={labels.viewport?.copied} /> : <WindowFocusHint composer={labels.focus?.composer} window={labels.focus?.window} fallback={labels.hint} />;
  const liveNode = live ? <AssistantLive tail={live.step.liveTail} narration={live.step.narration} labels={labels.render} lead={live.lead} activeTool={live.step.activeTool} spaceBefore={isToolStep(buffer.tail.at(-1))}
    waiting={live.step.waiting} reasoningPreview={reasoning.show ? live.step.reasoningPreview : []} toolGroup={live.step.toolGroup} /> : null;
  const windowsNode = <>
    <PermissionModeKeys active={!busy && Boolean(props.permissionMode)} onCycle={() => void mode.cycle()} />
    {instructions.window}
    {fullscreenMode ? null : liveNode}
    <WindowOpeningContext.Provider value={doRunning || state.approval ? 'background' : 'foreground'}>
    {work.region}
    {planning && props.doPlan ? <Window title={[span('/do')]} body={[{ spans: [span(planWait?.body ?? props.doPlan.planning)] }]} hints={planWait?.hint ?? props.doPlan.cancelHint}
      position={labels.work?.window.position ?? ''} onClose={cancel} onInput={(input, key) => { if (key.ctrl && input === 'c') { cancel(); return true; } return false; }} /> : null}
    </WindowOpeningContext.Provider>
    {/* One window is visible at a time: a decision card, picker, approval or settings window takes the screen from the live window, which returns when it is answered. */}
    {othersOpen || deliveryShown ? null : liveWin.element}
    {/* TESLIM-PENCERESI: the delivery window gives way to every card, picker and slash window and returns after it; it takes the live window's place. */}
    {deliveryShown ? deliveries.element : null}
    {resumePicker && !work.modalOpen && !work.pickerOpen
      ? <Window title={[span(labels.work?.window.resumeTitle ?? '/resume')]} status={[span(String(resumePicker.length))]} hints={labels.work?.window.pick ?? ''}
        position={labels.work?.window.position ?? '{from}-{to}/{total}'} footerRows={ARROW_PICKER_ROWS + 3}
        footer={focused => <ArrowPicker rows={resumePicker.map(item => item.label)} styledRows={resumePicker.map(item => item.spans ?? [])} active={focused}
          details={resumePicker.map(item => item.hiddenNotice)} onSelect={finishResume} onCancel={() => finishResume(null)}
          {...(labels.sessions?.filter ? { filter: { prompt: (text: string) => fillTemplate(labels.sessions!.filter!.prompt, { text }), none: labels.sessions.filter.none } } : {})} />} /> : null}
    {settings.window}
    {/* The local window slot gives way to a decision card, picker, approval or settings window (approvals keep priority) and returns after it. */}
    <WindowOpeningContext.Provider value={turnRunning ? 'background' : 'foreground'}>
    {work.modalOpen || work.pickerOpen || resumePicker !== null || settings.openKind !== null ? null : slot.element}
    </WindowOpeningContext.Provider>
  </>;
  // Full window: a fixed number of information rows (state; work, else the full-access line; key hints) so the bar never moves.
  const infoRows = fullscreenInfoRows(fullscreenFrameRows(size.rows || 24));
  // alpha.59 L3: every card's Ctrl+Y copy goes through the host's one clipboard writer (absent off a TTY).
  const copyCard = useMemo(() => cardCopy(props.clipboard, labels.copy?.card), [props.clipboard, labels.copy?.card]);
  const activityNode = activeLabels && stripItems.length ? <ActiveWorkSummary items={stripItems} labels={activeLabels} /> : fullAccessNode ?? <Text> </Text>;
  const layout = fullscreenMode
    ? <FullscreenWorkline
      viewport={<WheelContext.Provider value={props.wheel ?? null}><PointerContext.Provider value={pointerSelection}><ChatViewport blocks={transcript} live={liveNode} active={!stripFocused} labels={labels.viewport ?? NEUTRAL_VIEWPORT_LABELS} onSearch={onSearch} onClick={toggleGroup} /></PointerContext.Provider></WheelContext.Provider>}
      above={<>
        {activeLabels ? <ActiveWorkStrip items={stripItems} labels={activeLabels} rows={activeWorkRows(size.rows)} focused={stripFocused} onFocus={focusStrip} onOpen={openActive} collapsed /> : null}
        {windowsNode}{queueNode}</>}
      bar={composerNode}
      info={<>{statusNode}{infoRows >= 3 ? activityNode : null}{infoRows >= 2 ? hintNode : null}</>} />
    : <Box flexDirection="column">
      <Static key={buffer.epoch} items={[...buffer.pending]}>
        {row => <LedgerEntryRow key={row.seq} entry={row.entry} labels={ledgerLabels} spaceBefore={rowSpaceBefore(buffer, row)} />}
      </Static>
      <PinnedWorkline enabled={pinnedMode} footer={<>
      {/* The banner wraps (never truncates): on a narrow terminal it still says how to quit; the footer's height is measured, not fixed. Tema L6
          §4.2: one fixed blank row above it, so the last conversation line never touches the bottom region. */}
      <Text> </Text>
      {!pinned || size.rows >= 8 ? <Text {...palette.accent}>{labels.banner}</Text> : null}
      {statusNode}
      {fullAccessNode}
      {activeLabels ? <ActiveWorkStrip items={stripItems} labels={activeLabels} rows={activeWorkRows(size.rows)} focused={stripFocused} onFocus={focusStrip} onOpen={openActive} /> : null}
      {queueNode}
      {composerNode}
      {!pinned || size.rows >= 5 ? hintNode : null}
      </>}>
      {windowsNode}
      </PinnedWorkline>
    </Box>;
  return (
    <CardCopyContext.Provider value={copyCard}>
    <PointerContext.Provider value={pointerSelection}>
    <DecisionArmContext.Provider value={props.decisionArmMs ?? DECISION_ARM_DEFAULT}>
    <DecisionArmLabelsContext.Provider value={labels.decisionArm ?? NEUTRAL_ARM_LABELS}>
    <HumanTextContext.Provider value={props.knownSecrets}>
    <WindowNoteContext.Provider value={argumentNote}>
    <WindowDecideHintContext.Provider value={labels.focus?.decide}>
    {layout}
    </WindowDecideHintContext.Provider>
    </WindowNoteContext.Provider>
    </HumanTextContext.Provider>
    </DecisionArmLabelsContext.Provider>
    </DecisionArmContext.Provider>
    </PointerContext.Provider>
    </CardCopyContext.Provider>
  );
}

const EMPTY_ROWS: readonly LedgerRow[] = Object.freeze([]);
const NEUTRAL_ARM_LABELS: DecisionArmLabels = Object.freeze({ arming: '…', ignored: '… ×' });
const NEUTRAL_QUEUE_LABELS: QueueLabels = Object.freeze({ service: '…', window: '…', command: '…', withdraw: 'Alt+Up', more: '+{count}', steered: '+', steerFull: '{limit} × {text}',
  steerReturned: '→ {text}', steerBack: '← {text}' });
/** The information row's context segment: the same measurement and words as `/context` (`terminal.render.context`); before one, "unknown". */
function contextStatus(measured: Readonly<{ promptTokens: number; windowTokens: number | null; quality: string }> | null, render: AssistantRenderLabels, locale: 'en' | 'tr' | undefined): string | undefined {
  if (!measured) return render.contextUnknown;
  return fillTemplate(render.context, { approx: measured.quality === 'upper-bound' ? '~' : '', percent: measured.windowTokens ? Math.ceil(measured.promptTokens * 100 / measured.windowTokens) : '?',
    window: measured.windowTokens === null ? '?' : formatContextTokens(measured.windowTokens, locale ?? 'en') });
}
/** Language-neutral until the catalog words are passed (tests, hosts without the catalog). */
const NEUTRAL_VIEWPORT_LABELS: ChatViewportLabels = Object.freeze({ below: '+{count} PgDn · End', newMessages: '+{count} · End', search: '/{query}{state}', searchNone: ' ∅' });

export interface WorklineRunOptions extends Omit<WorklineProps, 'labels'> {
  readonly labels: WorklineLabels;
  readonly palette: WorklineInkPalette;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly signal?: AbortSignal;
  /** ASCII decoration for terminals that cannot be assumed to draw Unicode. */
  readonly ascii?: boolean;
  /** T2 T-STARTUP: clear the visible screen and print the banner before the live view (TTY only; scrollback is never erased). */
  readonly startup?: WorklineStartup;
  /** alpha.60 C: the launch shell's open host; the Workline takes it (same alternate screen, input owner and restore) with its draft and sent lines. */
  readonly shell?: TerminalShell;
  /** TEMA-OKUNURLUK: the host draws `terminalPalette` of this request (its own background probe) instead of `palette`. */
  readonly theme?: TerminalThemeRequest;
}

/** The workline is the host's view: the host owns start-up, mouse, OSC 52 copy, the alternate screen and the terminal restore (`terminal-host`). */
export async function runTerminalWorkline(options: WorklineRunOptions): Promise<void> {
  const { palette, stdin, stdout, signal, ascii, startup, shell, theme, ...props } = options;
  const view = (context: TerminalHostContext, handed?: ReturnType<TerminalShell['take']>) => createElement(WorklineApp, { ...props, fullscreen: context.fullscreen, ...(context.fullscreen && startup ? { startup } : {}),
    transcriptExit: context.transcriptExit, ...(handed ? { initialDraft: handed.draft, queuedInputs: handed.queued, armedAt: handed.armedAt } : {}),
    ...(context.wheel ? { wheel: context.wheel } : {}), ...(context.handover ? { handover: context.handover } : {}), ...(context.pointer ? { pointer: context.pointer } : {}), ...(context.copyText ? { copyText: context.copyText } : {}),
    ...(context.clipboard ? { clipboard: context.clipboard } : {}), ...(context.notify ? { notify: context.notify } : {}) });
  // alpha.60 C: the launch shell's host is taken as it is (closed in the shell with Ctrl+D: nothing opens); otherwise the host opens here.
  // The shell's host keeps the palette it draws (TH-A: its theme request and later background answers); passing one here would replace it.
  if (shell) { if (!shell.host.open()) return; const handed = shell.take(); shell.host.setView(context => view(context, handed)); await shell.host.wait(); }
  else await runTerminalHost({ palette, ...(theme ? { theme } : {}), ...(stdin ? { stdin } : {}), ...(stdout ? { stdout } : {}), ...(signal ? { signal } : {}), ...(ascii !== undefined ? { ascii } : {}),
    ...(props.attention ? { attention: true } : {}),
    ...(props.clearScreen !== undefined ? { clearScreen: props.clearScreen } : {}), ...(props.fullscreen !== undefined ? { fullscreen: props.fullscreen } : {}),
    ...(startup ? { inlineStartup: (out, chosen) => writeStartup(out, startup, chosen) } : {}), view: context => view(context) });
  // BeUser AYSE-22: like Claude Code, closing says how to come back to the saved conversation.
  const out = stdout ?? process.stdout, hint = props.sessions ? props.labels.sessions?.exitHint : undefined;
  if (hint && out.isTTY) try { out.write(`${hint}\n`); } catch { /* the terminal is gone */ }
}
