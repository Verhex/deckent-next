import { classifyProviderRejection, type ProviderRejectionKind } from '#engine/index.js';
import { PROVIDER_CONNECT_LIMITS, providerConnectKind, providerEndpoint, type ProviderConnectKind } from './registry.js';
import { listKindProviderWorkspaces } from './workspaces.js';
/**
 * The typed outcomes of a connection check (T4 PROVIDER-CONNECT). The rejection names are the secret lane's `ProviderRejectionKind`
 * (`credential-rejected` 401, `access-denied` 403, `spend-limit`, `rate-limit`, `limit-reached`); `unreachable` covers no answer, a timeout
 * and a server error; `unexpected` any other answer (a redirect is never followed: the key would travel to another host).
 */
export const PROVIDER_PROBE_OUTCOMES = ['ok', 'credential-rejected', 'access-denied', 'spend-limit', 'rate-limit', 'limit-reached', 'unreachable', 'unexpected'] as const;
export type ProviderProbeOutcome = typeof PROVIDER_PROBE_OUTCOMES[number];
/** The secret lane's `ProviderRejectionKind` (one vocabulary for a refused turn and a refused check). */
export type ProviderProbeRejection = ProviderRejectionKind;
/** `key`: `verified` — the endpoint answered a request that needs the key; `none` — no key was sent; `unverified` — a local server answered,
 * but it may not check keys at all. Nothing of the answer body is ever returned. */
export type ProviderProbeResult = Readonly<{ outcome: ProviderProbeOutcome; httpStatus: number | null; key: 'verified' | 'none' | 'unverified'; workspaceRequired?: true }>;
export type ProviderProbeInput = Readonly<{ kind: string; endpoint: string | null; key: string | null }>;
export type ProviderProbeFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;
export type ProviderProbeOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal; fetch?: ProviderProbeFetch }>;
export class ProviderProbeError extends Error {
  constructor(readonly code: 'PROVIDER_KIND_UNAVAILABLE' | 'PROVIDER_ENDPOINT_INVALID' | 'PROVIDER_KEY_REQUIRED', readonly reason?: string) { super(code); this.name = 'ProviderProbeError'; }
}
/** How much of a refusal's body is read to tell a spend limit from a rate limit; the text is matched, never kept or returned. */
const BODY_PREFIX_BYTES = PROVIDER_CONNECT_LIMITS.bodyPrefixBytes;
/** A 429 is a rate limit only when its body says so (Anthropic `rate_limit_error`, OpenAI `rate_limit_exceeded`); a body that is missing,
 * unreadable or names nothing known is an unknown limit, never guessed as a rate limit (Astra note on the classifier, 2026-10-08). */
function namesRateLimit(bodyPrefix: string, codes?: Readonly<Record<string, ProviderRejectionKind>>): boolean {
  try {
    const error = (JSON.parse(bodyPrefix) as { error?: { type?: unknown; code?: unknown } } | null)?.error;
    return error?.type === 'rate_limit_error' || error?.code === 'rate_limit_exceeded' || error?.type === 'requests' || error?.type === 'tokens' || (typeof error?.code === 'string' && Object.hasOwn(codes ?? {}, error.code) && codes![error.code] === 'rate-limit');
  } catch { return false; }
}
/**
 * The one mapping point of an HTTP refusal to its typed kind: the secret lane's `classifyProviderRejection` (SECRET-AT-REST 1b, the same kinds
 * the terminal shows for a refused turn), fed the bounded body prefix the same way the invocation evidence carries it (base64 `data`). The
 * connection check only narrows a 429 the classifier calls `rate-limit` to `limit-reached` when the body does not name a rate limit.
 */
