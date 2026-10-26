import { HUB_LIMITS, type HubPackage } from '#domain/index.js';
import { HubServerError, type HubServerTransaction } from './ports.js';

/** Exact local closure only. Per-path cycle/depth checks are not bypassed by a shared dependency's shallower first visit. */
export async function requireHubDependencies(store: Pick<HubServerTransaction, 'get'>, hubId: string, root: HubPackage): Promise<void> {
  const visited = new Set<string>(), checkedDepth = new Map<string, number>();
  const walk = async (manifest: HubPackage, path: readonly string[]) => {
    for (const dependency of manifest.dependencies) {
      const id = `${dependency.packageId}@${dependency.version}`;
      if (dependency.hubId && dependency.hubId !== hubId || path.includes(id) || path.length > HUB_LIMITS.dependencyDepthMax)
        throw new HubServerError('HUB_DEPENDENCY_INVALID');
      visited.add(id);
      if (visited.size > HUB_LIMITS.dependenciesMax) throw new HubServerError('HUB_DEPENDENCY_INVALID');
      const found = await store.get(dependency.packageId, dependency.version);
      if (!found || found.envelope.payloadDigest !== dependency.manifestDigest) throw new HubServerError('HUB_DEPENDENCY_INVALID');
      if ((checkedDepth.get(id) ?? -1) < path.length) {
        await walk(found.manifest, [...path, id]);
        checkedDepth.set(id, path.length);
      }
    }
  };
  await walk(root, [`${root.packageId}@${root.version}`]);
}
export function newerHubVersion(next: string, previous: string): boolean {
  const a = next.split('.').map(BigInt), b = previous.split('.').map(BigInt);
  for (let index = 0; index < a.length; index++) {
    if (a[index]! > b[index]!) return true;
    if (a[index]! < b[index]!) return false;
  }
  return false;
}
