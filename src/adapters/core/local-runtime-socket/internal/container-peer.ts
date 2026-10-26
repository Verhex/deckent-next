import { createRequire } from 'node:module';
import { closeSync } from 'node:fs';
import { Socket } from 'node:net';
import { LocalRuntimeSocketError } from './endpoint.js';

/** Host-pid-namespace credentials of one accepted peer (SO_PEERCRED); `isActive` re-checks them against the still-connected socket. */
export type ContainerPeer = Readonly<{ pid: number; uid: number; gid: number; isActive: () => boolean }>;
interface Handoff { peer: { pid: number; uid: number; gid: number }; takeFd(): number }
interface Native { isConnectionActive(fd: number, pid: number, uid: number, gid: number): boolean;
  createListener(endpoint: string, backlog: number, onConnection: (handoff: Handoff) => void, onLifecycle: () => void, retryDelayMs: number, retryLimit: number): { close(): void; removeEndpoint(): void } }

/**
 * U9-6: a private 0600 UNIX endpoint for a peer in ANOTHER namespace set (a bind-mounted container worker). Unlike the runtime service
 * listener it does not require the service's own namespaces (SEC-1 stays there); the caller's `admit` decides from kernel facts it reads
 * for the host pid (the owner uid is required here). A refused or vanished peer is closed before any byte is read.
 */
export function listenForContainerPeer(endpoint: string, maxConnections: number, admit: (peer: Omit<ContainerPeer, 'isActive'>) => boolean,
  onConnection: (socket: Socket, peer: ContainerPeer) => void) {
  let native: Native;
  try { native = createRequire(import.meta.url)('../native/build/Release/peer_credentials.node') as Native; }
  catch (error) { throw new LocalRuntimeSocketError('LOCAL_RUNTIME_NATIVE_UNAVAILABLE', { cause: error }); }
  const clients = new Set<Socket>(); let stopped = false;
  const listener = native.createListener(endpoint, maxConnections, handoff => {
    const { pid, uid, gid } = handoff.peer, fd = handoff.takeFd();
    let admitted = false;
    try { admitted = !stopped && clients.size < maxConnections && uid === process.getuid?.() && pid > 0 && [pid, uid, gid].every(Number.isSafeInteger)
      && admit({ pid, uid, gid }) && native.isConnectionActive(fd, pid, uid, gid); } catch { /* refused below */ }
    let socket: Socket;
    try { if (!admitted) throw new Error(); socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true }); }
    catch { closeSync(fd); return; }
    clients.add(socket); socket.once('close', () => clients.delete(socket)); socket.on('error', () => socket.destroy());
    try { onConnection(socket, Object.freeze({ pid, uid, gid, isActive: () => !socket.destroyed && native.isConnectionActive(fd, pid, uid, gid) })); }
    catch { socket.destroy(); }
  }, () => { stopped = true; }, 50, 3);
  return Object.freeze({
    close() { stopped = true; listener.close(); for (const socket of clients) socket.destroy(); try { listener.removeEndpoint(); } catch { /* the caller removes its private directory */ } },
  });
}
/** U9-6: the same audited native module, mounted read-only into a SIWC worker so its bootstrap can make itself non-dumpable. */
export function localPeerNativePath(): string { return createRequire(import.meta.url).resolve('../native/build/Release/peer_credentials.node'); }
