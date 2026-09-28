import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { isPublicNativeAddress } from '#adapters/core/native-connection/index.js';

/**
 * How the fetch adapter reaches the network (FETCH S6): name resolution, a TCP connection to one already checked address on port 443,
 * and optional extra trust anchors. The product always uses {@link SYSTEM_FETCH_TRANSPORT}; a test may route a checked address to a local
 * TLS server. The public-address check is not part of the transport: it runs in {@link fetchHttps} on every answer before any connect.
 */
export interface HttpFetchTransport {
  resolve(host: string): Promise<readonly string[]>;
  connect(address: string): Duplex;
  readonly ca?: readonly string[];
}
export const SYSTEM_FETCH_TRANSPORT: HttpFetchTransport = Object.freeze({
  async resolve(host: string) { return (await lookup(host, { all: true, verbatim: true })).map(row => row.address); },
  connect(address: string) { return netConnect({ host: address, port: 443 }); },
});

export const FETCH_USER_AGENT = 'Deckent-Fetch/1';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/**
 * `response`: the final response was read (any HTTP status). `refused`: nothing was sent (bad URL, name not resolved, a non-public
 * address, TLS or connection failure before the request; or a timeout before it). `stopped`: requests were sent and answered, but a
 * redirect could not be followed. `unknown`: the request was sent and then timed out, was cancelled or broke — never sent again.
 */
export interface HttpFetchResult {
  readonly outcome: 'response' | 'refused' | 'stopped' | 'unknown';
  readonly reason: string | null;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly body: Buffer;
  readonly truncated: boolean;
  readonly finalUrl: string;
  readonly redirects: number;
  readonly location?: string;
}

/** A URL a hop may request: https on the default port, no credentials, a host name (never an IP literal: SNI names the host). */
export function fetchableUrlError(url: URL): string | null {
  if (url.protocol !== 'https:') return 'not-https';
  if (url.username || url.password) return 'credentials-in-url';
  if (url.port !== '' && url.port !== '443') return 'port-not-allowed';
  if (isIP(url.hostname.replace(/^\[|\]$/gu, '')) !== 0) return 'ip-literal-host';
  return null;
}

type Exchange = { readonly status: number; readonly contentType: string | null; readonly location: string | null; readonly body: Buffer; readonly truncated: boolean };
/** One GET over TLS to `address` with SNI and Host = `host`; the body is cut at `maxBytes` (the connection is then closed). */
function exchange(transport: HttpFetchTransport, host: string, address: string, path: string, maxBytes: number, signal: AbortSignal,
  onSent: () => void): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const raw = transport.connect(address);
    const socket = tlsConnect({ socket: raw, servername: host, ALPNProtocols: ['http/1.1'], ...(transport.ca ? { ca: [...transport.ca] } : {}) });
    // The request is written by the HTTP client into the TLS socket, which holds it until the handshake is done: from then on it is sent.
    socket.once('secureConnect', onSent);
    const request = httpRequest({ host, path, method: 'GET', createConnection: () => socket,
      headers: { host, 'user-agent': FETCH_USER_AGENT, accept: '*/*', 'accept-encoding': 'identity' } });
    const close = () => { request.destroy(); socket.destroy(); raw.destroy(); };
    const finish = (error: unknown, value?: Exchange) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); close();
      if (value) resolve(value); else reject(error);
    };
    const abort = () => finish(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    raw.on('error', error => finish(error));
    request.on('error', error => finish(error));
    request.on('response', (response: IncomingMessage) => {
      const status = response.statusCode ?? 0, header = (name: string) => { const value = response.headers[name]; return typeof value === 'string' ? value : null; };
      const base = { status, contentType: header('content-type'), location: header('location') };
      if (REDIRECT_STATUSES.has(status) && base.location !== null) { finish(null, { ...base, body: Buffer.alloc(0), truncated: false }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        if (size + chunk.length > maxBytes) {
          chunks.push(chunk.subarray(0, maxBytes - size)); size = maxBytes;
          finish(null, { ...base, body: Buffer.concat(chunks, size), truncated: true }); return;
        }
        chunks.push(chunk); size += chunk.length;
      });
      response.on('end', () => finish(null, { ...base, body: Buffer.concat(chunks, size), truncated: false }));
      response.on('error', error => finish(error));
      response.on('close', () => { if (!response.complete) finish(new Error('connection-broken')); });
    });
    request.end();
  });
}

