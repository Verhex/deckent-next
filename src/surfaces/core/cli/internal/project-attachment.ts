import { ErrorRegistry, emit, loadConfigLanguage, resolveLocale, t, terminalSafeText } from '#platform/index.js';
import { projectAttachmentCommandSchema } from '#domain/index.js';
import { askCliCard, cliMode } from '#surfaces/core/cli-human/index.js';
import type { CommandContext } from './kernel-commands.js';

/** Explicit preparatory CLI; the bare-terminal offer remains gated on the connection-lease join. */
export async function projectAttachmentCommand(argv: readonly string[], context: CommandContext) {
  const values = new Map<string, string>(), switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (['--scope', '--expect', '--command-id', '--revoke', '--lang'].includes(flag) && !values.has(flag)) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(flag, value);
    } else if (['--preview', '--apply', '--register', '--json', '--no-color'].includes(flag) && !switches.has(flag)) switches.add(flag);
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const root = context.root ?? process.cwd(), options = { ...(context.env ? { env: context.env } : {}), heal: false }, scopeId = values.get('--scope');
  const locale = resolveLocale(values.get('--lang'), context.env, await loadConfigLanguage(root, options)); context.onLocale?.(locale);
  const apply = switches.has('--apply'), preview = switches.has('--preview'), revoke = values.get('--revoke');
  if (apply === preview || !apply && (values.has('--expect') || values.has('--command-id'))
    || switches.has('--register') && values.has('--command-id') || !context.projectAttachment || revoke && (switches.has('--register') || preview || scopeId)) throw ErrorRegistry.createError('CLI_USAGE');
  const parsed = projectAttachmentCommandSchema.safeParse(revoke ? { action: 'revoke', projectId: revoke }
    : { action: switches.has('--register') ? apply ? 'register' : 'register-preview' : apply ? 'apply' : 'preview', scopeId,
      ...(apply ? { expect: values.get('--expect'), ...(!switches.has('--register') ? { commandId: values.get('--command-id') } : {}) } : {}) });
  if (!parsed.success) throw ErrorRegistry.createError('CLI_USAGE');
  if (apply) {
    if (cliMode(context).reason !== 'tty') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'project.attach' } });
    const answer = await askCliCard({ title: t('setup.attach.title', {}, locale), body: [t('setup.attach.body', { path: terminalSafeText(root), scope: terminalSafeText(scopeId ?? revoke ?? '') }, locale)],
      options: [{ id: 'yes', label: t('setup.window.yes', {}, locale), role: 'yes' }, { id: 'no', label: t('setup.window.no', {}, locale), role: 'no' }], initial: 'no' },
    { locale, ...(context.env ? { env: context.env } : {}), ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}),
      ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}), ...(context.signal ? { signal: context.signal } : {}) });
    if (answer !== 'yes') return;
  }
  const result = await context.projectAttachment(root, parsed.data, options);
  emit(result, { json: switches.has('--json'), ...(context.stdout ? { stdout: context.stdout } : {}), render: value =>
    `${apply ? t('setup.attach.saved', {}, locale) : t('setup.attach.preview', {}, locale)}\n${terminalSafeText(JSON.stringify(value, null, 2))}` });
}
