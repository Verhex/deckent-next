import { chmod } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { runtimeServiceRequestSchema, runtimeServiceResponseSchema, type RuntimeServiceRequest,
  type RuntimeServiceResponse } from '#engine/index.js';
import { listenWithPeerIdentity, type LocalPeerIdentity, type PeerClosure } from './peer.js';
import { encodeServiceFrame, ServiceFrameDecoder, ServiceFrameError } from './framing.js';
import { LocalRuntimeSocketError, removeOwnedSocket, resolveSocketOptions,
  type LocalRuntimeSocketOptions, type ResolvedLocalRuntimeSocketOptions } from './endpoint.js';

export type RuntimeServiceHandlerReply = RuntimeServiceResponse | Readonly<{
  response: RuntimeServiceResponse;
  afterResponseOrDisconnect: () => void;
}>;
export type RuntimeServiceHandler = (request: RuntimeServiceRequest, peer: LocalPeerIdentity) => RuntimeServiceHandlerReply | Promise<RuntimeServiceHandlerReply>;
export interface LocalRuntimeSocketServer { readonly endpoint: string; readonly termination: Promise<PeerClosure>; stopAccepting(): void; disconnectClients(): void; dispose(): Promise<void> }

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const error = (cause: Error & { code?: string }) => {
      server.off('listening', ready);
      reject(cause);
    };
    const ready = () => { server.off('error', error); resolve(); };
    server.once('error', error);
    server.once('listening', ready);
    server.listen(endpoint);
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function transportFailure(requestId: string, code = 'RUNTIME_SERVICE_TRANSPORT'): RuntimeServiceResponse {
  return { schemaVersion: 6, requestId, ok: false, error: { code, category: 'error' } };
}
function isAfterResponseOrDisconnect(value: unknown): value is () => void { return typeof value === 'function'; }
function reply(value: RuntimeServiceHandlerReply) {
  if (value && typeof value === 'object' && 'response' in value && 'afterResponseOrDisconnect' in value) {
    const wrapped = value as { response: RuntimeServiceResponse; afterResponseOrDisconnect: unknown };
    if (!isAfterResponseOrDisconnect(wrapped.afterResponseOrDisconnect)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
    return { response: runtimeServiceResponseSchema.parse(wrapped.response), afterResponseOrDisconnect: wrapped.afterResponseOrDisconnect };
  }
  return { response: runtimeServiceResponseSchema.parse(value), afterResponseOrDisconnect: undefined };
}

function accept(socket: Socket, options: ResolvedLocalRuntimeSocketOptions, handler: RuntimeServiceHandler, peer: LocalPeerIdentity): void {
  const decoder = new ServiceFrameDecoder(options.inputMaxBytes);
  const headerTimer = setTimeout(() => socket.destroy(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT')),
    options.headerTimeoutMs);
  headerTimer.unref();
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let disconnected = false;
  let afterResponseOrDisconnect: (() => void) | undefined;
  let handedOff = false;
  const finishHandoff = () => {
    if (handedOff || !afterResponseOrDisconnect) return;
    handedOff = true;
    try { afterResponseOrDisconnect(); } catch { /* Lifecycle ownership remains outside transport. */ }
  };
  const disconnectedNow = () => {
    disconnected = true; clearTimeout(headerTimer); if (responseTimer) clearTimeout(responseTimer); finishHandoff();
  };
  socket.on('data', chunk => {
    try {
      if (!Buffer.isBuffer(chunk)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
      decoder.push(chunk);
    } catch { socket.destroy(); }
  });
  socket.once('end', () => {
    clearTimeout(headerTimer);
    let request: RuntimeServiceRequest;
    try { request = runtimeServiceRequestSchema.parse(decoder.finish()); }
    catch { socket.destroy(); return; }
    // Prove a correlated error can be delivered before admitting any effect. Tiny limits must not fail after dispatch.
    let limitFrame: Buffer;
    try { limitFrame = encodeServiceFrame(transportFailure(request.requestId, 'RUNTIME_SERVICE_RESPONSE_LIMIT'), options.responseMaxBytes); }
    catch { socket.destroy(); return; }
    void Promise.resolve().then(() => handler(request, peer)).then(reply)
      .then(value => {
        let response = value.response;
        afterResponseOrDisconnect = value.afterResponseOrDisconnect;
        if (disconnected) { finishHandoff(); return; }
        if (response.requestId !== request.requestId) response = transportFailure(request.requestId);
        responseTimer = setTimeout(() => socket.destroy(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT')), options.responseTimeoutMs);
        responseTimer.unref();
        try {
          let frame: Buffer;
          try { frame = encodeServiceFrame(response, options.responseMaxBytes); }
          catch (error) {
            if (!(error instanceof ServiceFrameError) || error.code !== 'SERVICE_FRAME_LIMIT') throw error;
            frame = limitFrame;
          }
          socket.end(frame, () => {
            if (responseTimer) clearTimeout(responseTimer); finishHandoff();
          });
        } catch { socket.destroy(); }
      }, () => {
        if (!disconnected) {
          try { socket.end(encodeServiceFrame(transportFailure(request.requestId), options.responseMaxBytes)); } catch { socket.destroy(); }
        }
      });
  });
  socket.once('error', disconnectedNow);
  socket.once('close', disconnectedNow);
}

export async function startLocalRuntimeSocketServer(options: LocalRuntimeSocketOptions,
  handler: RuntimeServiceHandler): Promise<LocalRuntimeSocketServer> {
  const resolved = await resolveSocketOptions(options);
  const guard = createServer({ allowHalfOpen: true }, socket => socket.destroy());
  try { await listen(guard, resolved.guardEndpoint); }
  catch (error) {
    guard.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new LocalRuntimeSocketError('LOCAL_RUNTIME_ALREADY_RUNNING');
    throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', { cause: error });
  }
  let endpoint: ReturnType<typeof listenWithPeerIdentity> | undefined;
  try {
    await removeOwnedSocket(resolved.endpoint, true);
    endpoint = listenWithPeerIdentity(resolved.endpoint, resolved.maxConnections,
      (socket, peer) => accept(socket, resolved, handler, peer), resolved.acceptRetryDelayMs, resolved.acceptRetryLimit);
    await chmod(resolved.endpoint, 0o600);
  } catch (error) {
    endpoint?.stopAccepting(); endpoint?.disconnectClients();
    try {
      if (endpoint) { await Promise.all([endpoint.drained, endpoint.settled]); endpoint.removeEndpoint(); }
    } finally { await close(guard).catch(() => undefined); }
    if (error instanceof LocalRuntimeSocketError) throw error;
    throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', { cause: error });
  }
  let stopping: Promise<void> | null = null;
  let disposed: Promise<void> | null = null;
  const stopAccepting = () => {
    if (!stopping) { endpoint.stopAccepting(); stopping = Promise.all([endpoint.drained, endpoint.settled]).then(() => undefined); }
  };
  const disconnectClients = () => {
    endpoint.disconnectClients();
  };
  const dispose = async () => {
    if (disposed) return await disposed;
    stopAccepting();
    const stopped = stopping;
    if (!stopped) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
    disposed = (async () => {
      await stopped;
      try { endpoint.removeEndpoint(); }
      finally { await close(guard); }
    })();
    return await disposed;
  };
  return Object.freeze({ endpoint: resolved.endpoint, termination: endpoint.settled, stopAccepting, disconnectClients, dispose });
}
