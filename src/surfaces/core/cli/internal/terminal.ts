import { createInterface } from 'node:readline';
import { DeckentError, ErrorRegistry, emit, loadConfig, readBuildIdentity, resolveLocale, t, formatValue, colorTier, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { buildInferenceServingPlan, estimateReplicaCapacity, readInferenceServingProfile } from '#engine/index.js';
import { prefersAsciiGlyphs, runTerminalWorkline, resolveWorklinePalette, buildWorklineBridgeSnapshot, boundChatHistory, bindSessionScope, type AgentChatMessage, type ChatTurnMessage, type WorklineLabels,
  type WorkSurfaceLabels } from '#surfaces/core/terminal/index.js';
import { terminalComposerLabels, terminalRenderLabels, terminalSessionLabels } from '#surfaces/core/terminal-labels/index.js';
import { createWorklineLedgerPorts } from './terminal-ledger.js';
import { phaseLabel } from './transcript.js';
import type { CommandContext } from './kernel-commands.js';
import type { TerminalChatPlanView } from './terminal-chat.js';

type Action = 'status' | 'session' | 'workline' | 'snapshot' | 'chat-plan';
interface Parsed { action: Action; json: boolean; help: boolean; language?: string; scopeId?: string }
const ACTIONS: readonly Action[] = ['status', 'session', 'workline', 'snapshot', 'chat-plan'];
const DEFAULT_HISTORY_MESSAGES = 40;

function parse(argv: readonly string[]): Parsed {
  // Bare `deckent terminal` is the interactive terminal, the same as `deckent` with no arguments on a TTY.
  const action = (argv.length === 1 ? 'workline' : argv[1]) as Action;
  if (argv[0] !== 'terminal' || !ACTIONS.includes(action)) throw ErrorRegistry.createError('CLI_USAGE');
  const parsed: Parsed = { action, json: false, help: false };
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (key === '--help') parsed.help = true;
    else if (key === '--json') parsed.json = true;
    else if (key === '--no-color') continue;
    else if (key === '--lang' || key === '--scope') {
      const value = argv[++index];
      if (!value || value.startsWith('-') || (key === '--lang' ? parsed.language : parsed.scopeId) !== undefined) throw ErrorRegistry.createError('CLI_USAGE');
      if (key === '--lang') parsed.language = value; else parsed.scopeId = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (parsed.help && parsed.json) throw ErrorRegistry.createError('CLI_USAGE');
  if (parsed.json && (parsed.action === 'session' || parsed.action === 'workline')) throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}

function ttyState(context: CommandContext) {
  const stdin = context.stdin ?? process.stdin;
  const stdout: unknown = context.stdout ?? process.stdout;
  const stdoutTty = Boolean((stdout as { isTTY?: boolean }).isTTY);
  const columns = stdoutTty ? (stdout as { columns?: number }).columns ?? null : null;
  const rows = stdoutTty ? (stdout as { rows?: number }).rows ?? null : null;
  return { stdin: Boolean(stdin.isTTY), stdout: stdoutTty, columns, rows };
}

/** Typed errors render through the catalog; untyped failures never echo provider or transport detail. */
function errorText(error: unknown, locale: Locale): string {
  if (error instanceof DeckentError && ErrorRegistry.has(error.code)) {
    return `${ErrorRegistry.get(error.code, locale, error.params ?? {})?.message ?? error.code} [${error.code}]`;
  }
  return t('terminal.chat.failed', {}, locale);
}

function yesNo(value: boolean, locale: Locale): string { return value ? t('terminal.value.yes', {}, locale) : t('terminal.value.no', {}, locale); }

function chatTarget(plan: TerminalChatPlanView | null, locale: Locale): string {
  if (!plan || !plan.reference) return t('terminal.chat.notConfigured', {}, locale);
  const model = `${plan.reference.providerId}/${plan.reference.modelId}@${plan.reference.modelVersion}`;
  return plan.status === 'ready' ? model : `${model} · ${t('terminal.chat.modelNotDeclared', {}, locale)}`;
}

function renderStatus(payload: ReturnType<typeof statusPayload>, locale: Locale): string {
  const { tty, inference, chat } = payload;
  return [
    t('terminal.status.tty', { stdin: yesNo(tty.stdin, locale), stdout: yesNo(tty.stdout, locale),
      columns: tty.columns ?? t('terminal.value.unknown', {}, locale), rows: tty.rows ?? t('terminal.value.unknown', {}, locale) }, locale),
    inference.configured
      ? t('terminal.status.inference', { profile: inference.profileId, tokenBudget: inference.tokenBudget, maxSeqs: inference.maxSeqs,
        endpoint: inference.endpoint ?? t('terminal.value.none', {}, locale) }, locale)
      : t('terminal.status.inferenceAbsent', {}, locale),
    t('terminal.status.chat', { target: chatTarget(chat, locale) }, locale),
    t('terminal.status.hint', {}, locale),
  ].join('\n');
}

function statusPayload(tty: ReturnType<typeof ttyState>, config: Record<string, unknown>, chat: TerminalChatPlanView | null) {
  const profile = readInferenceServingProfile(config);
  const inference = profile ? (() => {
    const capacity = estimateReplicaCapacity(profile);
    return { configured: true as const, profileId: profile.id, tokenBudget: capacity.totalTokenBudget, maxSeqs: capacity.maxNumSeqs,
      endpoint: buildInferenceServingPlan(profile).openaiBaseUrl };
  })() : { configured: false as const };
  return { schemaVersion: 1 as const, tty, inference, chat };
}

/** Catalog-backed labels for the work surface (worker live line, transcript, approvals, run cancel). */
export function workSurfaceLabels(locale: Locale): WorkSurfaceLabels {
  const phases = ['starting', 'thinking', 'reading', 'editing', 'running', 'searching', 'fetching', 'delegating', 'finished', 'failed'] as const;
  return {
    workerLine: { numberLocale: locale, ordinal: t('terminal.worker.ordinal', {}, locale),
      phases: Object.fromEntries(phases.map(phase => [phase, phaseLabel(phase, locale)])) as WorkSurfaceLabels['workerLine']['phases'],
      durationSeconds: t('terminal.duration.seconds', {}, locale), durationMinutes: t('terminal.duration.minutes', {}, locale), durationHours: t('terminal.duration.hours', {}, locale),
      ago: t('terminal.worker.ago', {}, locale), tokens: t('terminal.worker.tokens', {}, locale), tokensCache: t('terminal.worker.tokensCache', {}, locale),
      reported: t('terminal.worker.reported', {}, locale), eventsTruncated: t('terminal.worker.eventsTruncated', {}, locale), dropped: t('terminal.worker.dropped', {}, locale),
      unmapped: t('terminal.worker.unmapped', {}, locale) },
    panel: { title: t('terminal.worker.panelTitle', {}, locale), more: t('terminal.worker.panelMore', {}, locale) },
    unavailable: t('terminal.work.unavailable', {}, locale),
    transcriptUsage: t('terminal.transcript.usage', {}, locale), transcriptNotFound: t('terminal.transcript.notFound', {}, locale),
    transcriptNoAttempt: t('terminal.transcript.noAttempt', {}, locale), transcriptHeader: t('terminal.transcript.header', {}, locale),
    approvalsNone: t('terminal.approval.none', {}, locale), approvalItem: t('terminal.approval.item', {}, locale), approvalsTruncated: t('terminal.approval.truncated', {}, locale),
    approvalNotFound: t('terminal.approval.notFound', {}, locale), approvalTitle: t('terminal.approval.title', {}, locale), approvalSubject: t('terminal.approval.subject', {}, locale),
    approvalExpires: t('terminal.approval.expires', {}, locale), approvalPrompt: t('terminal.approval.prompt', {}, locale), approvalPending: t('terminal.approval.pending', {}, locale),
    approvalAllowed: t('terminal.approval.allowed', {}, locale), approvalDenied: t('terminal.approval.denied', {}, locale), approvalMore: t('terminal.approval.more', {}, locale),
    approvalNotify: t('terminal.approval.notify', {}, locale), approvalPollFailed: t('terminal.approval.pollFailed', {}, locale),
    cancelUsage: t('terminal.cancel.usage', {}, locale), cancelTitle: t('terminal.cancel.title', {}, locale), cancelDetail: t('terminal.cancel.detail', {}, locale),
    cancelAlreadyRequested: t('terminal.cancel.alreadyRequested', {}, locale), cancelPrompt: t('terminal.cancel.prompt', {}, locale), cancelPending: t('terminal.cancel.pending', {}, locale),
    cancelKept: t('terminal.cancel.kept', {}, locale),
  };
}

function worklineLabels(locale: Locale, statusLine: string): WorklineLabels {
  return {
    work: workSurfaceLabels(locale),
    banner: t('terminal.workline.banner', {}, locale), prompt: t('terminal.session.prompt', {}, locale),
    statusReady: t('terminal.workline.statusReady', {}, locale), statusBusy: t('terminal.workline.statusBusy', {}, locale),
    statusCancelling: t('terminal.workline.statusCancelling', {}, locale), hint: t('terminal.workline.hint', {}, locale),
    roleUser: t('terminal.workline.roleUser', {}, locale), roleAssistant: t('terminal.workline.roleAssistant', {}, locale),
    runCard: t('terminal.ledger.runCard', {}, locale), workerCard: t('terminal.ledger.workerCard', {}, locale),
    watchFailed: t('terminal.workline.watchFailed', {}, locale), ledgerUnavailable: t('terminal.workline.ledgerUnavailable', {}, locale),
    runNotFound: t('terminal.workline.runNotFound', {}, locale), workersEmpty: t('terminal.workline.workersEmpty', {}, locale),
    runsEmpty: t('terminal.workline.runsEmpty', {}, locale), serviceRestartUnavailable: t('terminal.service.restartUnavailable', {}, locale),
    queued: t('terminal.workline.queued', {}, locale),
    runUsage: t('terminal.slash.runUsage', {}, locale), watchStarted: t('terminal.workline.watchStarted', {}, locale),
    watchRunsStarted: t('terminal.workline.watchRunsStarted', {}, locale), watchStopped: t('terminal.workline.watchStopped', {}, locale),
    unknownCommand: t('terminal.workline.unknownCommand', {}, locale), statusLine,
    render: terminalRenderLabels(locale), composer: terminalComposerLabels(locale), sessions: terminalSessionLabels(locale),
  };
}

/** Line mode is the degraded adapter: it works piped (one turn per input line) and prompts only on a terminal. */
async function runSession(locale: Locale, context: CommandContext, turn: (messages: readonly ChatTurnMessage[], signal?: AbortSignal) => Promise<string>,
  historyMessages: number, interactive: boolean, status: () => string): Promise<void> {
  const stdin = context.stdin ?? process.stdin;
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const rl = createInterface({ input: stdin, ...(interactive ? { output: process.stdout } : {}), terminal: interactive,
    prompt: t('terminal.session.prompt', {}, locale) });
  const system: ChatTurnMessage = { role: 'system', content: t('terminal.chat.systemPrompt', {}, locale) };
  let history: readonly ChatTurnMessage[] = [system];
  if (interactive) { emit(t('terminal.session.banner', {}, locale), sinks); rl.prompt(); }
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '/exit' || trimmed === '/quit') break;
      if (trimmed === '/status') { emit(status(), sinks); }
      // Slash input is a local command; an unknown one is reported, never sent to the model as a user message.
      else if (trimmed.startsWith('/')) emit(`${t('terminal.workline.unknownCommand', {}, locale)}: ${trimmed}`, { ...sinks, level: 'error' });
      else if (trimmed.length > 0) {
        const messages = boundChatHistory(system, [...history, { role: 'user', content: trimmed }], historyMessages);
        try {
          const reply = await turn(messages, context.signal);
          history = boundChatHistory(system, [...messages, { role: 'assistant', content: reply }], historyMessages);
          emit(reply, sinks);
        } catch (error) {
          history = messages;
          emit(errorText(error, locale), { ...sinks, level: 'error' });
        }
      }
      if (interactive) rl.prompt();
    }
  } finally { rl.close(); }
  if (interactive) emit(t('terminal.session.closed', {}, locale), sinks);
}

