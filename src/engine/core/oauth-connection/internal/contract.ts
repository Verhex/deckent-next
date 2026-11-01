import { persistedInteger, persistedUrl, persistedUuid } from '#platform/index.js';
import type { PersonalCustodyRefusal } from '#engine/core/secret-store/index.js';
import { z } from 'zod';
import type { SecretChangeAudit, SecretChangeAuthorization, SecretCustody, SecretStore } from '#engine/core/secret-store/index.js';

export type OAuthConnectionCode = 'OAUTH_CONNECTION_INVALID' | 'OAUTH_CONNECTION_DENIED' | 'OAUTH_CONNECTION_UNAVAILABLE'
  | 'OAUTH_CONNECTION_CANCELLED' | 'OAUTH_CONNECTION_TIMEOUT' | 'OAUTH_CONNECTION_IDENTITY_INVALID'
  | 'OAUTH_CONNECTION_STORE_REQUIRED' | 'OAUTH_CONNECTION_CHANGED' | 'OAUTH_CONNECTION_REAUTHORIZE'
  | 'SIWC_ACCOUNT_STILL_CONNECTED' | 'SIWC_STORE_NOT_PERSONAL' | 'OAUTH_CONNECTION_INTERACTIVE_REQUIRED' | 'OAUTH_CONNECTION_PLATFORM_UNSUPPORTED' | 'POLICY_APPROVAL_UNSUPPORTED';
/** No vendor text, callback, token, URL or nested cause enters an error. */
export class OAuthConnectionError extends Error {
  constructor(readonly code: OAuthConnectionCode, readonly reason?: PersonalCustodyRefusal) { super(code); this.name = 'OAuthConnectionError'; }
}
const text = z.string().min(1).max(256), time = persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const oauthConnectionOwnerSchema = z.strictObject({ installationId: text, companyId: text, scopeId: text,
  get principal() { return z.strictObject({ issuer: text, subject: text }).readonly(); } }).readonly();
export type OAuthConnectionOwner = z.infer<typeof oauthConnectionOwnerSchema>;
export const oauthConnectionConnectSchema = z.strictObject({ get connectionId() { return persistedUuid().optional(); }, get planUse() { return z.boolean(); },
  get enablePlanUse() { return z.boolean().optional(); } }).refine(value => !value.enablePlanUse || value.planUse);
const identity = z.strictObject({ get issuer() { return persistedUrl(); }, subject: text, get email() { return z.string().max(256).nullable(); } }).readonly();
export const oauthTokenSetSchema = z.strictObject({ get accessToken() { return z.string().min(1).nullable(); }, get refreshToken() { return z.string().min(1).nullable(); },
  get idToken() { return z.string().min(1).nullable(); }, get scopes() { return z.array(text).max(64).readonly(); }, get expiresAtMs() { return time.nullable(); },
  get earliestRefreshAtMs() { return time.nullable(); } }).readonly();
export type OAuthTokenSet = z.infer<typeof oauthTokenSetSchema>;
const legacyRecordSchema = z.strictObject({ get schemaVersion() { return z.literal(1); }, get connectionId() { return persistedUuid(); }, owner: oauthConnectionOwnerSchema,
  clientId: text, get identity() { return identity.nullable(); }, generation: time, get planUseEnabled() { return z.boolean(); },
  get state() { return z.enum(['registration', 'connected', 'refresh-pending', 'refresh-unknown', 'revoked', 'disconnecting', 'disconnected']); },
  get remoteRevocation() { return z.enum(['not-attempted', 'confirmed', 'unconfirmed']); }, get tokens() { return oauthTokenSetSchema.nullable(); } }).readonly();
export const oauthConnectionRecordSchema = z.union([legacyRecordSchema, legacyRecordSchema.unwrap().extend({ schemaVersion: z.literal(2),
  custody: z.strictObject({ get bindingId() { return persistedUuid(); }, generation: time }).readonly() }).strict().readonly()]);
export type OAuthConnectionRecord = z.infer<typeof oauthConnectionRecordSchema>;
export type OAuthConnectionView = Readonly<{ schemaVersion: 1; connectionId: string; generation: number; email: string | null;
  state: OAuthConnectionRecord['state'] | 'identity-only' | 'expired'; planUse: boolean; remoteRevocation: OAuthConnectionRecord['remoteRevocation'] }>;
export interface OAuthConnectionProtocol {
  readonly issuer: string; readonly dynamicClientId: string; readonly authorizationEndpoint: string; readonly tokenEndpoint: string;
  readonly resource: string; readonly appName: string; readonly identityScopes: readonly string[]; readonly usageScopes: readonly string[];
  readonly usagePermission: string; readonly callbackPath: string; readonly hostSecretName: string; readonly connectionSecretPrefix: string;
  readonly encryptedStoreId: string; readonly refreshMarginMs: number; readonly timeoutMs: number; readonly maxPending: number; readonly maxConnections: number;
}
/** One send's host-only access credential; never the renewable token set or identity record. */
export type OAuthAccessTokenLease = Readonly<{ accessToken: string; expiresAtMs: number }>;
/** Cross-process, per-connection lock; bounded waiting and cancellation, independent of installation secret custody. */
export type OAuthConnectionLock = <T>(connectionId: string, work: () => Promise<T>, signal: AbortSignal) => Promise<T>;
export interface OAuthConnectionPorts {
  readonly connectionLock: OAuthConnectionLock;
  readonly protocol: OAuthConnectionProtocol; readonly owner: OAuthConnectionOwner; readonly store: SecretStore; readonly custody: SecretCustody;
  readonly authorize: SecretChangeAuthorization; readonly audit: SecretChangeAudit; readonly now: () => number;
  /** Trusted local adapter: starts the listener before opening the browser; closes it on every terminal path. */
  readonly browser: (makeUrl: (redirectUri: string) => string, signal: AbortSignal) => Promise<{ callback: string; redirectUri: string }>;
  readonly exchange: (form: URLSearchParams, signal: AbortSignal) => Promise<unknown>;
  readonly verifyIdentity: (token: string, clientId: string, nonce: string | null, signal: AbortSignal) => Promise<z.infer<typeof identity>>;
  readonly revoke: (clientId: string, refreshToken: string, signal: AbortSignal) => Promise<boolean>;
  /** Classifies only a complete, machine-coded rejection; temporary/unknown errors never delete a token set. */
  readonly unusableRefresh: (error: unknown) => boolean;
}
