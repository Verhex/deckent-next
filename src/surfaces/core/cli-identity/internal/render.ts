import type { IdentityProfileListing, IdentityProfilePreview } from '#engine/index.js';
import { MESSAGE_REGISTRY, t, type Locale } from '#platform/index.js';
// Catalog data chooses labels; extension labels are package data, never commands or authority.
const safe = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
export function renderIdentityProfiles(value: IdentityProfileListing, locale: Locale) {
  return [t('identity.list', { version: value.registryVersion, digest: value.registryDigest }, locale),
    ...value.profiles.map(entry => t('identity.profileLine', { id: entry.definition.id, version: entry.definition.version,
      label: safe(entry.labels?.[locale] ?? MESSAGE_REGISTRY.catalogs[locale][entry.definition.labelKey] ?? entry.definition.labelKey), digest: entry.digest }, locale))].join('\n');
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
