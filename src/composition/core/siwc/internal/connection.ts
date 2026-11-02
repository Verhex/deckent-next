import type { VerifiedPrincipal } from '#domain/index.js';
import type { OAuthConnectionOwner, OAuthConnectionView, OAuthConnectionApplication } from '#engine/index.js';
import { withSiwcConnection } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
export type SiwcBrowserPresentation = Readonly<{ fallback?: (url: string) => void; signal?: AbortSignal }>;
export const withConfiguredSiwc = <T>(root: string, scopeId: string, options: ConfigLoadOptions, operation: 'connect' | 'logout' | 'lease' | 'inspect',
  work: (app: OAuthConnectionApplication, caller: OAuthConnectionOwner) => Promise<T>, presentation: SiwcBrowserPresentation = {}, actor?: VerifiedPrincipal) =>
  withSiwcConnection(scopeId, options, operation, work, { context: access => loadConfiguredScopeContext(root, scopeId, options, access),
    audit: (context, callback) => withScopeAudit(context, callback, false) }, presentation, actor);
/** The rich local terminal alone receives the optional account label. All JSON/MCP views omit the field entirely. */
export function siwcConnectionView(view: OAuthConnectionView, surface: 'terminal' | 'json' | 'mcp') {
  const { email, ...safe } = view;
  return surface === 'terminal' ? Object.freeze({ ...safe, email }) : Object.freeze(safe);
}
