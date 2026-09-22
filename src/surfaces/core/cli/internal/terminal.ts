import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, formatValue, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { InferenceServingProfile } from '#domain/index.js';
import { buildInferenceServingPlan, completeInferenceChatTurn, estimateReplicaCapacity, readInferenceServingProfile, type InferenceChatMessage } from '#engine/index.js';
import { runTerminalWorkline, resolveWorklinePalette, buildWorklineBridgeSnapshot } from '#surfaces/core/terminal/index.js';
import { colorTier } from '#platform/index.js';
import { createWorklineLedgerPorts } from './terminal-ledger.js';
import type { CommandContext } from './kernel-commands.js';

type TerminalCompleteTurn = (
  messages: readonly InferenceChatMessage[],
  signal?: AbortSignal,
) => Promise<string>;

function writeBridgeSnapshotAtomic(targetPath: string, snapshot: unknown): void {
  const payload = `${JSON.stringify(snapshot)}\n`;
  const temp = join(dirname(targetPath), `.${targetPath.split('/').pop() ?? 'bridge'}.tmp-${process.pid}`);
  writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, targetPath);
}

interface Parsed {
  action: 'status' | 'session' | 'workline' | 'snapshot' | 'chat-plan';
  json: boolean;
  help: boolean;
  language?: string;
}

