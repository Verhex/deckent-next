import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import type { Socket } from 'node:net';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { attemptIdentitySchema, type AuditSubject } from '#domain/index.js';
import type { OAuthAccessTokenLease } from '#engine/index.js';
import { SIWC_WORKER_RELAY as R } from '#adapters/core/provider-siwc/index.js';
import { listenForContainerPeer, localPeerNativePath } from '#adapters/core/local-runtime-socket/index.js';
import { finalReportJsonSchema, isPublicNativeAddress, readFinalReportText } from '#adapters/core/native-connection/index.js';
import { containerInitPeer } from './proc.js';
import { siwcWorkerRequestBody, secretScrubber, type SiwcRelayRefusal } from './request.js';
import { createAppServerTurn, type SiwcNativeApproval } from './client.js';

const text = z.string().min(1).max(256), generation = z.number().int().nonnegative().safe();
/** Nonsecret binding of one relay capability (U9 rev 6 §11.3): app, person, installation/company/scope, connection, Attempt/fence, generations, model. */
export const siwcWorkerBindingSchema = z.object({ schemaVersion: z.literal(1), connectionId: z.string().uuid(), installationId: text, companyId: text,
  person: z.object({ issuer: text, subject: text }).strict().readonly(), attempt: attemptIdentitySchema, model: text,
  /** U6 pin of this Attempt: the worker image id and the Codex CLI version its build receipt recorded. */
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u), codexVersion: text,
  generations: z.object({ connection: generation, custody: generation, consent: generation }).strict().readonly() }).strict().readonly();
export type SiwcWorkerBinding = z.infer<typeof siwcWorkerBindingSchema>;
/** Container mount points of the relay channel and its pinned standalone programs (no credential path). */
export const SIWC_WORKER_PATHS = Object.freeze({ socket: '/run/deckent-relay.sock', bootstrap: '/run/deckent-bootstrap.mjs', helper: '/run/deckent-siwc-helper.mjs', hardening: '/run/deckent-hardening.node',
  /** The native Codex worker's core prompt file (its frozen `model_instructions_file` config names it). */
  instructions: '/tmp/deckent-prompt/core.txt' });
export type SiwcUpstream = (input: Readonly<{ body: string; headers: Readonly<Record<string, string>>; signal: AbortSignal }>) =>
  Promise<Readonly<{ status: number; contentType: string; body: AsyncIterable<Buffer> }>>;
export type SiwcRelayAuditSubject = Extract<AuditSubject, { kind: 'siwc-relay' }>;
export type SiwcRelayRecord = Readonly<{ kind: 'peer-refused' | 'capability-issued' | 'capability-refused' | 'model-relayed' | 'model-refused' | 'approval' | 'revoked' | 'closed';
  requestId?: string; status?: number; reason?: SiwcRelayRefusal | string; bytes?: number }>;

/**
 * U9-7 relay records: observed, then sealed in order through the caller's audit write. `record` resolves false when a record is not durable (the
 * write failed — which also revokes the relay — or it is past the registry bound, then only counted into the closing summary's `suppressed`).
 */
