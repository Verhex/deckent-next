import { z } from 'zod';
import asset from './registry.json' with { type: 'json' };
import { openAiChatDialectSchema } from '#adapters/core/provider-openai-chat/index.js';

/**
 * The connection kinds the terminal `/provider` window offers (T4 PROVIDER-CONNECT): where each kind is reached, which free request proves
 * a key (a model list or the key's own record — never a billed call), how the key is sent, and the secret-store name it is kept under. Vendor
 * endpoints are versioned data here, not code (ARCHITECTURE literal rule); a kind with `available: false` is listed with its reason only.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The invocation adapters a connection can be bound to (adapter ids, not vendors): Anthropic Messages and OpenAI chat completions. */
export const PROVIDER_CONNECT_ADAPTERS = ['anthropic-messages-http', 'openai-chat-http'] as const;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const secretNameSchema = z.string().regex(SECRET_NAME);
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
  /** The secret-store name of the key: fixed per vendor row, or (the generic row, Jev da5312fb) derived per connection from the endpoint's host. */
  key: z.object({ required: z.boolean(), secretName: secretNameSchema.nullable(),
    derive: z.object({ from: z.literal('endpoint-host'), prefix: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}_$/u) }).strict().optional() }).strict()
    .refine(key => (key.secretName === null) === (key.derive !== undefined)).nullable(),
  /** T4-B `models connect`: the invocation adapter, the chat path under the endpoint base and the packaged catalog seed (null: only models already
   * declared in the provider catalog). Null: the kind stores a key but no model can be connected to it yet. */
  connect: z.object({ adapter: z.enum(PROVIDER_CONNECT_ADAPTERS), chatPath: z.string().regex(/^\/[A-Za-z0-9/._-]{1,127}$/u),
    seed: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u).nullable(),
    /** Owner 2026-10-08: no paid call to a remote endpoint without a verified price. `true`: a remote (non-loopback) address needs the operator's
     * declared price, which the SPEND-SETTLEMENT lane brings; until then such a connection is refused (`MODEL_CONNECT_PRICE_REQUIRED`). */
    priceRequired: z.boolean().default(false),
    /** K1: the provider's documented request dialect (OpenAI chat adapter v5; required for that adapter, refused for the Anthropic one). */
    dialect: openAiChatDialectSchema.optional() }).strict()
    .refine(connect => (connect.adapter === 'openai-chat-http') === (connect.dialect !== undefined)).nullable().default(null),
}).strict().readonly();
const positive = z.number().int().positive().safe();
const registrySchema = z.object({ schemaVersion: z.literal(2), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), note: z.string(),
  limits: z.object({ timeoutMs: positive, bodyPrefixBytes: positive }).strict(),
  /** Key names an earlier release stored that no row uses any more (T4-A's shared OpenAI-compatible slot): `/provider` warns and offers removal. */
  legacyKeys: z.array(z.object({ secretName: secretNameSchema, moveTo: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u) }).strict()).max(16).readonly().default([]),
  /** What a connected model's invocation profile starts with (data; the person can change the written profile on the governed config path). */
  profileDefaults: z.object({ requestMaxBytes: positive, responseMaxBytes: positive, timeoutMs: positive, maxInFlight: positive,
    maxOutputTokens: positive, currency: z.string().regex(/^[A-Z]{3}$/u) }).strict(),
  kinds: z.array(kindSchema).min(1).readonly() }).strict().readonly();

export type ProviderConnectKind = z.infer<typeof kindSchema>;
export type ProviderConnectRegistry = z.infer<typeof registrySchema>;
export const PROVIDER_CONNECT_REGISTRY_VERSION = 2;
/** Parsed once at load: a malformed data file fails the import, never a later connect. */
const registry = registrySchema.parse(asset);
export const PROVIDER_CONNECT_KINDS: readonly ProviderConnectKind[] = Object.freeze(registry.kinds);
/** The check's time bound and how much of a refusal body is read to classify it (data, not code). */
export const PROVIDER_CONNECT_LIMITS = Object.freeze({ ...registry.limits });
export const PROVIDER_CONNECT_LEGACY_KEYS = registry.legacyKeys;
/** The shipped registry (T4-B `models connect` reads kinds and profile defaults from it; a test may hand its own through the composition port). */
export const PROVIDER_CONNECT_REGISTRY: ProviderConnectRegistry = registry;
/** A registry document parsed by the same schema (test and Enterprise overlays use it; a malformed one throws). */
export function parseProviderConnectRegistry(input: unknown): ProviderConnectRegistry { return registrySchema.parse(input); }

export function providerConnectKind(id: string): ProviderConnectKind | null {
  return PROVIDER_CONNECT_KINDS.find(kind => kind.id === id) ?? null;
}

/**
 * The secret-store name of one connection's key (Jev da5312fb): a vendor row's own fixed name, or for the generic row the prefix plus the chosen
 * endpoint's host (and a non-default port), upper-cased with every other character as `_` — e.g. `https://llm.example.com:8443/v1` →
 * `DECKENT_OAICOMPAT_LLM_EXAMPLE_COM_8443`. Shown before anything is saved; null when the kind keeps no key or the address is not valid.
 */
export function providerConnectSecretName(kind: ProviderConnectKind, endpoint: string | null): string | null {
  if (!kind.key) return null;
  if (kind.key.secretName !== null) return kind.key.secretName;
  const derive = kind.key.derive;
  if (!derive || endpoint === null) return null;
  const checked = providerEndpoint(endpoint);
  if (!checked.ok) return null;
  const url = new URL(checked.base);
  const host = `${url.hostname.replace(/^\[|\]$/gu, '')}${url.port ? `_${url.port}` : ''}`.toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  const name = `${derive.prefix}${host}`.slice(0, 128).replace(/_+$/u, '');
  return SECRET_NAME.test(name) && name.length > derive.prefix.length ? name : null;
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

