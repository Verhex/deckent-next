import { Socket } from 'node:net';
import { runtimeServiceRequestSchema, createRuntimeEventsFrameConsumer,
  type RuntimeEventsItem, type RuntimeServiceRequest, type RuntimeServiceResponse } from '#engine/index.js';
import { encodeServiceFrame, ServiceFrameStreamDecoder } from '#engine/index.js';
import { assertOwnedSocket, resolveSocketOptions, LocalRuntimeSocketError, type LocalRuntimeSocketOptions } from './endpoint.js';
/** Readable async iteration applies socket backpressure while an async consumer applies one item. No SDK array grows with time. */
export async function subscribeLocalRuntime(options: LocalRuntimeSocketOptions, value: RuntimeServiceRequest,
  onItem: (item: RuntimeEventsItem) => void | Promise<void>, idleTimeoutMs: number, signal?: AbortSignal): Promise<RuntimeServiceResponse> {
  const request = runtimeServiceRequestSchema.parse(value);
  if (request.operation !== 'subscribeEvents' || signal?.aborted) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
  const resolved = await resolveSocketOptions(options), limit = Math.min(resolved.responseMaxBytes, request.delivery!.maxResultBytes);
  const consumer = createRuntimeEventsFrameConsumer(request, limit);
  const frame = encodeServiceFrame(request, resolved.inputMaxBytes);
  await assertOwnedSocket(resolved.endpoint);
  const socket = new Socket({ allowHalfOpen: true });
  const abort = () => socket.destroy(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT'));
  signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { cleanup(); reject(error); };
      const ready = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timer); socket.off('connect', ready); socket.off('error', fail); };
      timer = setTimeout(abort, resolved.headerTimeoutMs); socket.once('connect', ready); socket.once('error', fail);
      if (signal?.aborted) abort(); else socket.connect(resolved.endpoint);
    });
    socket.setTimeout(idleTimeoutMs, abort);
    const decoder = new ServiceFrameStreamDecoder(resolved.responseMaxBytes, null);
    socket.end(frame);
    for await (const chunk of socket) {
      if (!Buffer.isBuffer(chunk)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
      for (const raw of decoder.push(chunk)) {
        const item = consumer.accept(raw);
        if (!item) continue;
        // Callback lifetime is bounded too: AbortSignal/peer close can detach a stalled consumer without another callback.
        await deliver(onItem, item, socket, idleTimeoutMs, signal);
      }
    }
    decoder.finish();
    return consumer.finish();
  } catch (error) { throw error instanceof LocalRuntimeSocketError ? error : new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', { cause: error }); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); }
}
function deliver(callback: (item: RuntimeEventsItem) => void | Promise<void>, item: RuntimeEventsItem, socket: Socket, timeout: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => { clearTimeout(timer); socket.off('close', abort); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
    const abort = () => finish(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT'));
    const timer = setTimeout(abort, timeout); socket.once('close', abort); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else Promise.resolve().then(() => callback(item)).then(() => finish(), finish);
  });
}
