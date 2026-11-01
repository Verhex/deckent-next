import { persistedString, persistedInteger, persistedUrl } from '#platform/index.js';
import { z } from 'zod';
import asset from './registry.json' with { type: 'json' };
import type { OAuthConnectionProtocol } from '#engine/index.js';
import { nativeCliAppServer } from '#adapters/core/native-cli-registry/index.js';
import { promptFramingAllowanceSchema } from '#domain/index.js';
const positive = persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), url = persistedUrl().startsWith('https://');
const sourced = { source: url, observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) };
const parsed = z.strictObject({ schemaVersion: z.literal(3), source: url, observedOn: z.string(), issuer: url, dynamicClientId: persistedString(z.string().min(1)),
  authorizationEndpoint: url, tokenEndpoint: url, discoveryEndpoint: url, resource: url, appName: persistedString(z.string().min(1)),
  identityScopes: z.array(z.string()), usageScopes: z.array(z.string()), usagePermission: z.string(), callbackPath: z.string().startsWith('/'),
  hostSecretName: z.string(), connectionSecretPrefix: z.string(), encryptedStoreId: z.string(), timeoutMs: positive, maxPending: positive, maxConnections: positive,
  limits: z.strictObject({ loginWindowMs: positive, httpTimeoutMs: positive, responseMaxBytes: positive, jwtMaxBytes: positive, maxKeys: positive, callbackMaxBytes: positive, callbackMaxConnections: positive }),
  refreshMarginMs: positive, refreshLockWaitMs: positive,
  refreshPolicySource: z.strictObject({ ...sourced, kind: z.literal('deckent-policy') }),
  usageSummary: z.strictObject({ ...sourced, days: positive, maxEntries: positive, timeoutMs: positive, manageUrl: url }),
  inference: z.strictObject({ ...sourced, adapter: z.strictObject({ id: persistedString(z.string().min(1)), version: positive }), endpoint: url, modelsEndpoint: url,
    modelsMaxEntries: positive, modelsMaxBytes: positive, modelFieldMaxChars: positive, visibility: persistedString(z.string().min(1)), namespace: z.strictObject({ name: persistedString(z.string().min(1)), description: z.string() }), promptFramingAllowance: promptFramingAllowanceSchema }),
  requestRules: z.strictObject({ ...sourced, allowedFields: z.array(z.string()).min(1), unverifiedFields: z.array(z.string()), forbiddenFields: z.array(z.string()).min(1),
    store: z.literal(false), stream: z.literal(true) }).refine(r => [...r.allowedFields, ...r.unverifiedFields].every(f => !r.forbiddenFields.includes(f))
      && r.allowedFields.every(f => !r.unverifiedFields.includes(f))),
  usageErrors: z.strictObject({ ...sourced, codes: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u), z.strictObject({
    refusal: z.enum(['quota', 'plan-unavailable', 'login-required', 'usage-unavailable', 'service-unavailable']),
    status: persistedInteger().min(400).max(599) })) }),
  terminalRefreshErrors: z.array(z.string()).min(1),
  /** U9-6/7: the worker-embedded app-server relay. `activation` stays `hold` until the operator's real-binary proof; bounds are required data. */
  workerRelay: z.strictObject({ ...sourced, activation: z.enum(['hold', 'open']), appServer: z.strictObject({
    control: z.array(persistedString(z.string().min(1))).min(1), controlSource: url,
    native: z.strictObject({ note: z.string(), vendorRoots: z.record(z.string(), persistedString(z.string().min(1))), fallbackVendorRoot: persistedString(z.string().min(1)), triples: z.record(z.string(), persistedString(z.string().min(1))),
      binary: persistedString(z.string().min(1)), pathDir: persistedString(z.string().min(1)), managedEnv: persistedString(z.string().min(1)) }) }), approvalPolicy: z.literal('untrusted'), sandbox: z.literal('danger-full-access'), wireApi: z.literal('responses'),
    requestFields: z.array(persistedString(z.string().min(1))).min(1), toolTypes: z.array(persistedString(z.string().min(1))).min(1),
    methods: z.strictObject({ client: z.array(persistedString(z.string().min(1))).min(1), approvals: z.array(persistedString(z.string().min(1))).min(1) }),
    limits: z.strictObject({ requestMaxBytes: positive, responseMaxBytes: positive, headerBytes: positive, inFlight: positive, connections: positive, idleMs: positive,
      capabilityMaxTtlMs: positive, capabilityBytes: positive, approvalCommandBytes: positive, approvalDiffBytes: positive, approvalChanges: positive, approvalItems: positive, controlConnectMs: positive, controlPollMs: positive, helperTimeoutMs: positive, drainMs: positive, controlLineBytes: positive, controlLines: positive, auditRecords: positive }) }) }).refine(r => r.workerRelay.requestFields.every(field => !r.requestRules.forbiddenFields.includes(field))).parse(asset);
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

const quotaRules = Object.values(parsed.usageErrors.codes).filter(rule => rule.refusal === 'quota');
export const SIWC_USAGE_LIMIT_STATUS = positive.parse(quotaRules.length === 1 ? quotaRules[0]!.status : undefined);
/** U9-6/7 worker relay policy (registry data; `activation: hold` keeps every SIWC worker launch refused). */
/** The app-server command itself is the worker command catalog's (U6 `commands.json`, one source); the relay keeps only its transport data. */
const { id: appServerCli, ...appServerCommand } = nativeCliAppServer();
export const SIWC_WORKER_RELAY = Object.freeze({ ...parsed.workerRelay, appServer: Object.freeze({ ...parsed.workerRelay.appServer, ...appServerCommand }), appServerCli,
  appName: parsed.appName, endpoint: parsed.inference.endpoint });
