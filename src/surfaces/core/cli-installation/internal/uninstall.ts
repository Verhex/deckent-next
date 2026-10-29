import { randomUUID } from 'node:crypto';
import { ErrorRegistry, emit, getConfigFieldDefault, t, terminalSafeText as safe, type ExitCode } from '#platform/index.js';
import { uninstallBlockerError, type UninstallPlan, type UninstallQuery } from '#engine/index.js';
import { readHidden } from '#surfaces/core/cli-admin/index.js';
import { askCliCard, cliMode, formatDuration, type CliCardRequest } from '#surfaces/core/cli-human/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { uninstallDetailLines, uninstallMessages, uninstallPlanLines, uninstallResolvable, uninstallStatusMessage, uninstallSummaryLines, uninstallTierChoices } from './uninstall-text.js';
import type { InstallationCommandContext } from './context.js';
export { uninstallPlanLines, uninstallDetailLines, uninstallSummaryLines } from './uninstall-text.js';
const TIERS: Readonly<Record<string, UninstallQuery['tier']>> = { '--keep-data': 'keep-data', '--keep-work': 'keep-work', '--all': 'all' };
const SWITCHES = ['--force', '--yes', '--dry-run', '--json', '--disable-unit', '--verbose', '--no-color', '--lang'];

/**
 * Owner 2026-10-27: a menu of tiers (keep data — default; keep pending work; delete everything, backup first) whose every step has a flag
 * twin; every check precedes the one confirmation; nothing to do asks nothing. `--yes` skips only the final card (the plan is still printed,
 * the digest still binds it); `--json` and `--dry-run` only preview. Applying stays a person at their own terminal (AI, CI and pipes refused).
 */
