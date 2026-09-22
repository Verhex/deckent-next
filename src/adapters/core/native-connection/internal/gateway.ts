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
import { readNativeClientHello } from './tls-hello.js';

const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) denied.addSubnet(address, prefix);
export function isPublicNativeAddress(address: string) {
  return isIPv4(address) && !denied.check(address) && !Object.values(networkInterfaces()).flat().some(row => row?.address === address);
}
/** One per-attempt capability. No TCP listener, TLS interception, redirects, refresh or host writeback. */
export async function openNativeConnection(input: { binding: NativeSubscription; directory: string; credential: Record<string, unknown>; deadlineMs: number }) {
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
  const statistics = { connected: 0, rejected: 0, bootstrapReads: 0, bytes: 0 };
  const server = createServer({ maxHeaderSize: limits.headerBytes }, (request, response) => {
    if (closed || request.method !== 'GET' || request.url !== '/bootstrap' || !credential || statistics.bootstrapReads > 0) {
      statistics.rejected++; response.writeHead(403).end(); return;
    }
    statistics.bootstrapReads++;
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ schemaVersion: 1, provider: binding.provider, home: spec.home, file: spec.file,
      credential, preflight: binding.preflight,
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
    if (closed) return; closed = true; credential = undefined; clearTimeout(timer);
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
