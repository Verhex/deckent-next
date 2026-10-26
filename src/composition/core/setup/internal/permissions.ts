import { userInfo } from 'node:os';
import { permissionDefaultsRegistry, inspectPermissionMode, PermissionModeApplication, AuditApplication, assertAuthorityWitness, type AuthorityWitness } from '#engine/index.js';
import { readIdentityProfileConfig, localPrincipalChannel, attestLocalInteractiveTerminal, openSqliteAuditStore, openLocalIntegrityAuthority } from '#adapters/index.js';
import { ErrorRegistry, sha256, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { openOwnPermissionMode, openPermissionModesInstallation } from '#composition/core/installation/index.js';

/** Read-back, not a UI completion flag. A partially opened grant resumes at the mode-entry owner. */
export async function observeOnboardingPermissions(root: string, scopeId: string, options: ConfigLoadOptions) {
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'read');
  const profile = readIdentityProfileConfig(context.config['identity'])?.profile ?? null;
  const defaults = permissionDefaultsRegistry.resolve(profile);
  const mode = inspectPermissionMode(context.document, context.principal, { schemaVersion: 1, scopeId });
  const grants = await openPermissionModesInstallation(root, scopeId, { modes: [], apply: false,
    person: { issuer: context.principal.issuer, subject: context.principal.subject } }, options);
  const needed = defaults && defaults.startMode !== 'standart' && mode.mode === 'standart';
  const basis = { profile, defaults, revision: context.document.revision, grants, mode: mode.mode };
  return { state: needed ? 'needed' as const : 'applied' as const, reason: 'onboarding.permissions.guided',
    digest: sha256(JSON.stringify(basis)), profileDigest: sha256(JSON.stringify({ profile, defaults })), grantRevision: grants.revision,
    principal: `${context.principal.issuer}/${context.principal.subject}`, mode: defaults?.startMode ?? 'standart', profile: profile?.id ?? '-', revision: context.document.revision };
}

/** U5 owners: PRE-9 grant first, PermissionModeApplication entry second; both keep their own audit/CAS. */
export async function applyOnboardingPermissions(root: string, scopeId: string, digest: string, options: ConfigLoadOptions,
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }) {
  await assertAuthorityWitness('policyPermissionModes', localPrincipalChannel(), witness);
  const preview = await observeOnboardingPermissions(root, scopeId, options);
  if (preview.digest !== digest) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
  if (preview.state === 'applied' || preview.mode === 'standart') return;
  const opened = await openOwnPermissionMode(root, { scopeId, mode: preview.mode, confirm: async grant => grant.revision === preview.grantRevision }, options, undefined, witness);
  if (!opened) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'write');
  // Opening a grant must not silently accept a concurrently changed profile or mode.
  const fresh = await observeOnboardingPermissions(root, scopeId, options);
  if (fresh.profileDigest !== preview.profileDigest || fresh.state !== 'needed') throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
  const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
  try {
    await assertAuthorityWitness('policyPermissionModes', localPrincipalChannel(), witness);
    const audit = new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true));
    await new PermissionModeApplication(createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes),
      event => { audit.record(event); }, () => new SystemTrustedClock().sample().wallMs).set(context.principal,
      { schemaVersion: 1, scopeId, mode: preview.mode, expectedRevision: fresh.revision });
  } finally { store.close(); }
}
