import { createServer, type IncomingMessage } from 'node:http';
import { connect, isIPv4, isIPv6, BlockList, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import catalog from './providers.json' with { type: 'json' };
import { NativeConnectionError, nativeProviderSpec, type NativeSubscription } from './credential.js';
import { readNativeClientHello } from './tls-hello.js';
import { HEADLESS_EGRESS_HOST, type HeadlessEgress, type HeadlessEgressReason } from '#domain/index.js';
import { privateIpcRoot } from '#platform/index.js';
const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) denied.addSubnet(address, prefix);
// IPv6 (FETCH S6): only global unicast 2000::/3, without the special-purpose blocks inside it (IETF protocol assignments incl.
const globalV6 = new BlockList(), deniedV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) deniedV6.addSubnet(address, prefix, 'ipv6');
/** Whether a numeric address is publicly routable and not this machine's own (the gateway resolves IPv4 only; the fetch adapter both). */
export function isPublicNativeAddress(address: string) {
  const routable = isIPv4(address) ? !denied.check(address) : isIPv6(address) && globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
  return routable && !Object.values(networkInterfaces()).flat().some(row => row?.address === address);
}
/** What one CONNECT tunnel shares with the gateway that owns it: the destination allowlist, its lifetime, its sockets and its traffic budget. */
export interface NativeTunnelContext {
  readonly destinations: readonly string[];
  readonly closed: () => boolean;
  readonly sockets: Set<Socket>;
  /** Adds transferred bytes to the owner's budget; `false` = over it (the tunnel closes). */
  readonly count: (bytes: number) => boolean;
  readonly connected: () => void;
  /** A refused request; `target` is the CONNECT target as asked (`host:port`), absent for a request that is not a CONNECT. */
  readonly rejected: (target?: string, reason?: HeadlessEgressReason) => void;
}
/**
 * One CONNECT request (workers' gateway and the isolated headless CLI alike): only `<allowlisted host>:443`, resolved once to public IPv4
 * addresses, the client's TLS ClientHello must name that host (no termination, no certificate replacement), then a byte-bounded pipe to the
 * checked numeric address. Anything else is refused by closing the client socket without a tunnel.
 */
export function tunnelNativeConnect(request: IncomingMessage, client: Socket, head: Buffer, context: NativeTunnelContext): void {
  const limits = catalog.limits;
  let reason: HeadlessEgressReason = 'gateway-closed', rejected = false;
  const reject = () => { if (!rejected) { rejected = true; context.rejected(request.url ?? '', reason); } };
  void (async () => {
    const target = request.url ?? ''; const host = target.slice(0, -4);
    if (context.closed()) throw new Error();
    reason = 'allowlist'; if (!target.endsWith(':443') || !context.destinations.includes(host)) throw new Error();
    reason = 'dns'; const addresses = await lookup(host, { family: 4, all: true });
    reason = 'gateway-closed'; if (context.closed() || client.destroyed) throw new Error();
    reason = 'unknown'; const publicAddresses = addresses.length > 0 && addresses.every(row => isPublicNativeAddress(row.address));
    reason = 'non-public'; if (!publicAddresses) throw new Error();
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    reason = 'client-hello'; const hello = await readNativeClientHello(client, head, host, limits.headerBytes);
    reason = 'gateway-closed'; if (context.closed() || client.destroyed) throw new Error();
    reason = 'upstream'; const upstream = connect({ host: addresses[0]!.address, port: 443 }); context.sockets.add(upstream);
    const close = () => { upstream.destroy(); client.destroy(); };
    upstream.on('error', () => { reason = 'upstream'; reject(); close(); }); client.on('error', close);
    upstream.on('close', () => { context.sockets.delete(upstream); client.destroy(); }); client.on('close', () => upstream.destroy());
    upstream.setTimeout(limits.idleMs, close);
    const count = (chunk: Buffer) => { if (!context.count(chunk.length)) { reason = 'byte-budget'; reject(); close(); } };
    upstream.on('data', count); client.on('data', count);
    upstream.once('connect', () => {
      if (context.closed()) { reason = 'gateway-closed'; reject(); close(); return; }
      context.connected(); count(hello); if (upstream.destroyed) return; upstream.write(hello);
      client.pipe(upstream); upstream.pipe(client); client.resume();
    });
  })().catch(() => { reject(); client.destroy(); });
}
/** f5: the gateway's refusals by host name for doctor and the invocation record: a CONNECT target's host part when it is a valid lower-case DNS name,
 * up to `refusedHostsMax` distinct names (`providers.json`); anything else (no host, a bracketed or malformed one, past the bound) counts as `other`. */
