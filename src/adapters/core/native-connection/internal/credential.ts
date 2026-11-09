import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { persistedString, workerEffortSchema, nativeCliIdSchema, modelUsageEvidenceSchema, workerModelPinEvidenceShape, workspaceHiddenPathsSchema, delegationOwner, delegationPrincipalClass, DEFAULT_DELEGATED_CLASSES } from '#domain/index.js';
import { z } from 'zod';
import catalog from './providers.json' with { type: 'json' };
import { nativePromptDeliverySchema } from './prompt.js';
import { nativeCliCommand } from '#adapters/core/native-cli-registry/index.js';
import { readLocalOsOwner } from '#adapters/core/local-principal/index.js';

const exactModelId = persistedString(z.string().min(1).max(256)).refine(value => value.trim() === value && !value.startsWith('-')
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
/** v2 (WORKER-CURRENCY-1): the admitted catalog reference — channel and exact model id, plus declared helper model ids. The host compares the
 * models the worker reports against it (model.verification); v1 profiles carry none and are refused for new Runs at admission. The pin may carry
 * the catalog's session-start names / provider-choice flag, stamped at admission (owner K1/K2 2026-10-22). */
export const nativeSubscriptionSchema = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), provider: nativeCliIdSchema, modelUsageEvidence: modelUsageEvidenceSchema.optional(),
  reasoningEffort: workerEffortSchema.optional(), effortMode: z.enum(['arguments', 'model-id']).nullable().optional(),
  model: z.strictObject({ channelId: persistedString(z.string().min(1).max(256)), modelId: exactModelId, auxiliaryModelIds: z.array(exactModelId).max(8).readonly(),
    ...workerModelPinEvidenceShape }).readonly().optional(),
  promptDelivery: nativePromptDeliverySchema.optional(),
  finalReport: z.strictObject({ schemaVersion: z.literal(1) }).readonly().optional(),
  preflight: z.strictObject({ schemaVersion: z.literal(1), cliVersion: persistedString(z.string().trim().min(1).max(128)).regex(/^[\w .()+-]+$/),
    discovery: z.enum(['disabled', 'repository']),
    helpArgs: z.array(z.enum(['exec', '--help'])).min(1).max(2).readonly(),
    requiredFlags: z.array(persistedString(z.string().regex(/^--[a-z][a-z-]*$/).max(64))).min(1).max(20).readonly(),
  }).readonly().optional(),
  /** C2: `disabled` discovery realised by checkout shaping — the worker's Git checkout leaves these paths out. Frozen at compilation, so the
   * ledger-pinned profile (never a file beside the checkout) is what allocation and patch capture read. Absent = full checkout. */
  checkout: z.strictObject({ schemaVersion: z.literal(1), hiddenPaths: workspaceHiddenPathsSchema }).readonly().optional(),
}).refine(value => (value.schemaVersion === 2) === (value.model !== undefined))
  .refine(value => value.checkout === undefined || value.preflight?.discovery === 'disabled').readonly();
export type NativeSubscription = z.infer<typeof nativeSubscriptionSchema>;
/** Alpha.63 contract gate: only new dispatch is checked; persisted/running connections retain their own custody. */
export function nativeProjectionDispatch(binding: NativeSubscription | undefined, retired: boolean): 'legacy' | 'retired' {
  return retired && binding && nativeCliCommand(binding.provider).agent ? 'retired' : 'legacy';
}
export class NativeConnectionError extends Error {
  constructor(readonly code: 'NATIVE_CREDENTIAL_UNAVAILABLE' | 'NATIVE_CONNECTION_UNAVAILABLE' | 'NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE' | 'NATIVE_SUBSCRIPTION_OTHER_PERSON') { super(code); this.name = 'NativeConnectionError'; }
}
/** A provider's local credential spec as shipped in `providers.json`; declared explicitly so the published `.d.ts` never references the JSON module. */
export interface NativeProviderSpec { readonly homeOverride: string; readonly home: string; readonly file: string; readonly destinations: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  /** How a Docker worker of this CLI authenticates: `relayed` (the host relay attaches the login per request; the container holds a placeholder),
   * `projected` (the short-lived token is projected into the container) or `prohibited` (no Docker subscription path; owner 2026-11-08). */
  readonly dockerCredential: 'relayed' | 'projected' | 'prohibited'; readonly relay?: NativeRelaySpec }
/** The host relay of a `relayed` CLI: the provider origin and the only routes forwarded, the header naming the account, the placeholder bearer the
 * container's CLI sends, byte caps, and the CLI configuration (`-c` pairs; `{shimPort}` is the container's loopback shim) that points the CLI at it. */
