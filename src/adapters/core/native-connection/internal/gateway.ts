import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { chmod, realpath, lstat, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import catalog from './providers.json' with { type: 'json' };
import { nativeSubscriptionSchema, NativeConnectionError, nativeProviderSpec, projectNativeCredential, type NativeSubscription } from './credential.js';
import { scrubWorkerEvent } from './event-guard.js';
import { INPUT_VALIDATION_LIMITS, inputWithinValidationLimit } from '#platform/index.js';
import { secretValues, type QuotaPolicy } from './worker.js';
import { nativeCliCommand } from '#adapters/core/native-cli-registry/index.js';
import { privateSocketDirectory, tunnelNativeConnect } from './egress.js';
import { workerReportLimits, verifyWorkerModels, workerEventSchema, type WorkerEvent } from '#domain/index.js';
/** One source for the gateway's NDJSON retention budget and the config-load artifact check. */
export function nativeWorkerEventRetentionBytes(): number { return catalog.limits.maxEventBytes; }
/** The one quota classification of native CLI evidence (`providers.json` quotaPolicy), shared by workers and the headless model port. */
export function nativeQuotaPolicy(): QuotaPolicy { return catalog.quotaPolicy; }
export { isPublicNativeAddress } from './egress.js';
/** One per-attempt capability. No TCP listener, TLS interception, redirects, refresh or host writeback. */
/** Receives validated worker events (untrusted, worker-reported evidence) for live observation and retention. */
export type WorkerEventSink = (events: readonly WorkerEvent[]) => void;
export async function openNativeConnection(input: { binding: NativeSubscription; directory: string; credential: Record<string, unknown>; deadlineMs: number;
  onEvents?: WorkerEventSink; dependencyContext?: Readonly<{ text: string; sha256: string }> }) {
  if (input.dependencyContext && (Buffer.byteLength(input.dependencyContext.text) > workerReportLimits.promptBytes
    || createHash('sha256').update(input.dependencyContext.text).digest('hex') !== input.dependencyContext.sha256)) throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE');
  const binding = nativeSubscriptionSchema.parse(input.binding);
  if (input.dependencyContext && !binding.promptDelivery) throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE');
  const spec = nativeProviderSpec(binding.provider);
  const capabilities = nativeCliCommand(binding.provider).capabilities;
  const projected = projectNativeCredential(binding.provider, input.credential);
  const limits = catalog.limits;
  const root = await realpath(input.directory); const stat = await lstat(root);
  if (root !== input.directory || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)
    || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0 || input.deadlineMs > 2_147_483_647) throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE');
  const bootstrapPath = fileURLToPath(new URL('./worker.js', import.meta.url)), bootstrapSha256 = createHash('sha256').update(await readFile(bootstrapPath)).digest('hex');
  const directory = await privateSocketDirectory('connection-');
  const socketPath = join(directory, 'gateway.sock');
  if (Buffer.byteLength(socketPath) > 103) { await rm(directory, { recursive: true }); throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE'); }
  const capabilityPath = join(directory, 'bootstrap.key'), capability = randomBytes(32).toString('hex');
  let credential: Record<string, unknown> | undefined = projected;
  let closed = false; let transferred = 0; let timer: ReturnType<typeof setTimeout>;
  const sockets = new Set<Socket>();
  const statistics = { connected: 0, rejected: 0, bootstrapReads: 0, bytes: 0, events: 0, eventBytes: 0, eventsDropped: 0, eventsUnreported: 0 };
  let secrets: string[] = [...secretValues(projected), capability];
  let lastSequence = 0;
  const reported: { startSeen: boolean; started: string | null; used: readonly string[] | null; ended: boolean } = { startSeen: false, started: null, used: null, ended: false };
  const receiveEvents = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    if (statistics.events >= limits.maxEvents - 1 || statistics.eventBytes >= limits.maxEventBytes - 256) {
      statistics.rejected++; statistics.eventsUnreported++; response.writeHead(429).end(); request.resume(); return;
    }
    const declared = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(declared) || declared <= 0 || declared > limits.eventBatchBytes) { statistics.rejected++; response.writeHead(413).end(); request.resume(); return; }
    let body = ''; let received = 0;
    request.setEncoding('utf8');
    request.on('data', (part: string) => { received += Buffer.byteLength(part); if (received > limits.eventBatchBytes) request.destroy(); else body += part; });
    request.on('end', () => {
      const packet = body.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as unknown; } catch { return null; } });
      if (!inputWithinValidationLimit(packet, INPUT_VALIDATION_LIMITS.worker)) { statistics.rejected++; response.writeHead(413).end(); return; }
      const accepted: WorkerEvent[] = []; let dropped = 0;
      for (const value of packet) {
        const parsed = workerEventSchema.safeParse(value);
        const event = parsed?.success ? scrubWorkerEvent(parsed.data, secrets) : null;
        const bytes = event ? Buffer.byteLength(JSON.stringify(event) + '\n') : 0;
        if (!parsed?.success || parsed.data.kind === 'model.verification' || parsed.data.sequence <= lastSequence || statistics.events >= limits.maxEvents - 1 || statistics.eventBytes + bytes > limits.maxEventBytes - 256) { dropped++; continue; }
        lastSequence = parsed.data.sequence; statistics.events++; statistics.eventBytes += bytes; accepted.push(event!);
        if (parsed.data.kind === 'session.started' && !reported.startSeen) { reported.startSeen = true; reported.started = parsed.data.model; }
        else if (parsed.data.kind === 'session.ended') { reported.ended = true; reported.used = parsed.data.models ?? null; }
      }
      statistics.eventsDropped += dropped;
      if (dropped) {
        const marker: WorkerEvent = { schemaVersion: 1, sequence: lastSequence + 1, atMs: accepted.at(-1)?.atMs ?? 0, kind: 'dropped', reason: 'invalid', count: dropped };
        const markerBytes = Buffer.byteLength(JSON.stringify(marker) + '\n');
        if (statistics.events < limits.maxEvents - 1 && statistics.eventBytes + markerBytes <= limits.maxEventBytes - 256) {
          lastSequence = marker.sequence; statistics.events++; statistics.eventBytes += markerBytes; accepted.push(marker);
        } else statistics.eventsUnreported += dropped;
      }
      try { if (accepted.length) input.onEvents?.(Object.freeze(accepted)); } catch { /* observation never changes execution */ }
      response.writeHead(204).end();
    });
  };
  const server = createServer({ maxHeaderSize: limits.headerBytes }, (request, response) => {
    const offered = request.headers['authorization'];
    if (typeof offered !== 'string' || Buffer.byteLength(offered) !== capability.length || !timingSafeEqual(Buffer.from(offered), Buffer.from(capability))) {
      statistics.rejected++; response.writeHead(403).end(); request.resume(); return;
    }
    if (!closed && request.method === 'POST' && request.url === '/events' && statistics.bootstrapReads > 0) { receiveEvents(request, response); return; }
    if (closed || request.method !== 'GET' || request.url !== '/bootstrap' || !credential || statistics.bootstrapReads > 0) {
      statistics.rejected++; response.writeHead(403).end(); return;
    }
    statistics.bootstrapReads++;
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ schemaVersion: 1, provider: binding.provider, capabilities, home: spec.home, file: spec.file,
      credential, quotaPolicy: catalog.quotaPolicy, preflight: binding.preflight, promptDelivery: binding.promptDelivery, dependencyContext: input.dependencyContext ? { ...input.dependencyContext, maxBytes: workerReportLimits.promptBytes } : undefined, finalReport: binding.finalReport ? { ...binding.finalReport, limits: workerReportLimits } : undefined,
      ...('credentialEnvironment' in spec ? { credentialEnvironment: spec.credentialEnvironment } : {}), environment: spec.environment, limits }));
    credential = undefined;
  });
  server.maxConnections = limits.connections;
  server.headersTimeout = limits.idleMs; server.requestTimeout = limits.idleMs; server.keepAliveTimeout = 1;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', socket => {
    sockets.add(socket); socket.setTimeout(limits.idleMs, () => socket.destroy());
    socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, client, head) => tunnelNativeConnect(request, client as Socket, head, { destinations: spec.destinations, closed: () => closed, sockets,
    count: bytes => { transferred += bytes; statistics.bytes = transferred; return transferred <= limits.trafficBytes; },
    connected: () => { statistics.connected++; }, rejected: () => { statistics.rejected++; } }));
  const close = async () => {
    if (closed) return; closed = true; credential = undefined; secrets = []; clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(capabilityPath, capability, { mode: 0o600, flag: 'wx' });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    timer = setTimeout(() => { void close().catch(() => undefined); }, input.deadlineMs); timer.unref();
    return Object.freeze({ descriptor: Object.freeze({ schemaVersion: 1 as const, socketPath, capabilityPath, bootstrapPath, bootstrapSha256, provider: binding.provider }),
      statistics: () => Object.freeze({ ...statistics, closed }), close,
      /** Host verdict over the accepted worker events against the admitted model (null until the session ended). */
      modelVerification: () => reported.ended ? Object.freeze({ ...verifyWorkerModels({ evidenceCapability: capabilities.modelUsageEvidence, admitted: binding.model ?? null,
        startedModel: reported.started, usedModels: reported.used }), evidenceCapability: capabilities.modelUsageEvidence }) : null });
  } catch { await close(); throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE'); }
}
