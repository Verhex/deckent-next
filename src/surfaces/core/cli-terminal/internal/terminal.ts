import { lineInstructionContext, instructionModelContext, instructionSourceLine, projectInstructionLabels } from '#surfaces/core/project-instructions/index.js';
import type { WorklineStreamTurn } from '#surfaces/core/terminal-kit/index.js';
import { configPanelPort, configTtySlash } from '#surfaces/core/config/index.js';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { loadMonitorSurface, monitorSlash } from '#surfaces/core/monitor/index.js';
import { DeckentError, ErrorRegistry, emit, getConfigKnownSecrets, loadConfig, readBuildIdentity, resolveLocale, t, formatValue, colorCapability, PACKAGE_VERSION, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { buildInferenceServingPlan, estimateReplicaCapacity, readInferenceServingProfile, runtimeConfigFreshness, RUNTIME_SERVICE_HEARTBEAT_MS, type IdentityRead, type InstallationIdentityRead } from '#engine/index.js';
import { prefersAsciiGlyphs, runTerminalWorkline, resolveWorklinePalette, resolveTerminalTheme, STARTUP_BANNERS, TERMINAL_THEME_SETTINGS, type TerminalThemeSetting, type WorklineStartup, buildWorklineBridgeSnapshot, streamLineTurn, boundAgentHistory, boundChatHistory, bindSessionScope, type AgentChatMessage, type ChatTurnMessage, type TurnDelta, type WorklineLabels, type SlashWindowLabels } from '#surfaces/core/terminal/index.js';
import { fillTemplate, plainText, projectHumanText, shortenHomePath } from '#surfaces/core/terminal-render/index.js';
import { terminalComposerLabels, terminalRenderLabels, terminalSessionLabels, terminalStartupLabels } from '#surfaces/core/terminal-labels/index.js';
import { createWorklineLedgerPorts } from './terminal-ledger.js';
import { pickerLabels, runtimeBuildSkew, terminalPanelLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { pickerNeedsTextFallback } from '#surfaces/core/terminal-picker/index.js';
import { mcpPanelPort } from './mcp-panel.js';
import { modelPanelSource } from './model-panel.js';
import { budgetPanelPort } from './budget-panel.js';
import { cachePanelPort } from './cache-panel.js';
import { protocolPanelPort } from './protocol-panel.js';
import { providerPanelPort } from './provider-panel.js';
import type { TerminalLaunchContext, TerminalLaunchPorts } from './context.js';
import { terminalAdminPorts, spendRecoveryView } from '#surfaces/core/terminal-admin/index.js';
import type { ProjectIdentity, PermissionMode } from '#domain/index.js';
import type { TerminalChatPlanView } from './terminal-chat.js';
import { providerDisplayName } from './provider-label.js';

type Action = 'status' | 'session' | 'workline' | 'snapshot' | 'chat-plan';
interface Parsed { action: Action; json: boolean; help: boolean; fullAccess: boolean; trustDigest?: string; language?: string; scopeId?: string }
const ACTIONS: readonly Action[] = ['status', 'session', 'workline', 'snapshot', 'chat-plan'];
const DEFAULT_HISTORY_MESSAGES = 40;
/** Refusals of the identity write admission that leave the interactive view usable (nothing was created; no authority is implied). */
const ADMISSION_DEFERRED = {
  POLICY_UNAVAILABLE: (locale: Locale) => t('terminal.admission.policyUnavailable', {}, locale),
  POLICY_DENIED: (locale: Locale) => t('terminal.admission.policyDenied', {}, locale),
  SCOPE_UNKNOWN: (locale: Locale) => t('terminal.admission.scopeUnknown', {}, locale),
  ATTEMPT_STORE_VERSION: (locale: Locale) => t('terminal.admission.ledgerUpgrade', {}, locale),
} as const;
const UNADMITTED_CUSTODY_LABEL = 'unadmitted';

function parse(argv: readonly string[]): Parsed {
  // Bare `deckent terminal` (options only) is the interactive terminal, the same as `deckent` with no arguments on a TTY.
  const named = argv[1] !== undefined && !argv[1].startsWith('-');
  const action = (named ? argv[1] : 'workline') as Action;
  if (argv[0] !== 'terminal' || !ACTIONS.includes(action)) throw ErrorRegistry.createError('CLI_USAGE');
  const parsed: Parsed = { action, json: false, help: false, fullAccess: false };
  for (let index = named ? 2 : 1; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (key === '--help') parsed.help = true;
    else if (key === '--full-access') parsed.fullAccess = true;
    else if (key === '--trust-instructions' && parsed.trustDigest === undefined) {
      const digest = argv[++index]; if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw ErrorRegistry.createError('CLI_USAGE'); parsed.trustDigest = digest;
    }
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
  // Full access is a launch of the interactive terminal only (MODES-3); no other action runs agent tools.
  if (parsed.fullAccess && parsed.action !== 'workline') throw ErrorRegistry.createError('CLI_USAGE');
  if (parsed.trustDigest && parsed.action !== 'session') throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}

function ttyState(context: TerminalLaunchContext) {
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
    return `${ErrorRegistry.get(error.code, locale, error.params ?? {})?.message ?? error.code}\n${t('terminal.error.code', { code: error.code }, locale)}`;
  }
  return t('terminal.chat.failed', {}, locale);
}

/** The host user's name for `/scope`: display only (the principal itself is derived by the runtime service). */
function hostUserName(): string | null { try { return userInfo().username || null; } catch { return null; } }

function yesNo(value: boolean, locale: Locale): string { return value ? t('terminal.value.yes', {}, locale) : t('terminal.value.no', {}, locale); }

function chatTarget(plan: TerminalChatPlanView | null, locale: Locale): string {
  if (!plan || !plan.reference) return t('terminal.chat.notConfigured', {}, locale);
  const model = `${plan.reference.providerId}/${plan.reference.modelId}@${plan.reference.modelVersion}`;
  return plan.status === 'ready' ? model : `${model} · ${t('terminal.chat.modelNotDeclared', {}, locale)}`;
}

function renderStatus(payload: ReturnType<typeof statusPayload>, locale: Locale): string {
  const { tty, inference, chat, projectId, installationId, identity } = payload;
  const unavailable = (reason: 'not-created' | 'unsupported') => reason === 'not-created'
    ? t('terminal.identity.notCreated', {}, locale) : t('terminal.identity.unsupported', {}, locale);
  return [
    t('terminal.status.installationId', { installationId: installationId ?? unavailable(identity.installation.status === 'unavailable' ? identity.installation.reason : 'not-created') }, locale),
    t('terminal.status.projectId', { projectId: projectId ?? unavailable(identity.project.status === 'unavailable' ? identity.project.reason : 'not-created') }, locale),
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

function statusPayload(tty: ReturnType<typeof ttyState>, config: Record<string, unknown>, chat: TerminalChatPlanView | null, identity: { readonly project: IdentityRead<ProjectIdentity>; readonly installation: InstallationIdentityRead }) {
  const profile = readInferenceServingProfile(config);
  const inference = profile ? (() => {
    const capacity = estimateReplicaCapacity(profile);
    return { configured: true as const, profileId: profile.id, tokenBudget: capacity.totalTokenBudget, maxSeqs: capacity.maxNumSeqs,
      endpoint: buildInferenceServingPlan(profile).openaiBaseUrl };
  })() : { configured: false as const };
  const projectId = identity.project.status === 'available' ? identity.project.value.projectId : null;
  const installationId = identity.installation.status === 'available' ? identity.installation.value.installationId : null;
  return { schemaVersion: 1 as const, tty, inference, chat, projectId, installationId, identity };
}

function modeStopWords(locale: Locale) {
  return { standart: t('terminal.mode.stop.standart', {}, locale), 'ask-edits': t('terminal.mode.stop.ask-edits', {}, locale),
    'full-auto': t('terminal.mode.stop.full-auto', {}, locale), 'full-access': t('terminal.mode.stop.full-access', {}, locale) } as const;
}

/** SLASH-WINDOWS (owner 2026-10-08): the words of the `/reasoning`, `/scratch` and unknown-command windows; absent where the terminal cannot draw a list. */
function slashWindowLabels(locale: Locale): SlashWindowLabels {
  return { picker: pickerLabels(locale), position: t('terminal.window.position', {}, locale), hints: t('terminal.window.hints', {}, locale), infoHints: t('terminal.window.infoHints', {}, locale), typedArgument: t('terminal.window.typedArgument', {}, locale),
    reasoning: { title: t('terminal.window.reasoning.title', {}, locale), thinkingOn: t('terminal.window.reasoning.thinkingOn', {}, locale), thinkingOnDetail: t('terminal.window.reasoning.thinkingOnDetail', {}, locale), thinkingOff: t('terminal.window.reasoning.thinkingOff', {}, locale),
      thinkingOffDetail: t('terminal.window.reasoning.thinkingOffDetail', {}, locale), previewOn: t('terminal.window.reasoning.previewOn', {}, locale), previewOnDetail: t('terminal.window.reasoning.previewOnDetail', {}, locale), previewOff: t('terminal.window.reasoning.previewOff', {}, locale),
      previewOffDetail: t('terminal.window.reasoning.previewOffDetail', {}, locale), current: t('terminal.window.reasoning.current', {}, locale), statusOn: t('terminal.window.reasoning.statusOn', {}, locale), statusOnHidden: t('terminal.window.reasoning.statusOnHidden', {}, locale),
      statusOff: t('terminal.window.reasoning.statusOff', {}, locale) },
    scratch: { title: t('terminal.window.scratch.title', {}, locale), status: t('terminal.window.scratch.status', {}, locale), folder: t('terminal.window.scratch.folder', {}, locale), more: t('terminal.window.scratch.more', {}, locale), empty: t('terminal.window.scratch.empty', {}, locale), fileDetail: t('terminal.window.scratch.fileDetail', {}, locale),
      clear: t('terminal.window.scratch.clear', {}, locale), clearDetail: t('terminal.window.scratch.clearDetail', {}, locale), clearTitle: t('terminal.window.scratch.clearTitle', {}, locale), clearBody: t('terminal.window.scratch.clearBody', {}, locale), clearPrompt: t('terminal.window.scratch.clearPrompt', {}, locale),
      pathTitle: t('terminal.window.scratch.pathTitle', {}, locale) },
    unknown: { title: t('terminal.window.unknown.title', {}, locale), body: t('terminal.window.unknown.body', {}, locale), closest: t('terminal.window.unknown.closest', {}, locale), none: t('terminal.window.unknown.none', {}, locale),
      all: t('terminal.window.unknown.all', {}, locale), allDetail: t('terminal.window.unknown.allDetail', {}, locale) } };
}

function worklineLabels(locale: Locale, statusLine: string): WorklineLabels {
  return {
    work: workSurfaceLabels(locale),
    banner: t('terminal.workline.banner', {}, locale), prompt: '', // workline input has no visible prompt prefix (placeholder instead); line mode keeps terminal.session.prompt
    statusReady: t('terminal.workline.statusReady', {}, locale), statusBusy: t('terminal.workline.statusBusy', {}, locale),
    statusCancelling: t('terminal.workline.statusCancelling', {}, locale), hint: t('terminal.workline.hint', {}, locale),
    selfSourceFloor: t('terminal.mode.selfSourceFloor', {}, locale),
    roleUser: t('terminal.workline.roleUser', {}, locale), roleAssistant: t('terminal.workline.roleAssistant', {}, locale),
    runCard: t('terminal.ledger.runCard', {}, locale), workerCard: t('terminal.ledger.workerCard', {}, locale),
    watchFailed: t('terminal.workline.watchFailed', {}, locale), commandUnavailable: t('terminal.admin.partUnavailable', {}, locale), // `{part}` stays a template
    watchDelivery: t('terminal.workline.watchDelivery', {}, locale), watchStep: t('terminal.workline.watchStep', {}, locale),
    watchNotInitialized: t('terminal.workline.watchNotInitialized', {}, locale),
    watchAccessDenied: t('terminal.workline.watchAccessDenied', {}, locale), watchAccessStopped: t('terminal.workline.watchAccessStopped', {}, locale),
    watchPushFailed: t('terminal.workline.watchPushFailed', {}, locale), ledgerUnavailable: t('terminal.workline.ledgerUnavailable', {}, locale),
    runNotFound: t('terminal.workline.runNotFound', {}, locale), workersEmpty: t('terminal.workline.workersEmpty', {}, locale),
    runsEmpty: t('terminal.workline.runsEmpty', {}, locale), serviceRestartUnavailable: t('terminal.service.restartUnavailable', {}, locale),
    queued: t('terminal.workline.queued', {}, locale),
    runUsage: t('terminal.slash.runUsage', {}, locale), watchStarted: t('terminal.workline.watchStarted', {}, locale),
    watchRunsStarted: t('terminal.workline.watchRunsStarted', {}, locale), watchStopped: t('terminal.workline.watchStopped', {}, locale),
    unknownCommand: t('terminal.workline.unknownCommand', {}, locale), statusLine,
    render: terminalRenderLabels(locale), composer: terminalComposerLabels(locale), sessions: terminalSessionLabels(locale),
    mentions: { attached: t('terminal.mention.attached', {}, locale), truncated: t('terminal.mention.truncated', {}, locale),
      refused: t('terminal.mention.refused', {}, locale) },
    mode: { current: t('terminal.mode.current', {}, locale), changed: t('terminal.mode.changed', {}, locale), inert: t('terminal.mode.inert', {}, locale),
      unsupported: t('terminal.mode.unsupported', {}, locale), usage: t('terminal.mode.usage', {}, locale),
      effect: { standart: t('terminal.mode.effect.standart', {}, locale), 'full-auto': t('terminal.mode.effect.full-auto', {}, locale),
        'full-access': t('terminal.mode.effect.full-access', {}, locale) },
      switch: t('terminal.mode.switch', {}, locale), fullAccessGrant: t('terminal.mode.fullAccessGrant', {}, locale), startSaved: t('terminal.mode.startSaved', {}, locale),
      stops: modeStopWords(locale), cycled: t('terminal.mode.cycled', {}, locale), cycledFullAccess: t('terminal.mode.cycledFullAccess', {}, locale),
      askEditsOn: t('terminal.mode.askEditsOn', {}, locale), askEditsOff: t('terminal.mode.askEditsOff', {}, locale), fullAccessLine: t('tui.panel.mode.fullAccessLine', {}, locale) },
    reasoning: { on: t('terminal.reasoning.on', {}, locale), off: t('terminal.reasoning.off', {}, locale), usage: t('terminal.reasoning.usage', {}, locale), unsupported: t('tui.model.reason.reasoningOff', {}, locale) },
    scratch: { summary: t('terminal.scratch.summary', {}, locale), empty: t('terminal.scratch.empty', {}, locale), entry: t('terminal.scratch.entry', {}, locale),
      more: t('terminal.scratch.more', {}, locale), path: t('terminal.scratch.path', {}, locale), cleared: t('terminal.scratch.cleared', {}, locale),
      usage: t('terminal.scratch.usage', {}, locale) },
  };
}

/**
 * T3 L4: the `/config` and `/mcp` windows' ports and every panel's words (`/mode`'s port is the workline's own). Where the terminal cannot draw
 * a list (TERM=dumb) there are none and the slash commands stay the text commands.
 */
function panelProps(root: string, scopeId: string, context: TerminalLaunchContext, ports: TerminalLaunchPorts, options: ConfigLoadOptions, locale: Locale, env: NodeJS.ProcessEnv) {
  if (pickerNeedsTextFallback(env, true)) return {};
  const providerConnect = context.providerConnect;
  // Stage 1: the scope budget window (create / change) in `/model` and `/provider`, when the host binds the spend read and the governed command.
  const budget = context.inspectProviderSpendAccount && context.manageProviderSpend ? { budget: budgetPanelPort(root, scopeId, { inspectProviderSpendAccount: context.inspectProviderSpendAccount,
    manageProviderSpend: context.manageProviderSpend }, options, locale, error => errorText(error, locale)) } : {};
  // CACHE-SLICE1: the governed 5-minute cache migration of existing profiles, offered in both windows when the governed config writer is bound.
  const planProfileCache = context.planProfileCache;
  const cache = planProfileCache && context.configApplication && context.resolveConfigPrincipal ? { cache: cachePanelPort(root, scopeId, { ...context, planProfileCache }, options, locale) } : {};
  const planProfileProtocol = context.planProfileProtocol;
  const protocol = planProfileProtocol && context.configApplication && context.resolveConfigPrincipal
    ? { protocol: protocolPanelPort(root, scopeId, { ...context, planProfileProtocol }, options, locale) } : {};
  return { panels: { labels: terminalPanelLabels(locale), ports: { ...(context.configApplication ? { config: configPanelPort(root, context, options, locale) } : {}),
    ...(ports.runMcp ? { mcp: mcpPanelPort(root, ports.runMcp, options, locale) } : {}),
    // T4: `/model` lists the declared models with their state; `/provider` connects a kind (free check, key to the secret store through the service).
    // The pin rides only on the streamed agent turn (v23): without that port the window is not offered (no pin that a turn would drop).
    ...(context.inspectDeclaredModels && context.streamTerminalChat ? { model: { ...modelPanelSource(root, scopeId, context, options, locale), ...budget, ...cache, ...protocol } } : {}),
    ...(providerConnect ? { provider: { ...providerPanelPort(root, scopeId, { ...context, providerConnect }, options, locale, error => errorText(error, locale)), ...budget, ...cache } } : {}) } } };
}

/** Line mode is the degraded adapter: it works piped (one turn per input line) and prompts only on a terminal. */
async function runSession(locale: Locale, context: TerminalLaunchContext, turn: (messages: readonly ChatTurnMessage[], signal?: AbortSignal) => Promise<string>,
  historyMessages: number, interactive: boolean, status: () => Promise<string>, known: Parameters<typeof projectHumanText>[2],
  stream?: (messages: readonly AgentChatMessage[], signal: AbortSignal | undefined) => AsyncIterable<TurnDelta>, instructionSources?: () => readonly string[]): Promise<void> {
  // The rich view's one projection (B7 record redaction, controls removed, B8 hidden marks) on every model-written line.
  const project = (text: string, kind: 'exact' | 'prose') => plainText(projectHumanText(text, kind, known).spans);
  const stdin = context.stdin ?? process.stdin;
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const rl = createInterface({ input: stdin, ...(interactive ? { output: process.stdout } : {}), terminal: interactive,
    prompt: t('terminal.session.prompt', {}, locale) });
  const system = { role: 'system' as const, content: t('terminal.chat.systemPrompt', {}, locale) };
  let history: readonly ChatTurnMessage[] = [system];
  // Streaming path (the service's agent turn): the history is the agent's own (tool messages included), written as the turn appends.
  let agentHistory: readonly AgentChatMessage[] = [system];
  if (interactive) { emit(t('terminal.session.banner', {}, locale), sinks); rl.prompt(); }
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '/exit' || trimmed === '/quit') break;
      if (trimmed === '/context') { for (const line of instructionSources?.() ?? []) emit(line, sinks); }
      else if (trimmed === '/status') { emit(await status(), sinks); }
      // Slash input is a local command; an unknown one is reported, never sent to the model as a user message.
      else if (trimmed.startsWith('/')) emit(t('terminal.notice.error', { text: `${t('terminal.workline.unknownCommand', {}, locale)}: ${trimmed}` }, locale), { ...sinks, level: 'error' });
      else if (trimmed.length > 0) {
        if (stream) {
          const messages = boundAgentHistory(system, [...agentHistory, { role: 'user', content: trimmed }], historyMessages);
          const stop = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, stop.signal]) : stop.signal;
          try {
            const turn = await streamLineTurn(stream(messages, signal), { out: context.stdout ?? process.stdout, err: context.stderr ?? process.stderr, cancel: () => stop.abort(), project,
              toolLine: call => t('terminal.line.tool', { name: call.name, target: call.target ?? '-', status: call.status ?? '-', ms: call.ms ?? 0 }, locale),
              approvalLine: summary => t('terminal.line.approvalRefused', { summary }, locale) });
            // Only a finished turn continues the conversation; a cancelled or failed one leaves the question without an answer.
            agentHistory = turn.finish === 'stop' || turn.finish === 'length'
              ? boundAgentHistory(system, [...(turn.compacted ? [system, ...turn.compacted] : messages), ...turn.appended], historyMessages) : messages;
          } catch (error) {
            agentHistory = messages;
            emit(t('terminal.notice.error', { text: errorText(error, locale) }, locale), { ...sinks, level: 'error' });
          }
          if (interactive) rl.prompt();
          continue;
        }
        const messages = boundChatHistory(system, [...history, { role: 'user', content: trimmed }], historyMessages);
        try {
          const reply = await turn(messages, context.signal);
          history = boundChatHistory(system, [...messages, { role: 'assistant', content: reply }], historyMessages);
          emit(project(reply, 'prose'), sinks);
        } catch (error) {
          history = messages;
          emit(t('terminal.notice.error', { text: errorText(error, locale) }, locale), { ...sinks, level: 'error' });
        }
      }
      if (interactive) rl.prompt();
    }
  } finally { rl.close(); }
  if (interactive) emit(t('terminal.session.closed', {}, locale), sinks);
}

