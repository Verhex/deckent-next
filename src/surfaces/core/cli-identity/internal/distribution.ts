import { IDENTITY_PROFILE_LIMITS } from '#domain/index.js';
import { EXIT_CODES, ErrorRegistry, emit, getConfigFieldDefault, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import type { IdentityDistributionPreview, IdentityProfileDistributionApplication } from '#engine/index.js';
import { commandLocale, readJsonInput, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, cliMode, cliTableStyle, renderCliTable, type CliCardRequest } from '#surfaces/core/cli-human/index.js';
import { profileLabel, renderIdentityPreview } from './render.js';

type Choices = Awaited<ReturnType<IdentityProfileDistributionApplication['choices']>>;
export interface IdentityDistributionContext extends CliBaseContext {
  listIdentityDistributionChoices?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<Choices>;
  previewIdentityDistribution?: (root: string, selection: unknown, options: ConfigLoadOptions) => Promise<IdentityDistributionPreview>;
  applyIdentityDistribution?: (root: string, submission: unknown, expect: string, options: ConfigLoadOptions) => Promise<{
    readonly schemaVersion: 1; readonly profile: { readonly id: string; readonly version: number }; readonly digest: string;
    readonly outcome: import('#engine/index.js').EffectOutcome }>;
}
const safe = (value: string) => terminalSafeText(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '));
/** `identity choices` for a person (owner CLI review 2026-10-19): labelled tables — profiles with their roles, the people, the scopes. */
function renderChoices(value: Choices, locale: Locale, context: IdentityDistributionContext): string {
  const style = cliTableStyle(context);
  return [renderCliTable([{ header: t('climodels.identity.table.profile', {}, locale), shrink: false }, { header: t('climodels.identity.table.roles', {}, locale) }],
    value.profiles.map(item => [profileLabel(item, locale), item.definition.roleTemplates.map(role => safe(role.id)).join(', ') || t('climodels.identity.noRoles', {}, locale)]), style),
  '', renderCliTable([{ header: t('climodels.identity.table.people', {}, locale), shrink: false }, { header: t('climodels.identity.table.kind', {}, locale) }],
    value.principals.map(item => [safe(item.label), safe(item.kind)]), style),
  '', renderCliTable([{ header: t('climodels.identity.table.scopes', {}, locale) }], value.scopeIds.map(id => [safe(id)]), style)].join('\n');
}
/** One card on the person's terminal, bounded by the session approval time; null = cancelled, nothing is applied. */
async function ask(context: IdentityDistributionContext, locale: Locale, request: CliCardRequest): Promise<string | null> {
  const env = context.env ?? process.env;
  const ttlMs = await loadConfig(context.root ?? process.cwd(), { env, heal: false }).then(config => config.approvals.sessionTtlMs, () => getConfigFieldDefault('approvals').sessionTtlMs);
  return askCliCard(request, { locale, env, signal: AbortSignal.any([AbortSignal.timeout(ttlMs), ...(context.signal ? [context.signal] : [])]),
    ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) });
}
export async function identityDistributionCommand(argv: readonly string[], context: IdentityDistributionContext): Promise<void | ExitCode> {
  const values = new Map<string, string>(); let apply = false, json = false;
  const usage = () => ErrorRegistry.createError('CLI_USAGE', { params: { usage: t('identity.distributionHelp', {}, commandLocale(context)) } });
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--apply' && !apply && argv[1] === 'distribute') { apply = true; continue; }
    if (flag === '--no-color') continue;
    if (!['--scope', '--lang', '--input', '--expect'].includes(flag) || values.has(flag)) throw usage();
    const value = argv[++i]; if (!value || value.startsWith('--')) throw usage(); values.set(flag, value);
  }
  const env = context.env ?? process.env, locale = commandLocale(context, values.get('--lang'));
  const root = context.root ?? process.cwd(), options = { env }, stdin = context.stdin ?? process.stdin;
  const sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  const scope = values.get('--scope'), path = values.get('--input'), expect = values.get('--expect');
  if (argv[1] === 'choices') {
    if (!scope || apply || path || expect || !context.listIdentityDistributionChoices) throw usage();
    const choices = await context.listIdentityDistributionChoices(root, scope, options);
    emit(choices, { ...sinks, render: value => renderChoices(value, locale, context) }); return;
  }
  if (!context.previewIdentityDistribution || !context.applyIdentityDistribution || (expect && !apply)) throw usage();
  const result = (value: { outcome: { status: string } }) => t('identity.distributionResult', { status: value.outcome.status }, locale);
  if (path) {
    if (scope || (apply && !expect)) throw usage();
    const body = await readJsonInput(path, IDENTITY_PROFILE_LIMITS.maxInputBytes,
      { limit: 'IDENTITY_PREVIEW_LIMIT', invalid: 'IDENTITY_PREVIEW_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'IDENTITY_PREVIEW_UNAVAILABLE' }, stdin);
    if (apply) { emit(await context.applyIdentityDistribution(root, body, expect!, options), { ...sinks, render: result }); return; }
    emit(await context.previewIdentityDistribution(root, body, options), { ...sinks, render: value => `${renderIdentityPreview(value.preview, locale)}\n${t('identity.distributionExpect', { digest: value.digest }, locale)}` }); return;
  }
  // Every interactive input is a selection on a card (arrow keys; owner 2026-10-08): no typed principal, role or policy is accepted. Only a person at a
  // real terminal is asked (never an agent, CI or pipe); the apply itself attests the terminal again in the application.
  if (cliMode(context, json).mode !== 'interactive' || !scope || expect || !context.listIdentityDistributionChoices) throw usage();
  const choices = await context.listIdentityDistributionChoices(root, scope, options);
  const cancelled = () => { emit(t('climodels.card.cancelled', {}, locale), { level: 'warning', ...sinks, json: false }); return EXIT_CODES.error; };
  const pick = async <T>(title: string, rows: readonly T[], id: (row: T) => string, label: (row: T) => string): Promise<T | null> => {
    if (!rows.length) throw ErrorRegistry.createError('IDENTITY_PREVIEW_UNAVAILABLE');
    const chosen = await ask(context, locale, { title, options: rows.map(row => ({ id: id(row), label: safe(label(row)) })) });
    return rows.find(row => id(row) === chosen) ?? null;
  };
  const profile = await pick(t('climodels.identity.pick.profile', {}, locale), choices.profiles, entry => `${entry.definition.id}@${entry.definition.version}`, entry => profileLabel(entry, locale));
  if (!profile) return cancelled();
  const principal = await pick(t('climodels.identity.pick.person', {}, locale), choices.principals, entry => entry.id, entry => entry.label);
  if (!principal) return cancelled();
  const role = await pick(t('climodels.identity.pick.role', { profile: profileLabel(profile, locale) }, locale), profile.definition.roleTemplates, entry => entry.id, entry => entry.id);
  if (!role) return cancelled();
  const project = await pick(t('climodels.identity.pick.scope', {}, locale), choices.scopeIds, id => id, id => id);
  if (!project) return cancelled();
  const prepared = await context.previewIdentityDistribution(root, { schemaVersion: 1, profile: { id: profile.definition.id, version: profile.definition.version },
    scopeId: scope, assignments: [{ principalId: principal.id, roleId: role.id, scopeIds: [project] }], removeBindingIds: [] }, options);
  const shown = `${renderIdentityPreview(prepared.preview, locale)}\n${t('identity.distributionExpect', { digest: prepared.digest }, locale)}`;
  if (!apply) { emit(prepared, { ...sinks, render: () => shown }); return; }
  const answer = await ask(context, locale, { title: t('climodels.identity.card.apply', { profile: profileLabel(profile, locale) }, locale), body: shown.split('\n'),
    options: [{ id: 'apply', label: t('identity.approveDistribution', {}, locale), key: 'y' }, { id: 'cancel', label: t('identity.cancelDistribution', {}, locale), key: 'n' }] });
  if (answer !== 'apply') return cancelled();
  emit(await context.applyIdentityDistribution(root, prepared.submission, prepared.digest, options), { ...sinks, render: result });
}
