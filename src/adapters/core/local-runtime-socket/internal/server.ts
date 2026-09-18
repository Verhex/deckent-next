import { chmod } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { runtimeServiceRequestSchema, runtimeServiceResponseSchema, type RuntimeServiceRequest,
  type RuntimeServiceResponse } from '#engine/index.js';
import { encodeServiceFrame, ServiceFrameDecoder } from './framing.js';
import { LocalRuntimeSocketError, removeOwnedSocket, resolveSocketOptions,
  type LocalRuntimeSocketOptions, type ResolvedLocalRuntimeSocketOptions } from './endpoint.js';

export type RuntimeServiceHandler = (request: RuntimeServiceRequest) => Promise<RuntimeServiceResponse>;
export interface LocalRuntimeSocketServer { readonly endpoint: string; stopAccepting(): void; dispose(): Promise<void> }

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
function transportFailure(requestId: string): RuntimeServiceResponse {
  return { schemaVersion: 1, requestId, ok: false, error: { code: 'RUNTIME_SERVICE_TRANSPORT', category: 'error' } };
}

function accept(socket: Socket, options: ResolvedLocalRuntimeSocketOptions, handler: RuntimeServiceHandler): void {
  const decoder = new ServiceFrameDecoder(options.inputMaxBytes);
  const timer = setTimeout(() => socket.destroy(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT')),
    options.headerTimeoutMs);
  timer.unref();
  socket.on('data', chunk => {
    try {
      if (!Buffer.isBuffer(chunk)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
      decoder.push(chunk);
    } catch { socket.destroy(); }
  });
  socket.once('end', () => {
    clearTimeout(timer);
    let request: RuntimeServiceRequest;
    try { request = runtimeServiceRequestSchema.parse(decoder.finish()); }
    catch { socket.destroy(); return; }
    void Promise.resolve().then(() => handler(request)).then(value => runtimeServiceResponseSchema.parse(value))
      .catch(() => transportFailure(request.requestId))
      .then(response => {
        if (response.requestId !== request.requestId) response = transportFailure(request.requestId);
        try { socket.end(encodeServiceFrame(response, options.responseMaxBytes)); } catch { socket.destroy(); }
      });
  });
  socket.once('error', () => clearTimeout(timer));
  socket.once('close', () => clearTimeout(timer));
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
  const endpoint = createServer({ allowHalfOpen: true }, socket => accept(socket, resolved, handler));
  endpoint.maxConnections = resolved.maxConnections;
  try {
    await removeOwnedSocket(resolved.endpoint, true);
    await listen(endpoint, resolved.endpoint);
    await chmod(resolved.endpoint, 0o600);
  } catch (error) {
    if (endpoint.listening) await close(endpoint).catch(() => undefined);
    await close(guard).catch(() => undefined);
    if (error instanceof LocalRuntimeSocketError) throw error;
    throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', { cause: error });
  }
  let stopping: Promise<void> | null = null;
  let disposed: Promise<void> | null = null;
  const stopAccepting = () => {
    if (!stopping) stopping = close(endpoint);
  };
  const dispose = async () => {
    if (disposed) return await disposed;
    stopAccepting();
    const stopped = stopping;
    if (!stopped) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
    disposed = (async () => {
      await stopped;
      await removeOwnedSocket(resolved.endpoint, true);
      await close(guard);
    })();
    return await disposed;
  };
  return Object.freeze({ endpoint: resolved.endpoint, stopAccepting, dispose });
}
