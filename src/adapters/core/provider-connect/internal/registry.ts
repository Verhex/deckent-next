import { z } from 'zod';
import asset from './registry.json' with { type: 'json' };

/**
 * The connection kinds the terminal `/provider` window offers (T4 PROVIDER-CONNECT): where each kind is reached, which free request proves
 * a key (a model list or the key's own record — never a billed call), how the key is sent, and the secret-store name it is kept under. Vendor
 * endpoints are versioned data here, not code (ARCHITECTURE literal rule); a kind with `available: false` is listed with its reason only.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const header = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const kindSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
  /** The catalog key of the kind's name (a surface resolves it in the person's language). */
  labelKey: z.string().regex(/^tui\.provider\.kind\.[A-Za-z]+$/u),
  available: z.boolean(),
  /** `choices`: known addresses offered as a list (owner 2026-10-08: values are chosen; a typed address is the last row's narrow exception). */
  endpoint: z.object({ default: z.string().url().startsWith('https://').nullable(), editable: z.boolean(),
    choices: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u), labelKey: z.string().regex(/^tui\.provider\.endpoint\.choice\.[A-Za-z]+$/u),
      // Every listed address passes the same rule as a typed one (https, or plain http only to this machine).
      url: z.string().url().refine(url => providerEndpoint(url).ok) }).strict().readonly()).readonly().default([]) }).strict(),
  probe: z.object({ path: z.string().startsWith('/').max(128), auth: z.discriminatedUnion('type', [z.object({ type: z.literal('bearer') }).strict(),
    z.object({ type: z.literal('header'), name: header }).strict()]), headers: z.record(header, z.string().max(128)), listsModels: z.boolean() }).strict().nullable(),
  key: z.object({ required: z.boolean(), secretName: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u) }).strict().nullable(),
}).strict().readonly();
const registrySchema = z.object({ schemaVersion: z.literal(1), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), note: z.string(),
  limits: z.object({ timeoutMs: z.number().int().positive().safe(), bodyPrefixBytes: z.number().int().positive().safe() }).strict(),
  kinds: z.array(kindSchema).min(1).readonly() }).strict().readonly();

export type ProviderConnectKind = z.infer<typeof kindSchema>;
export const PROVIDER_CONNECT_REGISTRY_VERSION = 1;
/** Parsed once at load: a malformed data file fails the import, never a later connect. */
const registry = registrySchema.parse(asset);
export const PROVIDER_CONNECT_KINDS: readonly ProviderConnectKind[] = Object.freeze(registry.kinds);
/** The check's time bound and how much of a refusal body is read to classify it (data, not code). */
export const PROVIDER_CONNECT_LIMITS = Object.freeze({ ...registry.limits });

export function providerConnectKind(id: string): ProviderConnectKind | null {
  return PROVIDER_CONNECT_KINDS.find(kind => kind.id === id) ?? null;
}

export type ProviderEndpointRefusal = 'url-invalid' | 'url-credentials' | 'url-query' | 'url-insecure-remote' | 'url-scheme-refused';
/**
 * The endpoint rule of a typed base URL (the same rule as MCP HTTP entries): https anywhere, plain http only to this machine (a local server);
 * no credentials, query or fragment in the URL (the key travels only in its header). Returns the canonical base without a trailing slash.
 */
export function providerEndpoint(text: string): Readonly<{ ok: true; base: string }> | Readonly<{ ok: false; reason: ProviderEndpointRefusal }> {
  let parsed: URL;
  try { parsed = new URL(text.trim()); } catch { return { ok: false, reason: 'url-invalid' }; }
  if (parsed.username || parsed.password) return { ok: false, reason: 'url-credentials' };
  if (parsed.search || parsed.hash || text.includes('?') || text.includes('#')) return { ok: false, reason: 'url-query' };
  if (parsed.protocol === 'http:' && !LOOPBACK.has(parsed.hostname)) return { ok: false, reason: 'url-insecure-remote' };
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'url-scheme-refused' };
  const path = parsed.pathname.replace(/\/+$/u, '');
  // An OpenAI-compatible base is often given with its `/v1`; the probe path already carries it.
  return { ok: true, base: `${parsed.origin}${path.endsWith('/v1') ? path.slice(0, -3) : path}` };
}

