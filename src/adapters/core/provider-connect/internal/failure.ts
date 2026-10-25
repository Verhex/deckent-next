import { classifyProviderRejection } from '#engine/index.js';
import { PROVIDER_CONNECT_LIMITS } from './registry.js';

export type ProviderDiscoveryCause = 'no-credential' | 'credential-rejected' | 'access-denied' | 'rate-limit' | 'spend-limit'
  | 'limit-reached' | 'http-status' | 'redirect' | 'network' | 'timeout' | 'invalid-list' | 'not-listable';
export class ProviderModelListError extends Error {
  constructor(readonly code: 'MODEL_CONNECT_DISCOVERY_UNAVAILABLE' | 'MODEL_CONNECT_DISCOVERY_INVALID' | 'MODEL_CONNECT_DISCOVERY_LIMIT',
    override readonly cause: ProviderDiscoveryCause = 'invalid-list', readonly status?: number) { super(code); this.name = 'ProviderModelListError'; }
}
/** Reads cannot outlive their request, including injected transports with non-cancelling streams. */
export async function readProviderPart(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  signal.throwIfAborted(); let abort!: () => void;
  try { return await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  })]); } finally { signal.removeEventListener('abort', abort); }
}
/** Only the bounded refusal prefix enters the existing classifier; no body or transport text leaves this function. */
export async function providerListHttpError(response: Response, signal: AbortSignal, codes?: Readonly<Record<string, 'spend-limit' | 'rate-limit'>>) {
  let prefix = ''; const reader = response.body?.getReader();
  try { if (reader && (response.status === 400 || response.status === 429)) {
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (bytes < PROVIDER_CONNECT_LIMITS.bodyPrefixBytes) {
      const part = await readProviderPart(reader, signal); if (part.done) break;
      const chunk = part.value.subarray(0, PROVIDER_CONNECT_LIMITS.bodyPrefixBytes - bytes); chunks.push(chunk); bytes += chunk.byteLength;
    }
    prefix = Buffer.concat(chunks, bytes).toString('utf8');
  } } finally { void reader?.cancel().catch(() => undefined); }
  let rejection = classifyProviderRejection({ reason: 'http-status', httpStatus: response.status,
    ...(prefix ? { body: { data: Buffer.from(prefix).toString('base64') } } : {}) }, codes);
  if (rejection === 'rate-limit') {
    let named = false;
    try { const error = (JSON.parse(prefix) as { error?: { type?: string; code?: string } }).error;
      named = error?.type === 'rate_limit_error' || error?.code === 'rate_limit_exceeded' || error?.type === 'requests' || error?.type === 'tokens'
        || typeof error?.code === 'string' && Object.hasOwn(codes ?? {}, error.code) && codes![error.code] === 'rate-limit';
    } catch { /* Unknown 429 limits stay unknown. */ }
    if (!named) rejection = 'limit-reached';
  }
  return new ProviderModelListError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE', response.status >= 300 && response.status < 400 ? 'redirect'
    : rejection ?? 'http-status', response.status);
}
