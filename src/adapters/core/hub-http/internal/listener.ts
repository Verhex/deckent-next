import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer, type ServerOptions as TlsOptions } from 'node:https';
import { isIP, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { HUB_LIMITS } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';

export class HubNetworkError extends Error {
  constructor(readonly code: 'HUB_TLS_REQUIRED' | 'HUB_NETWORK_INVALID' | 'HUB_NETWORK_FAILED' | 'HUB_FIRST_USE_REQUIRED') {
    super(ErrorRegistry.get(code)!.message); this.name = 'HubNetworkError';
  }
}
export interface HubListenerOptions {
  readonly enabled?: boolean;
  /** Literal bind address, default loopback; names are refused to avoid ambiguous DNS/TLS scope. */
  readonly host?: string;
  readonly port: number;
  readonly endpoint: string;
  /** Material is loaded by the protected hub-process composition, never accepted from a request or logged. */
  readonly tls?: Pick<TlsOptions, 'cert' | 'key' | 'ca'>;
  readonly fetch: (request: Request) => Promise<Response>;
}
/** Own-process listener adapter. Construction has no effect while hub.serve is off. */
export async function startHubHttpListener(options: HubListenerOptions) {
  if (!options.enabled) return null;
  const host = options.host ?? '127.0.0.1', local = host === '::1' || /^127\./.test(host);
  if (!local && (!options.tls?.cert || !options.tls.key)) throw new HubNetworkError('HUB_TLS_REQUIRED');
  const endpoint = new URL(options.endpoint);
  if (!isIP(host) || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535
    || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || !['http:', 'https:'].includes(endpoint.protocol)
    || (endpoint.protocol === 'https:') !== Boolean(options.tls?.cert && options.tls.key)) throw new HubNetworkError('HUB_NETWORK_INVALID');
  let active = 0;
  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    if (active >= HUB_LIMITS.httpMaxConcurrentRequests) { outgoing.writeHead(503).end(); return; }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); incoming.destroy(); outgoing.destroy(); }, HUB_LIMITS.fetchTimeoutMs);
    const abort = () => { if (!outgoing.writableFinished) controller.abort(); };
    outgoing.once('close', abort); incoming.once('aborted', abort);
    try {
      // Never route authority from an untrusted Host or absolute request-target.
      const path = incoming.url ?? '/';
      if (!path.startsWith('/') || path.startsWith('//') || incoming.headers.host !== endpoint.host) { outgoing.writeHead(403).end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > HUB_LIMITS.httpMaxBytes) { outgoing.writeHead(413).end(); incoming.resume(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const method = incoming.method ?? 'GET';
      const request = new Request(new URL(path, endpoint.origin), { method, headers, signal: controller.signal,
        ...(method !== 'GET' && method !== 'HEAD' ? { body: Buffer.concat(chunks, size) } : {}) });
      const response = await options.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader(); let sent = 0;
        try {
          for (;;) {
            controller.signal.throwIfAborted();
            const next = await reader.read(); if (next.done) break;
            sent += next.value.length;
            if (sent > HUB_LIMITS.httpMaxBytes) { controller.abort(); outgoing.destroy(); break; }
            if (!outgoing.write(next.value)) await once(outgoing, 'drain', { signal: controller.signal });
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      outgoing.end();
    } catch { if (!outgoing.headersSent) outgoing.writeHead(500).end(); else outgoing.destroy(); }
    finally { clearTimeout(timer); outgoing.off('close', abort); incoming.off('aborted', abort); active--; }
  };
  const listener = (request: IncomingMessage, response: ServerResponse) => { void handle(request, response); };
  const server = options.tls ? createTlsServer({ ...options.tls, minVersion: 'TLSv1.2' }, listener) : createServer(listener);
  server.requestTimeout = HUB_LIMITS.fetchTimeoutMs; server.headersTimeout = HUB_LIMITS.fetchTimeoutMs;
  server.maxConnections = HUB_LIMITS.httpMaxConcurrentRequests;
  try { server.listen(options.port, host); await once(server, 'listening'); }
  catch { server.close(); throw new HubNetworkError('HUB_NETWORK_FAILED'); }
  // Named type: an inferred one is spelled `import("net")` in the published declaration, a module the zero-dependency package cannot resolve.
  const address: AddressInfo | string | null = server.address();
  return { address, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve(); }); server.closeAllConnections();
  }) };
}