function relayRecorder(input: Readonly<{ onRecord?: (record: SiwcRelayRecord) => void; audit?: (subject: SiwcRelayAuditSubject) => Promise<void> }>, binding: SiwcWorkerBinding,
  digests: Readonly<{ bindingDigest: string; policyDigest: string }>, statistics: Readonly<Record<'peersRefused' | 'capabilityIssued' | 'capabilityRefused' | 'relayed' | 'refused' | 'upstreamSends', number>>,
  failed: () => void) {
  let audits: Promise<unknown> = Promise.resolve(), audited = 0, suppressed = 0;
  const record = (entry: SiwcRelayRecord, summary = false): Promise<boolean> => {
    try { input.onRecord?.(Object.freeze(entry)); } catch { /* observation never changes the relay */ }
    if (!input.audit) return Promise.resolve(true);
    if (!summary && audited >= R.limits.auditRecords) { suppressed++; return Promise.resolve(false); }
    audited++;
    const s = statistics, counters = summary ? { peersRefused: s.peersRefused, capabilityIssued: s.capabilityIssued, capabilityRefused: s.capabilityRefused, relayed: s.relayed,
      refused: s.refused, upstreamSends: s.upstreamSends, suppressed } : null;
    const subject: SiwcRelayAuditSubject = { kind: 'siwc-relay', schemaVersion: 1, action: entry.kind, runId: binding.attempt.runId, taskId: binding.attempt.taskId,
      attemptId: binding.attempt.attemptId, connectionId: binding.connectionId, ...digests, requestId: entry.requestId ?? null, status: entry.status ?? null, bytes: entry.bytes ?? null,
      counters, reason: entry.reason === undefined ? null : /^[a-z][a-z0-9:-]{0,63}$/u.test(entry.reason) ? entry.reason : 'other' };
    const written = audits.then(() => input.audit!(subject)).then(() => true, () => false);
    audits = written.then(durable => { if (!durable) failed(); });
    return written;
  };
  return { record, settled: () => audits };
}
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

/** One relay launch's input (U9-6/7). */
export type SiwcWorkerRelayInput = {
  readonly directory: string; readonly binding: SiwcWorkerBinding; readonly prompt: string; readonly deadlineMs: number; readonly version: string;
  readonly lease: (connectionId: string, signal: AbortSignal) => Promise<OAuthAccessTokenLease>;
  /** Current Deckent decision for one native effect (fence/consent/policy re-read by the caller), asked before the effect. */
  readonly approve: (request: SiwcNativeApproval) => Promise<boolean>;
  /** Fence, consent, custody and connection generations are still current (re-checked before every upstream send). */
  readonly live: () => boolean | Promise<boolean>;
  readonly onRecord?: (record: SiwcRelayRecord) => void; readonly upstream?: SiwcUpstream; readonly appServer?: Readonly<{ executable: string; args: readonly string[] }>;
  /** The durable audit write of one relay record (U9-7): awaited before C is handed out and before an approval is answered (no audit, no
   * effect); every other record is written in order and a failed write revokes the relay. */
  readonly audit?: (subject: SiwcRelayAuditSubject) => Promise<void>;
  /** The frozen native worker's own `-c` config (discovery, core prompt file, effort), applied before the relay's: the same CLI configuration
   * the native Codex worker of this profile runs with. `instructions`: the compiled core prompt for that file. */
  readonly config?: readonly string[]; readonly instructions?: string | null;
  /** The profile asks for the structured final report (native `finalReport`): the turn carries the report schema and the host reads its answer. */
  readonly finalReport?: boolean;
  readonly now?: () => number };
/**
 * U9-6a/6b/6c host side of one SIWC worker launch. A fresh 0700 directory holds one 0600 UNIX socket that is bind-mounted into exactly one
 * container; only that container's init process (the pinned bootstrap, kernel-verified by SO_PEERCRED pid → cgroup + NSpid + start time)
 * is served. It hands out the nonsecret launch spec, issues the relay capability C ONCE (the app-server's first auth-helper call, before any
 * tool can run), bridges the app-server control RPC and relays only the bound Responses request: C is checked and consumed here, the
 * host-only OAuth access A is leased per send and never crosses into the worker; responses are masked for A and C.
 */
