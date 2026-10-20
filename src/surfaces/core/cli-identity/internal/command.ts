import { IDENTITY_PROFILE_LIMITS } from '#domain/index.js';
import type { IdentityProfileListing, IdentityProfilePreview } from '#engine/index.js';
import { ErrorRegistry, emit, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { commandLocale, readJsonInput, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { cliMode, resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { profileLabel, profileMeaning, renderIdentityPreview, renderIdentityProfiles } from './render.js';
import { identityDistributionCommand, type IdentityDistributionContext } from './distribution.js';
export interface IdentityCommandContext extends CliBaseContext, IdentityDistributionContext {
  listIdentityProfiles?: (packages: readonly unknown[]) => IdentityProfileListing;
  previewIdentityProfile?: (root: string, input: unknown, packages: readonly unknown[], options: ConfigLoadOptions) => Promise<IdentityProfilePreview>;
}
type Selection = Readonly<{ id: string; version: number }>;
/** The installation's selected identity profile (`identity.profile`, template data, never authority); null = none selected or unreadable. */
async function selectedProfile(root: string, options: ConfigLoadOptions): Promise<Selection | null> {
  const section = await loadConfig(root, { ...options, heal: false }).then(config => (config as Record<string, unknown>)['identity'], () => undefined) as { profile?: Selection } | undefined;
  return section?.profile && typeof section.profile.id === 'string' ? section.profile : null;
}
/** The selected profile in words, or how to select one (owner CLI review 2026-10-19: "profil seçilmemiş", not "profil geçersiz"). */
function selectionLine(selection: Selection | null, profiles: IdentityProfileListing['profiles'], locale: Locale): string {
  if (!selection) return t('climodels.identity.notSelected', {}, locale);
  const entry = profiles.find(item => item.definition.id === selection.id && item.definition.version === selection.version);
  return entry ? t('climodels.identity.selected', { profile: profileLabel(entry, locale), meaning: profileMeaning(entry, locale) }, locale)
    : t('climodels.identity.selectedUnknown', { profile: terminalSafeText(`${selection.id}@${selection.version}`) }, locale);
}
export async function identityCommand(argv: readonly string[], context: IdentityCommandContext) {
  if (argv[1] === 'choices' || argv[1] === 'distribute') return identityDistributionCommand(argv, context);
  const env = context.env ?? process.env, values = new Map<string, string>(); let json = false, verbose = false;
  const bare = argv[1] === undefined || argv[1].startsWith('-'), action = bare ? undefined : argv[1];
  const early = commandLocale(context, argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : undefined);
  const usage = () => ErrorRegistry.createError('CLI_USAGE', { params: { usage: t('identity.help', {}, early) } });
  if (!bare && action !== 'profiles' && action !== 'preview') throw usage();
  const allowed = bare ? ['--lang', '--scope'] : action === 'profiles' ? ['--lang', '--registry'] : ['--lang', '--registry', '--profile', '--profile-version', '--scope', '--input'];
  for (let index = bare ? 1 : 2; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--verbose' && !verbose && action !== 'preview') { verbose = true; continue; }
    if (flag === '--no-color') continue;
    if (!allowed.includes(flag) || values.has(flag)) throw usage();
    const value = argv[++index]; if (!value || value.startsWith('--')) throw usage(); values.set(flag, value);
  }
  const locale = commandLocale(context, values.get('--lang')), root = context.root ?? process.cwd(), options = { env };
  const sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (bare) return identityStatus(context, locale, values.get('--scope'), json);
  const errors = { limit: 'IDENTITY_PREVIEW_LIMIT', invalid: 'IDENTITY_PREVIEW_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'IDENTITY_PREVIEW_UNAVAILABLE' };
  const read = (source: string) => readJsonInput(source, IDENTITY_PROFILE_LIMITS.maxInputBytes, errors, context.stdin);
  const registryPath = values.get('--registry');
  if (registryPath === '-' && values.get('--input') === '-') throw usage();
  const packages = registryPath ? await read(registryPath) : [];
  if (!Array.isArray(packages)) throw ErrorRegistry.createError('IDENTITY_PROFILE_INVALID');
  if (action === 'profiles') {
    if (!context.listIdentityProfiles) throw ErrorRegistry.createError('IDENTITY_PREVIEW_UNAVAILABLE');
    const listing = context.listIdentityProfiles(packages), selection = json ? null : await selectedProfile(root, options);
    emit(listing, { ...sinks, render: result => [selectionLine(selection, result.profiles, locale), '', renderIdentityProfiles(result, locale, verbose)].join('\n') }); return;
  }
  const id = values.get('--profile'), scopeId = values.get('--scope'), rawVersion = values.get('--profile-version') ?? '1';
  if (!scopeId || (!id && values.has('--profile-version')) || !/^[1-9][0-9]*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))) throw usage();
  // Without --profile the installation's selection is used: none selected is said as such, with how to select one, before anything is read.
  if (!id && !await selectedProfile(root, options)) throw ErrorRegistry.createError('IDENTITY_PROFILE_NOT_SELECTED');
  const source = values.get('--input'), body = source ? await read(source) : { members: [], organization: [], assignments: [], removeBindingIds: [] };
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['members', 'organization', 'assignments', 'removeBindingIds', 'projectScopeIds', 'includeFutureProjects'].includes(key))) {
    throw ErrorRegistry.createError('IDENTITY_PREVIEW_INVALID');
  }
  if (!context.previewIdentityProfile) throw ErrorRegistry.createError('IDENTITY_PREVIEW_UNAVAILABLE');
  const input = { ...body, schemaVersion: 1, ...(id ? { profile: { id, version: Number(rawVersion) } } : {}), scopeId };
  emit(await context.previewIdentityProfile(root, input, packages, options), { ...sinks, render: result => renderIdentityPreview(result, locale) });
}

