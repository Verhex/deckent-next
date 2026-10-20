import { ErrorRegistry, EXIT_CODES, emit, getConfigFieldDefault, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import type { ToolchainCurrencyReport } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliTableStyle, formatDuration, renderCliTable, type CliTableStyle } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
import { adminInteractive, adminSinks, askAdminCard, confirmOptions, reportCancelled } from './io.js';

type UpdatePlan = Readonly<{ next: Readonly<{ imageVersion: string; previousVersion?: string }> | null; staleProviders?: readonly string[];
  affectedProfiles?: readonly Readonly<{ provider: string; cliVersion: string }>[] }>;
export type ToolchainUpdateHandler = (root: string, input: Readonly<{ apply: boolean }>, options: ConfigLoadOptions) => Promise<Readonly<{ decision: string; plan: UpdatePlan | null;
  build: Readonly<{ imageId: string; tag: string | null }> | null; proposalPath: string | null }>>;
type Entry = ToolchainCurrencyReport['providers'][number];
const states = (locale: Locale): Readonly<Record<Entry['status'], string>> => ({ fresh: t('cli.toolchains.state.fresh', {}, locale), stale: t('cli.toolchains.state.stale', {}, locale),
  ahead: t('cli.toolchains.state.ahead', {}, locale), unparsed: t('cli.toolchains.state.unparsed', {}, locale), 'unknown-offline': t('cli.toolchains.state.unknown-offline', {}, locale),
  unsupported: t('cli.toolchains.state.unsupported', {}, locale), disabled: t('cli.toolchains.state.disabled', {}, locale), 'not-admitted': t('cli.toolchains.state.not-admitted', {}, locale) });
const stateText = (entry: Entry, locale: Locale) => states(locale)[entry.status] ?? terminalSafeText(entry.status);
const accepted = (entry: Entry, locale: Locale) => [...new Set(entry.admitted.map(item => item.version ?? item.cliVersion))].map(text => terminalSafeText(text)).join(', ') || t('cli.toolchains.none', {}, locale);

/** Owner CLI review 2026-10-19 (`toolchains`): network use first, then tool · accepted · newest · state, then whether updates run by themselves. */
export function renderToolchainStatus(report: ToolchainCurrencyReport, updateMode: string, intervalMs: number, locale: Locale, style: CliTableStyle): string {
  const network = report.mode === 'off' ? t('cli.toolchains.network.off', {}, locale) : t('cli.toolchains.network.on', { endpoint: terminalSafeText(report.registryEndpoint ?? '-') }, locale);
  const columns = [t('cli.toolchains.column.tool', {}, locale), t('cli.toolchains.column.accepted', {}, locale), t('cli.toolchains.column.latest', {}, locale),
    t('cli.toolchains.column.state', {}, locale)].map(header => ({ header }));
  const rows = report.providers.map(entry => [terminalSafeText(entry.provider), accepted(entry, locale), entry.latest ? terminalSafeText(entry.latest.version) : '—', stateText(entry, locale)]);
  const stale = report.providers.filter(entry => entry.status === 'stale').map(entry => `${terminalSafeText(entry.provider)} ${accepted(entry, locale)} → ${entry.latest ? terminalSafeText(entry.latest.version) : '?'}`);
  const auto = updateMode === 'auto' ? t('cli.toolchains.auto.on', { interval: intervalMs > 0 ? formatDuration(intervalMs, locale) : t('cli.toolchains.auto.atStart', {}, locale) }, locale)
    : updateMode === 'propose' ? t('cli.toolchains.auto.propose', {}, locale) : t('cli.toolchains.auto.off', {}, locale);
  return [network, '', rows.length ? renderCliTable(columns, rows, style) : t('cli.toolchains.empty', {}, locale), '',
    stale.length ? t('cli.toolchains.stale', { tools: stale.join(', ') }, locale) : t('cli.toolchains.allCurrent', {}, locale), auto].join('\n');
}
function renderUpdate(value: Awaited<ReturnType<ToolchainUpdateHandler>>, locale: Locale): string {
  const next = value.plan?.next?.imageVersion;
  if (value.decision === 'disabled') return t('cli.toolchains.update.disabled', {}, locale);
  if (value.decision === 'no-change' || !next) return t('cli.toolchains.update.noChange', {}, locale);
  const tools = (value.plan?.staleProviders ?? []).map(id => terminalSafeText(id)).join(', ') || t('cli.toolchains.none', {}, locale);
  if (value.decision === 'built') return t('cli.toolchains.update.built', { version: next, image: terminalSafeText(value.build?.tag ?? value.build?.imageId ?? '-'),
    proposal: terminalSafeText(value.proposalPath ?? '-') }, locale);
  return [t('cli.toolchains.update.planned', { version: next, tools }, locale), t('cli.toolchains.update.applyHint', {}, locale)].join('\n');
}