export function providerProbeRejection(status: number, bodyPrefix: string | null, codes?: Readonly<Record<string, ProviderRejectionKind>>): ProviderProbeRejection | null {
  const kind = classifyProviderRejection({ reason: 'http-status', httpStatus: status,
    ...(bodyPrefix ? { body: { data: Buffer.from(bodyPrefix, 'utf8').toString('base64') } } : {}) }, codes);
  if (kind === 'rate-limit' && (bodyPrefix === null || !namesRateLimit(bodyPrefix, codes))) return 'limit-reached';
  return kind;
}
async function readPrefix(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < BODY_PREFIX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); bytes += value.byteLength;
    }
  } catch { return null; } finally { void reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).subarray(0, BODY_PREFIX_BYTES).toString('utf8');
}
/** The base URL a kind is checked at: the registry's own, or the person's typed one where the kind lets them choose it. */
export function providerProbeBase(kind: ProviderConnectKind, endpoint: string | null): string {
  const typed = kind.endpoint.editable && endpoint !== null && endpoint.trim() !== '' ? endpoint : kind.endpoint.default;
  if (typed === null) throw new ProviderProbeError('PROVIDER_ENDPOINT_INVALID', 'url-invalid');
  const checked = providerEndpoint(typed);
  if (!checked.ok) throw new ProviderProbeError('PROVIDER_ENDPOINT_INVALID', checked.reason);
  return checked.base;
}
/**
 * One free request that needs the key (GET, bounded time, no redirect), mapped to a typed outcome. The key is sent only in the kind's own header
 * to the kind's endpoint over https (plain http only to this machine); it never appears in the result, an error or a log.
 */
export async function probeProviderConnection(input: ProviderProbeInput, options: ProviderProbeOptions = {}): Promise<ProviderProbeResult> {
  const kind = providerConnectKind(input.kind);
  if (!kind?.available || !kind.key) throw new ProviderProbeError('PROVIDER_KIND_UNAVAILABLE');
  const key = input.key === null || input.key === '' ? null : input.key;
  if (kind.key.required && key === null) throw new ProviderProbeError('PROVIDER_KEY_REQUIRED');
  const base = providerProbeBase(kind, input.endpoint);
  // A provider that documents no free read (T4-B: Z.ai GLM has no models list): nothing is sent; the key is kept unverified (`httpStatus` null)
  // and the first turn shows any rejection.
  if (!kind.probe) return { outcome: 'ok', httpStatus: null, key: key === null ? 'none' : 'unverified' };
  const headers: Record<string, string> = { accept: 'application/json', ...kind.probe.headers };
  if (key !== null) headers[kind.probe.auth.type === 'bearer' ? 'authorization' : kind.probe.auth.name] = kind.probe.auth.type === 'bearer' ? `Bearer ${key}` : key;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PROVIDER_CONNECT_LIMITS.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${base}${kind.probe.path}`, { method: 'GET', headers, redirect: 'manual', signal });
  } catch {
    // A refused connection, a name that does not resolve, a TLS failure or the timeout: no detail (it could name the request).
    options.signal?.throwIfAborted();
    return { outcome: 'unreachable', httpStatus: null, key: key === null ? 'none' : 'unverified' };
  }
  const status = response.status;
  if (status >= 200 && status < 300) {
    void response.body?.cancel().catch(() => undefined);
    return { outcome: 'ok', httpStatus: status, key: key === null ? 'none' : kind.key.required ? 'verified' : 'unverified' };
  }
  const prefix = status === 429 || status === 400 ? await readPrefix(response) : (void response.body?.cancel().catch(() => undefined), null);
  // Multi-workspace identity keys cannot list models without a workspace header. A free organization list establishes identity;
  // the operator still selects a workspace in /model before generation. Never infer this from an arbitrary 400.
  if (status === 400 && kind.connect?.workspaceList && key !== null && prefix) {
    let error: { type?: unknown; message?: unknown } | undefined;
    try { error = (JSON.parse(prefix) as { error?: typeof error }).error; } catch { /* Unknown error remains refused. */ }
    if (error?.type === 'invalid_request_error' && typeof error.message === 'string'
      && error.message.startsWith('anthropic-workspace-id is required when authenticating with an identity-linked API key')) {
      try { const choices = await listKindProviderWorkspaces(kind, base, key, { ...options, signal });
        if (choices.length) return { outcome: 'ok', httpStatus: 200, key: 'unverified', workspaceRequired: true };
      } catch { options.signal?.throwIfAborted(); }
    }
  }
  const rejection = providerProbeRejection(status, prefix, kind.connect?.rejectionCodes);
  if (rejection) return { outcome: rejection, httpStatus: status, key: key === null ? 'none' : 'unverified' };
  return { outcome: status >= 500 ? 'unreachable' : 'unexpected', httpStatus: status, key: key === null ? 'none' : 'unverified' };
}
