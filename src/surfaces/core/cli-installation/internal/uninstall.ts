import { randomUUID } from 'node:crypto';
import { ErrorRegistry, emit, getConfigFieldDefault, t, terminalSafeText, type Locale, type ExitCode } from '#platform/index.js';
import { uninstallAuthorityBlocker, type UninstallPlan } from '#engine/index.js';
import { readHidden } from '#surfaces/core/cli-admin/index.js';
import { askCliCard, cliMode } from '#surfaces/core/cli-human/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { uninstallMessages, uninstallStatusMessage } from './uninstall-text.js';
import type { InstallationCommandContext } from './context.js';

/** Same immutable plan supplies the card and both preview modes; codes in JSON remain locale-free. */
export function uninstallPlanLines(plan: UninstallPlan, locale: Locale): readonly string[] {
  const safe = terminalSafeText, unknown = t('cli.uninstall.unknown', {}, locale), messages = uninstallMessages(locale);
  const lines = [t('cli.uninstall.title', {}, locale),
    t('cli.uninstall.installation', { path: safe(plan.installation.root), scopes: plan.scopeSummary.map(safe).join(', ') }, locale),
    t('cli.uninstall.digest', { digest: plan.planDigest }, locale)];
  for (const item of plan.items) {
    const label = item.action === 'remove' ? t('cli.uninstall.remove', {}, locale) : item.action === 'keep' ? t('cli.uninstall.keep', {}, locale)
      : item.action === 'manual' ? t('cli.uninstall.manual', {}, locale) : unknown;
    for (const locator of item.members ?? [item.locator]) lines.push(`${label}: ${safe(locator)} · ${messages[`reason.${item.reason}`] ?? unknown}`);
  }
  for (const blocker of plan.blockers) {
    const authority = /^authority-(relocated|unsafe):(.+)$/su.exec(blocker), path = safe(authority?.[2] ?? '');
    lines.push(t('cli.uninstall.blocked', { reason: authority?.[1] === 'relocated' ? t('cli.uninstall.blocker.authority-relocated', { path }, locale)
      : authority ? t('cli.uninstall.blocker.authority-unsafe', { path }, locale) : messages[`blocker.${blocker}`] ?? `${unknown} (${safe(blocker)})` }, locale));
  }
  lines.push(t('cli.uninstall.retainedData', {}, locale), t('cli.uninstall.reinstall', {}, locale));
  if (plan.backup.required) lines.push(t('cli.uninstall.backup', { path: safe(plan.backup.destination ?? unknown) }, locale));
  lines.push(plan.packageRemoval.command ? t('cli.uninstall.packageHandoff', { command: safe(plan.packageRemoval.command) }, locale)
    : t('cli.uninstall.packageUnknown', {}, locale));
  return lines;
}
export async function uninstallCommand(argv: readonly string[], context: InstallationCommandContext = {}): Promise<ExitCode> {
  const seen = new Set<string>(); let language: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (seen.has(flag) || !['--purge', '--dry-run', '--json', '--no-color', '--lang'].includes(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    seen.add(flag);
    if (flag === '--lang') { language = argv[++i]; if (!language || !['en', 'tr'].includes(language)) throw ErrorRegistry.createError('CLI_USAGE'); }
  }
  const locale = commandLocale(context, language), root = context.root ?? process.cwd(), options = { env: context.env ?? process.env, heal: false };
  const json = seen.has('--json'), previewOnly = json || seen.has('--dry-run');
  if (!previewOnly && cliMode(context).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'uninstall' } });
  if (!context.previewUninstall) throw ErrorRegistry.createError('UNINSTALL_UNSUPPORTED');
  const plan = await context.previewUninstall(root, seen.has('--purge'), options);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (previewOnly) { emit(plan, { ...sinks, json, render: value => [...uninstallPlanLines(value, locale), t('cli.uninstall.previewOnly', {}, locale)].join('\n') }); return 0; }
  if (plan.blockers.length) { emit(plan, { ...sinks, render: value => uninstallPlanLines(value, locale).join('\n') }); throw uninstallAuthorityBlocker(plan) ?? ErrorRegistry.createError(plan.purge ? 'UNINSTALL_BACKUP_COVERAGE' : 'UNINSTALL_OWNERSHIP'); }
  if (!context.applyUninstall) throw ErrorRegistry.createError('UNINSTALL_UNSUPPORTED');
  const signal = AbortSignal.timeout(getConfigFieldDefault('approvals').sessionTtlMs);
  const result = await context.applyUninstall(root, { schemaVersion: 1, commandId: randomUUID(), planDigest: plan.planDigest }, {
    backupPassphrase: () => readHidden(process.stdin, context.stderr ?? process.stderr, t('cli.uninstall.backupPassphrase', {}, locale)),
    confirm: async current => await askCliCard({ title: t('cli.uninstall.title', {}, locale),
      body: uninstallPlanLines(current, locale), initial: 'cancel', options: [
        { id: 'cancel', label: t('cli.uninstall.cancel', {}, locale) },
        { id: 'apply', label: current.purge ? t('cli.uninstall.purge.confirm', {}, locale) : t('cli.uninstall.confirm', {}, locale) },
      ] }, { locale, env: options.env, stdout: context.stdout, signal }) === 'apply',

  }, options, signal);
  const messages = uninstallMessages(locale);
  emit(result, { ...sinks, render: value => [uninstallStatusMessage(value.status, locale),
    ...value.items.map(item => `${terminalSafeText(plan.items.find(resource => resource.resourceId === item.resourceId)?.locator ?? item.resourceId)}: ${messages[`state.${item.state ?? 'kept'}`]}`),
    ...(value.backup.destination ? [t('cli.uninstall.backup', { path: terminalSafeText(value.backup.destination) }, locale)] : []),
    ...(value.packageRemoval.command ? [t('cli.uninstall.packageHandoff', { command: terminalSafeText(value.packageRemoval.command) }, locale)] : [t('cli.uninstall.packageUnknown', {}, locale)]),
    t('cli.uninstall.retainedData', {}, locale), t('cli.uninstall.reinstall', {}, locale),
  ].join('\n') });
  return result.status === 'completed' || result.status === 'noop' ? 0 : 1;
}
