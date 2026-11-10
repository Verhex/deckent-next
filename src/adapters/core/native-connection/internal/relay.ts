import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import { timingSafeEqual } from 'node:crypto';
import { isPublicNativeAddress } from './egress.js';
import type { NativeRelaySpec } from './credential.js';

/** Byte-stream masking of exact secret values (latin1 keeps bytes 1:1); a value split across chunks is held until it can be decided. */
export function secretScrubber(values: readonly string[]) {
  const secrets = values.filter(value => value.length >= 8), hold = Math.max(0, ...secrets.map(value => value.length - 1));
  let pending = '';
  const mask = (text: string) => secrets.reduce((current, secret) => current.split(secret).join('[REDACTED]'), text);
  return Object.freeze({
    push(chunk: Buffer): Buffer { const text = mask(pending + chunk.toString('latin1')), cut = Math.max(0, text.length - hold); pending = text.slice(cut); return Buffer.from(text.slice(0, cut), 'latin1'); },
    end(): Buffer { const text = mask(pending); pending = ''; return Buffer.from(text, 'latin1'); },
  });
}
export type NativeRelayUpstream = (input: Readonly<{ method: string; url: string; headers: Readonly<Record<string, string>>; body: Buffer; signal: AbortSignal }>) =>
  Promise<Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: AsyncIterable<Buffer> }>>;
/** Fresh TLS to the registry origin only (certificate + host name validated by Node), resolved to public addresses only; no redirect is followed. */
const httpsRelayUpstream: NativeRelayUpstream = input => new Promise((resolve, reject) => {
  const url = new URL(input.url);
  const call = httpsRequest({ host: url.hostname, servername: url.hostname, port: 443, path: url.pathname + url.search, method: input.method, headers: input.headers, signal: input.signal,
    lookup: (host, options, done) => lookup(host, { ...options, all: true }, (error, addresses) => {
      const rows = Array.isArray(addresses) ? addresses : [];
      if (error || !rows.length || !rows.every(row => isPublicNativeAddress(row.address))) { done(error ?? new Error('NATIVE_RELAY_DESTINATION'), '', 4); return; }
      if (options.all) (done as unknown as (e: null, a: typeof rows) => void)(null, rows); else done(null, rows[0]!.address, rows[0]!.family);
    }) }, response => resolve({ status: response.statusCode ?? 502, headers: Object.fromEntries(Object.entries(response.headers).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : [])), body: response }));
  call.on('error', reject); call.end(input.body);
});
/** Request headers never forwarded: hop-by-hop, host, every credential-bearing header (the relay sets its own), the length and the encoding (identity
 * bodies keep the response masking exact). */
const DROPPED = new Set(['host', 'authorization', 'cookie', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'content-length', 'accept-encoding', 'x-deckent-sequence']);
const RESPONSE_DROPPED = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding']);
type NativeRelayCredential = Readonly<{ accessToken: string; accountId: string | null }>;
type NativeRelayStatistics = { relayed: number; refused: number };

/**
 * Owner 2026-11-08 (alpha.64 card): one host relay per Attempt gateway. Only the registry routes are forwarded, only with this gateway's capability
 * (issued once to its bootstrap; a capability of another Attempt's gateway never matches), only for the admitted model; the person's login is
 * attached here per request and never crosses into the container; responses are masked for the token and the capability.
 */
