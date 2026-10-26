import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { connect, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';
import { HUB_LIMITS } from '#domain/index.js';
import { readHubHttpBody } from './body.js';
import { isPublicNativeAddress } from '#adapters/core/native-connection/index.js';

export interface HubHttpTransport {
  resolve(host: string): Promise<readonly string[]>;
  connect(address: string, port: number): Duplex;
  readonly ca?: readonly string[];
}
export const SYSTEM_HUB_HTTP_TRANSPORT: HubHttpTransport = Object.freeze({
  async resolve(host: string) { return (await lookup(host, { all: true, verbatim: true })).map(row => row.address); },
  connect(address: string, port: number) { return connect({ host: address, port }); },
});
export interface HubHttpResult {
  readonly outcome: 'response' | 'refused' | 'unknown' | 'stopped';
  readonly reason: string | null; readonly status: number | null; readonly headers: Headers; readonly body: Uint8Array;
}
const empty = (outcome: HubHttpResult['outcome'], reason: string): HubHttpResult => ({ outcome, reason, status: null, headers: new Headers(), body: new Uint8Array() });
const redirects = new Set([301, 302, 303, 307, 308]);
const preservingRedirects = new Set([307, 308]);
/** One bounded exchange; TLS keeps the configured hostname while TCP connects to the already checked IP. */
function exchange(request: Request, url: URL, address: string, body: Uint8Array, transport: HubHttpTransport, signal: AbortSignal, sent: () => void): Promise<HubHttpResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const secure = url.protocol === 'https:', host = url.hostname.replace(/^\[|\]$/g, '');
    const raw = transport.connect(address, Number(url.port || (secure ? 443 : 80)));
    const socket = secure ? tlsConnect({ socket: raw, host, ...(isIP(host) ? {} : { servername: host }), ALPNProtocols: ['http/1.1'],
      ...(transport.ca ? { ca: [...transport.ca] } : {}) }) : raw;
    socket.once(secure ? 'secureConnect' : 'connect', sent);
    const headers = Object.fromEntries(request.headers);
    // Host and framing are determined here; callers cannot smuggle a second request or route the checked address elsewhere.
    for (const name of ['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'proxy-authorization']) delete headers[name];
    const wire = httpRequest({ host, port: Number(url.port || (secure ? 443 : 80)), path: `${url.pathname}${url.search}`, method: request.method,
      createConnection: () => socket, headers: { ...headers, host: url.host, 'content-length': body.byteLength, connection: 'close', 'accept-encoding': 'identity' } });
    const finish = (error: unknown, value?: HubHttpResult) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); wire.destroy(); socket.destroy(); raw.destroy();
      if (value) resolve(value); else reject(error);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    raw.on('error', finish); socket.on('error', finish); wire.on('error', finish);
    wire.on('response', response => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined && name !== 'set-cookie') responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      const result = { outcome: 'response' as const, reason: null, status: response.statusCode ?? 502, headers: responseHeaders };
      response.on('error', finish);
      if (redirects.has(result.status)) { finish(null, { ...result, body: new Uint8Array() }); return; }
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > HUB_LIMITS.httpMaxBytes) { finish(null, empty('unknown', 'response-too-large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, { ...result, body: Buffer.concat(chunks, size) }));
      response.on('close', () => { if (!response.complete) finish(new Error()); });
    });
    wire.end(body);
  });
}
/** No retry, cross-origin redirect, cookie jar or ambient fetch. Explicit local sources alone may reach private addresses/plain HTTP. */
export async function hubHttpRequest(request: Request, options: { readonly local: boolean; readonly transport?: HubHttpTransport }): Promise<HubHttpResult> {
  const transport = options.transport ?? SYSTEM_HUB_HTTP_TRANSPORT;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(HUB_LIMITS.fetchTimeoutMs)]);
  const origin = new URL(request.url).origin;
  let url = new URL(request.url), sent = false;
  let body: Uint8Array;
  try { body = await readHubHttpBody(request, signal); } catch { return empty('refused', 'request-invalid'); }
  if (body.byteLength > HUB_LIMITS.httpMaxBytes || !['GET', 'POST'].includes(request.method)) return empty('refused', 'request-invalid');
  for (let hop = 0; ; hop++) {
    if (signal.aborted) return empty(sent ? 'unknown' : 'refused', 'cancelled');
    if (url.origin !== origin || url.username || url.password || url.hash || url.search || url.protocol !== 'https:' && !(options.local && url.protocol === 'http:')) return empty(sent ? 'stopped' : 'refused', 'url-refused');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: readonly string[];
    let abort!: () => void;
    try {
      addresses = await Promise.race([isIP(host) ? Promise.resolve([host]) : transport.resolve(host), new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      })]);
    } catch { return empty(sent ? 'unknown' : 'refused', 'dns-or-cancellation'); }
    finally { signal.removeEventListener('abort', abort); }
    if (signal.aborted) return empty(sent ? 'unknown' : 'refused', 'cancelled');
    let permitted = false;
    try { permitted = addresses.length > 0 && addresses.every(address => isIP(address) && (options.local || isPublicNativeAddress(address))); } catch { /* An unavailable interface inventory cannot certify public egress. */ }
    if (!permitted) return empty(sent ? 'stopped' : 'refused', 'address-not-public');
    let result: HubHttpResult;
    try { result = await exchange(request, url, addresses[0]!, body, transport, signal, () => { sent = true; }); }
    catch { return empty(sent ? 'unknown' : 'refused', 'connection-or-cancellation'); }
    if (result.status === null || !redirects.has(result.status)) return result;
    if (hop >= HUB_LIMITS.maxRedirects || request.method === 'POST' && !preservingRedirects.has(result.status)) return empty('stopped', 'redirect-refused');
    const location = result.headers.get('location');
    if (!location) return empty('stopped', 'redirect-refused');
    try { url = new URL(location, url); } catch { return empty('stopped', 'redirect-refused'); }
  }
}
