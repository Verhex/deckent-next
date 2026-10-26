import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import type { Socket } from 'node:net';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { attemptIdentitySchema } from '#domain/index.js';
import type { OAuthAccessTokenLease } from '#engine/index.js';
import { SIWC_WORKER_RELAY as R } from '#adapters/core/provider-siwc/index.js';
import { listenForContainerPeer } from '#adapters/core/local-runtime-socket/index.js';
import { isPublicNativeAddress } from '#adapters/core/native-connection/index.js';
import { containerInitPeer } from './proc.js';
import { siwcWorkerRequestBody, secretScrubber, type SiwcRelayRefusal } from './request.js';
import { createAppServerTurn, type SiwcNativeApproval } from './client.js';

const text = z.string().min(1).max(256), generation = z.number().int().nonnegative().safe();
/** Nonsecret binding of one relay capability (U9 rev 6 §11.3): app, person, installation/company/scope, connection, Attempt/fence, generations, model. */
export const siwcWorkerBindingSchema = z.object({ schemaVersion: z.literal(1), connectionId: z.string().uuid(), installationId: text, companyId: text,
  person: z.object({ issuer: text, subject: text }).strict().readonly(), attempt: attemptIdentitySchema, model: text,
  generations: z.object({ connection: generation, custody: generation, consent: generation }).strict().readonly() }).strict().readonly();
export type SiwcWorkerBinding = z.infer<typeof siwcWorkerBindingSchema>;
/** Container mount points of the relay channel and its pinned standalone programs (no credential path). */
export const SIWC_WORKER_PATHS = Object.freeze({ socket: '/run/deckent-relay.sock', bootstrap: '/run/deckent-bootstrap.mjs', helper: '/run/deckent-siwc-helper.mjs' });
export type SiwcUpstream = (input: Readonly<{ body: string; headers: Readonly<Record<string, string>>; signal: AbortSignal }>) =>
  Promise<Readonly<{ status: number; contentType: string; body: AsyncIterable<Buffer> }>>;
export type SiwcRelayRecord = Readonly<{ kind: 'peer-refused' | 'capability-issued' | 'capability-refused' | 'model-relayed' | 'model-refused' | 'approval' | 'revoked';
  requestId?: string; status?: number; reason?: SiwcRelayRefusal | string; bytes?: number }>;

/** Registry endpoint only, fresh TLS (certificate + host name validated by Node), resolved to public addresses only. */
const httpsUpstream: SiwcUpstream = input => new Promise((resolve, reject) => {
  const url = new URL(R.endpoint);
  const request = httpsRequest({ host: url.hostname, servername: url.hostname, port: 443, path: url.pathname, method: 'POST', headers: input.headers, signal: input.signal, timeout: R.limits.idleMs,
    lookup: (host, options, done) => lookup(host, { ...options, all: true }, (error, addresses) => {
      const rows = Array.isArray(addresses) ? addresses : [];
      if (error || !rows.length || !rows.every(row => isPublicNativeAddress(row.address))) { done(error ?? new Error('SIWC_RELAY_DESTINATION'), '', 4); return; }
      if (options.all) (done as unknown as (e: null, a: typeof rows) => void)(null, rows); else done(null, rows[0]!.address, rows[0]!.family);
    }) }, response => resolve({ status: response.statusCode ?? 502, contentType: String(response.headers['content-type'] ?? 'application/octet-stream'), body: response }));
  request.on('timeout', () => request.destroy(new Error('SIWC_RELAY_TIMEOUT'))); request.on('error', reject); request.end(input.body);
});

/**
 * U9-6a/6b/6c host side of one SIWC worker launch. A fresh 0700 directory holds one 0600 UNIX socket that is bind-mounted into exactly one
 * container; only that container's init process (the pinned bootstrap, kernel-verified by SO_PEERCRED pid → cgroup + NSpid + start time)
 * is served. It hands out the nonsecret launch spec, issues the relay capability C ONCE (the app-server's first auth-helper call, before any
 * tool can run), bridges the app-server control RPC and relays only the bound Responses request: C is checked and consumed here, the
 * host-only OAuth access A is leased per send and never crosses into the worker; responses are masked for A and C.
 */
