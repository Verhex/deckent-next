import { ErrorRegistry, emit, loadConfig, loadConfigLanguage, resolveLocale, t, terminalSafeText, TERMINAL_SCOPE_ID_SCHEMA } from '#platform/index.js';
import { projectAttachmentCommandSchema } from '#domain/index.js';
import { askCliCard, cliMode } from '#surfaces/core/cli-human/index.js';
import type { CommandContext } from './kernel-commands.js';

/** Explicit source, attachment and recovery commands share the witnessed application owner. */
export async function projectAttachmentCommand(argv: readonly string[], context: CommandContext) {
  const values = new Map<string, string>(), switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (['--scope', '--expect', '--command-id', '--revoke', '--lease-revoke', '--detach', '--restore', '--lang'].includes(flag) && !values.has(flag)) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(flag, value);
    } else if (['--preview', '--apply', '--register', '--unregister', '--relocate', '--json', '--no-color'].includes(flag) && !switches.has(flag)) switches.add(flag);
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const root = context.root ?? process.cwd(), options = { ...(context.env ? { env: context.env } : {}), heal: false }, requestedScope = values.get('--scope');
  const locale = resolveLocale(values.get('--lang'), context.env, await loadConfigLanguage(root, options)); context.onLocale?.(locale);
  const interaction = { json: switches.has('--json') };
  const apply = switches.has('--apply'), preview = switches.has('--preview'), revoke = values.get('--revoke') ?? values.get('--lease-revoke') ?? values.get('--detach') ?? values.get('--restore');
  const lifecycle = switches.has('--unregister') || switches.has('--relocate') || !!revoke;
  if ([values.has('--revoke'), values.has('--lease-revoke'), values.has('--detach'), values.has('--restore'), switches.has('--unregister'), switches.has('--relocate')].filter(Boolean).length > 1) throw ErrorRegistry.createError('CLI_USAGE');
  if (apply === preview || !apply && (values.has('--expect') || values.has('--command-id'))
    || switches.has('--register') && values.has('--command-id') || !context.projectAttachment || revoke && (switches.has('--register') || preview || requestedScope)) throw ErrorRegistry.createError('CLI_USAGE');
  if (lifecycle && (!apply || preview || switches.has('--register') || !values.has('--restore') && values.has('--expect') || values.has('--command-id') || switches.has('--unregister') && requestedScope)) throw ErrorRegistry.createError('CLI_USAGE');
  const terminal = switches.has('--register') && !requestedScope ? (await loadConfig(root, options))['terminal'] as { scopeId?: unknown } | undefined : undefined;
  const scopeId = requestedScope ?? TERMINAL_SCOPE_ID_SCHEMA.safeParse(terminal?.scopeId).data;
  const registration = switches.has('--register') && apply && !values.has('--expect') && scopeId
    ? await context.projectAttachment(root, { action: 'register-preview', scopeId }, options, interaction) as { planDigest: string } : null;
  const parsed = projectAttachmentCommandSchema.safeParse(switches.has('--unregister') ? { action: 'unregister' } : switches.has('--relocate') ? { action: 'relocate', scopeId } : revoke ? { action: values.has('--restore') ? 'restore' : values.has('--detach') ? 'detach' : values.has('--lease-revoke') ? 'lease-revoke' : 'revoke', projectId: revoke, ...(values.has('--restore') ? { expect: values.get('--expect') } : {}) }
    : { action: switches.has('--register') ? apply ? 'register' : 'register-preview' : apply ? 'apply' : 'preview', scopeId,
      ...(apply ? { expect: values.get('--expect') ?? registration?.planDigest, ...(!switches.has('--register') ? { commandId: values.get('--command-id') } : {}) } : {}) });
  if (!parsed.success) throw ErrorRegistry.createError('CLI_USAGE');
  if (apply) {
    if (cliMode(context, switches.has('--json')).reason !== 'tty') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'project.attach' } });
    const actionLabel = { register: t('setup.attachment.register', {}, locale), apply: t('setup.attachment.apply', {}, locale),
      revoke: t('setup.attachment.revoke', {}, locale), 'lease-revoke': t('setup.attachment.leaseRevoke', {}, locale), detach: t('setup.attachment.detach', {}, locale),
      unregister: t('setup.attachment.unregister', {}, locale), relocate: t('setup.attachment.relocate', {}, locale), restore: t('setup.attachment.restore', {}, locale) };
    const action = parsed.data.action;
    const answer = await askCliCard({ title: t('setup.attach.title', {}, locale), body: [t('setup.attachment.body', { action: action in actionLabel ? actionLabel[action as keyof typeof actionLabel] : action,
      path: terminalSafeText(root), scope: terminalSafeText(scopeId ?? revoke ?? '') }, locale)],
      options: [{ id: 'yes', label: t('setup.window.yes', {}, locale), role: 'yes' }, { id: 'no', label: t('setup.window.no', {}, locale), role: 'no' }], initial: 'no' },
    { locale, ...(context.env ? { env: context.env } : {}), ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}),
      ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}), ...(context.signal ? { signal: context.signal } : {}) });
    if (answer !== 'yes') return;
  }
  const result = await context.projectAttachment(root, parsed.data, options, interaction);
  emit(result, { json: switches.has('--json'), ...(context.stdout ? { stdout: context.stdout } : {}), render: value =>
    `${apply ? t('setup.attach.saved', {}, locale) : t('setup.attach.preview', {}, locale)}\n${terminalSafeText(JSON.stringify(value, null, 2))}` });
}