/** Bare `deckent identity` (owner CLI review 2026-10-19): a read of the scope's identity — the selected profile (or how to select one), the
 * people this installation can name and the role bindings in force, in words. The configured scope is used and named. */
async function identityStatus(context: IdentityCommandContext, locale: Locale, explicit: string | undefined, json: boolean): Promise<void> {
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  if (!context.listIdentityDistributionChoices) throw ErrorRegistry.createError('IDENTITY_PREVIEW_UNAVAILABLE');
  const configured = await loadConfig(root, { ...options, heal: false }).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const scope = await resolveCommandScope({ command: 'deckent identity', locale, explicit, configured: typeof configured === 'string' ? configured : undefined, mutating: false,
    interactive: cliMode(context, json).mode === 'interactive', listScopes: () => scopeLister(context as never, root, options)().catch(() => []) });
  if (!scope) return;
  const choices = await context.listIdentityDistributionChoices(root, scope.scopeId, options), selection = await selectedProfile(root, options);
  const sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (!json) emit(scopeNotice(scope, locale), sinks);
  const who = (ref: { issuer: string; subject: string }) => choices.principals.find(item => item.principal.issuer === ref.issuer && item.principal.subject === ref.subject)?.label
    ?? `${ref.issuer}/${ref.subject}`;
  const scopes = (selection: unknown) => { const value = selection as { values?: readonly string[]; except?: readonly string[] };
    return value.values ? value.values.map(terminalSafeText).join(', ') : value.except?.length ? t('identity.allExcept', { values: value.except.map(terminalSafeText).join(', ') }, locale) : t('identity.all', {}, locale); };
  emit({ schemaVersion: 1, scopeId: scope.scopeId, profile: selection, principals: choices.principals, bindings: choices.bindings }, { ...sinks, render: () => [
    selectionLine(selection, choices.profiles, locale),
    t('climodels.identity.people', { count: choices.principals.length, people: choices.principals.map(item => terminalSafeText(item.label)).join(', ') || '-' }, locale),
    choices.bindings.length ? t('climodels.identity.roles', {}, locale) : t('climodels.identity.noBindings', {}, locale),
    ...choices.bindings.map(binding => `  ${t('climodels.identity.binding', { roles: binding.roles.map(terminalSafeText).join(', '),
      people: binding.principals.map(ref => terminalSafeText(who(ref))).join(', '), scopes: scopes(binding.scopes) }, locale)}`),
    t('climodels.identity.next', {}, locale)].join('\n') });
}
