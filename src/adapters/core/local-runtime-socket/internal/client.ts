import { Socket } from 'node:net';
import { parseRuntimeServiceResponse, runtimeServiceRequestSchema, type RuntimeServiceRequest,
  type RuntimeServiceResponse } from '#engine/index.js';
import { encodeServiceFrame, ServiceFrameDecoder } from './framing.js';
import { assertOwnedSocket, LocalRuntimeSocketError, resolveSocketOptions, type LocalRuntimeSocketOptions } from './endpoint.js';

function connected(socket: Socket, endpoint: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT')); }, timeoutMs);
    timer.unref();
    const abort = () => socket.destroy(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT'));
    const error = (cause: Error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.off('connect', ready); reject(cause); };
    const ready = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.off('error', error); resolve(); };
    socket.once('error', error);
    socket.once('connect', ready);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else socket.connect(endpoint);
  });
}
export async function requestLocalRuntime(options: LocalRuntimeSocketOptions,
  value: RuntimeServiceRequest, signal?: AbortSignal): Promise<RuntimeServiceResponse> {
  if (signal?.aborted) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
  const request = runtimeServiceRequestSchema.parse(value);
  const resolved = await resolveSocketOptions(options);
  const frame = encodeServiceFrame(request, resolved.inputMaxBytes);
  await assertOwnedSocket(resolved.endpoint);
  const socket = new Socket({ allowHalfOpen: true });
  try { await connected(socket, resolved.endpoint, resolved.headerTimeoutMs, signal); }
  catch (error) { socket.destroy(); throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', { cause: error }); }
  const decoder = new ServiceFrameDecoder(resolved.responseMaxBytes);
  return await new Promise((resolve, reject) => {
    let ended = false;
    // Aborting this client disconnects its wait; an accepted server operation is never cancelled here.
    const abort = () => socket.destroy(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('data', chunk => {
      try {
        if (!Buffer.isBuffer(chunk)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
        decoder.push(chunk);
      } catch (error) { socket.destroy(); reject(error); }
    });
    socket.once('end', () => {
      ended = true;
      try { resolve(parseRuntimeServiceResponse(request.requestId, decoder.finish())); }
      catch (error) { reject(error); }
    });
    socket.once('close', () => { signal?.removeEventListener('abort', abort); if (!ended) reject(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT')); });
    socket.once('error', error => reject(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', { cause: error })));
    try { if (signal?.aborted) abort(); else socket.end(frame); }
    catch (error) { socket.destroy(); reject(error); }
  });
}
