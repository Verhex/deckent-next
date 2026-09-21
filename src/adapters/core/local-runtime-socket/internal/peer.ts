import { createRequire } from 'node:module';
import { closeSync } from 'node:fs';
import { Socket } from 'node:net';
import { LocalRuntimeSocketError } from './endpoint.js';

export type LocalPeerIdentity = Readonly<{ pid: number; uid: number; gid: number; assurance: 'linux-so-peercred'; connection?: AbortSignal }>;
interface PeerHandoff { peer: { pid: number; uid: number; gid: number }; takeFd(): number }
export type PeerClosure = Readonly<{ state: 'closed'; reason: 'requested' | 'poll-failed' | 'accept-failed' }>;
interface PeerAcceptor { close(): void; removeEndpoint(): void }
interface PeerModule { createListener(endpoint: string, backlog: number, onConnection: (handoff: PeerHandoff) => void, onLifecycle: (event: PeerClosure) => void, retryDelayMs: number, retryLimit: number): PeerAcceptor }

/** The native adapter owns accept and SO_PEERCRED; no private Node Socket fields are accessed. */
export function listenWithPeerIdentity(endpoint: string, maxConnections: number,
  onConnection: (socket: Socket, peer: LocalPeerIdentity) => void, retryDelayMs: number, retryLimit: number) {
  let native: PeerModule;
  try { native = createRequire(import.meta.url)('../native/build/Release/peer_credentials.node') as PeerModule; }
  catch (error) { throw new LocalRuntimeSocketError('LOCAL_RUNTIME_UNSUPPORTED', { cause: error }); }
  const clients = new Set<Socket>();
  let stopped = false; let finish: (() => void) | undefined;
  const drained = new Promise<void>(resolve => { finish = resolve; });
  let settle!: (event: PeerClosure) => void;
  const settled = new Promise<PeerClosure>(resolve => { settle = resolve; });
  const listener = native.createListener(endpoint, maxConnections, handoff => {
    const { pid, uid, gid } = handoff.peer;
    // Local socket owner is the sole allowed OS principal; root is not implicitly granted access.
    if (stopped || clients.size >= maxConnections || uid !== process.getuid?.()
      || ![pid, uid, gid].every(value => Number.isSafeInteger(value) && value >= 0) || pid === 0) return;
    const fd = handoff.takeFd();
    let socket: Socket;
    try { socket = new Socket({ fd, readable: true, writable: true, allowHalfOpen: true }); }
    catch { closeSync(fd); return; }
    const connection = new AbortController();
    socket.once('close', () => connection.abort());
    socket.once('error', () => connection.abort());
    clients.add(socket);
    socket.once('close', () => { clients.delete(socket); if (stopped && !clients.size) finish?.(); });
    socket.on('error', () => undefined);
    try {
      const identity = Object.defineProperty({ pid, uid, gid, assurance: 'linux-so-peercred' as const }, 'connection', { value: connection.signal });
      onConnection(socket, Object.freeze(identity));
    }
    catch { socket.destroy(); }
  }, event => {
    stopped = true; if (!clients.size) finish?.();
    settle(Object.freeze({ state: event.state, reason: event.reason }));
  }, retryDelayMs, retryLimit);
  return Object.freeze({
    stopAccepting() { if (!stopped) { stopped = true; listener.close(); if (!clients.size) finish?.(); } },
    disconnectClients() { for (const socket of clients) socket.destroy(); },
    removeEndpoint() {
      try { listener.removeEndpoint(); }
      catch (cause) { throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ENDPOINT_UNSAFE', { cause }); }
    },
    drained, settled,
  });
}