export async function terminalCommand(argv: readonly string[], context: TerminalLaunchContext, ports: TerminalLaunchPorts): Promise<void> {
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
  const readIdentity = async () => ({ installation: await context.loadInstallationIdentity?.(root, options)
    ?? { status: 'unavailable', reason: 'unsupported', bindingCapability: 'not-observed' } as const,
  project: await context.loadProjectIdentity?.(root, options) ?? { status: 'unavailable', reason: 'unsupported' } as const });
  if (parsed.action === 'status') {
    const payload = statusPayload(tty, config, chat, await readIdentity());
    emit(payload, { ...sinks, json: parsed.json, render: value => parsed.json ? formatValue(value) : renderStatus(value, locale) });
    return;
  }
  const completeTerminalChat = context.completeTerminalChat;
  if (!completeTerminalChat) throw ErrorRegistry.createError('TERMINAL_CHAT_UNAVAILABLE');
  const configured = (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  const scopeId = parsed.scopeId ?? (typeof configured === 'string' ? configured : undefined);
  if (!scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  if (parsed.action !== 'session' && (!tty.stdin || !tty.stdout)) throw ErrorRegistry.createError('TERMINAL_TTY_REQUIRED');
  // Admit identity before runtime startup or session/history writes. Piped line mode remains read-only until a governed turn writes.
  let installationId: string | undefined, projectId: string | undefined;
  const accessNotices: { level: 'info' | 'warning' | 'error'; text: string }[] = [];
  if (tty.stdin && tty.stdout) {
    if (!context.ensureTerminalIdentity) throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
    try { ({ installationId, projectId } = await context.ensureTerminalIdentity(root, scopeId, options)); }
    catch (error) {
      // Identity integrity refusals (unsupported, relocated, invalid, locked) stay fatal. A write admission that the trusted policy or a
      // not-yet-upgraded ledger refuses creates nothing; the view still opens and every governed command meets its own gate (B36 R6).
      // Existing identities are only read; absent ones get a fixed panel custody label that is never persisted, shown or authority.
      const code = String((error as { code?: unknown }).code);
      if (!Object.hasOwn(ADMISSION_DEFERRED, code)) throw error;
      accessNotices.push({ level: 'error', text: ADMISSION_DEFERRED[code as keyof typeof ADMISSION_DEFERRED](locale) });
      const observed = await readIdentity();
      installationId = observed.installation.status === 'available' ? observed.installation.value.installationId : UNADMITTED_CUSTODY_LABEL;
      projectId = observed.project.status === 'available' ? observed.project.value.projectId : UNADMITTED_CUSTODY_LABEL;
    }
    if (!installationId) throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
    if (!projectId) throw ErrorRegistry.createError('PROJECT_IDENTITY_UNAVAILABLE');
  }
  // Owner 2026-09-23: an interactive terminal starts the runtime service when none is running; it keeps running after exit.
  // Piped line mode never starts background processes. A start failure is shown, not fatal: local commands still work.
  const autostart = (config['terminal'] as { autostartService?: unknown } | undefined)?.autostartService !== false;
  let serviceLine: string | null = null, serviceFailed = false, skewLine: string | null = null, configLine: string | null = null, idleStops = false;
  if (context.ensureRuntimeService && autostart && tty.stdin && tty.stdout) {
    try {
      const service = await context.ensureRuntimeService(root, options);
      const stop = service.shutdownAvailable ? t('terminal.service.stopHint', {}, locale) : t('terminal.service.stopUnavailable', {}, locale);
      serviceLine = service.mode === 'started'
        ? t('terminal.service.started', { pid: service.pid ?? '-', log: service.logPath ?? '-', stop }, locale)
        : t('terminal.service.connected', { instance: service.instanceId, stop }, locale);
      // A service started from another build answers with that build's code; say so instead of failing later (Jev 8bb2a0c7).
      const skew = runtimeBuildSkew(readBuildIdentity(), service.build);
      // A restart-apply section changed since the service started (measured against the service's own fingerprint, never assumed).
      if (runtimeConfigFreshness(service.configDigest, config) === 'stale') configLine = t('terminal.service.configStale', {}, locale); idleStops = service.idleStopMs != null;
      if (skew) skewLine = t('terminal.service.buildSkew', { service: skew.service ?? t('terminal.value.unknown', {}, locale), terminal: skew.terminal }, locale);
    } catch (error) { serviceLine = errorText(error, locale); serviceFailed = true; }
  }
  const historyMessages = chat?.historyMessages ?? DEFAULT_HISTORY_MESSAGES;
  const instructionPort = context.openProjectInstructions ? await context.openProjectInstructions(root, options) : undefined;
  const instructionLabels = projectInstructionLabels(locale);
  let lineSources: readonly string[] = [];
  const withInstructions = async <T extends { readonly role: string }>(messages: readonly T[]) => {
    const view = await lineInstructionContext(instructionPort, parsed.trustDigest);
    lineSources = view.status === 'ready' ? [instructionSourceLine(view.source, instructionLabels)] : [];
    if (view.status === 'trust-required' || view.status === 'ready') emit(instructionSourceLine(view.source, instructionLabels), sinks);
    if (view.status === 'trust-required') emit(fillTemplate(instructionLabels.lineTrustRequired, { digest: view.source.digest }), sinks);
    if (view.status === 'blocked') emit(fillTemplate(instructionLabels.blocked, { reason: view.reason }), sinks);
    const system = { role: 'system' as const, content: t('terminal.chat.systemPrompt', {}, locale) + instructionModelContext(view) };
    return [system, ...messages.filter(message => message.role !== 'system')];
  };
  const turn = async (messages: readonly ChatTurnMessage[], signal?: AbortSignal) =>
    completeTerminalChat(root, { scopeId, messages: parsed.action === 'session' ? await withInstructions(messages) : messages }, options, signal);
  if (parsed.action === 'session') {
    for (const notice of accessNotices) emit(notice.text, sinks);
    if (serviceLine && tty.stdin && tty.stdout) emit(serviceLine, sinks);
    const lineStream = context.streamTerminalChat ? (messages: readonly AgentChatMessage[], signal: AbortSignal | undefined) =>
      (async function* () { yield* context.streamTerminalChat!(root, { scopeId, messages: await withInstructions(messages) }, options, signal); })() : undefined;
    await runSession(locale, context, turn, historyMessages, tty.stdin && tty.stdout,
      async () => [renderStatus(statusPayload(tty, config, chat, await readIdentity()), locale), ...(serviceLine ? [serviceLine] : [])].join('\n'), getConfigKnownSecrets(config), lineStream, () => lineSources);
    return;
  }
  if (!tty.stdin || !tty.stdout) throw ErrorRegistry.createError('TERMINAL_TTY_REQUIRED');
  // T-L4 slice 4c: the mode is read and set through the runtime service (v15); this surface reads and writes no policy file.
  const modePort = context.inspectPermissionMode && context.setPermissionMode ? {
    inspect: (signal?: AbortSignal) => context.inspectPermissionMode!(root, { schemaVersion: 1, scopeId }, options, signal),
    set: (mode: PermissionMode, expectedRevision: string, askEdits?: boolean, session?: { readonly sessionId: string | null }) => context.setPermissionMode!(root,
      { schemaVersion: 1, scopeId, mode, expectedRevision, ...(askEdits === undefined ? {} : { askEdits }), ...(session ? { session: { sessionId: session.sessionId } } : {}) }, options) } : null;
  // MODES-3: full access starts only here — `--full-access` or the person's stored start mode — and only on the company grant (the service asks
  // it again on every turn and call). An explicit flag without the grant is refused; a stored start mode without it opens a standart session.
  let fullAccess = false;
  if (parsed.fullAccess && !modePort) throw ErrorRegistry.createError('TERMINAL_CHAT_UNAVAILABLE');
  const view = modePort ? await (parsed.fullAccess ? modePort.inspect(context.signal) : modePort.inspect(context.signal).catch(() => null)) : null;
  if (parsed.fullAccess && !view?.fullAccess) throw ErrorRegistry.createError('PERMISSION_MODE_DENIED', { params: { mode: 'full-access' } });
  if (parsed.fullAccess || (view?.mode === 'full-access' && view.fullAccess)) fullAccess = true;
  else if (view?.mode === 'full-access') accessNotices.push({ level: 'error', text: t('terminal.fullAccess.startDenied', {}, locale) });
  if (fullAccess) accessNotices.push({ level: 'error', text: t('terminal.fullAccess.banner', {}, locale) });
  const ledger = createWorklineLedgerPorts({ root, scopeId, options, locale, workerHeartbeatMs: config.inspection.workers.heartbeatMs, renderRunCancellation: ports.renderRunCancellation,
    approvalPageSize: config.approvals.pageSize,
    ...(context.inspectWorkers ? { inspectWorkers: context.inspectWorkers } : {}),
    ...(context.inspectRun ? { inspectRun: context.inspectRun } : {}),
    ...(context.inspectInventory ? { inspectInventory: context.inspectInventory } : {}),
    ...(context.inspectWorkerTranscript ? { inspectWorkerTranscript: context.inspectWorkerTranscript } : {}),
    ...(context.listApprovals ? { listApprovals: context.listApprovals } : {}),
    ...(context.clearSessionStanding ? { clearSessionStanding: context.clearSessionStanding } : {}),
    ...(context.decideApproval ? { decideApproval: context.decideApproval } : {}),
    ...(context.deliverRunCancellation ? { deliverRunCancellation: context.deliverRunCancellation } : {}),
    ...(context.inspectSurfaceAccess ? { inspectSurfaceAccess: () => context.inspectSurfaceAccess!(root, scopeId, options) } : {}),
    ...(context.inspectSurfaceRunIds ? { inspectSurfaceRunIds: () => context.inspectSurfaceRunIds!(root, scopeId, options) } : {}),
    ...(context.followSurfaceEvents ? { followEvents: signal => context.followSurfaceEvents!(root, scopeId, options, signal) } : {}) });
  const target = scopeId;
  // T2: theme and tier from what the terminal can draw and the person's setting; the banner and the clear from their settings (TERM=dumb never
  // clears). A config without a `terminal` section (scope from --scope) keeps every default.
  const presentation = (config['terminal'] ?? {}) as { readonly theme?: TerminalThemeSetting; readonly banner?: WorklineStartup['banner']; readonly clearOnStart?: boolean };
  const theme = resolveTerminalTheme(presentation.theme ?? TERMINAL_THEME_SETTINGS[0], colorCapability({ env, isTTY: tty.stdout, argv: process.argv }), env['COLORFGBG']);
  const ascii = prefersAsciiGlyphs(env);
  const home = env['HOME'] ?? env['USERPROFILE'], where = shortenHomePath(root, home);
  const startup: WorklineStartup = { clear: presentation.clearOnStart !== false && env['TERM']?.trim().toLowerCase() !== 'dumb', banner: presentation.banner ?? STARTUP_BANNERS[0],
    ...terminalStartupLabels(locale, { version: PACKAGE_VERSION, project: basename(root), path: where, model: chatTarget(chat, locale) }, ascii) };
  // History is a convenience: an unavailable history file never blocks the terminal.
  const inputHistory = context.openTerminalHistory ? await context.openTerminalHistory(root, options).catch(() => null) : null;
  const sessionStore = context.openTerminalSessions ? await context.openTerminalSessions(root, options).catch(() => null) : null;
  const sessions = sessionStore ? bindSessionScope(sessionStore, scopeId) : null;
  // TERM-UX-1 a: the first `@` finds the service's file list already walked. One empty query warms it in the background (same authorization
  // and deny as any `@`); a service that is not there or refuses is left to the person's own first `@`.
  if (!serviceFailed && context.findTerminalMentions) void context.findTerminalMentions(root, { scopeId, query: '' }, options, context.signal).catch(() => undefined);
  if (!installationId) throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  if (!projectId) throw ErrorRegistry.createError('PROJECT_IDENTITY_UNAVAILABLE');
  // K6 = A: a service that stops itself when idle counts this open terminal as a client only through this beat (clients connect per request).
  const beat = idleStops && context.describeRuntimeService ? setInterval(() => { void context.describeRuntimeService!(root, options).catch(() => undefined); }, RUNTIME_SERVICE_HEARTBEAT_MS).unref() : null;
  try { await runTerminalWorkline({
    context: { installationId, projectId, scopeId },
    knownSecrets: getConfigKnownSecrets(config),
    selfSource: await context.selfSourceProject?.(root) ?? false,
    labels: { ...worklineLabels(locale, [t('terminal.status.chat', { target: chatTarget(chat, locale) }, locale), ...(serviceLine ? [serviceLine] : [])].join(' · ')),
      ...(pickerNeedsTextFallback(env, true) ? {} : { windows: slashWindowLabels(locale) }) },
    ...(instructionPort && !pickerNeedsTextFallback(env, true) ? { projectInstructions: { port: instructionPort, labels: instructionLabels } } : {}),
    target, model: chat?.reference?.modelId ?? chatTarget(chat, locale),
    ...(chat?.reference ? { provider: providerDisplayName(chat.reference.providerId, context.providerConnect, locale) } : {}),
    systemPrompt: t('terminal.chat.systemPrompt', {}, locale), historyMessages, projectRoot: root, ...(home ? { homeDirectory: home } : {}),
    // Owner 2026-10-08: `/clear` clears screen and scrollback; no escape sequence on TERM=dumb (and never to a non-TTY).
    // NO_COLOR concerns colour only, so it does not stop the clear.
    clearScreen: env['TERM']?.trim().toLowerCase() !== 'dumb',
    completeTurn: turn, errorText: error => errorText(error, locale),
    ...(context.inspectProviderSpendAccount && context.manageProviderSpend ? { spending: () => spendRecoveryView({ root, scopeId, options, locale, context }) } : {}),
    ...(inputHistory ? { inputHistory } : {}),
    // T-L5 `@file`: candidates and content come from the runtime service's scoped read port; this surface reads no file.
    ...(context.findTerminalMentions ? { mentions: (query: string, signal: AbortSignal) => context.findTerminalMentions!(root, { scopeId, query }, options, signal) } : {}),
    ...(context.attachTerminalMentions ? { attachMentions: (text: string, paths: readonly string[], signal: AbortSignal) =>
      context.attachTerminalMentions!(root, { scopeId, text, paths }, options, signal) } : {}),
    ...(sessions ? { sessions } : {}),
    ...(modePort ? { permissionMode: modePort } : {}), ...(fullAccess ? { fullAccess } : {}),
    ...(context.streamTerminalChat ? { streamTurn: (messages: readonly AgentChatMessage[], signal: AbortSignal, turn?: Parameters<WorklineStreamTurn>[2]) =>
      context.streamTerminalChat!(root, { scopeId, messages, ...(turn?.reasoning ? { reasoning: turn.reasoning } : {}),
        ...(turn?.sessionId ? { sessionId: turn.sessionId } : {}), ...(turn?.fullAccess ? { fullAccess: true as const } : {}), ...(turn?.reference ? { reference: turn.reference } : {}),
        ...(turn?.onTurnBound ? { onTurnBound: turn.onTurnBound } : {}) }, options, signal) } : {}),
    // SCR-A `/scratch`: the conversation's scratch area through the runtime service (v16); this surface reads and deletes no file.
    ...(context.inspectScratch && context.clearScratch ? { scratch: {
      inspect: (sessionId: string, signal?: AbortSignal) => context.inspectScratch!(root, { schemaVersion: 1, scopeId, sessionId }, options, signal),
      clear: (sessionId: string) => context.clearScratch!(root, { schemaVersion: 1, scopeId, sessionId }, options) } } : {}),
    // TERMINAL-CLOSE S09: `/status`, `/model`, `/usage`, `/doctor`, `/scope` re-read their typed producers on every call (this surface keeps no copy).
    ...terminalAdminPorts({ root, scopeId, installationId, projectId, options, locale, context, principalName: hostUserName(),
      status: async () => renderStatus(statusPayload(ttyState(context), await loadConfig(root, options), context.describeTerminalChatPlan ? await context.describeTerminalChatPlan(root, options) : null, await readIdentity()), locale),
      doctor: sink => ports.runKernelCommand(['doctor', '--lang', locale], { root, env, stdout: sink, stderr: sink }),
      // SW-1: the `/doctor` window groups the same command's structured report by area.
      doctorReport: sink => ports.runKernelCommand(['doctor', '--json', '--lang', locale], { root, env, stdout: sink, stderr: sink }) }),
    ...(ports.mcpSlash ? { mcp: (args: string) => ports.mcpSlash!(root, args, options, locale) } : {}),
    ...(context.configApplication ? { config: (args: string) => configTtySlash(root, args, context, options, locale, Math.max(40, (tty.columns ?? 100) - 4)) } : {}),
    ...panelProps(root, scopeId, context, ports, options, locale, env),
    // MONITOR: `/monitor` prints the monitor's text snapshot as notice lines (the fullscreen view is `deckent monitor`).
    ...(context.inspectMonitor ? { monitor: (args: string) => monitorSlash(root, args, context, options, locale, Math.max(40, (tty.columns ?? 100) - 4)) } : {}),
    // T3 L5: a bare `/monitor` opens the monitor in a window. The view loads on the first use (like `deckent monitor`); this unit stays free of it until then.
    ...(context.inspectMonitor ? { monitorWindow: async () => {
      const surface = await loadMonitorSurface(), inspect = context.inspectMonitor!;
      return surface.monitorWindowView({ load: () => inspect(root, options), intervalMs: config.inspection.workers.heartbeatMs, locale, ascii,
        palette: resolveWorklinePalette(theme.tier, theme.theme), errorText: error => surface.monitorFailureText(error, locale),
        ...(context.configApplication ? { loadConfigView: () => context.configApplication!(root, options).inspect() } : {}) });
    } } : {}),
    ...(serviceLine || accessNotices.length ? { openingNotices: [...accessNotices, ...(serviceLine ? [{ level: serviceFailed ? 'error' as const : 'info' as const, text: serviceLine }] : []),
      ...(skewLine ? [{ level: 'warning' as const, text: skewLine }] : []), ...(configLine ? [{ level: 'error' as const, text: configLine }] : [])] } : {}),
    ...(context.restartRuntimeService ? { restartService: async () => {
      const restarted = await context.restartRuntimeService!(root, options);
      return t('terminal.service.restarted', { pid: restarted.pid ?? '-', instance: restarted.instanceId }, locale);
    } } : {}),
    palette: resolveWorklinePalette(theme.tier, theme.theme), ascii, startup,
    ...(ledger ? { ledger } : {}),
    ...(context.stdin ? { stdin: context.stdin as NodeJS.ReadStream } : {}),
    ...(context.stdout ? { stdout: context.stdout as unknown as NodeJS.WriteStream } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  }); } finally { if (beat) clearInterval(beat); }
}