export interface NativeRelaySpec { readonly origin: string; readonly basePath: string; readonly routes: readonly Readonly<{ method: string; path: string; query: boolean; exclusive?: boolean }>[];
  readonly accountHeader: string; readonly placeholder: string; readonly capabilityBytes: number; readonly requestBytes: number; readonly responseBytes: number;
  /** Requests one Attempt's relay forwards in total; an `exclusive` route (the metered model call) runs one at a time. */ readonly maxRequests: number; readonly config: Readonly<Record<string, unknown>> }
/** The provider's local credential spec from the adapter catalog; an id the catalog does not list is a typed unavailability, never `any`. */
/** The environment names that move a native CLI's home (the runtime service keeps them, A6-3). */
export const nativeHomeOverrideNames = (): readonly string[] => Object.values(catalog.providers as Readonly<Record<string, NativeProviderSpec>>).map(spec => spec.homeOverride).filter(Boolean);
export function nativeProviderSpec(provider: NativeSubscription['provider']): NativeProviderSpec {
  const specs = catalog.providers as Readonly<Record<string, NativeProviderSpec | undefined>>;
  const spec = specs[provider];
  if (!spec) throw new NativeConnectionError('NATIVE_CREDENTIAL_UNAVAILABLE');
  return spec;
}
/**
 * Owner 2026-11-08 ("Kapat, yalnız token'sız yol"): a `prohibited` CLI has no Docker subscription path; its local login is never read, held or
 * served into a container. Anthropic, code.claude.com/docs/en/legal-and-compliance (read 2026-11-09): "developers may not collect, store, or
 * intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." Its workers use
 * the tokenless native CLI worker (`deckent coding template --connection <profile>`).
 */
export function assertNativeDockerSubscription(provider: NativeSubscription['provider']): void {
  if (nativeDockerCredential(provider) === 'prohibited') throw new NativeConnectionError('NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE');
}
export const nativeDockerCredential = (provider: NativeSubscription['provider']): NativeProviderSpec['dockerCredential'] => nativeProviderSpec(provider).dockerCredential;
/** Owner 2026-11-08 (lead): a Docker login belongs to the OS account owning the file (this uid, checked at read). Delegation decides use: the person acted for must
 * be that owner and a non-person class needs consent; a Docker login records none, so the connect default (`DEFAULT_DELEGATED_CLASSES`) applies. */
export const nativeLoginUseAllowed = (principal: Readonly<{ issuer: string; subject: string; assurance?: string }> | null | undefined): boolean => { if (!principal) return false;
  const owner = readLocalOsOwner(), actsFor = delegationOwner(principal), kind = delegationPrincipalClass(principal); return actsFor.issuer === owner.issuer && actsFor.subject === owner.subject && (kind === 'person' || DEFAULT_DELEGATED_CLASSES.includes(kind)); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const token = (value: unknown): string => { if (typeof value !== 'string' || !value) throw new NativeConnectionError('NATIVE_CREDENTIAL_UNAVAILABLE'); return value; };
/** Expiry metadata is only a preflight hint. Remote authentication remains the authority. */
function validJwt(value: string) {
  try {
    const payload = JSON.parse(Buffer.from(value.split('.')[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) throw new Error();
  } catch { throw new NativeConnectionError('NATIVE_CREDENTIAL_UNAVAILABLE'); }
}
/** Allowlist projection. Refresh tokens, API keys and unrelated account material never leave the host. */
export function projectNativeCredential(provider: NativeSubscription['provider'], input: unknown): Record<string, unknown> {
  assertNativeDockerSubscription(provider); const source = record(input);
  if (provider === 'codex') {
    const tokens = record(source.tokens); const access = token(tokens.access_token); validJwt(access);
    return { auth_mode: 'chatgpt', tokens: { access_token: access, id_token: token(tokens.id_token), refresh_token: '',
      ...(typeof tokens.account_id === 'string' ? { account_id: tokens.account_id } : {}) },
    ...(typeof source.last_refresh === 'string' ? { last_refresh: source.last_refresh } : {}) };
  }
  const access = token(source.accessToken); validJwt(access);
  return { accessToken: access };
}
/** Local native login cache only; never reads provider settings, sessions, hooks or whole HOME. */
export async function readLocalNativeCredential(provider: NativeSubscription['provider'], env: Readonly<Record<string, string | undefined>> = process.env) {
  assertNativeDockerSubscription(provider); const spec = nativeProviderSpec(provider); const home = env.HOME ?? homedir();
  const root = provider === 'cursor' ? join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'cursor') : env[spec.homeOverride] ?? join(home, spec.home);
  const path = resolve(root, spec.file);
  try {
    if (await realpath(path) !== path) throw new Error();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > catalog.limits.credentialBytes) throw new Error();
      const bytes = Buffer.alloc(catalog.limits.credentialBytes + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > catalog.limits.credentialBytes) throw new Error();
      try { return projectNativeCredential(provider, JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))); }
      finally { bytes.fill(0); }
    } finally { await handle.close(); }
  } catch { throw new NativeConnectionError('NATIVE_CREDENTIAL_UNAVAILABLE'); }
}