export async function uninstallCommand(argv: readonly string[], context: InstallationCommandContext = {}): Promise<ExitCode> {
  const seen = new Set<string>(); let language: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--purge') throw ErrorRegistry.createError('UNINSTALL_FLAG_MOVED', { params: { flag, to: '--all' } });
    if (seen.has(flag) || !(flag in TIERS || SWITCHES.includes(flag))) throw ErrorRegistry.createError('CLI_USAGE');
    seen.add(flag);
    if (flag === '--lang') { language = argv[++i]; if (!language || !['en', 'tr'].includes(language)) throw ErrorRegistry.createError('CLI_USAGE'); }
  }
  const named = Object.keys(TIERS).filter(flag => seen.has(flag));
  if (named.length > 1) throw ErrorRegistry.createError('CLI_USAGE');
  const locale = commandLocale(context, language), root = context.root ?? process.cwd(), options = { env: context.env ?? process.env, heal: false };
  const json = seen.has('--json'), previewOnly = json || seen.has('--dry-run'), yes = seen.has('--yes'), interactive = cliMode(context).mode === 'interactive';
  if (!previewOnly && !interactive) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'uninstall' } });
  const preview = context.previewUninstall;
  if (!preview) throw ErrorRegistry.createError('UNINSTALL_UNSUPPORTED');
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const print = (lines: readonly string[]) => emit(lines, { ...sinks, render: value => value.join('\n') }), title = t('cli.uninstall.title', { path: safe(root) }, locale);
  let query: UninstallQuery = { schemaVersion: 2, tier: TIERS[named[0] ?? ''] ?? 'keep-data', force: seen.has('--force'), disableUnit: seen.has('--disable-unit') };
  let plan = await preview(root, query, options);
  if (previewOnly) { emit(plan, { ...sinks, json, render: value => [title, ...uninstallDetailLines(value, locale, seen.has('--verbose')), t('cli.uninstall.previewOnly', {}, locale)].join('\n') }); return 0; }
  const signal = AbortSignal.timeout(getConfigFieldDefault('approvals').sessionTtlMs);
  const ask = (request: CliCardRequest) => askCliCard(request, { locale, env: options.env, stdout: context.stdout, signal }), cancel = { id: 'cancel', label: t('cli.uninstall.cancel', {}, locale) };
  const cancelled = () => { print([uninstallStatusMessage('cancelled', locale)]); return 1 as ExitCode; };
  // The menu, when the person named no tier: one summary card; a refused tier stays visible with its reason under the card.
  // When every tier is refused for good, there is no choice to offer: the refusal below names its cause and next step.
  // Owner 2026-10-27: when no tier would remove or stop anything there is nothing to choose: no card, only the nothing-to-remove line.
  const idle = plan.nothingToRemove && Object.values(plan.tiers).every(tier => tier.removes === 0);
  while (!named.length && !yes && !idle && uninstallTierChoices(plan, locale).some(choice => !choice.blocked)) {
    const choices = uninstallTierChoices(plan, locale), answer = await ask({ title, initial: choices.find(choice => !choice.blocked)!.tier,
      body: [...uninstallSummaryLines(plan, locale), ...choices.flatMap(choice => choice.blocked ? [t('cli.uninstall.tier.blocked', { tier: choice.label, reason: choice.blocked }, locale)] : [])],
      options: [...choices.filter(choice => !choice.blocked).map(choice => ({ id: choice.tier, label: choice.label })), { id: 'details', label: t('cli.uninstall.details', {}, locale) }, cancel] });
    if (answer === 'details') { print(uninstallDetailLines(plan, locale, true)); continue; }
    if (!answer || answer === 'cancel') return cancelled();
    if (answer !== query.tier) plan = await preview(root, query = { ...query, tier: answer as UninstallQuery['tier'] }, options);
    break;
  }
  // Every check before the one confirmation. A refusal the person can resolve is offered with its flag twin (--force, --disable-unit).
  // A policy refusal is decided by the engine's own authorization (typed error with its owner), so it is not pre-empted here.
  for (let blocker = plan.blockers.find(value => !value.startsWith('policy:')); blocker; blocker = plan.blockers.find(value => !value.startsWith('policy:'))) {
    const work = uninstallResolvable(blocker, plan) && blocker !== 'service-managed' && !query.force, unit = blocker === 'service-managed' && !query.disableUnit && uninstallResolvable(blocker, plan);
    const error = uninstallBlockerError(plan)!;
    if (yes || !(work || unit)) { print(uninstallPlanLines(plan, locale)); throw error; }
    const offer = work ? { id: 'force', label: blocker === 'uncertain-effects' ? t('cli.uninstall.uncertain.offer', {}, locale) : t('cli.uninstall.force.offer', {}, locale), role: 'yes' as const }
      : { id: 'unit', label: t('cli.uninstall.unit.offer', { unit: safe(plan.service.unit ?? '') }, locale), role: 'yes' as const };
    const answer = await ask({ title, body: [error.localize?.(locale).message ?? error.message], initial: 'cancel',
      options: [offer, { id: 'cancel', label: work ? t('cli.uninstall.force.reconcile', {}, locale) : t('cli.uninstall.unit.manual', {}, locale), role: 'no' }] });
    if (answer !== offer.id) { print(uninstallPlanLines(plan, locale)); throw error; }
    plan = await preview(root, query = work ? { ...query, force: true } : { ...query, disableUnit: true }, options);
  }
  if (plan.nothingToRemove && !plan.blockers.length) { print([t('cli.uninstall.nothing', {}, locale), plan.packageRemoval.command ? `  ${safe(plan.packageRemoval.command)}` : t('cli.uninstall.packageUnknown', {}, locale)]); return 0; }
  if (!context.applyUninstall) throw ErrorRegistry.createError('UNINSTALL_UNSUPPORTED');
  const result = await context.applyUninstall(root, { schemaVersion: 2, commandId: randomUUID(), planDigest: plan.planDigest }, {
    backupPassphrase: () => readHidden(process.stdin, context.stderr ?? process.stderr, t('cli.uninstall.backupPassphrase', {}, locale)),
    progress: event => print([t('cli.uninstall.progress', { count: String(event.remaining), left: formatDuration(event.leftMs, locale) }, locale)]),
    confirm: async (current: UninstallPlan) => {
      if (yes) { print([title, ...uninstallPlanLines(current, locale)]); return true; }
      const label = current.backup.required ? t('cli.uninstall.apply.purge', {}, locale) : current.steps.stopService ? t('cli.uninstall.apply.stop', {}, locale) : t('cli.uninstall.apply.remove', {}, locale);
      // An irreversible deletion keeps Cancel preselected; keeping data preselects the action like the rest of the menu.
      return await ask({ title, body: uninstallPlanLines(current, locale), initial: current.backup.required ? 'cancel' : 'apply', options: [{ id: 'apply', label, role: 'yes' }, { ...cancel, role: 'no' }] }) === 'apply';
    },
  }, options, signal);
  const messages = uninstallMessages(locale);
  print([uninstallStatusMessage(result.status, locale),
    ...result.items.filter(item => item.state).map(item => `${safe(plan.items.find(resource => resource.resourceId === item.resourceId)?.locator ?? item.resourceId)}: ${messages[`state.${item.state}`]}`),
    ...(result.unit ? [t('cli.uninstall.unitReceipt', { unit: safe(result.unit.unit), previous: safe(result.unit.previous), undo: safe(result.unit.undo) }, locale)] : []),
    ...(result.uncertain.length && plan.purge ? [t('cli.uninstall.uncertain', { list: result.uncertain.map(item => safe(`${item.kind} ${item.id}`)).join(', ') }, locale)] : []),
    ...(result.backup.destination && plan.backup.required ? [t('cli.uninstall.backup', { path: safe(result.backup.destination) }, locale)] : []),
    result.packageRemoval.command ? t('cli.uninstall.packageHandoff', { command: safe(result.packageRemoval.command) }, locale) : t('cli.uninstall.packageUnknown', {}, locale)]);
  return result.status === 'completed' || result.status === 'noop' ? 0 : 1;
}
