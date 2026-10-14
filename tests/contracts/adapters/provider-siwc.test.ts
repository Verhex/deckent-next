import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSiwcOAuthTransport, SIWC_PROTOCOL, SIWC_LIMITS, SiwcOAuthTransportError, verifySiwcIdentity, siwcBrowserAuthorization } from '#adapters/index.js';
import { OAuthConnectionError } from '#engine/index.js';

const TIME = 1_800_000_000_000, CLIENT = 'oaiapp_fixture', NONCE = 'nonce-fixture', TOKEN = 'fixture-token-canary';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = pair.publicKey.export({ format: 'jwk' });
const jwks = { keys: [{ ...publicJwk, kid: 'fixture-key', alg: 'RS256', use: 'sig' }] };
const claims = { iss: SIWC_PROTOCOL.issuer, aud: CLIENT, sub: 'subject-fixture', exp: TIME / 1000 + 100,
  iat: TIME / 1000 - 1, nonce: NONCE, email: 'person@example.test' };
function jwt(payload: unknown = claims, header: unknown = { alg: 'RS256', kid: 'fixture-key' }) {
  const head = Buffer.from(JSON.stringify(header)).toString('base64url'), body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`;
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req_fixture' } });
const discovery = { issuer: SIWC_PROTOCOL.issuer, authorization_endpoint: SIWC_PROTOCOL.authorizationEndpoint, token_endpoint: SIWC_PROTOCOL.tokenEndpoint,
  jwks_uri: `${SIWC_PROTOCOL.issuer}/.well-known/jwks.json`, revocation_endpoint: `${SIWC_PROTOCOL.issuer}/revoke` };

describe('SIWC signature verification', () => {
  it('verifies signature/issuer/audience/nonce and returns only minimal identity', () => {
    expect(verifySiwcIdentity(jwt(), CLIENT, NONCE, jwks, TIME)).toEqual({ issuer: SIWC_PROTOCOL.issuer, subject: claims.sub, email: claims.email });
  });
  it.each(['issuer', 'audience', 'nonce', 'expired', 'future-iat', 'future-nbf', 'missing-sub', 'multi-audience', 'wrong-azp'])(
    'rejects %s despite a valid signature', variant => {
      const changed: Record<string, unknown> = { ...claims };
      if (variant === 'issuer') changed['iss'] = 'https://wrong.example.test';
      if (variant === 'audience') changed['aud'] = 'other';
      if (variant === 'nonce') changed['nonce'] = 'other';
      if (variant === 'expired') changed['exp'] = TIME / 1000;
      if (variant === 'future-iat') changed['iat'] = TIME / 1000 + 1;
      if (variant === 'future-nbf') changed['nbf'] = TIME / 1000 + 1;
      if (variant === 'missing-sub') delete changed['sub'];
      if (variant === 'multi-audience') changed['aud'] = [CLIENT, 'other'];
      if (variant === 'wrong-azp') changed['azp'] = 'other';
      expect(() => verifySiwcIdentity(jwt(changed), CLIENT, NONCE, jwks, TIME)).toThrowError(expect.objectContaining({ code: 'OAUTH_CONNECTION_IDENTITY_INVALID' }));
    });
  it.each(['none', 'HS256', 'RS512'])('rejects algorithm %s with no confusion fallback', alg => {
    expect(() => verifySiwcIdentity(jwt(claims, { alg, kid: 'fixture-key' }), CLIENT, NONCE, jwks, TIME)).toThrow(OAuthConnectionError);
  });
  it('rejects altered signature, unknown/duplicate kid, key-selected URL and embedded key', () => {
    const token = jwt(), parts = token.split('.'); parts[2] = Buffer.alloc(256).toString('base64url');
    expect(() => verifySiwcIdentity(parts.join('.'), CLIENT, NONCE, jwks, TIME)).toThrow(OAuthConnectionError);
    expect(() => verifySiwcIdentity(jwt(), CLIENT, NONCE, { keys: [] }, TIME)).toThrow(OAuthConnectionError);
    expect(() => verifySiwcIdentity(jwt(), CLIENT, NONCE, { keys: [...jwks.keys, ...jwks.keys] }, TIME)).toThrow(OAuthConnectionError);
    expect(() => verifySiwcIdentity(jwt(claims, { alg: 'RS256', kid: 'fixture-key', jku: 'https://evil.example.test/key' }), CLIENT, NONCE, jwks, TIME)).toThrow(OAuthConnectionError);
    expect(() => verifySiwcIdentity(jwt(claims, { alg: 'RS256', kid: 'fixture-key', jwk: publicJwk }), CLIENT, NONCE, jwks, TIME)).toThrow(OAuthConnectionError);
  });
  it('does not infer membership from email and removes control characters from its label', () => {
    const value = verifySiwcIdentity(jwt({ ...claims, email: 'admin\u202e@example.test', roles: ['admin'] }), CLIENT, NONCE, jwks, TIME);
    expect(value).toEqual({ issuer: SIWC_PROTOCOL.issuer, subject: claims.sub, email: null });
  });
  it('bounds JWT and key-set input', () => {
    expect(() => verifySiwcIdentity('x'.repeat(SIWC_LIMITS.jwtMaxBytes + 1), CLIENT, NONCE, jwks, TIME)).toThrow(OAuthConnectionError);
    expect(() => verifySiwcIdentity(jwt(), CLIENT, NONCE, { keys: Array(SIWC_LIMITS.maxKeys + 1).fill(jwks.keys[0]) }, TIME)).toThrow(OAuthConnectionError);
  });
});

describe('SIWC fixture-only OAuth transport', () => {
  it('noninteractive or unsupported platforms refuse before listener/browser side effects', async () => {
    const make = vi.fn(() => SIWC_PROTOCOL.authorizationEndpoint);
    const expected = process.platform === 'linux' ? 'OAUTH_CONNECTION_INTERACTIVE_REQUIRED' : 'OAUTH_CONNECTION_PLATFORM_UNSUPPORTED';
    await expect(siwcBrowserAuthorization(make, new AbortController().signal)).rejects.toMatchObject({ code: expected });
    expect(make).not.toHaveBeenCalled();
  });
  it('normalizes returned scopes/expiry and passes secrets only in POST form body, with no redirects', async () => {
    const send = vi.fn<typeof fetch>(async () => response({ access_token: TOKEN, refresh_token: `${TOKEN}-refresh`, id_token: jwt(), token_type: 'Bearer',
      expires_in: 120, earliest_refresh_at: TIME / 1000 + 30, scope: 'openid profile chatgpt.tokens.use.direct' }));
    const transport = createSiwcOAuthTransport({ fetch: send, now: () => TIME });
    const value = await transport.exchange(new URLSearchParams({ grant_type: 'authorization_code', code: 'code-fixture', client_id: CLIENT }), new AbortController().signal);
    expect(value).toMatchObject({ expiresAtMs: TIME + 120_000, earliestRefreshAtMs: TIME + 30_000, scopes: ['openid', 'profile', 'chatgpt.tokens.use.direct'] });
    expect(send.mock.calls[0]![0]).toBe(SIWC_PROTOCOL.tokenEndpoint);
    expect(send.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.stringify(send.mock.calls[0]![1]!.headers)).not.toContain(TOKEN);
  });
  it('identity-only results need a verifiable ID token rather than an inference access token', async () => {
    const transport = createSiwcOAuthTransport({ fetch: async () => response({ id_token: jwt(), scope: 'openid profile email' }) });
    expect(await transport.exchange(new URLSearchParams(), new AbortController().signal)).toMatchObject({ accessToken: null, refreshToken: null, expiresAtMs: null });
  });
  it.each(['invalid_grant', 'invalid_refresh_token', 'refresh_token_reused', 'invalid_client', 'unknown'])('handles exact refresh code %s', async code => {
    const transport = createSiwcOAuthTransport({ fetch: async () => response({ error: code, error_description: TOKEN }, 400) });
    const error = await transport.exchange(new URLSearchParams(), new AbortController().signal).catch(e => e);
    expect(error).toBeInstanceOf(SiwcOAuthTransportError);
    expect(error).toMatchObject({ httpStatus: 400, requestId: 'req_fixture' });
    expect(transport.unusableRefresh(error)).toBe(['invalid_grant', 'invalid_refresh_token', 'refresh_token_reused'].includes(code));
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
  it('accepts a provider RFC3339 earliest-refresh timestamp and refuses an unparseable one', async () => {
    const token = { access_token: TOKEN, refresh_token: TOKEN, id_token: jwt(), token_type: 'Bearer', scope: 'openid', expires_in: 60 };
    const send = vi.fn<typeof fetch>(async () => response({ ...token, earliest_refresh_at: new Date(TIME).toISOString() }));
    const transport = createSiwcOAuthTransport({ fetch: send, now: () => TIME });
    expect((await transport.exchange(new URLSearchParams(), new AbortController().signal)).earliestRefreshAtMs).toBe(TIME);
    send.mockImplementation(async () => response({ ...token, earliest_refresh_at: 'invalid' }));
    await expect(transport.exchange(new URLSearchParams(), new AbortController().signal)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_INVALID' });
  });
  it('never clears credentials on temporary status, network failure or admission detail prose', async () => {
    for (const failure of [async () => response({ error: 'invalid_grant' }, 503), async () => response({ detail: TOKEN }, 403), async () => { throw new Error(TOKEN); }]) {
      const transport = createSiwcOAuthTransport({ fetch: failure });
      const error = await transport.exchange(new URLSearchParams(), new AbortController().signal).catch(e => e);
      expect(transport.unusableRefresh(error)).toBe(false); expect(JSON.stringify(error)).not.toContain(TOKEN); expect(error.message).not.toContain(TOKEN);
    }
  });
  it('a provider echo of the refresh token in a request-id header cannot enter public errors', async () => {
    const transport = createSiwcOAuthTransport({ fetch: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400, headers: { 'x-request-id': TOKEN } }) });
    const error = await transport.exchange(new URLSearchParams({ refresh_token: TOKEN }), new AbortController().signal).catch(error => error);
    expect(error).toMatchObject({ httpStatus: 400, requestId: null }); expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
  it('loads trusted discovery/JWKS and verifies identity instead of decoding it', async () => {
    const send = vi.fn<typeof fetch>(async url => response(String(url).endsWith('openid-configuration') ? discovery : jwks));
    const transport = createSiwcOAuthTransport({ fetch: send, now: () => TIME });
    expect(await transport.verifyIdentity(jwt(), CLIENT, NONCE, new AbortController().signal)).toMatchObject({ subject: claims.sub });
    expect(send.mock.calls).toHaveLength(2);
  });
  it.each(['issuer', 'token_endpoint', 'jwks_uri', 'revocation_endpoint'])('rejects untrusted discovery %s before further network', async field => {
    const send = vi.fn<typeof fetch>(async () => response({ ...discovery, [field]: 'https://evil.example.test/secret' }));
    const transport = createSiwcOAuthTransport({ fetch: send, now: () => TIME });
    await expect(transport.verifyIdentity(jwt(), CLIENT, NONCE, new AbortController().signal)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_INVALID' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('revokes using the discovery endpoint and recognizes empty HTTP 200 only', async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith('openid-configuration') ? response(discovery) : new Response(null, { status: 200 }));
    const transport = createSiwcOAuthTransport({ fetch: send });
    expect(await transport.revoke(CLIENT, TOKEN, new AbortController().signal)).toBe(true);
    expect(send.mock.calls[1]![0]).toBe(discovery.revocation_endpoint);
    expect((send.mock.calls[1]![1]!.body as URLSearchParams).get('token')).toBe(TOKEN);
  });
  it('rejects missing/invalid expiry and over-limit response without leaking body', async () => {
    const send = vi.fn<typeof fetch>(async () => response({ access_token: TOKEN, token_type: 'Bearer', scope: 'openid', expires_in: -1 }));
    const transport = createSiwcOAuthTransport({ fetch: send });
    await expect(transport.exchange(new URLSearchParams(), new AbortController().signal)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_INVALID' });
    send.mockImplementation(async () => response({ data: TOKEN.repeat(SIWC_LIMITS.responseMaxBytes) }));
    await expect(transport.exchange(new URLSearchParams(), new AbortController().signal)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_UNAVAILABLE' });
  });
  it('pre-cancelled calls make no HTTP request', async () => {
    const send = vi.fn<typeof fetch>(), transport = createSiwcOAuthTransport({ fetch: send });
    await expect(transport.exchange(new URLSearchParams(), AbortSignal.abort())).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_CANCELLED' });
    expect(send).not.toHaveBeenCalled();
  });
});
