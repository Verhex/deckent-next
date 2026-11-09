import { authorizeConfigWrite, type ConfigAuthorityPort } from '#engine/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
interface ConfigAuthorityContext {
  readonly principal: VerifiedPrincipal; readonly document: unknown;
}
export function createConfigFileAuthority(loadContext: (scopeId: string) => Promise<ConfigAuthorityContext>): Pick<ConfigAuthorityPort, 'authorize'> {
  return {
    async authorize(input) { const context = await loadContext(input.scopeId); return authorizeConfigWrite(context.document, context.principal, input); },
  };
}
