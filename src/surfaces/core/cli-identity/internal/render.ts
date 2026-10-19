import type { IdentityProfileListing, IdentityProfilePreview } from '#engine/index.js';
import { MESSAGE_REGISTRY, t, type Locale } from '#platform/index.js';
// Catalog data chooses labels; extension labels are package data, never commands or authority.
const safe = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
type ProfileEntry = IdentityProfileListing['profiles'][number];
const catalog = (locale: Locale) => MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>;
/** A profile's name in the person's language (package labels first, then the catalog label, else its key). */
export const profileLabel = (entry: ProfileEntry, locale: Locale): string =>
  safe(entry.labels?.[locale] ?? catalog(locale)[entry.definition.labelKey] ?? entry.definition.labelKey);
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
  return [t('climodels.identity.profilesHeading', {}, locale), ...value.profiles.map(entry => `  ${profileLabel(entry, locale)} · ${profileMeaning(entry, locale)}`)].join('\n');
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
    ...(value.differences.length ? value.differences.map(cell => {
      const selection = (value: typeof cell.actions) => 'values' in value ? value.values.map(safe).join(', ') : value.except.length ? t('identity.allExcept', { values: value.except.map(safe).join(', ') }, locale) : t('identity.all', {}, locale);
      const status = cell.change === 'gain' ? t('identity.gain', {}, locale) : cell.change === 'loss' ? t('identity.loss', {}, locale) : t('identity.unchanged', {}, locale);
      return t('identity.difference', { status, member: safe(cell.memberId), scope: safe(cell.scopeId), kind: safe(cell.resourceKind), actions: selection(cell.actions),
        resources: selection(cell.resourceIds), before: decision(cell.before.decision, locale), after: decision(cell.after.decision, locale) }, locale);
    }) : [t('identity.noDifferences', {}, locale)]),
  ].join('\n');
}

function decision(value: 'allow' | 'deny' | 'require-approval', locale: Locale) {
  return value === 'allow' ? t('identity.allow', {}, locale) : value === 'deny' ? t('identity.deny', {}, locale) : t('identity.approval', {}, locale);
}
