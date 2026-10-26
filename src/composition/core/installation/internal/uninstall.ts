import { userInfo } from 'node:os';
import { policySchema } from '#domain/index.js';
import { UninstallRecovery, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, readLocalOsIdentity, readTerminalConfig, FileInstallationIdentityStore, openLocalIntegrityAuthority } from '#adapters/index.js';
import { UninstallApplication, uninstallApplySchema, authorizeUninstall, installationOwnScopes, type UninstallInteraction } from '#engine/index.js';
import { ErrorRegistry, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { uninstallRecoveryDirectory, readUninstallTombstone, completedUninstallPreview } from '#adapters/index.js';
import { observeUninstallInventory as configuredUninstallInventory } from '#adapters/index.js';
import { withUninstallAdmission } from './uninstall-admission.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

/** Trusted local composition: read-only previews and witnessed application admission use the same owned inventory. */
async function configuredUninstall(root: string, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, { ...options, heal: false, secretResolver: async () => undefined, uninstallHold: 'admit' });
  const layout = config.productLayout, scopeId = readTerminalConfig(config as Record<string, unknown>).scopeId;
  if (!scopeId) throw ErrorRegistry.createError('CLI_SCOPE_REQUIRED');
  const source = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);

  const scopes = (document: unknown) => installationOwnScopes(document, [scopeId,
    ...(config.service.identity ? [config.service.identity.scopeId] : []), ...(config.cancellationRuntime?.scopeIds ?? []), ...(config.reconciliationRuntime?.scopeIds ?? [])]);
  return new UninstallApplication({
    channel: localPrincipalChannel(), witness: { attest: () => { const peer = localPrincipalPeer(); return attestLocalInteractiveTerminal(peer?.pid, peer?.uid); } },
    async principal() {
      const document = policySchema.parse(await source.load()), identity = readLocalOsIdentity();
      // Like BackupApplication, this installation-wide operation uses explicit all-scopes policy, not project-record admission.
      // No ledger open (even read-only SQLite may create WAL/SHM), so preview cannot create sidecars.
      return { ...identity, scopeIds: scopes(document) };
    },
    async authorize(action, principal) {
      const document = policySchema.parse(await source.load());
      const identity = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
      if (identity.status !== 'available') throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
      authorizeUninstall(document, principal, identity.value.installationId, scopes(document), action);
    },
    async inventory(purge) {
      const document = policySchema.parse(await source.load());
      return (await configuredUninstallInventory(config, document.revision, scopes(document), options, purge)).inventory;
    },
    async retainedPlan(digest) {
      const identity = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
      if (identity.status !== 'available') throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
      const principal = { ...readLocalOsIdentity(), scopeIds: scopes(await source.load()) };
      const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile);
      return new UninstallRecovery(layout.root, identity.value.installationId, principal, integrity, config.installation.profileMaxBytes, uninstallRecoveryDirectory(layout.root)).retained(digest);
    },
    async withAdmission(plan, _commandId, work) {
      const document = policySchema.parse(await source.load()), scopeIds = scopes(document);
      return withUninstallAdmission(config, plan, { ...readLocalOsIdentity(), scopeIds }, scopeId, scopeIds, options, work);
    },
  });
}
async function completed(root: string, options: ConfigLoadOptions) {
  const config = await loadComposedConfig(root, { ...options, heal: false, secretResolver: async () => undefined, uninstallHold: 'admit' });
  return readUninstallTombstone(config.productLayout.root, { ...readLocalOsIdentity(), scopeIds: [] }, config.installation.profileMaxBytes, productResourcePath(config.productLayout, 'installationIdentity'));
}
export async function previewConfiguredUninstall(root: string, purge: boolean, options: ConfigLoadOptions = {}) {
  const previous = await completed(root, options); if (previous) return completedUninstallPreview(previous.plan);
  return (await configuredUninstall(root, options)).preview(purge);
}
export async function applyConfiguredUninstall(root: string, input: unknown, interaction: UninstallInteraction, options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  const previous = await completed(root, options);
  if (previous) {
    const peer = localPrincipalPeer();
    if (localPrincipalChannel() || !await attestLocalInteractiveTerminal(peer?.pid, peer?.uid)) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'uninstall' } });
    const plan = completedUninstallPreview(previous.plan);
    const command = uninstallApplySchema.safeParse(input); if (!command.success) throw ErrorRegistry.createError('UNINSTALL_INVALID');
    if (command.data.planDigest !== plan.planDigest) throw ErrorRegistry.createError('UNINSTALL_PLAN_CHANGED');
    return { ...previous.result, status: 'noop' as const, planDigest: plan.planDigest };
  }
  return (await configuredUninstall(root, options)).apply(input, interaction, signal);
}
