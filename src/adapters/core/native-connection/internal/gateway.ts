import { createServer } from 'node:http';
import { connect, isIPv4, BlockList, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { chmod, mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import catalog from './providers.json' with { type: 'json' };
import { nativeSubscriptionSchema, NativeConnectionError, projectNativeCredential, type NativeSubscription } from './credential.js';
import { scrubWorkerEvent } from './event-guard.js';
import { secretValues } from './worker.js';
import { readNativeClientHello } from './tls-hello.js';
import { workerEventSchema, type WorkerEvent } from '#domain/index.js';

const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) denied.addSubnet(address, prefix);
export function isPublicNativeAddress(address: string) {
  return isIPv4(address) && !denied.check(address) && !Object.values(networkInterfaces()).flat().some(row => row?.address === address);
}
/** One per-attempt capability. No TCP listener, TLS interception, redirects, refresh or host writeback. */
/** Receives validated worker events (untrusted, worker-reported evidence) for live observation and retention. */
export type WorkerEventSink = (events: readonly WorkerEvent[]) => void;
export async function openNativeConnection(input: { binding: NativeSubscription; directory: string; credential: Record<string, unknown>; deadlineMs: number;
  onEvents?: WorkerEventSink }) {
  const binding = nativeSubscriptionSchema.parse(input.binding); const spec = catalog.providers[binding.provider];
  const projected = projectNativeCredential(binding.provider, input.credential);
  const limits = catalog.limits;
  const root = await realpath(input.directory); const stat = await lstat(root);
  if (root !== input.directory || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)
    || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0 || input.deadlineMs > 2_147_483_647) throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE');
  const bootstrapPath = fileURLToPath(new URL('./worker.js', import.meta.url));
  const bootstrapSha256 = createHash('sha256').update(await readFile(bootstrapPath)).digest('hex');
  const directory = await mkdtemp(join(root, 'connection-')); await chmod(directory, 0o700);
  const socketPath = join(directory, 'gateway.sock');
  if (Buffer.byteLength(socketPath) > 103) { await rm(directory, { recursive: true }); throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE'); }
  let credential: Record<string, unknown> | undefined = projected;
  let closed = false; let transferred = 0; let timer: ReturnType<typeof setTimeout>;
  const sockets = new Set<Socket>();
  const statistics = { connected: 0, rejected: 0, bootstrapReads: 0, bytes: 0, events: 0, eventBytes: 0, eventsDropped: 0, eventsUnreported: 0 };
  // The values this gateway projects into the worker; kept only to scrub events it receives (never sent anywhere).
  let secrets: string[] = secretValues(projected);
  let lastSequence = 0;
  // Worker-reported events after the bootstrap only: bounded per request and per attempt, schema-validated, strictly ordered.
  const receiveEvents = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => {
    // Budget exhausted (one event and a little space stay reserved): refuse without parsing; the loss is sealed later.
    if (statistics.events >= limits.maxEvents - 1 || statistics.eventBytes >= limits.maxEventBytes - 256) {
      statistics.rejected++; statistics.eventsUnreported++; response.writeHead(429).end(); request.resume(); return;
    }
    const declared = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(declared) || declared <= 0 || declared > limits.eventBatchBytes) { statistics.rejected++; response.writeHead(413).end(); request.resume(); return; }
    let body = ''; let received = 0;
    request.setEncoding('utf8');
    request.on('data', (part: string) => { received += Buffer.byteLength(part); if (received > limits.eventBatchBytes) request.destroy(); else body += part; });
    request.on('end', () => {
      const accepted: WorkerEvent[] = []; let dropped = 0;
      for (const line of body.split('\n')) {
        if (!line) continue;
        let parsed; try { parsed = workerEventSchema.safeParse(JSON.parse(line)); } catch { parsed = null; }
        const bytes = Buffer.byteLength(line);
        if (!parsed?.success || parsed.data.sequence <= lastSequence || statistics.events >= limits.maxEvents - 1 || statistics.eventBytes + bytes > limits.maxEventBytes - 256) { dropped++; continue; }
        lastSequence = parsed.data.sequence; statistics.events++; statistics.eventBytes += bytes; accepted.push(scrubWorkerEvent(parsed.data, secrets));
      }
      statistics.eventsDropped += dropped;
      if (dropped) {
        // Loss markers are charged to the same budget; past it they are counted and sealed as one marker at the end.
        const marker: WorkerEvent = { schemaVersion: 1, sequence: lastSequence + 1, atMs: accepted.at(-1)?.atMs ?? 0, kind: 'dropped', reason: 'invalid', count: dropped };
        const markerBytes = Buffer.byteLength(JSON.stringify(marker));
        if (statistics.events < limits.maxEvents - 1 && statistics.eventBytes + markerBytes <= limits.maxEventBytes - 256) {
          lastSequence = marker.sequence; statistics.events++; statistics.eventBytes += markerBytes; accepted.push(marker);
        } else statistics.eventsUnreported += dropped;
      }
      try { if (accepted.length) input.onEvents?.(Object.freeze(accepted)); } catch { /* observation never changes execution */ }
      response.writeHead(204).end();
    });
  };
  const server = createServer({ maxHeaderSize: limits.headerBytes }, (request, response) => {
    if (!closed && request.method === 'POST' && request.url === '/events' && statistics.bootstrapReads > 0) { receiveEvents(request, response); return; }
    if (closed || request.method !== 'GET' || request.url !== '/bootstrap' || !credential || statistics.bootstrapReads > 0) {
      statistics.rejected++; response.writeHead(403).end(); return;
    }
    statistics.bootstrapReads++;
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ schemaVersion: 1, provider: binding.provider, home: spec.home, file: spec.file,
      credential, preflight: binding.preflight, promptDelivery: binding.promptDelivery,
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
  server.on('connect', (request, client, head) => {
    const socket = client as Socket;
    void (async () => {
      const target = request.url ?? ''; const host = target.slice(0, -4);
      if (closed || !target.endsWith(':443') || !spec.destinations.includes(host)) throw new Error();
      const addresses = await lookup(host, { family: 4, all: true });
      if (closed || socket.destroyed || !addresses.length || addresses.some(row => !isPublicNativeAddress(row.address))) throw new Error();
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const hello = await readNativeClientHello(socket, head, host, limits.headerBytes);
      if (closed || socket.destroyed) throw new Error();
      // Use the checked numeric address directly. DNS cannot change between validation and connect.
      const upstream = connect({ host: addresses[0]!.address, port: 443 }); sockets.add(upstream);
      const close = () => { upstream.destroy(); socket.destroy(); };
      upstream.on('error', close); socket.on('error', close);
      upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); }); socket.on('close', () => upstream.destroy());
      upstream.setTimeout(limits.idleMs, close);
      const count = (chunk: Buffer) => { transferred += chunk.length; statistics.bytes = transferred; if (transferred > limits.trafficBytes) close(); };
      upstream.on('data', count); socket.on('data', count);
      upstream.once('connect', () => {
        if (closed) { close(); return; }
        statistics.connected++; count(hello); upstream.write(hello);
        socket.pipe(upstream); upstream.pipe(socket); socket.resume();
      });
    })().catch(() => { statistics.rejected++; socket.destroy(); });
  });
  const close = async () => {
    if (closed) return; closed = true; credential = undefined; secrets = []; clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    timer = setTimeout(() => { void close().catch(() => undefined); }, input.deadlineMs); timer.unref();
    return Object.freeze({ descriptor: Object.freeze({ schemaVersion: 1 as const, socketPath, bootstrapPath, bootstrapSha256 }),
      statistics: () => Object.freeze({ ...statistics, closed }), close });
  } catch { await close(); throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE'); }
}
