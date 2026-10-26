import { createHubServiceHttpHandler, type HubServiceHttpOptions } from './service-http.js';
import { createMcpHandler, requireBearerAuth, type OAuthTokenVerifier, type AuthInfo } from '@modelcontextprotocol/server';
import { HUB_LIMITS } from '#domain/index.js';
import { HubClientError, HubModeratedApplication, hubActorSchema, type HubServerApplication, type HubServerContext, type HubServerPeer } from '#engine/index.js';
import { createHubSkillsServer } from './server.js';
import type { HubMcpOptions } from './methods.js';

export interface HubHttpAuth {
  readonly service?: Pick<HubServiceHttpOptions, 'addressId' | 'publicContext' | 'locale'>;
  readonly endpoint: string;
  readonly authorizationServers: readonly string[];
  readonly scopes: readonly string[];
  readonly verifier: OAuthTokenVerifier;
  /** Maps verified token claims to a scoped actor. Neither params nor clientId alone grants a publisher identity. */
  readonly context: (auth: AuthInfo) => HubServerContext;
  readonly allowedOrigins: readonly string[];
}
/** OAuth resource server only. The IdP owns OAuth/OIDC discovery, login, PKCE and key custody. */
export function createHubHttpHandler(app: HubServerApplication, auth: HubHttpAuth, options: HubMcpOptions) {
  const endpoint = new URL(auth.endpoint);
  const validUrl = (url: URL) => !url.username && !url.password && !url.hash && !url.search && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname));
  const validOrigin = (origin: string) => {
    try { const url = new URL(origin); return url.origin === origin && ['http:', 'https:'].includes(url.protocol); } catch { return false; }
  };
  if (auth.allowedOrigins.some(origin => !validOrigin(origin)) || !validUrl(endpoint) || !auth.authorizationServers.length || auth.authorizationServers.some(value => !validUrl(new URL(value)))
    || auth.scopes.some(scope => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) throw new HubClientError('HUB_SOURCE_INVALID');
  const metadata = new URL(`/.well-known/oauth-protected-resource${endpoint.pathname === '/' ? '' : endpoint.pathname}`, endpoint.origin);
  const gate = requireBearerAuth({ verifier: auth.verifier, expectedResource: endpoint, requiredScopes: [...auth.scopes], resourceMetadataUrl: metadata.href });
  const handler = createMcpHandler(({ authInfo }) => {
    if (!authInfo) throw new HubClientError('HUB_AUTHORITY_REFUSED');
    const ctx = auth.context(authInfo);
    if (ctx.scopeId !== app.ports.scopeId || !hubActorSchema.safeParse(ctx.principal).success) throw new HubClientError('HUB_AUTHORITY_REFUSED');
    return createHubSkillsServer(app, () => ctx, options);
  }, { legacy: 'reject' });
  const service = app instanceof HubModeratedApplication && auth.service ? createHubServiceHttpHandler(app, { endpoint: endpoint.origin + '/', ...auth.service }) : null;
  const serve = async (request: Request, peer?: HubServerPeer): Promise<Response> => {
      const url = new URL(request.url), origin = request.headers.get('origin');
      if (url.origin !== endpoint.origin || request.headers.has('host') && request.headers.get('host') !== endpoint.host
        || origin !== null && !auth.allowedOrigins.includes(origin) && !(service && url.pathname !== endpoint.pathname && origin === endpoint.origin)) return new Response(null, { status: 403 });
      if (url.search || url.hash) return new Response(null, { status: 400 });
      if (url.pathname === metadata.pathname && request.method === 'GET') return Response.json({ resource: endpoint.href, authorization_servers: [...auth.authorizationServers],
        scopes_supported: [...auth.scopes], bearer_methods_supported: ['header'] }, { headers: { 'cache-control': 'no-store' } });
      if (url.pathname !== endpoint.pathname) return service ? service.fetch(request, peer) : new Response(null, { status: 404 });
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
      const verified = await gate(request);
      if (verified instanceof Response) return verified;
      request.signal.throwIfAborted();
      // A bounded stream read also protects the fetch-shaped entry when no Node listener is used.
      const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) try {
        for (;;) {
          request.signal.throwIfAborted();
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > HUB_LIMITS.httpMaxBytes) { await reader.cancel(); return new Response(null, { status: 413 }); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      let parsedBody: unknown;
      try { parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return new Response(null, { status: 400 }); }
      try { return await handler.fetch(request, { authInfo: verified, parsedBody }); }
      catch { return new Response(null, { status: 403 }); }
  };
  return {
    async fetch(incoming: Request, peer?: HubServerPeer): Promise<Response> {
      const signal = AbortSignal.any([incoming.signal, AbortSignal.timeout(HUB_LIMITS.fetchTimeoutMs)]);
      const request = new Request(incoming, { signal });
      let abort!: () => void;
      try {
        return await Promise.race([serve(request, peer), new Promise<Response>(resolve => {
          abort = () => resolve(new Response(null, { status: 504 }));
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        })]);
      } finally { signal.removeEventListener('abort', abort); }
    },
    close: () => handler.close(),
  };
}