export async function openSiwcWorkerRelay(input: {
  readonly directory: string; readonly binding: SiwcWorkerBinding; readonly prompt: string; readonly deadlineMs: number; readonly version: string;
  readonly lease: (connectionId: string, signal: AbortSignal) => Promise<OAuthAccessTokenLease>;
  /** Current Deckent decision for one native effect (fence/consent/policy re-read by the caller), asked before the effect. */
  readonly approve: (request: SiwcNativeApproval) => Promise<boolean>;
  /** Fence, consent, custody and connection generations are still current (re-checked before every upstream send). */
  readonly live: () => boolean | Promise<boolean>;
  readonly onRecord?: (record: SiwcRelayRecord) => void; readonly upstream?: SiwcUpstream; readonly appServer?: Readonly<{ executable: string; args: readonly string[] }>;
  readonly now?: () => number }) {
  const binding = siwcWorkerBindingSchema.parse(input.binding), L = R.limits, now = input.now ?? Date.now, upstream = input.upstream ?? httpsUpstream;
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0 || !input.prompt) throw new Error('SIWC_WORKER_ISOLATION_UNAVAILABLE');
  const file = async (name: string) => { const path = fileURLToPath(new URL(`./${name}.js`, import.meta.url)); return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }; };
  const [bootstrap, helper] = await Promise.all([file('bootstrap'), file('helper')]);
  const directory = await mkdtemp(join(input.directory, 'siwc-relay-')); await chmod(directory, 0o700);
  const socketPath = join(directory, 'relay.sock');
  const policySha256 = createHash('sha256').update(JSON.stringify(R)).digest('hex'), bindingSha256 = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  let containerId: string | null = null, init: Readonly<{ pid: number; startTime: string }> | null = null, capability: string | undefined, issued = false;
  let revoked: string | null = null, sequence = 0, inFlight = 0, launched = false, control: ServerResponse | null = null;
  const capabilityDeadline = now() + Math.min(input.deadlineMs, L.capabilityMaxTtlMs), aborts = new Set<AbortController>(), streams = new Set<ServerResponse>();
  const statistics = { peersRefused: 0, capabilityIssued: 0, capabilityRefused: 0, relayed: 0, refused: 0, upstreamSends: 0 };
  const record = (entry: SiwcRelayRecord) => { try { input.onRecord?.(Object.freeze(entry)); } catch { /* observation never changes the relay */ } };
  const refuse = (response: ServerResponse, status: number, reason: SiwcRelayRefusal, requestId?: string) => {
    statistics.refused++; record({ kind: 'model-refused', reason, status, ...(requestId ? { requestId } : {}) });
    if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: { type: 'deckent_relay_refused', code: reason } }));
  };
  const turn = createAppServerTurn({ prompt: input.prompt, model: binding.model, version: input.version, approve: async request => {
    const accepted = !revoked && await input.live() && await input.approve(request); record({ kind: 'approval', reason: `${request.kind}:${accepted ? 'accept' : 'decline'}` }); return accepted;
  }, send: message => { if (control && !control.writableEnded) control.write(JSON.stringify(message) + '\n'); } });
  // A settled turn ends the control channel: the bootstrap closes app-server stdin and the worker exits (no second turn on this launch).
  void turn.outcome.then(() => { if (control && !control.writableEnded) control.end(); });
  const body = (request: IncomingMessage, max: number) => new Promise<string | null>(resolve => {
    const declared = Number(request.headers['content-length']); let size = 0; const parts: Buffer[] = [];
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > max) { request.resume(); resolve(null); return; }
    request.on('data', (part: Buffer) => { size += part.length; if (size > max) { request.destroy(); resolve(null); } else parts.push(part); });
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8'))); request.on('error', () => resolve(null));
  });
  const launch = (response: ServerResponse) => {
    const overrides = { model: binding.model, model_provider: 'deckent_relay', 'model_providers.deckent_relay.name': R.appName,
      'model_providers.deckent_relay.base_url': 'http://127.0.0.1:{shimPort}/v1', 'model_providers.deckent_relay.wire_api': R.wireApi,
      'model_providers.deckent_relay.supports_websockets': false, 'model_providers.deckent_relay.auth.command': 'node',
      'model_providers.deckent_relay.auth.args': [SIWC_WORKER_PATHS.helper, '{capPort}'], 'model_providers.deckent_relay.auth.timeout_ms': L.helperTimeoutMs,
      'model_providers.deckent_relay.auth.refresh_interval_ms': 0, approval_policy: R.approvalPolicy, sandbox_mode: R.sandbox, 'history.persistence': 'none',
      check_for_update_on_startup: false, web_search: 'disabled' };
    const app = input.appServer ?? R.appServer;
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ schemaVersion: 1, executable: app.executable, args: [...app.args, ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
      limits: { requestMaxBytes: L.requestMaxBytes, controlLineBytes: L.controlLineBytes, connections: L.connections, idleMs: L.idleMs, helperTimeoutMs: L.helperTimeoutMs, drainMs: L.drainMs } }));
  };
  const issue = (response: ServerResponse) => {
    if (issued || revoked || now() >= capabilityDeadline) { statistics.capabilityRefused++; record({ kind: 'capability-refused', reason: issued ? 'replay' : 'closed' }); response.writeHead(403).end(); return; }
    issued = true; capability = randomBytes(L.capabilityBytes).toString('base64url'); statistics.capabilityIssued++; record({ kind: 'capability-issued' });
    response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end(capability);
  };
  const bridge = (request: IncomingMessage, response: ServerResponse) => {
    if (control || revoked) { response.writeHead(409).end(); request.resume(); return; }
    control = response; response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    let buffer = '', lines = 0;
    request.setEncoding('utf8');
    request.on('data', (part: string) => {
      buffer += part;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (++lines > L.controlLines) { request.destroy(); return; }
        try { const message = JSON.parse(line) as unknown; if (message && typeof message === 'object' && !Array.isArray(message)) turn.receive(message as Record<string, unknown>); } catch { /* not JSON-RPC */ }
      }
      if (Buffer.byteLength(buffer) > L.controlLineBytes) request.destroy();
    });
    const lost = () => { turn.lost(); if (!response.writableEnded) response.end(); };
    request.on('close', lost); response.on('close', lost);
    turn.start();
  };
  const relay = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = randomUUID(), presented = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(String(request.headers['authorization'] ?? ''))?.[1];
    const seq = Number(request.headers['x-deckent-sequence']);
    if (revoked || !capability || now() >= capabilityDeadline) { request.resume(); refuse(response, 401, 'capability', requestId); return; }
    if (!presented || presented.length !== capability.length || !timingSafeEqual(Buffer.from(presented), Buffer.from(capability))) { request.resume(); refuse(response, 401, 'capability', requestId); return; }
    if (!Number.isSafeInteger(seq) || seq <= sequence) { request.resume(); refuse(response, 409, 'replay', requestId); return; }
    sequence = seq;
    if (inFlight >= L.inFlight) { request.resume(); refuse(response, 429, 'bound', requestId); return; }
    inFlight++; const abort = new AbortController(); aborts.add(abort);
    try {
      const raw = await body(request, L.requestMaxBytes);
      if (raw === null) { refuse(response, 413, 'bound', requestId); return; }
      const built = siwcWorkerRequestBody(raw, binding.model);
      if ('refusal' in built) { refuse(response, 400, built.refusal, requestId); return; }
      if (revoked || !await input.live()) { refuse(response, 403, 'authority', requestId); return; }
      const lease = await input.lease(binding.connectionId, abort.signal);
      if (revoked || !Number.isSafeInteger(lease.expiresAtMs) || now() >= lease.expiresAtMs) { refuse(response, 401, 'upstream', requestId); return; }
      statistics.upstreamSends++;
      const answer = await upstream({ body: built.body, signal: abort.signal, headers: { authorization: `Bearer ${lease.accessToken}`, 'content-type': 'application/json',
        accept: 'text/event-stream', originator: R.appName, 'user-agent': `${R.appName}/${input.version}`, 'content-length': String(Buffer.byteLength(built.body)) } });
      const scrub = secretScrubber([lease.accessToken, capability ?? '']); let bytes = 0;
      streams.add(response);
      response.writeHead(answer.status, { 'content-type': /^(text\/event-stream|application\/json)\b/u.test(answer.contentType) ? answer.contentType : 'application/octet-stream', 'cache-control': 'no-store' });
      for await (const chunk of answer.body) {
        bytes += chunk.length;
        if (bytes > L.responseMaxBytes || revoked) { abort.abort(); response.destroy(); record({ kind: 'model-refused', requestId, reason: revoked ? 'closed' : 'bound' }); return; }
        response.write(scrub.push(chunk));
      }
      response.end(scrub.end()); statistics.relayed++; record({ kind: 'model-relayed', requestId, status: answer.status, bytes });
    } catch { if (!response.headersSent) refuse(response, 502, 'upstream', requestId); else response.destroy(); }
    finally { inFlight--; aborts.delete(abort); streams.delete(response); }
  };
  const server = createServer({ maxHeaderSize: L.headerBytes }, (request, response) => {
    const route = `${request.method} ${request.url}`;
    if (route === 'GET /launch' && !launched) { launched = true; launch(response); }
    else if (route === 'POST /capability') { request.resume(); issue(response); }
    else if (route === 'POST /control') bridge(request, response);
    else if (route === 'POST /v1/responses') void relay(request, response);
    else { request.resume(); refuse(response, 404, 'endpoint'); }
  });
  server.headersTimeout = L.idleMs; server.requestTimeout = 0; server.keepAliveTimeout = L.idleMs;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (_request, socket: Socket) => { statistics.refused++; record({ kind: 'model-refused', reason: 'endpoint' }); socket.destroy(); });
  const listener = listenForContainerPeer(socketPath, L.connections, peer => {
    const observed = containerId ? containerInitPeer(peer.pid, containerId) : null;
    const admitted = !revoked && observed !== null && (init === null || init.pid === observed.pid && init.startTime === observed.startTime);
    if (admitted) init ??= observed; else { statistics.peersRefused++; record({ kind: 'peer-refused', reason: 'peer' }); }
    return admitted;
  }, socket => { socket.setTimeout(L.idleMs, () => socket.destroy()); server.emit('connection', socket); });
  await chmod(socketPath, 0o600).catch(() => undefined);
  let closing: Promise<void> | null = null;
  const revoke = (reason: string) => {
    if (revoked) return; revoked = reason; capability = undefined; record({ kind: 'revoked', reason });
    for (const abort of aborts) abort.abort(); for (const stream of streams) stream.destroy();
    turn.interrupt();
  };
  const close = () => closing ??= (async () => {
    revoke('closed'); listener.close(); control?.end();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  })();
  const timer = setTimeout(() => revoke('deadline'), input.deadlineMs); timer.unref();
  return Object.freeze({
    descriptor: Object.freeze({ schemaVersion: 1 as const, socketPath, bootstrapPath: bootstrap.path, bootstrapSha256: bootstrap.sha256, helperPath: helper.path,
      helperSha256: helper.sha256, policySha256, bindingSha256 }),
    /** The supervisor names the created container before it starts; nothing is served before (or for any other container). */
    bindContainer(id: string) { if (containerId === null && /^[a-f0-9]{64}$/u.test(id)) containerId = id; },
    /** Fence/consent/logout/MOVE/cancel/deadline: invalidate C first, abort upstream sends and streams, then ask the turn to interrupt. */
    revoke, close: async () => { clearTimeout(timer); await close(); },
    outcome: turn.outcome,
    statistics: () => Object.freeze({ ...statistics, revoked, issued, peer: init ? Object.freeze({ ...init }) : null, containerId }),
  });
}
