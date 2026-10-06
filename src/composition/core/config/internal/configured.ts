import { ConfigApplication, type ConfigDocumentPort, type ConfigSnapshot } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { registerProviderConfig, createConfigFileDocuments, createConfigFileAuthority } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
export async function resolveConfiguredConfigPrincipal(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<VerifiedPrincipal> {
  return (await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write')).principal;
}
/** `guard` runs on the snapshot taken under the layer's write lock, immediately before the change is planned: it may refuse the write (throw) when
 * something outside the written layer changed what the write was derived from. */
/** Layer documents and the layer digest from one read per file (the value and its digest always come from the same bytes). */
export function snapshotConfiguredConfig(projectRoot: string, options: ConfigLoadOptions = {}, layer: 'project' | 'global' = 'project') {
  registerProviderConfig(); return createConfigFileDocuments(projectRoot, options).snapshot(layer);
}
export function createConfiguredConfigApplication(projectRoot: string, options: ConfigLoadOptions = {}, guard?: (snapshot: ConfigSnapshot) => void) {
  registerProviderConfig();
  const documents = createConfigFileDocuments(projectRoot, options);
  const guarded: ConfigDocumentPort = guard ? { snapshot: layer => documents.snapshot(layer), publish: (input, planner) => documents.publish(input, async snapshot => { guard(snapshot); return planner(snapshot); }) } : documents;
  return new ConfigApplication(guarded, createConfigFileAuthority(
    scopeId => loadConfiguredScopeContext(projectRoot, scopeId, { ...options, force: true, heal: false }, 'write')));
}