/**
 * `deckent toolchains` (no action): the worker toolchains' currency (read; asks the package registry over the network, said first).
 * `deckent toolchains update [--apply] [--json]`: the policy-driven plan, and with `--apply` the new worker image build. Installed config is never
 * written here. Off a terminal without `--apply` it only reports. On a terminal the plan is shown on a card (what changes, the new image, the
 * build time limit, running work untouched) and only "apply" builds it.
 */
export async function toolchainsCommand(argv: readonly string[], context: AdminCommandContext): Promise<void | ExitCode> {
  const action = argv[1], status = action === undefined || action.startsWith('-');
  let apply = false, json = false, language: string | undefined;
  if (!status && action !== 'update') throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = status ? 1 : 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply' && !apply && !status) { apply = true; continue; }
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--no-color') continue;
    if (flag === '--lang' && language === undefined) { language = argv[++i]; if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); continue; }
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  const env = context.env ?? process.env, root = context.root ?? process.cwd(), options = { env }, locale = commandLocale(context, language);
  const policy = await loadConfig(root, options).then(config => config.toolchains.update, () => getConfigFieldDefault('toolchains').update);
  if (status) {
    if (!context.inspectToolchainCurrency) throw ErrorRegistry.createError('CLI_USAGE');
    const report = await context.inspectToolchainCurrency(root, options);
    emit(report, { json, ...adminSinks(context), render: () => renderToolchainStatus(report, policy.mode, policy.intervalMs, locale, cliTableStyle(context)) });
    return;
  }
  if (!context.updateToolchains) throw ErrorRegistry.createError('CLI_USAGE');
  const interactive = adminInteractive(context, json);
  const plan = await context.updateToolchains(root, { apply: apply && !interactive }, options);
  if (!interactive || !plan.plan?.next || plan.decision !== 'planned') { emit(plan, { json, ...adminSinks(context), render: value => renderUpdate(value, locale) }); return; }
  // A person on a terminal always sees the plan on a card first (with or without `--apply`); only "apply" there builds.
  const tools = (plan.plan.affectedProfiles ?? []).map(item => `${terminalSafeText(item.provider)} ${terminalSafeText(item.cliVersion)}`).join(', ') || t('cli.toolchains.none', {}, locale);
  const answer = await askAdminCard(context, locale, { title: t('cli.toolchains.card.title', { version: plan.plan.next.imageVersion }, locale), body: [
    t('cli.toolchains.card.what', { tools: (plan.plan.staleProviders ?? []).map(id => terminalSafeText(id)).join(', ') || t('cli.toolchains.none', {}, locale), profiles: tools }, locale),
    t('cli.toolchains.card.build', { limit: formatDuration(policy.buildTimeoutMs, locale) }, locale), t('cli.toolchains.card.running', {}, locale)], options: confirmOptions(locale) });
  if (answer !== 'apply') { reportCancelled(context, locale); return EXIT_CODES.error; }
  emit(t('cli.toolchains.card.building', { limit: formatDuration(policy.buildTimeoutMs, locale) }, locale), { level: 'warning', ...adminSinks(context) });
  const built = await context.updateToolchains(root, { apply: true }, options);
  emit(built, { json, ...adminSinks(context), render: value => renderUpdate(value, locale) });
}
