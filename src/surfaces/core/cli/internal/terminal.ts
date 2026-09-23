import { createInterface } from 'node:readline';
import { DeckentError, ErrorRegistry, emit, loadConfig, resolveLocale, t, formatValue, colorTier, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { buildInferenceServingPlan, estimateReplicaCapacity, readInferenceServingProfile } from '#engine/index.js';
import { runTerminalWorkline, resolveWorklinePalette, buildWorklineBridgeSnapshot, boundChatHistory, type ChatTurnMessage, type WorklineLabels } from '#surfaces/core/terminal/index.js';
import { createWorklineLedgerPorts } from './terminal-ledger.js';
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

function worklineLabels(locale: Locale, statusLine: string): WorklineLabels {
  return {
    banner: t('terminal.workline.banner', {}, locale), prompt: t('terminal.session.prompt', {}, locale),
    statusReady: t('terminal.workline.statusReady', {}, locale), statusBusy: t('terminal.workline.statusBusy', {}, locale),
    statusCancelling: t('terminal.workline.statusCancelling', {}, locale), hint: t('terminal.workline.hint', {}, locale),
    roleUser: t('terminal.workline.roleUser', {}, locale), roleAssistant: t('terminal.workline.roleAssistant', {}, locale),
    runCard: t('terminal.ledger.runCard', {}, locale), workerCard: t('terminal.ledger.workerCard', {}, locale),
    watchFailed: t('terminal.workline.watchFailed', {}, locale), ledgerUnavailable: t('terminal.workline.ledgerUnavailable', {}, locale),
    runNotFound: t('terminal.workline.runNotFound', {}, locale), workersEmpty: t('terminal.workline.workersEmpty', {}, locale),
    runsEmpty: t('terminal.workline.runsEmpty', {}, locale),
    runUsage: t('terminal.slash.runUsage', {}, locale), watchStarted: t('terminal.workline.watchStarted', {}, locale),
    watchRunsStarted: t('terminal.workline.watchRunsStarted', {}, locale), watchStopped: t('terminal.workline.watchStopped', {}, locale),
    unknownCommand: t('terminal.workline.unknownCommand', {}, locale), statusLine,
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
  const config = await loadConfig(root, options) as Record<string, unknown> & { language?: string; inspection: { workers: { heartbeatMs: number } } };
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
  let serviceLine: string | null = null, serviceFailed = false;
  if (context.ensureRuntimeService && autostart && tty.stdin && tty.stdout) {
    try {
      const service = await context.ensureRuntimeService(root, options);
      serviceLine = service.mode === 'started'
        ? t('terminal.service.started', { pid: service.pid ?? '-', log: service.logPath ?? '-' }, locale)
        : t('terminal.service.connected', { instance: service.instanceId }, locale);
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
  const ledger = createWorklineLedgerPorts({ root, scopeId, options, workerHeartbeatMs: config.inspection.workers.heartbeatMs,
    ...(context.inspectWorkers ? { inspectWorkers: context.inspectWorkers } : {}),
    ...(context.inspectRun ? { inspectRun: context.inspectRun } : {}),
    ...(context.inspectInventory ? { inspectInventory: context.inspectInventory } : {}) });
  const target = `${scopeId} · ${chatTarget(chat, locale)}`;
  await runTerminalWorkline({
    labels: worklineLabels(locale, [t('terminal.status.chat', { target: chatTarget(chat, locale) }, locale), ...(serviceLine ? [serviceLine] : [])].join(' · ')),
    target, systemPrompt: t('terminal.chat.systemPrompt', {}, locale), historyMessages,
    completeTurn: turn, errorText: error => errorText(error, locale),
    ...(serviceLine ? { openingNotices: [{ level: serviceFailed ? 'error' as const : 'info' as const, text: serviceLine }] } : {}),
    palette: resolveWorklinePalette(colorTier({ env, isTTY: tty.stdout, argv: process.argv })),
    ...(ledger ? { ledger } : {}),
    ...(context.stdin ? { stdin: context.stdin as NodeJS.ReadStream } : {}),
    ...(context.stdout ? { stdout: context.stdout as unknown as NodeJS.WriteStream } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  });
}