export function createNativeRelay(input: Readonly<{ spec: NativeRelaySpec; credential: () => NativeRelayCredential | undefined; capability: () => string | undefined;
  model: string | null; count: (bytes: number) => boolean; statistics: NativeRelayStatistics; upstream?: NativeRelayUpstream }>) {
  const { spec } = input, upstream = input.upstream ?? httpsRelayUpstream;
  let busy = false, served = 0, abandoned = 0;
  const route = (request: IncomingMessage) => {
    const [path, query] = (request.url ?? '').split(/\?(.*)/su);
    return spec.routes.find(row => request.method === row.method && path === spec.basePath + row.path && (row.query || query === undefined)) ?? null;
  };
  const refuse = (response: ServerResponse, status: number, code: string) => {
    input.statistics.refused++; if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: { type: 'deckent_relay_refused', code } }));
  };
  const body = (request: IncomingMessage) => new Promise<Buffer | null>(resolve => {
    let size = 0; const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => { size += part.length; if (size > spec.requestBytes || !input.count(part.length)) { request.destroy(); resolve(null); } else parts.push(part); });
    request.on('end', () => resolve(Buffer.concat(parts))); request.on('error', () => resolve(null)); request.on('close', () => resolve(null));
  });
  return Object.freeze({
    /** Whether this request is addressed to the relay at all (the gateway serves everything else). */
    matches: (request: IncomingMessage) => (request.url ?? '').startsWith(spec.basePath + '/'),
    async handle(request: IncomingMessage, response: ServerResponse) {
      const capability = input.capability(), credential = input.credential(), offered = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(String(request.headers['authorization'] ?? ''))?.[1];
      if (!capability || !credential || !offered || offered.length !== capability.length || !timingSafeEqual(Buffer.from(offered), Buffer.from(capability))) { request.resume(); refuse(response, 401, 'capability'); return; }
      const row = route(request);
      if (!row) { request.resume(); refuse(response, 404, 'endpoint'); return; }
      // One metered (`exclusive`) request at a time and a bounded total per Attempt: whatever else reaches the shim cannot multiply the spend. The CLI
      // itself fetches models twice in parallel at start and overlaps them with its first model call (codex-cli 0.166.0 probe 2026-11-09).
      if ((row.exclusive && (busy || abandoned >= spec.maxAbandoned)) || served >= spec.maxRequests) { request.resume(); refuse(response, 429, 'NATIVE_RELAY_LIMIT'); return; }
      served++; if (!row.exclusive) { await forward(request, response, row, capability, credential); return; }
      // A model call the client dropped frees the slot, but the provider may still be generating it: such calls count against a small budget of
      // their own, so start-and-drop cannot run many generations at once (security review of d57464963).
      let dropped = false; response.on('close', () => { if (!response.writableEnded) dropped = true; });
      busy = true; try { await forward(request, response, row, capability, credential); } finally { busy = false; if (dropped) abandoned++; }
    },
  });
  async function forward(request: IncomingMessage, response: ServerResponse, row: NativeRelaySpec['routes'][number], capability: string, credential: NativeRelayCredential) {
    const raw = await body(request);
    if (raw === null) { refuse(response, 413, 'bound'); return; }
    if (row.method === 'POST' && input.model !== null) {
      let model: unknown; try { model = (JSON.parse(raw.toString('utf8')) as { model?: unknown }).model; } catch { model = undefined; }
      if (model !== input.model) { refuse(response, 400, 'model'); return; }
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string' && !DROPPED.has(key) && key !== spec.accountHeader) headers[key] = value;
    headers['authorization'] = `Bearer ${credential.accessToken}`; if (credential.accountId) headers[spec.accountHeader] = credential.accountId;
    headers['content-length'] = String(raw.length);
    const abort = new AbortController(); response.on('close', () => abort.abort());
    try {
      const answer = await upstream({ method: row.method, url: spec.origin + request.url, headers, body: raw, signal: abort.signal });
      const scrub = secretScrubber([credential.accessToken, capability]); let bytes = 0;
      response.writeHead(answer.status, { ...Object.fromEntries(Object.entries(answer.headers).filter(([key]) => !RESPONSE_DROPPED.has(key))), 'cache-control': 'no-store' });
      for await (const chunk of answer.body) {
        bytes += chunk.length;
        if (bytes > spec.responseBytes || !input.count(chunk.length)) { abort.abort(); response.destroy(); input.statistics.refused++; return; }
        response.write(scrub.push(chunk));
      }
      response.end(scrub.end()); input.statistics.relayed++;
    } catch { if (!response.headersSent) refuse(response, 502, 'upstream'); else response.destroy(); }
  }
}