export async function openSiwcWorkerRelay(input: SiwcWorkerRelayInput) {
  const binding = siwcWorkerBindingSchema.parse(input.binding), L = R.limits, now = input.now ?? Date.now, upstream = input.upstream ?? httpsUpstream;
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0 || !input.prompt) throw new Error('SIWC_WORKER_ISOLATION_UNAVAILABLE');
  const file = async (name: string) => { const path = fileURLToPath(new URL(`./${name}.js`, import.meta.url)); return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }; };
  const hardeningPath = localPeerNativePath();
  const [bootstrap, helper, hardening] = await Promise.all([file('bootstrap'), file('helper'),
    readFile(hardeningPath).then(bytes => ({ path: hardeningPath, sha256: createHash('sha256').update(bytes).digest('hex') }))]);
  const directory = await mkdtemp(join(input.directory, 'siwc-relay-')); await chmod(directory, 0o700);
  const socketPath = join(directory, 'relay.sock');
  const policySha256 = createHash('sha256').update(JSON.stringify(R)).digest('hex'), bindingSha256 = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  let containerId: string | null = null, init: Readonly<{ pid: number; startTime: string }> | null = null, capability: string | undefined, issued = false;
  let revoked: string | null = null, sequence = 0, inFlight = 0, launched = false, control: ServerResponse | null = null;
  const secrets: string[] = []; // C, for report redaction only (A never reaches the worker or its answer)
  const capabilityDeadline = now() + Math.min(input.deadlineMs, L.capabilityMaxTtlMs), aborts = new Set<AbortController>(), streams = new Set<ServerResponse>();
  // `events`/`bytes`: host-observed activity (app-server control lines received, model bytes relayed) — the R3 silence watch's gateway counters.
  const statistics = { peersRefused: 0, capabilityIssued: 0, capabilityRefused: 0, relayed: 0, refused: 0, upstreamSends: 0, events: 0, bytes: 0 };
  const recorder = relayRecorder(input, binding, { bindingDigest: bindingSha256, policyDigest: policySha256 }, statistics, () => revoke('audit')), record = recorder.record;
  const refuse = (response: ServerResponse, status: number, reason: SiwcRelayRefusal, requestId?: string) => {
    statistics.refused++; void record({ kind: 'model-refused', reason, status, ...(requestId ? { requestId } : {}) });
    if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ error: { type: 'deckent_relay_refused', code: reason } }));
  };
  const turn = createAppServerTurn({ prompt: input.prompt, model: binding.model, version: input.version, ...(input.finalReport ? { outputSchema: finalReportJsonSchema() } : {}), approve: async request => {
    const accepted = !revoked && await input.live() && await input.approve(request);
    // The decision is durable before the app-server hears it: an unrecorded accept is answered as a decline.
    return await record({ kind: 'approval', reason: `${request.kind}:${accepted ? 'accept' : 'decline'}` }) && accepted && !revoked;
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
    response.end(JSON.stringify({ schemaVersion: 1, executable: app.executable, native: R.appServer.native, instructions: input.instructions ? { path: SIWC_WORKER_PATHS.instructions, text: input.instructions } : null,
      args: [...app.args, ...R.appServer.control, ...(input.config ?? []).flatMap(pair => ['-c', pair]), ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])],
      limits: { requestMaxBytes: L.requestMaxBytes, controlLineBytes: L.controlLineBytes, connections: L.connections, idleMs: L.idleMs, helperTimeoutMs: L.helperTimeoutMs, drainMs: L.drainMs, controlConnectMs: L.controlConnectMs, controlPollMs: L.controlPollMs } }));
  };
  const issue = async (response: ServerResponse) => {
    const current = !issued && !revoked && now() < capabilityDeadline && await Promise.resolve(input.live()).catch(() => false);
    if (!current || issued || revoked) { statistics.capabilityRefused++; void record({ kind: 'capability-refused', reason: issued ? 'replay' : 'closed' }); response.writeHead(403).end(); return; }
    // C exists only after its issue is durable (no audit, no capability); the single issue is spent either way.
    issued = true;
    if (!await record({ kind: 'capability-issued' }) || revoked) { statistics.capabilityRefused++; response.writeHead(403).end(); return; }
    capability = randomBytes(L.capabilityBytes).toString('base64url'); secrets.push(capability); statistics.capabilityIssued++;
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
        statistics.events++;
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
      statistics.bytes += Buffer.byteLength(raw);
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
        bytes += chunk.length; statistics.bytes += chunk.length;
        if (bytes > L.responseMaxBytes || revoked) { abort.abort(); response.destroy(); void record({ kind: 'model-refused', requestId, reason: revoked ? 'closed' : 'bound' }); return; }
        response.write(scrub.push(chunk));
      }
      response.end(scrub.end()); statistics.relayed++; void record({ kind: 'model-relayed', requestId, status: answer.status, bytes });
    } catch { if (!response.headersSent) refuse(response, 502, 'upstream', requestId); else response.destroy(); }
    finally { inFlight--; aborts.delete(abort); streams.delete(response); }
  };
  const server = createServer({ maxHeaderSize: L.headerBytes }, (request, response) => {
    const route = `${request.method} ${request.url}`;
    if (route === 'GET /launch' && !launched) { launched = true; launch(response); }
    else if (route === 'POST /capability') { request.resume(); void issue(response); }
    else if (route === 'POST /control') bridge(request, response);
    else if (route === 'POST /v1/responses') void relay(request, response);
    else { request.resume(); refuse(response, 404, 'endpoint'); }
  });
  server.headersTimeout = L.idleMs; server.requestTimeout = 0; server.keepAliveTimeout = L.idleMs;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (_request, socket: Socket) => { statistics.refused++; void record({ kind: 'model-refused', reason: 'endpoint' }); socket.destroy(); });
  const listener = listenForContainerPeer(socketPath, L.connections, peer => {
    const observed = containerId ? containerInitPeer(peer.pid, containerId) : null;
    const admitted = !revoked && observed !== null && (init === null || init.pid === observed.pid && init.startTime === observed.startTime);
    if (admitted) init ??= observed; else { statistics.peersRefused++; void record({ kind: 'peer-refused', reason: 'peer' }); }
    return admitted;
  }, socket => { socket.setTimeout(L.idleMs, () => socket.destroy()); server.emit('connection', socket); });
  await chmod(socketPath, 0o600).catch(() => undefined);
  let closing: Promise<void> | null = null;
  const revoke = (reason: string) => {
    if (revoked) return; revoked = reason; capability = undefined; void record({ kind: 'revoked', reason });
    for (const abort of aborts) abort.abort(); for (const stream of streams) stream.destroy();
    turn.interrupt();
  };
  const close = () => closing ??= (async () => {
    revoke('closed'); listener.close(); control?.end();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    // The closing summary (counts, including records past the bound) is always written; close waits for every pending write.
    await record({ kind: 'closed' }, true); await recorder.settled();
  })();
  const timer = setTimeout(() => revoke('deadline'), input.deadlineMs); timer.unref();
  return Object.freeze({
    descriptor: Object.freeze({ schemaVersion: 1 as const, socketPath, bootstrapPath: bootstrap.path, bootstrapSha256: bootstrap.sha256, helperPath: helper.path,
      helperSha256: helper.sha256, hardeningPath: hardening.path, hardeningSha256: hardening.sha256, policySha256, bindingSha256 }),
    /** The supervisor names the created container before it starts; nothing is served before (or for any other container). */
    bindContainer(id: string) { if (containerId === null && /^[a-f0-9]{64}$/u.test(id)) containerId = id; },
    /** Fence/consent/logout/MOVE/cancel/deadline: invalidate C first, abort upstream sends and streams, then ask the turn to interrupt. */
    revoke, close: async () => { clearTimeout(timer); await close(); },
    /** `turn/completed` alone is never success: a completed turn also needs host-side evidence of a relayed model exchange. */
    outcome: turn.outcome.then(outcome => outcome.status === 'completed' && statistics.relayed === 0 ? Object.freeze({ ...outcome, status: 'failed' as const, reason: 'protocol' as const }) : outcome),
    /** U9-7 final report of a completed turn, read from its last agent message as the native Codex reader reads it (null: not asked). */
    finalReport: () => input.finalReport ? readFinalReportText(turn.finalMessage(), secrets) : null,
    statistics: () => Object.freeze({ ...statistics, eventsDropped: 0, eventsUnreported: 0, revoked, issued, peer: init ? Object.freeze({ ...init }) : null, containerId }),
  });
}