function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'terminal') throw ErrorRegistry.createError('CLI_USAGE');
  const action = argv[1];
  if (action !== 'status' && action !== 'session' && action !== 'workline' && action !== 'snapshot' && action !== 'chat-plan') {
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  const parsed: Parsed = { action, json: false, help: false };
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (key === '--help') parsed.help = true;
    else if (key === '--json') parsed.json = true;
    else if (key === '--no-color') continue;
    else if (key === '--lang') {
      const language = argv[++index];
      if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      parsed.language = language;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (parsed.help && parsed.json) throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}

function ttySnapshot(stdin: CommandContext['stdin']): { interactive: boolean; columns: number | null; rows: number | null } {
  const input = stdin ?? process.stdin;
  const interactive = Boolean(input.isTTY);
  const columns = interactive && process.stdout.columns ? process.stdout.columns : null;
  const rows = interactive && process.stdout.rows ? process.stdout.rows : null;
  return { interactive, columns, rows };
}

function renderStatus(payload: {
  tty: ReturnType<typeof ttySnapshot>;
  inference: { configured: boolean; profileId?: string; tokenBudget?: number; maxSeqs?: number; endpoint?: string | null };
  chat: { backend: string; invokeReady: boolean };
}, locale: Locale): string {
  const lines = [
    t('terminal.status.tty', {
      interactive: payload.tty.interactive ? t('terminal.value.yes', {}, locale) : t('terminal.value.no', {}, locale),
      columns: payload.tty.columns ?? t('terminal.value.unknown', {}, locale),
      rows: payload.tty.rows ?? t('terminal.value.unknown', {}, locale),
    }, locale),
  ];
  if (!payload.inference.configured) {
    lines.push(t('terminal.status.inferenceAbsent', {}, locale));
  } else {
    lines.push(t('terminal.status.inference', {
      profile: payload.inference.profileId ?? '',
      tokenBudget: payload.inference.tokenBudget ?? 0,
      maxSeqs: payload.inference.maxSeqs ?? 0,
      endpoint: payload.inference.endpoint ?? t('terminal.value.none', {}, locale),
    }, locale));
  }
  lines.push(t('terminal.status.chatBackend', { backend: payload.chat.backend, invokeReady: payload.chat.invokeReady ? t('terminal.value.yes', {}, locale) : t('terminal.value.no', {}, locale) }, locale));
  lines.push(t('terminal.status.hint', {}, locale));
  return lines.join('\n');
}

async function runSession(locale: Locale, context: CommandContext, profile: InferenceServingProfile): Promise<void> {
  const stdin = context.stdin ?? process.stdin;
  if (!stdin.isTTY) throw ErrorRegistry.createError('CLI_USAGE');
  const rl = createInterface({ input: stdin, output: process.stdout, terminal: true, prompt: t('terminal.session.prompt', {}, locale) });
  const history: InferenceChatMessage[] = [{ role: 'system', content: 'You are Deckent terminal assistant.' }];
  emit(t('terminal.session.banner', {}, locale), { ...(context.stdout ? { stdout: context.stdout } : {}) });
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '/exit' || trimmed === '/quit') break;
    if (trimmed === '/status') {
      await terminalCommand(['terminal', 'status'], context);
      rl.prompt();
      continue;
    }
    if (trimmed.length === 0) { rl.prompt(); continue; }
    history.push({ role: 'user', content: trimmed });
    try {
      const completeTurn: TerminalCompleteTurn | null = context.completeTerminalChat
        ? async (messages, signal) =>
          context.completeTerminalChat!(context.root ?? process.cwd(), profile, messages, { env: context.env ?? process.env }, signal ?? context.signal)
        : null;
      const reply = completeTurn
        ? await completeTurn(history, context.signal)
        : await completeInferenceChatTurn(profile, history, context.signal);
      history.push({ role: 'assistant', content: reply });
      emit(reply, { ...(context.stdout ? { stdout: context.stdout } : {}) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      emit(t('terminal.session.chatFailed', {}, locale), { ...(context.stdout ? { stdout: context.stdout } : {}), level: 'error' });
      if (detail.includes('404')) {
        emit(t('terminal.session.chat404Hint', {}, locale), { ...(context.stdout ? { stdout: context.stdout } : {}), level: 'warning' });
      }
    }
    rl.prompt();
  }
  rl.close();
  emit(t('terminal.session.closed', {}, locale), { ...(context.stdout ? { stdout: context.stdout } : {}) });
}

export async function terminalCommand(argv: readonly string[], context: CommandContext = {}): Promise<void> {
  const parsed = parse(argv);
  const root = context.root ?? process.cwd();
  const env = context.env ?? process.env;
  let locale = resolveLocale(parsed.language, env);
  context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) {
    emit(t('cli.help.terminal', {}, locale), sinks);
    return;
  }
  const tty = ttySnapshot(context.stdin);
  const options: ConfigLoadOptions = { env };
  const config = await loadConfig(root, options);
  locale = resolveLocale(parsed.language, env, config.language);
  context.onLocale?.(locale);
  let inference: { configured: boolean; profileId?: string; tokenBudget?: number; maxSeqs?: number; endpoint?: string | null } = { configured: false };
  const activeProfile = readInferenceServingProfile(config as Record<string, unknown>);
  let chat: { backend: string; invokeReady: boolean; blockCode?: string } = { backend: 'invoke_model', invokeReady: false };
  if (context.describeTerminalChatPlan) {
    chat = await context.describeTerminalChatPlan(root, options);
  }
  if (activeProfile) {
    const profile = activeProfile;
    const capacity = estimateReplicaCapacity(profile);
    const plan = buildInferenceServingPlan(profile);
    inference = {
      configured: true,
      profileId: profile.id,
      tokenBudget: capacity.totalTokenBudget,
      maxSeqs: capacity.maxNumSeqs,
      endpoint: plan.openaiBaseUrl,
    };
  }
  if (parsed.action === 'chat-plan') {
    emit({ schemaVersion: 1, ...chat }, { ...sinks, json: true, render: value => formatValue(value) });
    return;
  }
  if (parsed.action === 'session') {
    if (!activeProfile) throw ErrorRegistry.createError('CLI_USAGE');
    await runSession(locale, context, activeProfile);
    return;
  }
  if (parsed.action === 'workline') {
    if (!activeProfile) {
      emit(t('terminal.workline.inferenceRequired', {}, locale), { ...sinks, level: 'error' });
      throw ErrorRegistry.createError('CLI_USAGE');
    }
    if (!tty.interactive) {
      emit(t('terminal.workline.ttyRequired', {}, locale), { ...sinks, level: 'error' });
      throw ErrorRegistry.createError('CLI_USAGE');
    }
    const completeTurn: TerminalCompleteTurn | undefined = context.completeTerminalChat
      ? async (messages, signal) =>
        context.completeTerminalChat!(root, activeProfile, messages, options, signal ?? context.signal)
      : undefined;
    const ledger = createWorklineLedgerPorts({
      root,
      scopeId: activeProfile.scopeId,
      options,
      workerHeartbeatMs: config.inspection.workers.heartbeatMs,
      ...(context.inspectWorkers ? { inspectWorkers: context.inspectWorkers } : {}),
      ...(context.inspectRun ? { inspectRun: context.inspectRun } : {}),
      ...(context.inspectInventory ? { inspectInventory: context.inspectInventory } : {}),
    });
    const palette = resolveWorklinePalette(colorTier({ env, isTTY: tty.interactive, argv: process.argv }));
    const bridgePath = env['DECKENT_WORKLINE_BRIDGE_FILE'];
    const bridge = bridgePath ? {
      onUpdate(snapshot: ReturnType<typeof buildWorklineBridgeSnapshot>) {
        writeBridgeSnapshotAtomic(bridgePath, snapshot);
      },
    } : undefined;
    const chatBackendLine = t('terminal.workline.chatBackend', {
      backend: chat.backend,
      invokeReady: chat.invokeReady ? t('terminal.value.yes', {}, locale) : t('terminal.value.no', {}, locale),
    }, locale);
    await runTerminalWorkline(activeProfile, locale, {
      palette,
      chatBackendLine,
      tty: { columns: tty.columns, rows: tty.rows },
      ...(context.signal ? { signal: context.signal } : {}),
      ...(completeTurn ? { completeTurn } : {}),
      ...(ledger ? { ledger } : {}),
      ...(bridge ? { bridge } : {}),
    });
    return;
  }
  if (parsed.action === 'snapshot') {
    if (!activeProfile) {
      emit(t('terminal.workline.inferenceRequired', {}, locale), { ...sinks, level: 'error' });
      throw ErrorRegistry.createError('CLI_USAGE');
    }
    const plan = buildInferenceServingPlan(activeProfile);
    const snapshot = buildWorklineBridgeSnapshot({
      profile: activeProfile,
      plan,
      tty: { columns: tty.columns, rows: tty.rows },
      ledgerTail: [],
    });
    emit(snapshot, { ...sinks, json: true, render: value => formatValue(value) });
    return;
  }
  const payload = { tty, inference, chat };
  emit(payload, { ...sinks, json: parsed.json, render: value => parsed.json ? formatValue(value) : renderStatus(value, locale) });
}
