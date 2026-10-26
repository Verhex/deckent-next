import { OAuthConnectionError, type OAuthAccessTokenLease } from '#engine/index.js';
import { SIWC_INFERENCE, SIWC_LIMITS } from './registry.js';
import { parseSiwcModels } from './responses.js';
/** Account-scoped, bounded, GET-only discovery. No redirect, retry, credential-name lookup or paid inference. */
export async function listSiwcModels(lease: (signal: AbortSignal) => Promise<OAuthAccessTokenLease>, signal?: AbortSignal) {
  const timeout = new AbortController(), bounded = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), SIWC_LIMITS.httpTimeoutMs); timer.unref();
  try {
    const credential = await lease(bounded);
    if (bounded.aborted || Date.now() >= credential.expiresAtMs) throw new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE');
    const response = await fetch(SIWC_INFERENCE.modelsEndpoint, { method: 'GET', redirect: 'error', signal: bounded,
      headers: { accept: 'application/json', authorization: `Bearer ${credential.accessToken}` } });
    if (response.status !== 200) { await response.body?.cancel(); throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE'); }
    const reader = response.body?.getReader();
    if (!reader) throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > SIWC_INFERENCE.modelsMaxBytes) throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return parseSiwcModels(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) { if (error instanceof OAuthConnectionError) throw error; throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE'); }
  finally { clearTimeout(timer); }
}
