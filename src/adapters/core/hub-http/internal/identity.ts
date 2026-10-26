import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { z } from 'zod';
import { HUB_LIMITS } from '#domain/index.js';
import { HubServerError, type HubIdentityVerifier } from '#engine/index.js';
import { HOST_LIMITS_REGISTRY } from '#platform/index.js';

export const hubOidcProviderSchema = z.object({ issuer: z.string().url(), audience: z.string().min(1),
  algorithms: z.array(z.enum(['RS256', 'ES256', 'EdDSA'])).min(1),
  /** The operator must configure values that certify WebAuthn + second factor at this exact issuer, never generic MFA alone. */
  passkeyAcr: z.array(z.string().min(1)).min(1), passkeyAmr: z.array(z.string().min(1)).min(1),
}).strict().readonly();
export type HubOidcProvider = z.infer<typeof hubOidcProviderSchema>;
const claimsSchema = z.object({ iss: z.string(), sub: z.string().min(1), aud: z.union([z.string(), z.array(z.string()).min(1)]),
  azp: z.string().optional(), nonce: z.string(), exp: z.number().int().safe(), iat: z.number().int().safe(), nbf: z.number().int().safe().optional(),
  email: z.string().email(), email_verified: z.boolean(), name: z.string().min(1), acr: z.string(), amr: z.array(z.string()) });
const decode = (part: string): unknown => {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || Buffer.from(part, 'base64url').toString('base64url') !== part) throw new HubServerError('HUB_ACCOUNT_REFUSED');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
};
/** OIDC relying-party adapter with passkey assurance delegated to the configured IdP's WebAuthn verifier.
 * Keys come only from the installation's issuer-bound JWKS adapter, never jku/jwk/x5u supplied by a token.
 * The IdP's code/PKCE/redirect and WebAuthn enrollment/verification remain its responsibilities. */
export class HubOidcPasskeyVerifier implements HubIdentityVerifier {
  readonly providers: readonly HubOidcProvider[];
  constructor(providers: readonly HubOidcProvider[], private readonly key: (issuer: string, kid: string) => Promise<JsonWebKey>, private readonly now: () => number) {
    this.providers = providers.map(provider => hubOidcProviderSchema.parse(provider));
    if (this.providers.some(p => new URL(p.issuer).protocol !== 'https:')) throw new HubServerError('HUB_ACCOUNT_REFUSED');
  }
  async verify(input: unknown, expected: Parameters<HubIdentityVerifier['verify']>[1]) {
    try {
      const { idToken } = z.object({ idToken: z.string().max(HUB_LIMITS.networkInputMaxBytes) }).strict().parse(input);
      const parts = idToken.split('.'); if (parts.length !== 3) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      const [headerPart, bodyPart, signaturePart] = parts as [string, string, string];
      const header = z.object({ kid: z.string().min(1), alg: z.enum(['RS256', 'ES256', 'EdDSA']), typ: z.literal('JWT').optional() }).strict().parse(decode(headerPart));
      const provider = this.providers.find(p => p.issuer === expected.issuer && p.audience === expected.audience);
      if (!provider || !provider.algorithms.includes(header.alg)) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      const jwk = await this.key(provider.issuer, header.kid);
      if ('d' in jwk || jwk.alg !== undefined && jwk.alg !== header.alg || jwk.use !== undefined && jwk.use !== 'sig'
        || jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify'))) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      if (header.alg === 'RS256' && (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
        || header.alg === 'ES256' && (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
        || header.alg === 'EdDSA' && key.asymmetricKeyType !== 'ed25519') throw new HubServerError('HUB_ACCOUNT_REFUSED');
      const signature = Buffer.from(signaturePart, 'base64url');
      if (signature.toString('base64url') !== signaturePart || !verify(header.alg === 'EdDSA' ? null : 'sha256', Buffer.from(`${headerPart}.${bodyPart}`),
        { key, ...(header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' as const } : {}) }, signature)) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      const nowMs = this.now();
      if (!Number.isSafeInteger(nowMs) || nowMs < expected.nowMs) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      const claims = claimsSchema.parse(decode(bodyPart)), nowSeconds = Math.floor(nowMs / HOST_LIMITS_REGISTRY.msPerSecond);
      const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
      if (claims.iss !== provider.issuer || !audiences.includes(provider.audience) || audiences.length > 1 && claims.azp !== provider.audience
        || claims.azp !== undefined && claims.azp !== provider.audience || claims.nonce !== expected.challenge
        || claims.exp <= nowSeconds || claims.iat > nowSeconds || claims.exp <= claims.iat || claims.nbf !== undefined && claims.nbf > nowSeconds
        || !claims.email_verified || !provider.passkeyAcr.includes(claims.acr) || !provider.passkeyAmr.some(value => claims.amr.includes(value))) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      return { subject: claims.sub, email: claims.email, displayName: claims.name, emailVerified: true, passkeyVerified: true };
    } catch { throw new HubServerError('HUB_ACCOUNT_REFUSED'); }
  }
}
