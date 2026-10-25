import { HubClientApplication, type HubClientDependencies } from '#engine/index.js';
import { openSqliteHubClientStore } from '#adapters/index.js';
import { FileArtifactStore } from '#adapters/index.js';
import { openLocalIntegrityAuthority } from '#adapters/index.js';
import { inspectProductDirectory, prepareProductDirectory } from '#platform/index.js';
import { catalogDependencies, type ScopeContext } from '#composition/core/agent-catalog/index.js';
/** H7 supplies the common card/policy authorization and H8 supplies optional signed trust evidence. No network or default source is composed. */
export function configuredHubClient(context: ScopeContext, ports: Pick<HubClientDependencies, 'authorize' | 'resolveTrust'>): HubClientApplication {
  const artifacts = async (write: boolean) => new FileArtifactStore({ root: await (write ? prepareProductDirectory : inspectProductDirectory)(context.layout, 'artifacts'), maxBytes: context.config.artifacts.maxBytes });
  return new HubClientApplication({ catalog: catalogDependencies(context), ...ports,
    artifacts: { put: async (scopeId, bytes) => (await artifacts(true)).put(scopeId, bytes), read: async (scopeId, receipt) => (await artifacts(false)).read(scopeId, receipt) },
    openStore: async access => openSqliteHubClientStore(await context.path(), context.config.storage.sqlite,
      await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, access === 'write'), access) });
}
