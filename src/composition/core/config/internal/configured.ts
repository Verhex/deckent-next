import { ConfigApplication } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import { registerProviderConfig, createConfigFileDocuments, createConfigFileAuthority } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
export async function resolveConfiguredConfigPrincipal(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}): Promise<VerifiedPrincipal> {
  return (await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write')).principal;
}
export function createConfiguredConfigApplication(projectRoot: string, options: ConfigLoadOptions = {}) {
  registerProviderConfig();
  return new ConfigApplication(createConfigFileDocuments(projectRoot, options), createConfigFileAuthority(
    scopeId => loadConfiguredScopeContext(projectRoot, scopeId, { ...options, force: true, heal: false }, 'write')));
}
