import { OAuthConnectionError, type OAuthConnectionPorts, type OAuthTokenSet } from '#engine/index.js';
import { SIWC_PROTOCOL as P, SIWC_LIMITS as L, SIWC_DISCOVERY_ENDPOINT, SIWC_TERMINAL_REFRESH_ERRORS } from './registry.js';
import { verifySiwcIdentity } from './identity.js';
const MILLISECONDS_PER_SECOND = 1000;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export class SiwcOAuthTransportError extends OAuthConnectionError {
  constructor(readonly httpStatus: number, readonly providerCode: string | null, readonly requestId: string | null) { super('OAUTH_CONNECTION_UNAVAILABLE'); }
}
/** The error code is allowlisted; response text/query URLs and arbitrary provider strings never enter an error. */
const codeOf = (body: unknown) => {
  const value = object(body) ? typeof body['error'] === 'string' ? body['error'] : object(body['error']) ? body['error']['code'] : null : null;
  return typeof value === 'string' && [...SIWC_TERMINAL_REFRESH_ERRORS, 'invalid_client', 'access_denied'].includes(value) ? value : null;
};
export function createSiwcOAuthTransport(options: { fetch?: typeof fetch; now?: () => number } = {}):
  Pick<OAuthConnectionPorts, 'exchange' | 'verifyIdentity' | 'revoke' | 'unusableRefresh'> {
  const send = options.fetch ?? fetch, now = options.now ?? Date.now;
  const trusted = (url: string) => {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.origin !== P.issuer || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
    return endpoint.href;
  };
  const request = async (url: string, signal: AbortSignal, form?: URLSearchParams, empty = false): Promise<unknown> => {
    const controller = new AbortController(), bounded = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), L.httpTimeoutMs); timer.unref();
    try {
      if (bounded.aborted) throw new OAuthConnectionError('OAUTH_CONNECTION_CANCELLED');
      const response = await send(trusted(url), { method: form ? 'POST' : 'GET', redirect: 'error', signal: bounded,
        headers: { accept: 'application/json', ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(form ? { body: form } : {}) });
      const reader = response.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      if (reader) try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
          if (bytes > L.responseMaxBytes || bounded.aborted) throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE'); chunks.push(chunk.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8'); let body: unknown = null;
      if (text) try { body = JSON.parse(text); } catch { throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID'); }
      if (!response.ok) {
        const id = response.headers.get('x-request-id') ?? response.headers.get('openai-request-id');
        const echoed = form && ['code', 'code_verifier', 'refresh_token', 'token'].some(key => { const value = form.get(key); return value && id?.includes(value); });
        throw new SiwcOAuthTransportError(response.status, codeOf(body), !echoed && id && /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : null);
      }
      if (response.status !== 200 || (empty && text.length !== 0)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      return body;
    } catch (error) {
      if (error instanceof OAuthConnectionError) throw error;
      throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  };
  const discovery = async (signal: AbortSignal) => {
    const value = await request(SIWC_DISCOVERY_ENDPOINT, signal);
    if (!object(value) || value['issuer'] !== P.issuer || value['authorization_endpoint'] !== P.authorizationEndpoint
      || value['token_endpoint'] !== P.tokenEndpoint || typeof value['jwks_uri'] !== 'string' || typeof value['revocation_endpoint'] !== 'string')
      throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
    return { jwks: trusted(value['jwks_uri']), revoke: trusted(value['revocation_endpoint']) };
  };
  return Object.freeze({
    async exchange(form: URLSearchParams, signal: AbortSignal): Promise<OAuthTokenSet> {
      const body = await request(P.tokenEndpoint, signal, form);
      if (!object(body) || typeof body['scope'] !== 'string'
        || (body['refresh_token'] !== undefined && typeof body['refresh_token'] !== 'string')
        || (body['id_token'] !== undefined && typeof body['id_token'] !== 'string')) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      const access = body['access_token'], scopes = body['scope'].split(/\s+/u).filter(Boolean);
      if (access !== undefined && (typeof access !== 'string' || !access || body['token_type'] !== 'Bearer'
        || !Number.isSafeInteger(body['expires_in']) || (body['expires_in'] as number) <= 0)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      if (access === undefined && (typeof body['id_token'] !== 'string' || !body['id_token'] || scopes.includes(P.usagePermission)
        || scopes.includes('offline_access'))) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      const earliest = body['earliest_refresh_at'];
      const earliestMs = earliest === undefined ? null : typeof earliest === 'number' ? earliest * MILLISECONDS_PER_SECOND : typeof earliest === 'string' ? Date.parse(earliest) : NaN;
      if (earliestMs !== null && (!Number.isSafeInteger(earliestMs) || earliestMs < 0)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      return Object.freeze({ accessToken: access as string ?? null, refreshToken: body['refresh_token'] as string ?? null,
        idToken: body['id_token'] as string ?? null, scopes,
        expiresAtMs: access === undefined ? null : now() + (body['expires_in'] as number) * MILLISECONDS_PER_SECOND, earliestRefreshAtMs: earliestMs });
    },
    async verifyIdentity(token: string, clientId: string, nonce: string | null, signal: AbortSignal) {
      const endpoints = await discovery(signal);
      return verifySiwcIdentity(token, clientId, nonce, await request(endpoints.jwks, signal), now());
    },
    async revoke(clientId: string, refreshToken: string, signal: AbortSignal) {
      const endpoints = await discovery(signal);
      await request(endpoints.revoke, signal, new URLSearchParams({ client_id: clientId, token: refreshToken, token_type_hint: 'refresh_token' }), true);
      return true;
    },
    unusableRefresh: (error: unknown) => error instanceof SiwcOAuthTransportError && error.httpStatus >= 400 && error.httpStatus < 500
      && error.providerCode !== null && SIWC_TERMINAL_REFRESH_ERRORS.includes(error.providerCode),
  });
}
