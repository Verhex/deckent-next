import { admitProjectVault, installationSecretRoot, openSecretGrantStore, projectVaultDirectory, readLocalOsIdentity } from '#adapters/index.js';
import { resolveProjectVaultAnchor } from '#composition/core/secrets/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';

/**
 * PRE-8 v2 test fixture: lend main-vault keys to a fixture project as an admin already did (the grant record beside the project vault), so a
 * positive-path test exercises the send it was written for. The governed grant itself (witness, policy cell, sealed decision) is proven in
 * secret-project-grant tests; this writes only the record, with a fixture decision id. Never a value.
 */
export async function grantFixtureSecrets(projectRoot: string, scopeId: string, names: readonly string[], options: ConfigLoadOptions = {}) {
  const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'), anchor = await resolveProjectVaultAnchor(context, options);
  const root = installationSecretRoot(options.env ?? process.env, options.platform);
  if (!anchor || !root) throw new Error('FIXTURE_PROJECT_IDENTITY');
  const directory = await projectVaultDirectory(root, anchor, true);
  await admitProjectVault(directory!, anchor, true, 1, 2_000);
  const { issuer, subject } = readLocalOsIdentity();
  await openSecretGrantStore(root, anchor, 2_000).update(current => [...current.grants.filter(grant => !names.includes(grant.name)),
    ...names.map(name => ({ name, scopeId, by: { issuer, subject }, atMs: 1, source: 'admin' as const, decisionEventId: `fixture:${name}` }))]);
}
