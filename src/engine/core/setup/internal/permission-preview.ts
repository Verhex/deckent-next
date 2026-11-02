import type { PermissionModeView } from '#domain/index.js';
import { ErrorRegistry, sha256 } from '#platform/index.js';
import { IdentityProfileRegistry, permissionDefaultsRegistry } from '#engine/core/identity-profile/index.js';
import { SetupStageRegistry } from './registry.js';
import { setupProfileRefSchema } from './contract.js';
import type { SetupPermissionPreview } from './permissions.js';
type Profile = Readonly<{ id: string; version: number }>;
/** Profile selection and preview are pure decisions; the host supplies verified reads. */
export function selectSetupPermissionProfile(selection: { profile: Profile; packages?: readonly unknown[] | undefined } | null, selected?: Profile) {
  const saved = selection?.profile ?? null;
  const defaultProfile = new SetupStageRegistry().unattendedProfile;
  const profiles = new IdentityProfileRegistry(selection?.packages ?? []).list().map(row => ({ id: row.definition.id, version: row.definition.version }))
    .sort((a, b) => Number(b.id === defaultProfile) - Number(a.id === defaultProfile));
  const candidate = selected ? setupProfileRefSchema.parse(selected) : saved ?? profiles.find(row => row.id === defaultProfile) ?? null;
  if (selected && (saved && JSON.stringify(saved) !== JSON.stringify(selected) || !profiles.some(row => row.id === selected.id && row.version === selected.version)))
    throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
  const defaults = permissionDefaultsRegistry.resolve(candidate);
  return { saved, candidate, profiles, defaults };
}
export function finishSetupPermissionPreview(selection: ReturnType<typeof selectSetupPermissionProfile>, view: PermissionModeView,
  grants: { status: string; revision: string | null }, preserveMode: boolean, bounded: boolean, modeRevision: string | null,
  layers: { project: unknown; global: unknown }, scopeId: string, principal: { issuer: string; subject: string }): SetupPermissionPreview {
  const { saved, candidate, defaults, profiles } = selection;
  const configDigest = sha256(JSON.stringify(layers));
  const effectiveMode = view.mode === 'full-auto' && !view.fullAuto || view.mode === 'full-access' && !view.fullAccess ? 'standart' : view.mode;
  const mode = preserveMode ? view.mode : defaults?.startMode ?? 'standart';
  const state: SetupPermissionPreview['state'] = !view.supported || bounded ? 'blocked' : !saved ? 'needs-profile' : !defaults ? 'not-applicable'
    : preserveMode || mode === 'standart' ? 'applied' : !['preview', 'current'].includes(grants.status) ? 'blocked' : 'needs-confirmation';
  const profileDigest = sha256(JSON.stringify({ saved, candidate, defaults }));
  const basis = { state, configDigest, profileDigest, revision: view.revision, modeRevision, currentMode: view.mode, effectiveMode, mode, preserveMode,
    scopeId, principal: `${principal.issuer}/${principal.subject}`, profile: candidate?.id ?? '-', selectedProfile: candidate, profiles };
  return { ...basis, reason: !defaults ? 'onboarding.permissions.profileWithoutDefaults' : !saved ? 'onboarding.permissions.profileMissing' : preserveMode ? 'onboarding.permissions.preserved' : 'onboarding.permissions.guided',
    grantRevision: grants.revision, digest: sha256(JSON.stringify({ ...basis, grants })) };
}
