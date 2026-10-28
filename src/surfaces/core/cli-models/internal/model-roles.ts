import { randomUUID } from 'node:crypto';
import { ErrorRegistry, EXIT_CODES, MESSAGE_REGISTRY, emit, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { MODEL_TIERS, type ModelTier } from '#domain/index.js';
import type { ModelRoleAssignCommand, ModelRoleAssignResult, ModelRoleEntry, ModelRoleInspection, ModelRoleQuery } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliTableStyle, renderCliTable, type CliTableStyle, resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import type { ModelCommandContext } from './context.js';
import { askModelsCard, modelsConfirmOptions, modelsInteractive, modelsSinks, reportModelsCancelled } from './io.js';

export type ModelRoleInspectionHandler = (root: string, query: ModelRoleQuery, options: ConfigLoadOptions) => Promise<ModelRoleInspection>;
export type ModelRoleAssignHandler = (root: string, command: ModelRoleAssignCommand, options: ConfigLoadOptions) => Promise<ModelRoleAssignResult>;

interface Parsed { action: 'show' | 'set'; json: boolean; help: boolean; noRoles: boolean; language?: string; scopeId?: string; channelId?: string; modelId?: string;
  tier?: ModelTier; roles?: string[]; commandId?: string }
const VALUED = { '--lang': 'language', '--scope': 'scopeId', '--channel': 'channelId', '--model': 'modelId', '--tier': 'tier', '--roles': 'roles', '--command-id': 'commandId' } as const;
const SET_ONLY: readonly string[] = ['--tier', '--roles', '--no-roles', '--command-id'];
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'models' || argv[1] !== 'roles') throw ErrorRegistry.createError('CLI_USAGE');
  const action = argv[2] === 'set' ? 'set' : 'show', start = argv[2] === 'set' || argv[2] === 'show' ? 3 : 2;
  const result: Parsed = { action, json: false, help: false, noRoles: false }, seen = new Set<string>();
  for (let index = start; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (seen.has(key) || (action === 'show' && SET_ONLY.includes(key))) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
    if (key === '--help') result.help = true;
    else if (key === '--json') result.json = true;
    else if (key === '--no-color') continue;
    else if (key === '--no-roles') result.noRoles = true;
    else if (Object.hasOwn(VALUED, key)) {
      const value = argv[++index]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      const field = VALUED[key as keyof typeof VALUED];
      if (field === 'tier') { if (!(MODEL_TIERS as readonly string[]).includes(value)) throw ErrorRegistry.createError('CLI_USAGE', { params: { flag: '--tier' } }); result.tier = value as ModelTier; }
      else if (field === 'roles') result.roles = value.split(',').map(role => role.trim());
      else result[field] = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (result.help) return result;
  if ((result.modelId !== undefined && result.channelId === undefined)) throw ErrorRegistry.createError('CLI_USAGE');
  if (action === 'set' && (!result.channelId || !result.modelId || !result.tier || (result.roles === undefined) === !result.noRoles
    || result.roles?.some(role => !role))) throw ErrorRegistry.createError('CLI_USAGE');
  return result;
}

/** What a role lets a model do, in the catalogs' words (`climodels.roles.unlock.<role id>`: role ids are registry data); a role an overlay added
 * with no text in this release shows its id. */
const roleText = (role: string, locale: Locale) => (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[`climodels.roles.unlock.${role}`]
  ?? t('climodels.roles.unlock.other', { role: terminalSafeText(role) }, locale);
const tierWord = (tier: ModelTier | null, locale: Locale) => tier === null ? '-'
  : tier === 'frontier' ? t('climodels.roles.tier.frontier', {}, locale) : t('climodels.roles.tier.worker', {}, locale);
const rolesWord = (roles: readonly string[], locale: Locale) => roles.length ? roles.map(role => terminalSafeText(role)).join(', ') : t('climodels.roles.none', {}, locale);
const stateWord = (entry: ModelRoleEntry, locale: Locale) => entry.state === 'pending' ? t('climodels.roles.state.pending', {}, locale)
  : entry.state === 'exception' ? t('climodels.roles.state.exception', {}, locale) : t('climodels.roles.state.assigned', {}, locale);
function priceText(entry: ModelRoleEntry, locale: Locale): string {
  const pricing = entry.catalog?.pricing;
  if (!pricing || pricing.kind === 'unknown') return t('climodels.roles.price.unknown', {}, locale);
  if (pricing.kind === 'subscription') return t('climodels.roles.price.subscription', {}, locale);
  return t('climodels.roles.price.perToken', { input: terminalSafeText(pricing.inputPerMTok ?? '-'), output: terminalSafeText(pricing.outputPerMTok ?? '-'),
    day: terminalSafeText(pricing.asOf ?? '-') }, locale);
}
const makerText = (entry: ModelRoleEntry, locale: Locale) => entry.catalog?.maker ? terminalSafeText(entry.catalog.maker) : t('climodels.roles.makerUnknown', {}, locale);

/** The read view as text: `deckent models roles` and the terminal `/roles` window render the very same table and legend. */
export function renderModelRoleInspection(view: ModelRoleInspection, locale: Locale, style: CliTableStyle): string {
  if (!view.models.length) return t('climodels.roles.empty', {}, locale);
  const rows = view.models.map(entry => [terminalSafeText(entry.modelId), terminalSafeText(entry.channelId), makerText(entry, locale), tierWord(entry.tier, locale),
    rolesWord(entry.roles, locale), stateWord(entry, locale)]);
  const lines = [t('climodels.roles.heading', { revision: terminalSafeText(view.revision) }, locale), renderCliTable([
    { header: t('climodels.models.table.model', {}, locale), shrink: false }, { header: t('climodels.roles.table.channel', {}, locale) },
    { header: t('climodels.roles.table.maker', {}, locale) }, { header: t('climodels.roles.table.tier', {}, locale) },
    { header: t('climodels.roles.table.roles', {}, locale) }, { header: t('climodels.roles.table.state', {}, locale) }], rows, style), '',
  t('climodels.roles.legend', { roles: view.roles.map(role => `${terminalSafeText(role.id)} (${tierWord(role.minimumTier, locale)})`).join(', ') }, locale)];
  // BeUser E-08: the command a person can copy (the first pending model's real ids), the values each flag takes, and what a tier means.
  const first = view.models.find(entry => entry.state === 'pending');
  if (view.pending && first) lines.push(t('climodels.roles.pendingFooter.filled', { count: view.pending, channel: terminalSafeText(first.channelId), model: terminalSafeText(first.modelId),
    roles: view.roles.map(role => terminalSafeText(role.id)).join(',') }, locale));
  else if (view.pending) lines.push(t('climodels.roles.pendingFooter', { count: view.pending }, locale));
  lines.push(t('climodels.roles.tierMeaning', {}, locale));
  return lines.join('\n');
}

/** The card: what the catalog says of the exact model, its row now, the proposed row, and what that unlocks or takes away. */
function cardBody(entry: ModelRoleEntry, parsed: Parsed, locale: Locale): string[] {
  const proposed = parsed.roles ?? [], gained = proposed.filter(role => !entry.roles.includes(role)), lost = entry.roles.filter(role => !proposed.includes(role));
  return [
    t('climodels.roles.card.channel', { channel: terminalSafeText(entry.channelId) }, locale),
    t('climodels.roles.card.model', { model: terminalSafeText(entry.modelId), name: terminalSafeText(entry.catalog?.displayName ?? '-') }, locale),
    t('climodels.roles.card.maker', { maker: makerText(entry, locale) }, locale),
    t('climodels.roles.card.price', { price: priceText(entry, locale) }, locale),
    entry.state === 'pending' ? t('climodels.roles.card.nowPending', {}, locale)
      : t('climodels.roles.card.now', { tier: tierWord(entry.tier, locale), roles: rolesWord(entry.roles, locale) }, locale),
    t('climodels.roles.card.proposed', { tier: tierWord(parsed.tier!, locale), roles: rolesWord(proposed, locale) }, locale),
    ...gained.map(role => t('climodels.roles.card.unlocks', { role: terminalSafeText(role), text: roleText(role, locale) }, locale)),
    ...lost.map(role => t('climodels.roles.card.removes', { role: terminalSafeText(role), text: roleText(role, locale) }, locale)),
    '', t('climodels.roles.card.where', {}, locale),
  ];
}

/** `deckent models roles [show] [--channel <id> [--model <id>]]` and `deckent models roles set ...` (M2 typed role admission). */
export async function modelRolesCommand(argv: readonly string[], context: ModelCommandContext): Promise<void | ExitCode> {
  const parsed = parse(argv), locale = commandLocale(context, parsed.language), sinks = modelsSinks(context);
  if (parsed.help) { emit(t('climodels.roles.help', {}, locale), sinks); return; }
  const writing = parsed.action === 'set';
  // A tier/role change is a person's terminal act: an AI tool, CI, pipe or `--json` is refused before anything is read (the composition checks
  // the terminal witness again).
  if (writing && !modelsInteractive(context, parsed.json)) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: argv.slice(0, 3).join(' ') } });
  if (!context.inspectModelRoles || (writing && !context.assignModelRole)) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), options: ConfigLoadOptions = { env: context.env ?? process.env };
  const configured = await loadConfig(root, { ...options, heal: false }).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const scope = await resolveCommandScope({ command: 'deckent models roles', locale, explicit: parsed.scopeId, configured: typeof configured === 'string' ? configured : undefined,
    mutating: writing, interactive: modelsInteractive(context, parsed.json), listScopes: () => scopeLister(context as never, root, options)().catch(() => []),
    pick: request => askModelsCard(context, locale, request) });
  if (!scope) return writing ? EXIT_CODES.error : undefined;
  const query: ModelRoleQuery = { schemaVersion: 1, scopeId: scope.scopeId, ...(parsed.channelId ? { channelId: parsed.channelId } : {}), ...(parsed.modelId ? { modelId: parsed.modelId } : {}) };
  const view = await context.inspectModelRoles(root, query, options);
  if (!parsed.json) emit(scopeNotice(scope, locale), sinks);
  if (!writing) { emit(view, { ...sinks, json: parsed.json, render: value => renderModelRoleInspection(value, locale, cliTableStyle(context)) }); return; }
  const entry = view.models.find(row => row.channelId === parsed.channelId && row.modelId === parsed.modelId);
  if (!entry) throw ErrorRegistry.createError('MODEL_ROLE_CATALOG_UNKNOWN');
  const title = entry.state === 'pending' ? t('climodels.roles.card.titleNew', {}, locale) : t('climodels.roles.card.titleChange', {}, locale);
  if (await askModelsCard(context, locale, { title, body: cardBody(entry, parsed, locale), options: modelsConfirmOptions(locale) }) !== 'apply') {
    reportModelsCancelled(context, locale); return EXIT_CODES.error;
  }
  const result = await context.assignModelRole!(root, { schemaVersion: 1, commandId: parsed.commandId ?? randomUUID(), scopeId: scope.scopeId, channelId: entry.channelId,
    modelId: entry.modelId, tier: parsed.tier!, roles: parsed.roles ?? [], expect: view.digest }, options);
  const params = { model: terminalSafeText(result.row.modelId), channel: terminalSafeText(result.row.channelId), tier: tierWord(result.row.tier, locale), roles: rolesWord(result.row.roles, locale) };
  if (result.status === 'unchanged') { emit(t('climodels.roles.done.unchanged', params, locale), sinks); return; }
  if (result.status === 'approval-pending') {
    emit([t('climodels.roles.done.pending', { ...params, approval: terminalSafeText(result.approvalId) }, locale),
      t('climodels.roles.done.pendingNext', { commandId: terminalSafeText(result.commandId) }, locale)].join('\n'), { level: 'warning', ...sinks });
    return EXIT_CODES.error;
  }
  emit(t('climodels.roles.done.applied', { ...params, revision: terminalSafeText(result.revision) }, locale), sinks);
}
