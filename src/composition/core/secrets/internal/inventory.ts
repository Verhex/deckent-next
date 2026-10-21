import { modelInvocationProfileSchema } from '#domain/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { installationSecretRoot, listProjectVaults, openConfiguredSecretStore, openProjectVaultStore, openSecretGrantStore } from '#adapters/index.js';
import { authorizeSecretInventoryAll, buildSecretInventory, type SecretInventory, type SecretInventoryProject } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { openProjectSecrets } from './project.js';

export interface SecretInventoryView extends SecretInventory {
  readonly schemaVersion: 1; readonly project: string | null; readonly mainStore: string; readonly all: boolean;
}
const credentialRef = (definition: Record<string, unknown>) => {
  const authentication = (definition['authentication'] ?? (definition['transport'] as Record<string, unknown> | undefined)?.['authentication']) as { type?: string; credentialRef?: string } | undefined;
  return authentication && authentication.type !== 'none' ? authentication.credentialRef ?? null : null;
};

/**
 * PRE-8 v2 §1.6: the one inventory of `secret list`, `secret list --all` and the terminal provider panel — which name is in which vault, who
 * uses it, what `.deck` says, whether the main key is granted here, whether it is stored. Names and metadata only: no `get`, no helper run.
 * `--all` (every project vault of this main vault) is the main vault's administration: the existing `secret`/`switch` cell.
 */
export async function inspectConfiguredSecretInventory(projectRoot: string, scopeId: string, all: boolean, options: ConfigLoadOptions = {}): Promise<SecretInventoryView> {
  const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'read'), env = options.env ?? process.env, platform = options.platform ?? process.platform;
  if (all) authorizeSecretInventoryAll(context.document, context.principal, scopeId);
  const main = openConfiguredSecretStore(context.config, env, platform);
  const mainNames = main.descriptor.enumerable ? await main.listNames().catch(() => null) : null;
  const profiles = ((context.config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
  const references = profiles.flatMap(profile => { const name = credentialRef(profile.adapter.definition); return name ? [{ name, usedBy: `${profile.id}@${profile.version}` }] : []; });
  const opened = await openProjectSecrets(context, options);
  const current: SecretInventoryProject[] = opened ? [{ project: opened.anchor.projectRoot, names: opened.store ? await opened.store.listNames().catch(() => null) : [],
    grants: opened.grants, deck: opened.deck, current: true }] : [];
  const others: SecretInventoryProject[] = [], root = installationSecretRoot(env, platform);
  if (all && root) for (const vault of await listProjectVaults(root)) {
    if (!vault.record || (opened && vault.directory === opened.directory)) continue;
    const anchor = vault.record.anchor, store = openProjectVaultStore(vault.directory, anchor, env, platform);
    others.push({ project: anchor.projectRoot, names: await store.listNames().catch(() => null), deck: null, current: false,
      grants: await openSecretGrantStore(root, anchor, context.config.configFile.writeLockTimeoutMs).read().catch(() => null) });
  }
  const inventory = buildSecretInventory({ mainNames, references, projects: [...current, ...others] });
  return Object.freeze({ schemaVersion: 1, project: opened?.anchor.projectRoot ?? null, mainStore: main.descriptor.id, all, ...inventory });
}
