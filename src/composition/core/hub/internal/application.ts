import { HubClientApplication, type HubClientDependencies } from '#engine/index.js';
import { openSqliteHubClientStore } from '#adapters/index.js';
import { HubArtifactCache } from '#adapters/index.js';
import { openLocalIntegrityAuthority } from '#adapters/index.js';
import { inspectProductDirectory, prepareProductDirectory } from '#platform/index.js';
import { catalogDependencies, type ScopeContext } from '#composition/core/agent-catalog/index.js';
/** H7 supplies the common card/policy authorization and H8 supplies optional signed trust evidence. No network or default source is composed. */
export function configuredHubClient(context: ScopeContext, ports: Pick<HubClientDependencies, 'authorize' | 'resolveTrust' | 'fetchRevocations'>): HubClientApplication {
  let cache: Promise<HubArtifactCache> | undefined;
  const artifacts = (write: boolean) => cache ??= (write ? prepareProductDirectory : inspectProductDirectory)(context.layout, 'artifacts')
    .then(root => new HubArtifactCache(HubArtifactCache.path(root), context.config.artifacts.maxBytes))
    .catch(error => { cache = undefined; throw error; });
  return new HubClientApplication({ catalog: catalogDependencies(context), ...ports,
    artifacts: { put: async (scopeId, bytes) => (await artifacts(true)).put(scopeId, bytes), read: async (scopeId, receipt) => (await artifacts(false)).read(scopeId, receipt) },
    openStore: async access => {
      const store = openSqliteHubClientStore(await context.path(), context.config.storage.sqlite,
        await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, access === 'write'), access);
      if (access === 'write') {
        const atomic = store.atomic.bind(store);
        store.atomic = async work => (await artifacts(true)).withRetention(() => store.retainedArtifacts(), () => atomic(work));
      }
      return store;
    } });
}