function refusedHosts(max: number) {
  const hosts: Record<string, number> = Object.create(null) as Record<string, number>, reasons: NonNullable<HeadlessEgress['reasons']> = {}, otherReasons: NonNullable<HeadlessEgress['otherReasons']> = {}; let other = 0;
  return { add(target: string | undefined, reason: HeadlessEgressReason) {
    const host = target === undefined ? '' : target.slice(0, Math.max(0, target.lastIndexOf(':'))).toLowerCase();
    if (HEADLESS_EGRESS_HOST.test(host) && (Object.hasOwn(hosts, host) || Object.keys(hosts).length < max)) {
      hosts[host] = (hosts[host] ?? 0) + 1; const row = Object.hasOwn(reasons, host) ? reasons[host]! : (reasons[host] = {}); row[reason] = (row[reason] ?? 0) + 1;
    } else { other++; otherReasons[reason] = (otherReasons[reason] ?? 0) + 1; }
  }, view: () => Object.freeze({ hosts: Object.freeze({ ...hosts }), other, reasons: Object.fromEntries(Object.entries(reasons).map(([host, row]) => [host, { ...row }])), otherReasons: { ...otherReasons } }) };
}
/** Private per-socket directory; long paths use the short root every open sandbox hides, even before the socket exists. */
export const privateSocketDirectory = async (parent: string, prefix: string, file: string) => { const directory = await mkdtemp(Buffer.byteLength(join(parent, `${prefix}XXXXXX`, file)) > 103
  ? join(await privateIpcRoot(), prefix) : join(parent, prefix)); await chmod(directory, 0o700); return directory; };
/** The gateway limits a connection's server applies (`providers.json`), shared with the in-realm relay that feeds it. */
export const nativeEgressLimits = () => Object.freeze({ connections: catalog.limits.connections, idleMs: catalog.limits.idleMs, headerBytes: catalog.limits.headerBytes,
  refusedHostsMax: catalog.limits.refusedHostsMax });
/**
 * S3-5: the only way out of an isolated CLI's empty network namespace. A Unix-socket HTTP server in a fresh 0700 directory under `directory`
 * that answers nothing but CONNECT to the provider's `providers.json` destinations (the same allowlist, address check and ClientHello check as a
 * worker's gateway), bounded in connections, idle time and traffic; no credential, no bootstrap, no event channel.
 */
export async function openNativeEgressGateway(input: { readonly provider: NativeSubscription['provider']; readonly directory: string }) {
  const spec = nativeProviderSpec(input.provider), limits = catalog.limits;
  const directory = await privateSocketDirectory(input.directory, 'egress-', 'gateway.sock');
  const socketPath = join(directory, 'gateway.sock');
  let closed = false, transferred = 0;
  const sockets = new Set<Socket>(), statistics = { connected: 0, rejected: 0, bytes: 0 }, refused = refusedHosts(limits.refusedHostsMax);
  const reject = (target?: string, reason: HeadlessEgressReason = 'unknown') => { statistics.rejected++; refused.add(target, reason); };
  const server = createServer({ maxHeaderSize: limits.headerBytes }, (_request, response) => { reject(); response.writeHead(403).end(); });
  server.maxConnections = limits.connections;
  server.headersTimeout = limits.idleMs; server.requestTimeout = limits.idleMs; server.keepAliveTimeout = 1;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', socket => {
    sockets.add(socket); socket.setTimeout(limits.idleMs, () => socket.destroy());
    socket.on('error', () => socket.destroy()); socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, client, head) => tunnelNativeConnect(request, client as Socket, head, { destinations: spec.destinations, closed: () => closed, sockets,
    count: bytes => { transferred += bytes; statistics.bytes = transferred; return transferred <= limits.trafficBytes; },
    connected: () => { statistics.connected++; }, rejected: reject }));
  const close = async () => {
    if (closed) return; closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  if (Buffer.byteLength(socketPath) > 103) { await close(); throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE'); }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch { await close(); throw new NativeConnectionError('NATIVE_CONNECTION_UNAVAILABLE'); }
  /** The call's gateway summary (counts and refused host names only; `HeadlessEgress` shape). */
  const egress = (): HeadlessEgress => Object.freeze({ connected: statistics.connected, refused: statistics.rejected, ...refused.view() });
  return Object.freeze({ socketPath, statistics: () => Object.freeze({ ...statistics, closed }), egress, close });
}
