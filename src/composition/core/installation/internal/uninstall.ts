import { userInfo } from 'node:os';
import { policySchema } from '#domain/index.js';
import { UninstallRecovery, attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, readLocalOsIdentity, readTerminalConfig, FileInstallationIdentityStore, openLocalIntegrityAuthority } from '#adapters/index.js';
import { UninstallApplication, authorizeUninstall, installationOwnScopes, type UninstallInteraction } from '#engine/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { configuredUninstallInventory } from './uninstall-inventory.js';
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
    async inventory() {
      const document = policySchema.parse(await source.load());
      return (await configuredUninstallInventory(config, document.revision, scopes(document), options)).inventory;
    },
    async retainedPlan(digest) {
      const identity = await new FileInstallationIdentityStore(layout, config.configFile.writeLockTimeoutMs, undefined, config.installation).read();
      if (identity.status !== 'available') throw ErrorRegistry.createError('INSTALLATION_IDENTITY_UNAVAILABLE');
      const principal = { ...readLocalOsIdentity(), scopeIds: scopes(await source.load()) };
      const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile);
      return new UninstallRecovery(layout.root, identity.value.installationId, principal, integrity, config.installation.profileMaxBytes).retained(digest);
    },
    async withAdmission(plan, _commandId, work) {
      const document = policySchema.parse(await source.load()), scopeIds = scopes(document);
      return withUninstallAdmission(config, plan, { ...readLocalOsIdentity(), scopeIds }, scopeId, scopeIds, options, work);
    },
  });
}
export async function previewConfiguredUninstall(root: string, purge: boolean, options: ConfigLoadOptions = {}) {
  return (await configuredUninstall(root, options)).preview(purge);
}
export async function applyConfiguredUninstall(root: string, input: unknown, interaction: UninstallInteraction, options: ConfigLoadOptions = {}, signal?: AbortSignal) {
  return (await configuredUninstall(root, options)).apply(input, interaction, signal);
}
