import { IdentityProfileRegistry, type IdentityProfileListing, type IdentityProfilePreview } from '#engine/index.js';
import { coreIdentityProfileData } from '#domain/index.js';
import { MESSAGE_REGISTRY, t, type Locale } from '#platform/index.js';
// Catalog data chooses labels; extension labels are package data, never commands or authority.
const safe = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
type ProfileEntry = IdentityProfileListing['profiles'][number];
const catalog = (locale: Locale) => MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>;
/** Presentation order comes from the profile registry's authored order; extension profiles keep their relative order. */
export function orderedProfiles<T>(entries: readonly T[], id: (entry: T) => string): T[] {
  const order = new Map(coreIdentityProfileData.profiles.map((entry, index) => [entry.id, index]));
  return [...entries].sort((a, b) => (order.get(id(a)) ?? order.size) - (order.get(id(b)) ?? order.size));
}
/** A profile's name in the person's language (package labels first, then the catalog label, else its key). */
export const profileLabel = (entry: ProfileEntry, locale: Locale): string =>
  safe(entry.labels?.[locale] ?? catalog(locale)[entry.definition.labelKey] ?? entry.definition.labelKey);
/** A profile id in the person's words (its registry label, e.g. "Solo"), never the raw `core:solo`; an unregistered id stays as itself. */
export const profileName = (id: string, locale: Locale): string => {
  const entry = new IdentityProfileRegistry().list().find(row => row.definition.id === id);
  return entry ? profileLabel(entry, locale) : safe(id);
};
/** What a profile means, one line: the catalog's description of its label (`<labelKey>.description`), else its role templates (package data). */
export function profileMeaning(entry: ProfileEntry, locale: Locale): string {
  const described = catalog(locale)[`${entry.definition.labelKey}.description`];
  if (described) return described;
  const roles = entry.definition.roleTemplates.map(role => safe(role.id));
  return roles.length ? t('climodels.identity.rolesOnly', { roles: roles.join(', ') }, locale) : t('climodels.identity.noRoles', {}, locale);
}
/** `identity profiles` (owner CLI review 2026-10-19): one line per profile with its meaning; registry and profile digests only with `--verbose`. */
export function renderIdentityProfiles(value: IdentityProfileListing, locale: Locale, verbose = false) {
  if (verbose) return [t('identity.list', { version: value.registryVersion, digest: value.registryDigest }, locale),
    ...value.profiles.map(entry => t('identity.profileLine', { id: entry.definition.id, version: entry.definition.version, label: profileLabel(entry, locale), digest: entry.digest }, locale))].join('\n');
  return [t('climodels.identity.profilesHeading', {}, locale), ...orderedProfiles(value.profiles, entry => entry.definition.id).map(entry => `  ${profileLabel(entry, locale)} · ${profileMeaning(entry, locale)}`)].join('\n');
}
export function renderIdentityPreview(value: IdentityProfilePreview, locale: Locale) {
  const draft = value.draft;
  return [t('identity.preview', { profile: draft.profile.id, version: draft.profile.version, scopes: draft.projectScopeIds.map(safe).join(', ') }, locale),
    t('identity.noAuthority', {}, locale), t('identity.unverified', {}, locale),
    t('identity.pins', { policy: safe(value.pins.policyRevision), bindings: safe(value.pins.bindingsRevision ?? '-'), registry: value.pins.registryVersion, digest: value.digest }, locale),
    t('identity.preserve', { bindings: value.unaffectedBindings }, locale),
    t('identity.bindingSummary', { added: draft.addedBindings.length, removed: draft.removedBindings.length, roles: draft.addedRoles.length }, locale),
    ...draft.currentSeparationOfDuties.map(rule => t('identity.preservedDuty', { id: safe(rule.id) }, locale)),
    ...(draft.futureProjects.requested ? [t('identity.future', {}, locale)] : []),
    ...draft.unresolvedRequirements.map(requirement => t('identity.requirement', { id: safe(requirement.id), version: requirement.version }, locale)),
    ...draft.unsupportedHierarchyNodeIds.map(id => t('identity.hierarchyUnresolved', { id: safe(id) }, locale)),
    // BeUser S-08: only what changes is listed (gain, loss); the unchanged cells are one count line (`--json` keeps every cell).
    ...(value.differences.some(cell => cell.change !== 'unchanged') ? value.differences.filter(cell => cell.change !== 'unchanged').map(cell => {
      const selection = (value: typeof cell.actions) => 'values' in value ? value.values.map(safe).join(', ') : value.except.length ? t('identity.allExcept', { values: value.except.map(safe).join(', ') }, locale) : t('identity.all', {}, locale);
      const status = cell.change === 'gain' ? t('identity.gain', {}, locale) : cell.change === 'loss' ? t('identity.loss', {}, locale) : t('identity.unchanged', {}, locale);
      return t('identity.difference', { status, member: safe(cell.memberId), scope: safe(cell.scopeId), kind: safe(cell.resourceKind), actions: selection(cell.actions),
        resources: selection(cell.resourceIds), before: decision(cell.before.decision, locale), after: decision(cell.after.decision, locale) }, locale);
    }) : [t('identity.noDifferences', {}, locale)]),
    ...(value.differences.some(cell => cell.change === 'unchanged') ? [t('identity.unchangedCount', { count: value.differences.filter(cell => cell.change === 'unchanged').length }, locale)] : []),
  ].join('\n');
}

function decision(value: 'allow' | 'deny' | 'require-approval', locale: Locale) {
  return value === 'allow' ? t('identity.allow', {}, locale) : value === 'deny' ? t('identity.deny', {}, locale) : t('identity.approval', {}, locale);
}
