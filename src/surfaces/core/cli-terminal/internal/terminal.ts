import { hubPanelPort } from '#surfaces/core/terminal-hub/index.js';
import { permissionModeOpener } from './mode-open-card.js';
import { lineInstructionContext, instructionModelContext, instructionSourceLine, projectInstructionLabels } from '#surfaces/core/project-instructions/index.js';
import { lazySessionStore, serviceAbsenceWatch, type WorklineStreamTurn } from '#surfaces/core/terminal-kit/index.js';
import { configPanelPort, configTtySlash } from '#surfaces/core/config/index.js';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { loadMonitorSurface, monitorSlash } from '#surfaces/core/monitor/index.js';
import { DeckentError, ErrorRegistry, emit, getConfigMetadata, getConfigKnownSecrets, loadConfig, readBuildIdentity, resolveLocale, t, formatValue, colorCapability, clockText, PACKAGE_VERSION, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { buildInferenceServingPlan, estimateReplicaCapacity, readInferenceServingProfile, runtimeConfigFreshness, RUNTIME_SERVICE_HEARTBEAT_MS, type IdentityRead, type InstallationIdentityRead, type ProjectInstructionPort } from '#engine/index.js';
import { prefersAsciiGlyphs, runTerminalWorkline, resolveWorklinePalette, resolveTerminalTheme, STARTUP_BANNERS, TERMINAL_THEME_SETTINGS, type TerminalThemeSetting, type WorklineStartup, buildWorklineBridgeSnapshot, streamLineTurn, boundAgentHistory, boundChatHistory, bindSessionScope, type AgentChatMessage, type ChatTurnMessage, type TurnDelta } from '#surfaces/core/terminal/index.js';
import { fillTemplate, plainText, projectHumanText, shortenHomePath } from '#surfaces/core/terminal-render/index.js';
import { slashWindowLabels, worklineLabels, terminalStartupLabels } from '#surfaces/core/terminal-labels/index.js';
import { createWorklineLedgerPorts } from './terminal-ledger.js';
import { terminalDeliveryPort } from './deliver-port.js';
import { deliveryWindowLabels, runtimeBuildSkew, terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { pickerNeedsTextFallback } from '#surfaces/core/terminal-picker/index.js';
import { mcpPanelPort } from './mcp-panel.js';
import { secretGrantCardPort } from './secret-grant-card.js';
import { modelPanelSource } from './model-panel.js';
import { budgetPanelPort } from './budget-panel.js';
import { cachePanelPort } from './cache-panel.js';
import { workspacePanelPort } from './workspace-panel.js';
import { protocolPanelPort } from './protocol-panel.js';
import { providerPanelPort } from './provider-panel.js';
import { policyPanelPort } from './policy-panel.js';
import type { TerminalLaunchContext, TerminalLaunchPorts } from './context.js';
import { terminalAdminPorts, spendRecoveryView } from '#surfaces/core/terminal-admin/index.js';
import type { ProjectIdentity, PermissionMode, ModelReference, BrainPlanObserver, BrainPlanProgress } from '#domain/index.js';
import type { TerminalChatPlanView } from './terminal-chat.js';
import { providerDisplayName } from './provider-label.js';
const DEFAULT_HISTORY_MESSAGES = 40;
/** Refusals of the identity write admission that leave the interactive view usable (nothing was created; no authority is implied). */
const ADMISSION_DEFERRED = {
  POLICY_UNAVAILABLE: (locale: Locale) => t('terminal.admission.policyUnavailable', {}, locale),
  POLICY_DENIED: (locale: Locale) => t('terminal.admission.policyDenied', {}, locale),
  SCOPE_UNKNOWN: (locale: Locale) => t('terminal.admission.scopeUnknown', {}, locale),
  ATTEMPT_STORE_VERSION: (locale: Locale) => t('terminal.admission.ledgerUpgrade', {}, locale),
} as const;
const UNADMITTED_CUSTODY_LABEL = 'unadmitted';
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

/**
 * T3 L4: the `/config` and `/mcp` windows' ports and every panel's words (`/mode`'s port is the workline's own). Where the terminal cannot draw
 * a list (TERM=dumb) there are none and the slash commands stay the text commands.
 */
function panelProps(root: string, scopeId: string, context: TerminalLaunchContext, ports: TerminalLaunchPorts, options: ConfigLoadOptions, locale: Locale, env: NodeJS.ProcessEnv, config: { cli: { invocationInputMaxBytes: number }; approvals: { sessionTtlMs: number } }) {
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
  const openProviderWorkspaces = context.openProviderWorkspaces;
  const workspace = openProviderWorkspaces && context.configApplication && context.resolveConfigPrincipal ? { workspace: workspacePanelPort(root, scopeId, { ...context, openProviderWorkspaces }, options, locale) } : {};
  return { panels: { labels: terminalPanelLabels(locale), ports: { ...(context.configApplication ? { config: configPanelPort(root, context, options, locale) } : {}),
    ...(context.mcpCapabilities ? { policy: policyPanelPort(root, context.mcpCapabilities, options, locale, context.delegations, context.openOwnerBaselineInstallation) } : {}),
    ...(context.executeHub ? { hub: hubPanelPort({ root, scopeId, options, locale, known: getConfigKnownSecrets(config), maxBytes: config.cli.invocationInputMaxBytes, timeoutMs: config.approvals.sessionTtlMs, execute: context.executeHub }) } : {}),
    ...(ports.runMcp ? { mcp: mcpPanelPort(root, ports.runMcp, options, locale, context.secretGrantCard ? secretGrantCardPort(root, scopeId, options, locale, context.secretGrantCard, env['HOME'] ?? env['USERPROFILE']) : undefined) } : {}),
    // T4: `/model` lists the declared models with their state; `/provider` connects a kind (free check, key to the secret store through the service).
    // The pin rides only on the streamed agent turn (v23): without that port the window is not offered (no pin that a turn would drop).
    ...(context.inspectDeclaredModels && context.streamTerminalChat ? { model: { ...modelPanelSource(root, scopeId, context, options, locale), ...(providerConnect ? { provider: providerPanelPort(root, scopeId, { ...context, providerConnect }, options, locale, error => errorText(error, locale), context.secretGrantCard ? secretGrantCardPort(root, scopeId, options, locale, context.secretGrantCard, env['HOME'] ?? env['USERPROFILE']) : undefined) } : {}), ...budget, ...cache, ...protocol, ...workspace } } : {}),
    // PRE-8 v2: the same first-use card as the chat turn when a model list, a model connection or a just-stored key needs a grant here.
    ...(providerConnect ? { provider: { ...providerPanelPort(root, scopeId, { ...context, providerConnect }, options, locale, error => errorText(error, locale),
      context.secretGrantCard ? secretGrantCardPort(root, scopeId, options, locale, context.secretGrantCard, env['HOME'] ?? env['USERPROFILE']) : undefined), ...budget, ...cache } } : {}) } } };
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
      else if (trimmed === '/help') { emit(t('terminal.session.help', {}, locale), sinks); } // KER-09: line mode's own commands, on stdout
      else if (trimmed.startsWith('/')) emit(t('terminal.notice.error', { text: t('terminal.session.unknown', { command: trimmed.split(/\s/u)[0]! }, locale) }, locale), { ...sinks, level: 'error' }); // local, never sent to the model
      else if (trimmed.length > 0) {
        if (stream) {
          const messages = boundAgentHistory(system, [...agentHistory, { role: 'user', content: trimmed }], historyMessages);
          const stop = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, stop.signal]) : stop.signal;
          try {
            const turn = await streamLineTurn(stream(messages, signal), { out: context.stdout ?? process.stdout, err: context.stderr ?? process.stderr, cancel: () => stop.abort(), ...(known ? { knownSecrets: known } : {}), project,
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
  const parsed = (await import('#surfaces/core/terminal-onboarding/index.js')).parseTerminalLaunch(argv);
  const root = context.root ?? process.cwd();
  const env = context.env ?? process.env;
  let locale = resolveLocale(parsed.language, env);
  context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) { emit(t('cli.help.terminal', {}, locale), sinks); return; }
  const tty = ttyState(context);
  const options: ConfigLoadOptions = { env };
  const config = await loadConfig(root, options) as Record<string, unknown> & { cli: { invocationInputMaxBytes: number }; language?: string; inspection: { workers: { heartbeatMs: number } };
    approvals: { pageSize: number; sessionTtlMs: number } };
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
    const snapshot = buildWorklineBridgeSnapshot({ profile, plan: buildInferenceServingPlan(profile), tty: { columns: tty.columns, rows: tty.rows }, ledgerTail: [], knownSecrets: getConfigKnownSecrets(config) });
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
  const hereModel = async (pinned?: ModelReference) => pinned ?? await context.describeTerminalChatPlan?.(root, options).then(plan => plan.source === 'connected' || plan.skippedDefault ? plan.reference ?? undefined : undefined, () => undefined); // M-08/AYSE-13: the model this terminal shows is the person's choice; /do passes it
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
  if (!await (await import('#surfaces/core/cli-human/index.js')).reopenRetiredFolder(config, locale, env, context, options)) return;
  const autostart = (config['terminal'] as { autostartService?: unknown } | undefined)?.autostartService !== false;
  // alpha.60 B (P3 draw-first): nothing below waits before the frame. One single-flight start serves the opening and a turn's restart (M-09); its
  // own LifecycleDeadline bounds it. Sessions, history, instructions and setup open on first use or after the frame.
  const lazy = <T>(open: () => Promise<T>) => { let made: Promise<T> | undefined; return () => made ??= open(); }, closing = new AbortController(); // closing: the view returned
  let starting: Promise<Awaited<ReturnType<NonNullable<typeof context.ensureRuntimeService>>>> | null = null;
  const ensure = () => starting ??= context.ensureRuntimeService!(root, options).finally(() => { starting = null; });
  const service = context.ensureRuntimeService && autostart && tty.stdin && tty.stdout ? ensure() : null, settled = service ? service.then(() => true, () => false) : Promise.resolve(false);
  const serviceNotices = service ? service.then(started => {
    const stop = started.shutdownAvailable ? t('terminal.service.stopHint', {}, locale) : t('terminal.service.stopUnavailable', {}, locale);
    // A service started from another build answers with that build's code; say so instead of failing later (Jev 8bb2a0c7).
    const skew = runtimeBuildSkew(readBuildIdentity(), started.build);
    // A restart-apply section changed since the service started (measured against the service's own fingerprint, never assumed).
    return [{ level: 'info' as const, text: started.mode === 'started' ? t('terminal.service.started', { pid: started.pid ?? '-', log: started.logPath ?? '-', stop }, locale) : t('terminal.service.connected', { instance: started.instanceId, stop }, locale) },
      ...(skew ? [{ level: 'warning' as const, text: t('terminal.service.buildSkew', { service: skew.service ?? t('terminal.value.unknown', {}, locale), terminal: skew.terminal }, locale) }] : []),
      ...(runtimeConfigFreshness(started.configDigest, config) === 'stale' ? [{ level: 'warning' as const, text: t('terminal.service.configStale', {}, locale) }] : [])];
  }, (error: unknown) => [{ level: 'error' as const, text: errorText(error, locale) }]) : Promise.resolve([]);
  // Presence follows the switch the store reads (`terminal.persistHistory`); the store opens on its first use.
  const sessionStore = parsed.action === 'workline' && context.openTerminalSessions && (config['terminal'] as { persistHistory?: unknown } | undefined)?.persistHistory !== false
    ? lazySessionStore(() => settled.then(() => context.openTerminalSessions!(root, options, context.rootResolution?.folder ?? ''))) : null, sessions = sessionStore ? bindSessionScope(sessionStore, scopeId) : null; // Astra 2858 B-R3: identity → service attempt → session store
  const previous = lazy(() => sessions ? sessions.list().then(list => list.some(session => session.messages > 0) ? t('terminal.session.previous', {}, locale) : undefined, () => undefined) : Promise.resolve(undefined));
  let onboarding: import('#surfaces/core/terminal-onboarding/index.js').OnboardingHandoff | undefined;
  if (parsed.action === 'workline' && context.openOnboarding && (await import('#surfaces/core/cli-human/index.js')).cliMode(context).mode === 'interactive') {
    const surface = await import('#surfaces/core/terminal-onboarding/index.js'), openOnboarding = context.openOnboarding;
    const port = lazy(() => openOnboarding(root, scopeId, context.rootResolution?.folder ?? '', options));
    // Astra 2834 R1: onboarding cards copy through the record projection, which also masks this config's known secrets.
    const io = { locale, env, stdin: process.stdin, stdout: process.stdout, known: getConfigKnownSecrets(config), ...(context.signal ? { signal: context.signal } : {}) };
    const ui = (): import('#surfaces/core/terminal-onboarding/index.js').OnboardingUi => {
      const panels = panelProps(root, scopeId, context, ports, options, locale, env, config).panels;
      return { locale, provider: async () => {
        if (!panels?.ports.provider) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
        await (await surface.loadOnboardingProvider()).runOnboardingProvider(panels.ports.provider, panels.labels,
          context.providerConnect?.kinds.filter(row => row.billing === 'subscription').map(row => row.id) ?? [], io);
      },
      instructions: async () => { await (await import('#surfaces/core/project-instructions/index.js')).instructionInitCommand(['instructions'], { ...context, root, locale }); },
      foreground: async stage => ports.foregroundSetup ? ports.foregroundSetup(root, stage, scopeId, locale) : { status: 'not-wired' } };
    };
    // Onboarding is presentation: an unreadable observation never keeps the Workline closed; every action there keeps its own owner's checks.
    const unavailable = (error: unknown) => {
      if (context.signal?.aborted) throw error;
      const { code: raw, params: p } = (error ?? {}) as { code?: unknown; params?: Readonly<Record<string, unknown>> }, code = typeof raw === 'string' ? raw : '-', family = p?.['family'], field = p?.['field']; // a refused fact names its family and field
      return { level: 'warning' as const, text: typeof family === 'string' && typeof field === 'string' ? t('onboarding.session.unavailableField', { code, family, field }, locale) : t('onboarding.session.unavailable', { code }, locale) };
    };
    // P2: the settled opening snapshot when no step is shown; after a person's answer or action the state is observed again.
    const deferred = (snapshot: import('#surfaces/core/terminal-onboarding/index.js').OnboardingSnapshot) => { const text = surface.deferredOnboardingNotice(snapshot, locale); return text ? { level: 'info' as const, text } : null; };
    const opening = settled.then(async () => {
      closing.signal.throwIfAborted(); const prepared = await (await surface.loadOnboardingScreens()).prepareOnboardingSession(await port(), false, undefined, closing.signal);
      return { total: prepared.total, notice: prepared.total ? null : deferred(prepared.snapshot), show: async (signal: AbortSignal) => {
        try { return { intent: await prepared.show(ui(), { ...io, signal }, await previous()), notice: deferred(await (await port()).observe({})) }; } catch (error) { return { intent: null, notice: unavailable(error) }; }
      } };
    }).catch((error: unknown) => ({ total: 0, notice: unavailable(error), unavailable: true as const, show: async () => ({ intent: null, notice: null }) }));
    onboarding = { opening, modelDraft: t('onboarding.model.draft', {}, locale), waiting: count => t('terminal.opening.setupWaiting', { count }, locale), pending: () => io.stdin.readableLength > 0,
      open: async (signal, focus) => (await surface.loadOnboardingScreens()).runOnboardingSession(await port(), ui(), { ...io, signal }, true, focus, await previous()) };
  }
  const historyMessages = chat?.historyMessages ?? DEFAULT_HISTORY_MESSAGES;
  const modelName = chat?.status === 'ready' && chat.reference && context.inspectModelBinding ? await context.inspectModelBinding(root, chat.reference, options).then(binding => binding.status === 'declared' ? binding.definition.model.nativeId : null, () => null) : null;
  const chatName = modelName && chat?.reference ? `${modelName} · ${providerDisplayName(chat.reference.providerId, context.providerConnect, locale)}` : chatTarget(chat, locale); // FIX9: names as `deckent models` shows them; the exact reference stays in /model details
  const instructions = context.openProjectInstructions ? lazy(() => context.openProjectInstructions!(root, options)) : null;
  const instructionPort: ProjectInstructionPort | undefined = instructions ? { inspect: async () => (await instructions()).inspect(), trust: async digest => (await instructions()).trust(digest), decline: async digest => (await instructions()).decline?.(digest),
    declined: async digest => await (await instructions()).declined?.(digest) ?? false, preview: async (bridges, skeleton) => (await instructions()).preview(bridges, skeleton), initialize: async preview => (await instructions()).initialize(preview) } : undefined;
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
    const serviceLine = service ? (await serviceNotices)[0]?.text ?? null : null;
    for (const notice of accessNotices) emit(notice.text, sinks);
    if (serviceLine) emit(serviceLine, sinks);
    const lineStream = context.streamTerminalChat ? (messages: readonly AgentChatMessage[], signal: AbortSignal | undefined) =>
      (async function* () { yield* context.streamTerminalChat!(root, { scopeId, messages: await withInstructions(messages) }, options, signal); })() : undefined;
    await runSession(locale, context, turn, historyMessages, tty.stdin && tty.stdout,
      async () => [renderStatus(statusPayload(tty, config, chat, await readIdentity()), locale), ...(serviceLine ? [serviceLine] : [])].join('\n'), getConfigKnownSecrets(config), lineStream, () => lineSources);
    return;
  }
  if (!tty.stdin || !tty.stdout) throw ErrorRegistry.createError('TERMINAL_TTY_REQUIRED');
  // T-L4 slice 4c: the mode is read and set through the runtime service (v15); this surface reads and writes no policy file.
  const openMode = permissionModeOpener(root, scopeId, options, locale, context, config.approvals.sessionTtlMs);
  const modePort = context.inspectPermissionMode && context.setPermissionMode ? {
    ...(openMode ? { open: openMode } : {}),
    inspect: (signal?: AbortSignal) => context.inspectPermissionMode!(root, { schemaVersion: 1, scopeId }, options, signal),
    set: (mode: PermissionMode, expectedRevision: string, askEdits?: boolean, session?: { readonly sessionId: string | null }) => context.setPermissionMode!(root,
      { schemaVersion: 1, scopeId, mode, expectedRevision, ...(askEdits === undefined ? {} : { askEdits }), ...(session ? { session: { sessionId: session.sessionId } } : {}) }, options) } : null;
  // MODES-3: full access starts only here — `--full-access` or the person's stored start mode — and only on the company grant (the service asks
  // it again on every turn and call). A closed explicit mode offers the host PRE-9 card; a stored mode without its grant starts standart.
  let fullAccess = false;
  if (parsed.fullAccess && !modePort) throw ErrorRegistry.createError('TERMINAL_CHAT_UNAVAILABLE');
  // alpha.60 B: only `--full-access` is decided before the frame (it waits for the service); a stored start mode is read after it (`useWorklineMode`).
  if (parsed.fullAccess && modePort) {
    await settled;
    let view = await modePort.inspect(context.signal);
    if (!view.fullAccess) {
      if (!modePort.open) throw ErrorRegistry.createError('PERMISSION_MODE_DENIED', { params: { mode: 'full-access' } });
      if (!await modePort.open('full-access')) return;
      view = await modePort.inspect(context.signal);
      if (!view.fullAccess) throw ErrorRegistry.createError('PERMISSION_MODE_DENIED', { params: { mode: 'full-access' } });
    }
    // A mode, stated calmly (owner 2026-10-18): the warning tone, not the error tone; the facts are unchanged.
    fullAccess = true; accessNotices.push({ level: 'warning', text: t('terminal.fullAccess.banner', {}, locale) });
  }
  const ledger = createWorklineLedgerPorts({ root, scopeId, options, locale, workerHeartbeatMs: config.inspection.workers.heartbeatMs, renderRunCancellation: ports.renderRunCancellation,
    approvalPageSize: config.approvals.pageSize,
    ...(context.inspectWorkers ? { inspectWorkers: context.inspectWorkers } : {}),
    ...(context.inspectRun ? { inspectRun: context.inspectRun } : {}),
    ...(context.describeDeliverySummaries ? { describeQueueSummaries: context.describeDeliverySummaries } : {}),
    ...(context.inspectInventory ? { inspectInventory: context.inspectInventory } : {}),
    ...(context.inspectWorkerTranscript ? { inspectWorkerTranscript: context.inspectWorkerTranscript } : {}),
    ...(context.listApprovals ? { listApprovals: context.listApprovals } : {}),
    ...(context.clearSessionStanding ? { clearSessionStanding: context.clearSessionStanding } : {}),
    ...(context.decideApproval ? { decideApproval: context.decideApproval } : {}),
    ...(context.deliverRunCancellation ? { deliverRunCancellation: context.deliverRunCancellation } : {}),
    ...(context.applyRunLifecycle ? { applyRunLifecycle: context.applyRunLifecycle } : {}),
    ...(context.inspectSurfaceAccess ? { inspectSurfaceAccess: () => context.inspectSurfaceAccess!(root, scopeId, options) } : {}),
    ...(context.inspectSurfaceRunIds ? { inspectSurfaceRunIds: () => context.inspectSurfaceRunIds!(root, scopeId, options) } : {}),
    ...(context.followSurfaceEvents ? { followEvents: signal => context.followSurfaceEvents!(root, scopeId, options, signal) } : {}) });
  // TESLIM-PENCERESI: the delivery window's port over the CLI's own task handlers and the composition's verified-terminal confirmation.
  const deliveryPort = terminalDeliveryPort(root, context, options);
  // BeUser DR3-02: the configured pool's hold, read with each plan, so the card says before y that an approved Run will wait.
  let poolHold: PlanningPoolHold | null = null;
  const readPoolHold = async () => { poolHold = await context.inspectPoolHold?.(root, { schemaVersion: 1, scopeId }, options).catch(() => null) ?? null; };
  const target = scopeId;
  // T2: theme and tier from what the terminal can draw and the person's setting; the banner and the clear from their settings (TERM=dumb never
  // clears). A config without a `terminal` section (scope from --scope) keeps every default.
  const presentation = (config['terminal'] ?? {}) as { readonly theme?: TerminalThemeSetting; readonly banner?: WorklineStartup['banner']; readonly clearOnStart?: boolean; readonly layout?: 'fullscreen' | 'inline'; readonly notify?: 'bell' | 'off'; readonly viewportRows?: number };
  const theme = resolveTerminalTheme(presentation.theme ?? TERMINAL_THEME_SETTINGS[0], colorCapability({ env, isTTY: tty.stdout, argv: process.argv }), env['COLORFGBG']);
  const ascii = prefersAsciiGlyphs(env);
  const home = env['HOME'] ?? env['USERPROFILE'], where = shortenHomePath(root, home);
  const startup: WorklineStartup = { clear: presentation.clearOnStart !== false && env['TERM']?.trim().toLowerCase() !== 'dumb', banner: presentation.banner ?? STARTUP_BANNERS[0],
    ...terminalStartupLabels(locale, { version: PACKAGE_VERSION, project: basename(root), path: where, model: chatName }, ascii) };
  // History is a convenience: an unavailable history file never blocks the terminal.
  const history = context.openTerminalHistory ? lazy(() => context.openTerminalHistory!(root, options).catch(() => null)) : null;
  const inputHistory = history ? { load: async () => await (await history())?.load() ?? [], append: async (entry: Parameters<NonNullable<Awaited<ReturnType<typeof history>>>['append']>[0]) => { await (await history())?.append(entry); } } : null;
  if (!installationId) throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
  if (!projectId) throw ErrorRegistry.createError('PROJECT_IDENTITY_UNAVAILABLE');
  // K6 = A: a service that stops itself when idle counts this open terminal as a client only through this beat (clients connect per request). BeUser D-05: the beat also tells the person, once per absence, that the service stopped under this terminal.
  const serviceWatch = serviceAbsenceWatch(() => context.describeRuntimeService!(root, options), false, () => t('terminal.service.lost', {}, locale)), beat = context.describeRuntimeService && tty.stdin && tty.stdout ? setInterval(() => { void serviceWatch.tick(); }, RUNTIME_SERVICE_HEARTBEAT_MS).unref() : null;
  // TERM-UX-1 a: the first `@` finds the service's file list already walked. One empty query warms it in the background (same authorization
  // and deny as any `@`); a service that is not there or refuses is left to the person's own first `@`. The watch is armed by the same answer.
  void settled.then(reached => { if (reached) { serviceWatch.arm(); if (context.findTerminalMentions) void context.findTerminalMentions(root, { scopeId, query: '' }, options, context.signal).catch(() => undefined); } });
  try { await runTerminalWorkline({
    context: { installationId, projectId, scopeId }, ...(onboarding ? { onboarding } : {}),
    knownSecrets: getConfigKnownSecrets(config),
    selfSource: await context.selfSourceProject?.(root) ?? false,
    labels: { ...worklineLabels(locale, t('terminal.status.chat', { target: chatName }, locale)),
      ...(pickerNeedsTextFallback(env, true) ? {} : { windows: slashWindowLabels(locale), delivery: deliveryWindowLabels(locale) }) },
    ...(instructionPort && !pickerNeedsTextFallback(env, true) ? { projectInstructions: { port: instructionPort, labels: instructionLabels } } : {}),
    // Owner 2026-10-30: in a person's terminal (setup cards at hand) the status row says a missing model is set up with /setup.
    target, model: modelName ?? chat?.reference?.modelId ?? (onboarding ? t('onboarding.model.status', {}, locale) : chatTarget(chat, locale)),
    ...(chat?.reference ? { provider: providerDisplayName(chat.reference.providerId, context.providerConnect, locale) } : {}),
    systemPrompt: t('terminal.chat.systemPrompt', {}, locale), historyMessages, maxTrackedRuns: ((config['terminal'] ?? getConfigMetadata().find(row => row.key === 'terminal')?.defaultValue) as { maxTrackedRuns?: number } | undefined)?.maxTrackedRuns, projectRoot: root, ...(home ? { homeDirectory: home } : {}),
    // Owner 2026-10-08: `/clear` clears screen and scrollback; no escape sequence on TERM=dumb (and never to a non-TTY).
    // NO_COLOR concerns colour only, so it does not stop the clear.
    clearScreen: env['TERM']?.trim().toLowerCase() !== 'dumb',
    // TERMINAL-SABIT-DUZEN: the full-window layout unless the person keeps the inline one (`terminal.layout: inline`).
    ...(presentation.notify !== 'off' ? { attention: true } : {}),
    ...(presentation.layout === 'inline' ? { fullscreen: false } : {}), ...(presentation.viewportRows ? { viewportRows: presentation.viewportRows } : {}),
    completeTurn: turn, errorText: error => errorText(error, locale),
    ...(context.planRun ? { doPlan: { planning: t('brain.planning', {}, locale), cancelHint: t('brain.cancelHint', {}, locale), requestHint: t('brain.requestHint', {}, locale), localFallback: t('brain.localFallback', {}, locale), localNoTools: t('brain.localNoTools', {}, locale), offerHere: async (code: unknown) => await context.localRunOffer?.(root, scopeId, options, code).catch(() => false) ?? false, // K2/K3: the one host answer (profile defaults, held pool)
        chatReady: async () => !context.describeTerminalChatPlan || Boolean(await context.describeTerminalChatPlan(root, options).then(plan => plan?.reference, () => true)),
        ...(context.workingTreeChanges ? { tree: async () => context.workingTreeChanges!(root, options) } : {}), dirty: { title: t('brain.dirty.title', {}, locale), body: t('brain.dirty.body', {}, locale), go: t('brain.dirty.continue', {}, locale), cancel: t('brain.here.cancel', {}, locale), prompt: t('brain.here.prompt', {}, locale), cancelled: t('brain.here.cancelled', {}, locale), check: async () => { const families = (await (context as { observeSetup?: (root: string, options: ConfigLoadOptions) => Promise<{ observation: { families?: Record<string, unknown> } }> }).observeSetup?.(root, options))?.observation.families ?? {}; const work = families['work'] as { registry?: boolean; pool?: boolean } | undefined; return (families['coding'] as { changes?: string } | undefined)?.changes === 'present' && work?.registry === true && work.pool === true; } }, here: { title: t('brain.here.title', {}, locale), effect: t('brain.here.effect', {}, locale), run: t('brain.here.run', {}, locale), setup: t('brain.here.setupChoice', {}, locale), cancel: t('brain.here.cancel', {}, locale), noWorkers: t('brain.here.noWorkers', {}, locale), noModel: t('brain.here.noModel', {}, locale), prompt: t('brain.here.prompt', {}, locale), cancelled: t('brain.here.cancelled', {}, locale), changed: t('brain.here.changed', {}, locale), unchanged: t('brain.here.unchanged', {}, locale), unread: t('brain.here.unread', {}, locale),
        canSetup: async () => ((await (context as { observeSetup?: (root: string, options: ConfigLoadOptions) => Promise<{ observation: { families?: Record<string, unknown> } }> }).observeSetup?.(root, options).catch(() => null))?.observation.families?.['coding'] as { repository?: string } | undefined)?.repository === 'present' },
      billingSwitch: t('siwc.switch.notice', { model: '{model}' }, locale),
      quotaWait: (progress: Extract<BrainPlanProgress, { kind: 'quota-wait' }>) => ({ untilText: clockText(progress.untilMs), hint: t('brainwait.cancelHint', {}, locale),
        body: t('brainwait.window', { time: clockText(progress.untilMs), attempt: progress.attempt, maxAttempts: progress.maxAttempts }, locale) }),
      plan: async (intent: string, commandId: string, signal: AbortSignal, reference?: ModelReference, observe?: BrainPlanObserver, pending?: import('#engine/index.js').RunIntentRecord) => {
        const result = await (pending && context.openOnboarding ? context.openOnboarding(root, scopeId, context.rootResolution?.folder ?? '', options).then(port => port.start(pending, signal))
          : hereModel(reference).then(chosen => context.planRun!(root, { schemaVersion: 1, commandId, scopeId, intent, ...(chosen ? { reference: chosen } : {}) }, options, signal, observe)));
        await readPoolHold();
        return result;
      },
      lines: (result: Parameters<typeof brainProposalLines>[0]) => brainProposalLines(result, locale, poolHold) } } : {}),
    ...(context.inspectProviderSpendAccount && context.manageProviderSpend ? { spending: () => spendRecoveryView({ root, scopeId, options, locale, context }) } : {}),
    ...(inputHistory ? { inputHistory } : {}), ...(context.externalEditor ? { externalEditor: context.externalEditor } : {}),
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
    ...(context.streamTerminalChat && context.secretGrantCard ? { secretGrant: secretGrantCardPort(root, scopeId, options, locale, context.secretGrantCard, home) } : {}),
    ...(ports.runMcp ? { mcpGrants: { given: (name: string) => t('mcp.grant.givenKey', { key: name }, locale), keys: async () => ((await ports.runMcp!(root, { verb: 'list', health: false }, options, async () => null)) as { servers?: { reason?: string }[] }).servers?.flatMap(server => server.reason?.startsWith('secret-refused:SECRET_GRANT_REQUIRED:') ? [{ name: server.reason.slice(37), project: root }] : []) ?? [] } } : {}), // KER-17 audit: offered after a turn
    // SCR-A `/scratch`: the conversation's scratch area through the runtime service (v16); this surface reads and deletes no file.
    ...(context.inspectScratch && context.clearScratch ? { scratch: {
      inspect: (sessionId: string, signal?: AbortSignal) => context.inspectScratch!(root, { schemaVersion: 1, scopeId, sessionId }, options, signal),
      clear: (sessionId: string) => context.clearScratch!(root, { schemaVersion: 1, scopeId, sessionId }, options) } } : {}),
    // TERMINAL-CLOSE S09: `/status`, `/model`, `/usage`, `/doctor`, `/scope` re-read their typed producers on every call (this surface keeps no copy).
    ...terminalAdminPorts({ root, scopeId, installationId, projectId, options, locale, context, principalName: hostUserName(), columns: Math.max(40, (tty.columns ?? 100) - 4),
      status: async () => renderStatus(statusPayload(ttyState(context), await loadConfig(root, options), context.describeTerminalChatPlan ? await context.describeTerminalChatPlan(root, options) : null, await readIdentity()), locale),
      doctor: sink => ports.runKernelCommand(['doctor', '--lang', locale], { root, env, stdout: sink, stderr: sink }),
      // SW-1: the `/doctor` window groups the same command's structured report by area.
      doctorReport: sink => ports.runKernelCommand(['doctor', '--json', '--lang', locale], { root, env, stdout: sink, stderr: sink }) }),
    ...(ports.mcpSlash ? { mcp: (args: string) => ports.mcpSlash!(root, args, options, locale) } : {}),
    ...(context.configApplication ? { config: (args: string) => configTtySlash(root, args, context, options, locale, Math.max(40, (tty.columns ?? 100) - 4)) } : {}),
    ...panelProps(root, scopeId, context, ports, options, locale, env, config),
    // MONITOR: `/monitor` prints the monitor's text snapshot as notice lines (the fullscreen view is `deckent monitor`).
    ...(context.inspectMonitor ? { monitor: (args: string) => monitorSlash(root, args, context, options, locale, Math.max(40, (tty.columns ?? 100) - 4)) } : {}),
    // T3 L5: a bare `/monitor` opens the monitor in a window. The view loads on the first use (like `deckent monitor`); this unit stays free of it until then.
    ...(context.inspectMonitor ? { monitorWindow: async () => {
      const surface = await loadMonitorSurface(), inspect = context.inspectMonitor!;
      return surface.monitorWindowView({ load: () => inspect(root, options), intervalMs: config.inspection.workers.heartbeatMs, locale, ascii,
        palette: resolveWorklinePalette(theme.tier, theme.theme), errorText: error => surface.monitorFailureText(error, locale),
        ...(context.configApplication ? { loadConfigView: () => context.configApplication!(root, options).inspect() } : {}) });
    } } : {}),
    ...(accessNotices.length || chat?.skippedDefault ? { openingNotices: [...accessNotices, ...(chat?.skippedDefault ? [{ level: 'warning' as const, text: t('terminal.model.defaultNotHere', {}, locale) }] : [])] } : {}),
    opening: { ready: service ?? Promise.resolve(), wait: t('terminal.opening.wait', {}, locale), notices: () => Promise.all([previous(), serviceNotices]).then(([text, notices]) => [...(text ? [{ level: 'info' as const, text }] : []), ...notices]) },
    serviceLost: serviceWatch.subscribe, ...(context.ensureRuntimeService && autostart ? { startService: async () => t('terminal.service.startedForTurn', { pid: (await ensure()).pid ?? '-' }, locale) } : {}), ...(context.restartRuntimeService ? { restartService: async () => {
      const building = await context.runningImageBuild?.(root, options).catch(() => false) === true, restarted = await context.restartRuntimeService!(root, options);
      return [t('terminal.service.restarted', { pid: restarted.pid ?? '-', instance: restarted.instanceId }, locale), ...(building ? [t('cli.runtime.imageBuildStopped', {}, locale)] : [])].join('\n');
    }, restartNotes: async () => await context.runningImageBuild?.(root, options).catch(() => false) === true ? [t('cli.runtime.card.imageBuild', {}, locale)] : [] } : {}),
    palette: resolveWorklinePalette(theme.tier, theme.theme), ascii, startup,
    ...(ledger ? { ledger } : {}), ...(deliveryPort && !pickerNeedsTextFallback(env, true) ? { delivery: { port: deliveryPort, confirmTimeoutMs: config.approvals.sessionTtlMs } } : {}),
    ...(context.stdin ? { stdin: context.stdin as NodeJS.ReadStream } : {}),
    ...(context.stdout ? { stdout: context.stdout as unknown as NodeJS.WriteStream } : {}),
    ...(context.signal ? { signal: context.signal } : {}), ...(context.terminalShell ? { shell: context.terminalShell } : {}),
  }); } finally { if (beat) clearInterval(beat); closing.abort(); await sessionStore?.idle(); } // a setup observation still running ends now; a session write in flight settles first
}
import { brainProposalLines, type PlanningPoolHold } from '#surfaces/core/run-planning/index.js';
