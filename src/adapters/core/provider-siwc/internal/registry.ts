import { z } from 'zod';
import asset from './registry.json' with { type: 'json' };
import type { OAuthConnectionProtocol } from '#engine/index.js';
const positive = z.number().int().positive().safe(), url = z.string().url().startsWith('https://');
const sourced = { source: url, observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) };
const parsed = z.object({ schemaVersion: z.literal(3), source: url, observedOn: z.string(), issuer: url, dynamicClientId: z.string().min(1),
  authorizationEndpoint: url, tokenEndpoint: url, discoveryEndpoint: url, resource: url, appName: z.string().min(1),
  identityScopes: z.array(z.string()), usageScopes: z.array(z.string()), usagePermission: z.string(), callbackPath: z.string().startsWith('/'),
  hostSecretName: z.string(), connectionSecretPrefix: z.string(), encryptedStoreId: z.string(), timeoutMs: positive, maxPending: positive, maxConnections: positive,
  limits: z.object({ loginWindowMs: positive, httpTimeoutMs: positive, responseMaxBytes: positive, jwtMaxBytes: positive, maxKeys: positive, callbackMaxBytes: positive, callbackMaxConnections: positive }).strict(),
  refreshMarginMs: positive, refreshLockWaitMs: positive,
  refreshPolicySource: z.object({ ...sourced, kind: z.literal('deckent-policy') }).strict(),
  usageSummary: z.object({ ...sourced, days: positive }).strict(),
  inference: z.object({ ...sourced, adapter: z.object({ id: z.string().min(1), version: positive }).strict(), endpoint: url, modelsEndpoint: url,
    modelsMaxEntries: positive, modelsMaxBytes: positive, modelFieldMaxChars: positive, visibility: z.string().min(1), namespace: z.object({ name: z.string().min(1), description: z.string() }).strict() }).strict(),
  requestRules: z.object({ ...sourced, allowedFields: z.array(z.string()).min(1), unverifiedFields: z.array(z.string()), forbiddenFields: z.array(z.string()).min(1),
    store: z.literal(false), stream: z.literal(true) }).strict().refine(r => [...r.allowedFields, ...r.unverifiedFields].every(f => !r.forbiddenFields.includes(f))
      && r.allowedFields.every(f => !r.unverifiedFields.includes(f))),
  usageErrors: z.object({ ...sourced, codes: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u), z.object({
    refusal: z.enum(['quota', 'plan-unavailable', 'login-required', 'usage-unavailable', 'service-unavailable']),
    status: z.number().int().min(400).max(599) }).strict()) }).strict(),
  terminalRefreshErrors: z.array(z.string()).min(1) }).strict().parse(asset);
export const SIWC_PROTOCOL: OAuthConnectionProtocol = Object.freeze({ ...parsed, identityScopes: Object.freeze(parsed.identityScopes), usageScopes: Object.freeze(parsed.usageScopes) });
export const SIWC_LIMITS = Object.freeze(parsed.limits);
export const SIWC_DISCOVERY_ENDPOINT = parsed.discoveryEndpoint;
export const SIWC_TERMINAL_REFRESH_ERRORS = Object.freeze(parsed.terminalRefreshErrors);

export const SIWC_INFERENCE = Object.freeze({ ...parsed.inference, adapter: Object.freeze(parsed.inference.adapter), namespace: Object.freeze(parsed.inference.namespace) });
export const SIWC_REQUEST_RULES = Object.freeze({ ...parsed.requestRules, allowedFields: Object.freeze(parsed.requestRules.allowedFields),
  unverifiedFields: Object.freeze(parsed.requestRules.unverifiedFields), forbiddenFields: Object.freeze(parsed.requestRules.forbiddenFields) });
export const SIWC_USAGE_SUMMARY = Object.freeze(parsed.usageSummary);
export const SIWC_USAGE_ERRORS = Object.freeze(parsed.usageErrors.codes);
export const SIWC_REFRESH_LOCK_WAIT_MS = parsed.refreshLockWaitMs;
