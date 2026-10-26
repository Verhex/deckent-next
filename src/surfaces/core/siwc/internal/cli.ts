import { ErrorRegistry, emit, getConfigFieldDefault, loadConfig, t } from '#platform/index.js';
import { cliMode, askCliCard, resolveCommandScope, scopeLister, type CliCardRequest } from '#surfaces/core/cli-human/index.js';
import { commandLocale, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { SiwcHandler, SiwcRequest } from './port.js';
/** Person TTY only. JSON/MCP/AI never receives an authorization URL or account label. */
export async function siwcCliCommand(argv: readonly string[], context: CliBaseContext & Parameters<typeof scopeLister>[0], handler: SiwcHandler): Promise<void> {
  const locale = commandLocale(context);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (argv.includes('--help') || argv.includes('-h')) { emit(t('siwc.help', {}, locale), sinks); return; }
  if (cliMode(context, argv.includes('--json')).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'models.login' } });
  const flags = new Map<string, string>();
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === '--new-account' && !flags.has(key)) { flags.set(key, 'true'); continue; }
    const value = argv[++i];
    if (!['--connection', '--scope', '--connection-id', '--delegate', '--lang'].includes(key) || !value || value.startsWith('--') || flags.has(key)) throw ErrorRegistry.createError('CLI_USAGE');
    flags.set(key, value);
  }
  const newAccount = flags.has('--new-account');
  if (newAccount && flags.has('--connection-id')) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, config = await loadConfig(root, { env, heal: false });
  const deadline = AbortSignal.timeout(config.approvals.sessionTtlMs ?? getConfigFieldDefault('approvals').sessionTtlMs);
  const signal = AbortSignal.any([deadline, ...(context.signal ? [context.signal] : [])]);
  const ask = (request: CliCardRequest) => askCliCard(request, { locale, env, signal, ...(context.stdin ? { stdin: context.stdin } : {}),
    ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) });
  const configured = (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  const scope = await resolveCommandScope({ command: `deckent models ${argv[1]}`, locale, explicit: flags.get('--scope'),
    configured: typeof configured === 'string' ? configured : undefined, mutating: true, interactive: true,
    listScopes: () => scopeLister(context, root, { env })().catch(() => []), pick: ask });
  if (!scope) return;
  const scopeId = scope.scopeId;
  const connectionId = flags.get('--connection-id'), operation = argv[1] as SiwcRequest['operation'];
  if (operation === 'logout' || operation === 'login' && !newAccount) {
    if (await ask({ title: (operation === 'logout' ? t('siwc.revoke.title', {}, locale) : t('siwc.card.title', {}, locale)), body: [t('siwc.privacy.body', {}, locale)],
      options: [{ id: 'no', label: t('siwc.card.cancel', {}, locale) }, { id: 'yes', label: t('siwc.card.continue', {}, locale) }], initial: 'no' }) !== 'yes') return;
    const result = await handler(root, { operation, scopeId, ...(connectionId ? { connectionId } : {}) }, { env }, { signal, fallback: url => emit(`${t('siwc.browser.fallback', {}, locale)}\n${url}`, sinks) });
    emit(result.remoteRevocation === 'unconfirmed' ? t('siwc.revoke.unconfirmed', {}, locale) : operation === 'logout' ? t('siwc.revoke.done', {}, locale) : t('siwc.welcome.body', {}, locale), sinks); return;
  }
  if (operation !== 'connect' && !(operation === 'login' && newAccount)) throw ErrorRegistry.createError('CLI_USAGE');
  const explicitClasses = flags.get('--delegate')?.split(',').filter(Boolean);
  if (explicitClasses?.some(value => value !== 'ai' && value !== 'system')) throw ErrorRegistry.createError('CLI_USAGE');
  const background = await ask({ title: t('siwc.card.title', {}, locale), body: [t('siwc.card.body', {}, locale), t('siwc.privacy.body', {}, locale), t('siwc.card.connectedAppOnly', {}, locale), t('siwc.card.background', {}, locale)],
    options: [{ id: 'no', label: t('siwc.card.onlyTyping', {}, locale) }, { id: 'yes', label: t('siwc.card.backgroundYes', {}, locale) }], initial: explicitClasses?.length ? 'yes' : 'no' });
  if (background === null) return;
  const prepared = await handler(root, { operation: 'prepare', scopeId }, { env });
  const api = await ask({ title: t('siwc.card.apiQuestion', {}, locale), body: [t('siwc.card.apiCost', {}, locale)], options: [{ id: 'no', label: t('siwc.card.apiOff', {}, locale) },
    ...(prepared.apiTargets ?? []).map((row, index) => ({ id: String(index), label: row.id }))], initial: 'no' });
  if (api === null) return;
  const target = api === 'no' ? null : prepared.apiTargets?.[Number(api)];
  if (api !== 'no' && !target) throw ErrorRegistry.createError('CLI_USAGE');
  emit(t('siwc.browser.waiting', { seconds: 0 }, locale), sinks);
  const result = await handler(root, { operation: 'connect', scopeId, ...(newAccount ? { newAccount: true } : {}), ...(connectionId ? { connectionId } : {}), delegate: background === 'yes' ? (explicitClasses ?? ['ai', 'system']) as ('ai' | 'system')[] : [], apiContinuation: target?.reference ?? null },
    { env }, { signal, fallback: url => emit(`${t('siwc.browser.fallback', {}, locale)}\n${url}`, sinks) });
  emit(result.models?.status === 'approval-pending' ? t('siwc.card.approvalPending', {}, locale) : t('siwc.welcome.ready', {}, locale), sinks);
}
