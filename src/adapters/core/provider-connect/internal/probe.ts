import { PROVIDER_CONNECT_LIMITS, providerConnectKind, providerEndpoint, type ProviderConnectKind } from './registry.js';

/**
 * The typed outcomes of a connection check (T4 PROVIDER-CONNECT). The rejection names are the secret lane's `ProviderRejectionKind`
 * (`credential-rejected` 401, `access-denied` 403, `spend-limit`, `rate-limit`, `limit-reached`); `unreachable` covers no answer, a timeout
 * and a server error; `unexpected` any other answer (a redirect is never followed: the key would travel to another host).
 */
export const PROVIDER_PROBE_OUTCOMES = ['ok', 'credential-rejected', 'access-denied', 'spend-limit', 'rate-limit', 'limit-reached', 'unreachable', 'unexpected'] as const;
export type ProviderProbeOutcome = typeof PROVIDER_PROBE_OUTCOMES[number];
export type ProviderProbeRejection = Exclude<ProviderProbeOutcome, 'ok' | 'unreachable' | 'unexpected'>;
/** `key`: `verified` — the endpoint answered a request that needs the key; `none` — no key was sent; `unverified` — a local server answered,
 * but it may not check keys at all. Nothing of the answer body is ever returned. */
export type ProviderProbeResult = Readonly<{ outcome: ProviderProbeOutcome; httpStatus: number | null; key: 'verified' | 'none' | 'unverified' }>;
export type ProviderProbeInput = Readonly<{ kind: string; endpoint: string | null; key: string | null }>;
export type ProviderProbeFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;
export type ProviderProbeOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal; fetch?: ProviderProbeFetch }>;
export class ProviderProbeError extends Error {
  constructor(readonly code: 'PROVIDER_KIND_UNAVAILABLE' | 'PROVIDER_ENDPOINT_INVALID' | 'PROVIDER_KEY_REQUIRED', readonly reason?: string) { super(code); this.name = 'ProviderProbeError'; }
}

/** How much of a refusal's body is read to tell a spend limit from a rate limit; the text is matched, never kept or returned. */
const BODY_PREFIX_BYTES = PROVIDER_CONNECT_LIMITS.bodyPrefixBytes;

/**
 * The one mapping point of an HTTP refusal to its typed kind. INTEGRATION (SECRET-AT-REST, feat/secret-at-rest d55f9cad): replace this body with
 * the secret lane's `classifyProviderRejection(evidence)` from `#engine` (engine/core/agent-turn/internal/metadata.ts) once it is on main; the
 * kind names here are already that function's `PROVIDER_REJECTION_KINDS`. Until then it applies the same published rules.
 */
export function providerProbeRejection(status: number, bodyPrefix: string | null): ProviderProbeRejection | null {
  if (status === 401) return 'credential-rejected';
  if (status === 403) return 'access-denied';
  if (status === 402) return 'spend-limit';
  if (status === 429) {
    if (bodyPrefix === null || bodyPrefix === '') return 'limit-reached';
    return /enforced_spend_limit_reached|insufficient_quota/u.test(bodyPrefix) ? 'spend-limit' : 'rate-limit';
  }
  if (status === 400 && bodyPrefix !== null && /API usage limits/u.test(bodyPrefix)) return 'spend-limit';
  return null;
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
  if (!kind?.available || !kind.probe || !kind.key) throw new ProviderProbeError('PROVIDER_KIND_UNAVAILABLE');
  const key = input.key === null || input.key === '' ? null : input.key;
  if (kind.key.required && key === null) throw new ProviderProbeError('PROVIDER_KEY_REQUIRED');
  const base = providerProbeBase(kind, input.endpoint);
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
  const rejection = providerProbeRejection(status, status === 429 || status === 400 ? await readPrefix(response) : (void response.body?.cancel().catch(() => undefined), null));
  if (rejection) return { outcome: rejection, httpStatus: status, key: key === null ? 'none' : 'unverified' };
  return { outcome: status >= 500 ? 'unreachable' : 'unexpected', httpStatus: status, key: key === null ? 'none' : 'unverified' };
}
