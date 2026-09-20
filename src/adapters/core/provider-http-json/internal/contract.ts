import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/index.js';

export type NativeJsonHttpErrorCode = 'NATIVE_JSON_HTTP_DEFINITION_INVALID' | 'NATIVE_JSON_HTTP_REQUEST_INVALID'
  | 'NATIVE_JSON_HTTP_REQUEST_TOO_LARGE' | 'NATIVE_JSON_HTTP_RESPONSE_TOO_LARGE' | 'NATIVE_JSON_HTTP_TIMEOUT'
  | 'NATIVE_JSON_HTTP_CANCELLED' | 'NATIVE_JSON_HTTP_TRANSPORT_UNKNOWN'
  | 'NATIVE_JSON_HTTP_CREDENTIAL_UNAVAILABLE' | 'NATIVE_JSON_HTTP_CREDENTIAL_ECHO';

/** Error details deliberately exclude provider bodies, prompts, headers, and credentials. */
export class NativeJsonHttpError extends Error {
  constructor(readonly code: NativeJsonHttpErrorCode, readonly status?: number) { super(code); this.name = 'NativeJsonHttpError'; }
}

export type NativeJsonHttpAuthentication = Readonly<{ type: 'none' } | { type: 'bearer'; credentialRef: string }>;
export type NativeJsonHttpDefinition = Readonly<{ endpoint: string; authentication: NativeJsonHttpAuthentication;
  tls?: Readonly<{ caPem: string }> }>;
export type NativeJsonHttpLimits = Readonly<{ requestMaxBytes: number; responseMaxBytes: number; timeoutMs: number }>;

const positive = z.number().int().positive().safe();
const credentialReference = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
const certificate = z.string().min(1).max(65_536).refine(value => {
  if ((value.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1
    || (value.match(/-----END CERTIFICATE-----/g) ?? []).length !== 1 || value.includes('PRIVATE KEY')) return false;
  try {
    const parsed = new X509Certificate(value), canonical = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();
    return canonical(value) === canonical(parsed.toString());
  } catch { return false; }
});
const definitionSchema = z.object({ endpoint: z.string().min(1),
  authentication: z.discriminatedUnion('type', [z.object({ type: z.literal('none') }).strict(),
    z.object({ type: z.literal('bearer'), credentialRef: credentialReference }).strict()]),
  tls: z.object({ caPem: certificate }).strict().optional() }).strict();
const limitsSchema = z.object({ requestMaxBytes: positive, responseMaxBytes: positive,
  timeoutMs: positive.max(2_147_483_647) }).strict();
export const nativeJsonHttpAdapterSchema = z.object({ id: identitySchema, version: counterSchema.positive() }).strict();

function copyPlainData(input: unknown, seen = new WeakSet<object>()): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input) || seen.has(input)) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_DEFINITION_INVALID');
  seen.add(input);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_DEFINITION_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.getOwnPropertySymbols(input).length > 0) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_DEFINITION_INVALID');
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_DEFINITION_INVALID');
    output[key] = copyPlainData(descriptor.value, seen);
  }
  return Object.freeze(output);
}

export function parseNativeJsonHttpDefinition(input: unknown): NativeJsonHttpDefinition {
  let copied: unknown;
  try { copied = copyPlainData(input); } catch (error) {
    if (error instanceof NativeJsonHttpError) throw error;
    throw new NativeJsonHttpError('NATIVE_JSON_HTTP_DEFINITION_INVALID');
  }
  const parsed = definitionSchema.safeParse(copied);
  if (!parsed.success || !isCanonicalEndpoint(parsed.data.endpoint, parsed.data.authentication.type, parsed.data.tls !== undefined)) {
    throw new NativeJsonHttpError('NATIVE_JSON_HTTP_DEFINITION_INVALID');
  }
  return Object.freeze({ endpoint: parsed.data.endpoint, authentication: Object.freeze({ ...parsed.data.authentication }),
    ...(parsed.data.tls ? { tls: Object.freeze({ ...parsed.data.tls }) } : {}) });
}

export function parseNativeJsonHttpLimits(input: unknown): NativeJsonHttpLimits {
  let copied: unknown;
  try { copied = copyPlainData(input); } catch { throw new NativeJsonHttpError('NATIVE_JSON_HTTP_REQUEST_INVALID'); }
  const parsed = limitsSchema.safeParse(copied);
  if (!parsed.success) throw new NativeJsonHttpError('NATIVE_JSON_HTTP_REQUEST_INVALID');
  return Object.freeze(parsed.data);
}

function isCanonicalEndpoint(endpoint: string, authentication: 'none' | 'bearer', hasTls: boolean): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  const common = url.search === '' && url.hash === '' && url.username === '' && url.password === ''
    && !endpoint.includes('?') && !endpoint.includes('#') && url.href === endpoint;
  if (!common) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && authentication === 'none' && !hasTls
    && (url.hostname === '127.0.0.1' || url.hostname === '[::1]') && url.port !== '' && Number(url.port) > 0;
}