/**
 * The governed HTTPS GET of `fetch_url` (FETCH S6). Every hop — the URL and at most `maxRedirects` redirects — resolves its host, requires
 * every answer to be a public address (the gateway's own check, extended to IPv6), connects to the checked address (no second
 * resolution) with SNI and Host = host, and sends no credentials or cookies. A redirect is followed only to an allowed host
 * (`redirectAllowed`) over https; anything else stops the fetch. The body is cut at `maxBytes`. `timeoutMs` bounds the whole call.
 */
export async function fetchHttps(input: { readonly url: string; readonly maxBytes: number; readonly timeoutMs: number; readonly maxRedirects: number;
  readonly redirectAllowed: (host: string) => boolean; readonly transport: HttpFetchTransport; readonly signal?: AbortSignal }): Promise<HttpFetchResult> {
  const deadline = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let url: URL, redirects = 0, sent = false;
  try { url = new URL(input.url); } catch { return end('refused', 'invalid-url', input.url); }
  url.hash = '';
  function end(outcome: HttpFetchResult['outcome'], reason: string | null, finalUrl: string, extra: Partial<HttpFetchResult> = {}): HttpFetchResult {
    return Object.freeze({ outcome, reason, httpStatus: null, contentType: null, body: Buffer.alloc(0), truncated: false, finalUrl, redirects, ...extra });
  }
  // Before the first request is sent nothing happened (refused); after it, a stop keeps what was answered and an interruption is unknown.
  const interrupted = () => end(sent ? 'unknown' : 'refused', deadline.aborted ? 'timed-out' : 'cancelled', url.href);
  const failed = (reason: string, extra: Partial<HttpFetchResult> = {}) => end(sent ? 'stopped' : 'refused', reason, url.href, extra);
  const invalid = fetchableUrlError(url);
  if (invalid) return failed(invalid);
  for (;;) {
    const host = url.hostname;
    let addresses: readonly string[];
    try {
      addresses = await Promise.race([input.transport.resolve(host), new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
    } catch { return signal.aborted ? interrupted() : failed('dns-failed'); }
    if (signal.aborted) return interrupted();
    if (!addresses.length || addresses.some(address => !isPublicNativeAddress(address))) return failed('address-not-public');
    let answer: Exchange;
    try { answer = await exchange(input.transport, host, addresses[0]!, `${url.pathname}${url.search}`, input.maxBytes, signal, () => { sent = true; }); }
    catch (error) {
      if (signal.aborted) return interrupted();
      if (sent) return end('unknown', 'connection-broken', url.href);
      const code = String((error as { code?: unknown })?.code ?? '');
      return failed(code.startsWith('ERR_TLS') || /CERT|SSL|SELF_SIGNED|UNABLE_TO/u.test(code) ? 'tls-failed' : 'connect-failed');
    }
    if (answer.location === null || !REDIRECT_STATUSES.has(answer.status)) {
      return end('response', null, url.href, { httpStatus: answer.status, contentType: answer.contentType, body: answer.body, truncated: answer.truncated });
    }
    if (redirects >= input.maxRedirects) return failed('too-many-redirects', { httpStatus: answer.status, location: answer.location });
    let next: URL;
    try { next = new URL(answer.location, url); } catch { return failed('redirect-refused', { httpStatus: answer.status, location: answer.location }); }
    next.hash = '';
    if (fetchableUrlError(next) !== null || !input.redirectAllowed(next.hostname)) return failed('redirect-refused', { httpStatus: answer.status, location: next.href });
    url = next; redirects++;
  }
}