/** A terminal from a compiled build talking to a service from another (or an unknown, older) build. Source runs never warn. */
export function runtimeBuildSkew(own: { readonly sourceTreeSha256: string } | null, service: { readonly sourceTreeSha256: string } | null):
  { readonly service: string | null; readonly terminal: string } | null {
  if (!own || service?.sourceTreeSha256 === own.sourceTreeSha256) return null;
  return { service: service ? service.sourceTreeSha256.slice(0, 12) : null, terminal: own.sourceTreeSha256.slice(0, 12) };
}

export async function terminalCommand(argv: readonly string[], context: CommandContext = {}): Promise<void> {
  const parsed = parse(argv);
  const root = context.root ?? process.cwd();
  const env = context.env ?? process.env;
  let locale = resolveLocale(parsed.language, env);
  context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) { emit(t('cli.help.terminal', {}, locale), sinks); return; }
  const tty = ttyState(context);
  const options: ConfigLoadOptions = { env };
  const config = await loadConfig(root, options) as Record<string, unknown> & { language?: string; inspection: { workers: { heartbeatMs: number } };
    approvals: { pageSize: number } };
  locale = resolveLocale(parsed.language, env, config.language);
  context.onLocale?.(locale);
  const chat = context.describeTerminalChatPlan ? await context.describeTerminalChatPlan(root, options) : null;
  if (parsed.action === 'chat-plan') {
    if (!chat) throw ErrorRegistry.createError('TERMINAL_CHAT_UNAVAILABLE');
    emit(chat, { ...sinks, json: true, render: value => formatValue(value) });
    return;
  }
  if (parsed.action === 'snapshot') {
    const profile = readInferenceServingProfile(config);
    if (!profile) { emit(t('inference.notConfigured', {}, locale), { ...sinks, level: 'error' }); throw ErrorRegistry.createError('CLI_USAGE'); }
    const snapshot = buildWorklineBridgeSnapshot({ profile, plan: buildInferenceServingPlan(profile), tty: { columns: tty.columns, rows: tty.rows }, ledgerTail: [] });
    emit(snapshot, { ...sinks, json: true, render: value => formatValue(value) });
    return;
  }
  if (parsed.action === 'status') {
    const payload = statusPayload(tty, config, chat);
    emit(payload, { ...sinks, json: parsed.json, render: value => parsed.json ? formatValue(value) : renderStatus(value, locale) });
    return;
  }
  const completeTerminalChat = context.completeTerminalChat;
  if (!completeTerminalChat) throw ErrorRegistry.createError('TERMINAL_CHAT_UNAVAILABLE');
  const configured = (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  const scopeId = parsed.scopeId ?? (typeof configured === 'string' ? configured : undefined);
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  // Owner 2026-09-23: an interactive terminal starts the runtime service when none is running; it keeps running after exit.
  // Piped line mode never starts background processes. A start failure is shown, not fatal: local commands still work.
  const autostart = (config['terminal'] as { autostartService?: unknown } | undefined)?.autostartService !== false;
  let serviceLine: string | null = null, serviceFailed = false, skewLine: string | null = null;
  if (context.ensureRuntimeService && autostart && tty.stdin && tty.stdout) {
    try {
      const service = await context.ensureRuntimeService(root, options);
      const stop = service.shutdownAvailable ? t('terminal.service.stopHint', {}, locale) : t('terminal.service.stopUnavailable', {}, locale);
      serviceLine = service.mode === 'started'
        ? t('terminal.service.started', { pid: service.pid ?? '-', log: service.logPath ?? '-', stop }, locale)
        : t('terminal.service.connected', { instance: service.instanceId, stop }, locale);
      // A service started from another build answers with that build's code; say so instead of failing later (Jev 8bb2a0c7).
      const skew = runtimeBuildSkew(readBuildIdentity(), service.build);
      if (skew) skewLine = t('terminal.service.buildSkew', { service: skew.service ?? t('terminal.value.unknown', {}, locale), terminal: skew.terminal }, locale);
    } catch (error) { serviceLine = errorText(error, locale); serviceFailed = true; }
  }
  const historyMessages = chat?.historyMessages ?? DEFAULT_HISTORY_MESSAGES;
  const turn = (messages: readonly ChatTurnMessage[], signal?: AbortSignal) =>
    completeTerminalChat(root, { scopeId, messages }, options, signal);
  if (parsed.action === 'session') {
    if (serviceLine && tty.stdin && tty.stdout) emit(serviceLine, sinks);
    await runSession(locale, context, turn, historyMessages, tty.stdin && tty.stdout,
      () => [renderStatus(statusPayload(tty, config, chat), locale), ...(serviceLine ? [serviceLine] : [])].join('\n'));
    return;
  }
  if (!tty.stdin || !tty.stdout) throw ErrorRegistry.createError('TERMINAL_TTY_REQUIRED');
  const ledger = createWorklineLedgerPorts({ root, scopeId, options, locale, workerHeartbeatMs: config.inspection.workers.heartbeatMs,
    approvalPageSize: config.approvals.pageSize,
    ...(context.inspectWorkers ? { inspectWorkers: context.inspectWorkers } : {}),
    ...(context.inspectRun ? { inspectRun: context.inspectRun } : {}),
    ...(context.inspectInventory ? { inspectInventory: context.inspectInventory } : {}),
    ...(context.inspectWorkerTranscript ? { inspectWorkerTranscript: context.inspectWorkerTranscript } : {}),
    ...(context.listApprovals ? { listApprovals: context.listApprovals } : {}),
    ...(context.decideApproval ? { decideApproval: context.decideApproval } : {}),
    ...(context.deliverRunCancellation ? { deliverRunCancellation: context.deliverRunCancellation } : {}) });
  const target = `${scopeId} · ${chatTarget(chat, locale)}`;
  // History is a convenience: an unavailable history file never blocks the terminal.
  const inputHistory = context.openTerminalHistory ? await context.openTerminalHistory(root, options).catch(() => null) : null;
  const sessionStore = context.openTerminalSessions ? await context.openTerminalSessions(root, options).catch(() => null) : null;
  const sessions = sessionStore ? bindSessionScope(sessionStore, scopeId) : null;
  await runTerminalWorkline({
    labels: worklineLabels(locale, [t('terminal.status.chat', { target: chatTarget(chat, locale) }, locale), ...(serviceLine ? [serviceLine] : [])].join(' · ')),
    target, systemPrompt: t('terminal.chat.systemPrompt', {}, locale), historyMessages,
    completeTurn: turn, errorText: error => errorText(error, locale),
    ...(inputHistory ? { inputHistory } : {}),
    ...(sessions ? { sessions } : {}),
    ...(context.streamTerminalChat ? { streamTurn: (messages: readonly AgentChatMessage[], signal: AbortSignal) =>
      context.streamTerminalChat!(root, { scopeId, messages }, options, signal) } : {}),
    ...(serviceLine ? { openingNotices: [{ level: serviceFailed ? 'error' as const : 'info' as const, text: serviceLine },
      ...(skewLine ? [{ level: 'error' as const, text: skewLine }] : [])] } : {}),
    ...(context.restartRuntimeService ? { restartService: async () => {
      const restarted = await context.restartRuntimeService!(root, options);
      return t('terminal.service.restarted', { pid: restarted.pid ?? '-', instance: restarted.instanceId }, locale);
    } } : {}),
    palette: resolveWorklinePalette(colorTier({ env, isTTY: tty.stdout, argv: process.argv })), ascii: prefersAsciiGlyphs(env),
    ...(ledger ? { ledger } : {}),
    ...(context.stdin ? { stdin: context.stdin as NodeJS.ReadStream } : {}),
    ...(context.stdout ? { stdout: context.stdout as unknown as NodeJS.WriteStream } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  });
}
