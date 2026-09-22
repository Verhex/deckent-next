import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import catalog from './providers.json' with { type: 'json' };

export const nativeSubscriptionSchema = z.object({ schemaVersion: z.literal(1), provider: z.enum(['codex', 'claude', 'cursor']),
  preflight: z.object({ schemaVersion: z.literal(1), cliVersion: z.string().trim().min(1).max(128).regex(/^[\w .()+-]+$/),
    discovery: z.enum(['disabled', 'repository']),
    helpArgs: z.array(z.enum(['exec', '--help'])).min(1).max(2).readonly(),
    requiredFlags: z.array(z.string().regex(/^--[a-z][a-z-]*$/).max(64)).min(1).max(20).readonly(),
  }).strict().readonly().optional(),
}).strict().readonly();
export type NativeSubscription = z.infer<typeof nativeSubscriptionSchema>;
export class NativeConnectionError extends Error {
  constructor(readonly code: 'NATIVE_CREDENTIAL_UNAVAILABLE' | 'NATIVE_CONNECTION_UNAVAILABLE') { super(code); this.name = 'NativeConnectionError'; }
}
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
  const source = record(input);
  if (provider === 'codex') {
    const tokens = record(source.tokens); const access = token(tokens.access_token); validJwt(access);
    return { auth_mode: 'chatgpt', tokens: { access_token: access, id_token: token(tokens.id_token), refresh_token: '',
      ...(typeof tokens.account_id === 'string' ? { account_id: tokens.account_id } : {}) },
    ...(typeof source.last_refresh === 'string' ? { last_refresh: source.last_refresh } : {}) };
  }
  if (provider === 'claude') {
    const oauth = record(source.claudeAiOauth); const access = token(oauth.accessToken);
    if (typeof oauth.expiresAt !== 'number' || oauth.expiresAt <= Date.now()) throw new NativeConnectionError('NATIVE_CREDENTIAL_UNAVAILABLE');
    return { claudeAiOauth: { accessToken: access, expiresAt: oauth.expiresAt,
      ...(Array.isArray(oauth.scopes) && oauth.scopes.every(x => typeof x === 'string') ? { scopes: oauth.scopes } : {}),
      ...(typeof oauth.subscriptionType === 'string' ? { subscriptionType: oauth.subscriptionType } : {}),
      ...(typeof oauth.rateLimitTier === 'string' ? { rateLimitTier: oauth.rateLimitTier } : {}) } };
  }
  const access = token(source.accessToken); validJwt(access);
  return { accessToken: access };
}
/** Local native login cache only; never reads provider settings, sessions, hooks or whole HOME. */
export async function readLocalNativeCredential(provider: NativeSubscription['provider'], env: Readonly<Record<string, string | undefined>> = process.env) {
  const spec = catalog.providers[provider]; const home = env.HOME ?? homedir();
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
