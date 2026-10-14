import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { OAuthConnectionError } from '#engine/index.js';
import { SIWC_PROTOCOL, SIWC_LIMITS } from './registry.js';
const MILLISECONDS_PER_SECOND = 1000;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Closed RS256 OIDC verification. No JWT-selected URL, embedded key, unverified email link or decoded-only identity. */
export function verifySiwcIdentity(token: string, clientId: string, nonce: string | null, jwks: unknown, nowMs: number) {
  try {
    if (Buffer.byteLength(token) > SIWC_LIMITS.jwtMaxBytes || !object(jwks) || !Array.isArray(jwks['keys'])
      || jwks['keys'].length > SIWC_LIMITS.maxKeys) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/u.test(part))) throw new Error();
    const header: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!object(header) || !object(claims) || header['alg'] !== 'RS256' || typeof header['kid'] !== 'string'
      || header['crit'] !== undefined || header['jku'] !== undefined || header['jwk'] !== undefined || header['x5u'] !== undefined) throw new Error();
    const matches = jwks['keys'].filter((key: unknown) => object(key) && key['kid'] === header['kid']);
    if (matches.length !== 1) throw new Error();
    const key = matches[0] as Record<string, unknown>;
    if (key['kty'] !== 'RSA' || (key['use'] !== undefined && key['use'] !== 'sig') || (key['alg'] !== undefined && key['alg'] !== 'RS256')
      || (key['key_ops'] !== undefined && (!Array.isArray(key['key_ops']) || !key['key_ops'].includes('verify')))
      || typeof key['n'] !== 'string' || typeof key['e'] !== 'string' || key['d'] !== undefined) throw new Error();
    const publicKey = createPublicKey({ key: { kty: 'RSA', n: key['n'], e: key['e'] } satisfies JsonWebKey, format: 'jwk' });
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, 'base64url'))) throw new Error();
    const now = Math.floor(nowMs / MILLISECONDS_PER_SECOND), audience = claims['aud'];
    if (claims['iss'] !== SIWC_PROTOCOL.issuer || (audience !== clientId && (!Array.isArray(audience) || !audience.includes(clientId)))
      || (Array.isArray(audience) && audience.length !== 1 && claims['azp'] !== clientId)
      || (claims['azp'] !== undefined && claims['azp'] !== clientId) || (nonce !== null && claims['nonce'] !== nonce)
      || !Number.isSafeInteger(claims['exp']) || (claims['exp'] as number) <= now
      || !Number.isSafeInteger(claims['iat']) || (claims['iat'] as number) > now
      || (claims['nbf'] !== undefined && (!Number.isSafeInteger(claims['nbf']) || (claims['nbf'] as number) > now))
      || typeof claims['sub'] !== 'string' || !claims['sub'] || claims['sub'].length > 256) throw new Error();
    return Object.freeze({ issuer: SIWC_PROTOCOL.issuer, subject: claims['sub'], email: typeof claims['email'] === 'string'
      && claims['email'].length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(claims['email']) ? claims['email'] : null });
  } catch { throw new OAuthConnectionError('OAUTH_CONNECTION_IDENTITY_INVALID'); }
}
