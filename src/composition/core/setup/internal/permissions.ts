import { randomUUID } from 'node:crypto';
import { selectSetupPermissionProfile, finishSetupPermissionPreview, inspectPermissionMode, PermissionModeApplication, AuditApplication,
  AUDIT_PAGE_MAX, assertAuthorityWitness, type AuthorityWitness, type SetupPermissionPreview } from '#engine/index.js';
import { readIdentityProfileConfig, localPrincipalChannel, attestLocalInteractiveTerminal, openSqliteAuditStore, openReadOnlyAuditStore, openLocalIntegrityAuthority } from '#adapters/index.js';
import { ErrorRegistry, sha256, SystemTrustedClock, withConfigLayersLocked, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { openOwnPermissionMode, openPermissionModesInstallation } from '#composition/core/installation/index.js';
import { createConfiguredConfigApplication, snapshotConfiguredConfig } from '#composition/core/config/index.js';

/** Read-back, never a UI done flag. Missing profile is distinct from a selected package without permission defaults. */
export async function observeSetupPermissions(root: string, scopeId: string, options: ConfigLoadOptions,
  selected?: Readonly<{ id: string; version: number }>): Promise<SetupPermissionPreview> {
  const before = await snapshotConfiguredConfig(root, options);
  const context = await loadConfiguredScopeContext(root, scopeId, { ...options, force: true, heal: false }, 'read');
  const selection = selectSetupPermissionProfile(readIdentityProfileConfig(context.config['identity']), selected);
  const view = inspectPermissionMode(context.document, context.principal, { schemaVersion: 1, scopeId });
  const grants = await openPermissionModesInstallation(root, scopeId, { modes: [], apply: false,
    person: { issuer: context.principal.issuer, subject: context.principal.subject } }, options);
  if (context.document.schemaVersion === 2 && context.document.policyRevision !== grants.revision) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
  const modeRevision = context.document.schemaVersion === 2 ? context.document.bindings.revision : null;
  // Even an explicit no-op choice of standart has a sealed receipt, though it writes no bindings entry. Read one bounded page;
  // if the page cannot establish absence, fail closed rather than overwrite an older person's choice.
  const store = await openReadOnlyAuditStore(await context.path(), context.config.storage.sqlite);
  let preserveMode = view.mode !== 'standart' || view.askEdits, bounded: boolean;
  try {
    // A fresh journal can have no audit key yet. An empty read needs none; any existing row still requires its verified seal.
    const present = store.pageOfKind?.(scopeId, 'permission-mode-change', 0, AUDIT_PAGE_MAX);
    if (!present) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
    const freshJournal = present.length === 0 && store.page(scopeId, 0, 1).length === 0;
    const choices = freshJournal ? [] : new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile))
      .listKind(scopeId, 'permission-mode-change', 0, AUDIT_PAGE_MAX);
    preserveMode ||= choices.some(row => row.event.principal.issuer === context.principal.issuer && row.event.principal.subject === context.principal.subject
      && row.event.subject.kind === 'permission-mode-change' && row.event.subject.decision.effect === 'allow'
      && (row.event.subject.requested === 'standart' || row.event.subject.bindingsRevision.after === modeRevision || row.event.subject.bindingsRevision.after === null
        && row.event.subject.bindingsRevision.before === modeRevision));
    bounded = !preserveMode && choices.length === AUDIT_PAGE_MAX;
  } finally { store.close(); }
  const after = await snapshotConfiguredConfig(root, options);
  if (before.digest !== after.digest || JSON.stringify(before.global) !== JSON.stringify(after.global)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
  return finishSetupPermissionPreview(selection, view, grants, preserveMode, bounded, modeRevision, { project: after.project, global: after.global }, scopeId, context.principal);
}

/** U5 sole carrier: witnessed config profile → PRE-9 grant → fresh observation → mode entry. Each owner keeps its CAS and audit. */
export async function applySetupPermissions(root: string, scopeId: string, digest: string, options: ConfigLoadOptions,
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }, selected?: Readonly<{ id: string; version: number }>) {
  await assertAuthorityWitness('policyPermissionModes', localPrincipalChannel(), witness);
  let preview = await observeSetupPermissions(root, scopeId, options, selected);
  if (preview.digest !== digest || preview.state === 'blocked') throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
  if (preview.state === 'needs-profile') {
    if (!preview.selectedProfile) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
    const context = await loadConfiguredScopeContext(root, scopeId, options, 'write');
    const global = await snapshotConfiguredConfig(root, options, 'global');
    await createConfiguredConfigApplication(root, options, current => {
      if (sha256(JSON.stringify({ project: current.project, global: current.global })) !== preview.configDigest)
        throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    }, witness).set({ keyPath: 'identity.profile', value: preview.selectedProfile, layer: 'global', principal: context.principal, scopeId,
      commandId: randomUUID(), expect: global.digest });
    const fresh = await observeSetupPermissions(root, scopeId, options);
    if (fresh.selectedProfile?.id !== preview.selectedProfile.id || fresh.selectedProfile.version !== preview.selectedProfile.version
      || fresh.revision !== preview.revision || fresh.grantRevision !== preview.grantRevision) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
    preview = fresh;
  }
  if (preview.state === 'blocked') throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
  if (preview.state === 'applied' || preview.state === 'not-applicable' || preview.mode === 'standart') return;
  if (preview.state !== 'needs-confirmation') throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
  const mode = preview.mode;
  return withConfigLayersLocked(root, options, async () => {
    if ((await observeSetupPermissions(root, scopeId, options)).digest !== preview.digest) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
    let openedRevision: string | null = null;
    if (!preview.grantRevision) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
    const opened = await openOwnPermissionMode(root, { scopeId, mode, expect: preview.grantRevision, onOpened: receipt => { openedRevision = receipt.revision; }, confirm: async grant => grant.revision === preview.grantRevision }, options, undefined, witness);
    if (!opened) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
    const fresh = await observeSetupPermissions(root, scopeId, options);
    if (fresh.grantRevision !== openedRevision || fresh.profileDigest !== preview.profileDigest || fresh.configDigest !== preview.configDigest || fresh.modeRevision !== preview.modeRevision || fresh.state !== 'needs-confirmation') throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
    const context = await loadConfiguredScopeContext(root, scopeId, options, 'write');
    const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
    try {
      await assertAuthorityWitness('policyPermissionModes', localPrincipalChannel(), witness);
      const audit = new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true));
      await new PermissionModeApplication(contextPolicySource(context),
        event => { audit.record(event); }, () => new SystemTrustedClock().sample().wallMs).set(context.principal,
        { schemaVersion: 1, scopeId, mode, expectedRevision: fresh.revision });
    } finally { store.close(); }
  });
}
