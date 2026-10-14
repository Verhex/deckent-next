import { z } from 'zod';
import asset from './registry.json' with { type: 'json' };
import type { OAuthConnectionProtocol } from '#engine/index.js';
const positive = z.number().int().positive().safe(), url = z.string().url().startsWith('https://');
const parsed = z.object({ schemaVersion: z.literal(1), source: url, observedOn: z.string(), issuer: url, dynamicClientId: z.string().min(1),
  authorizationEndpoint: url, tokenEndpoint: url, discoveryEndpoint: url, resource: url, appName: z.string().min(1),
  identityScopes: z.array(z.string()), usageScopes: z.array(z.string()), usagePermission: z.string(), callbackPath: z.string().startsWith('/'),
  hostSecretName: z.string(), connectionSecretPrefix: z.string(), encryptedStoreId: z.string(), timeoutMs: positive, maxPending: positive, maxConnections: positive,
  limits: z.object({ httpTimeoutMs: positive, responseMaxBytes: positive, jwtMaxBytes: positive, maxKeys: positive, callbackMaxBytes: positive, callbackMaxConnections: positive }).strict(),
  terminalRefreshErrors: z.array(z.string()).min(1) }).strict().parse(asset);
export const SIWC_PROTOCOL: OAuthConnectionProtocol = Object.freeze({ ...parsed, identityScopes: Object.freeze(parsed.identityScopes), usageScopes: Object.freeze(parsed.usageScopes) });
export const SIWC_LIMITS = Object.freeze(parsed.limits);
export const SIWC_DISCOVERY_ENDPOINT = parsed.discoveryEndpoint;
export const SIWC_TERMINAL_REFRESH_ERRORS = Object.freeze(parsed.terminalRefreshErrors);
