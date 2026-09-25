import { Socket } from 'node:net';
import { isRuntimeServiceStreamingOperation, isRuntimeServiceTurnOperation, parseRuntimeServiceLifecycleResponse, parseRuntimeServiceResponse, RUNTIME_SERVICE_SCHEMA_VERSION,
  RuntimeServiceProtocolError, runtimeServiceEventFrameSchema, runtimeServiceLifecycleRequestSchema, runtimeServiceRequestSchema, runtimeServiceStreamFrameSchema,
  type RuntimeServiceEventFrame, type RuntimeServiceLifecycleRequest, type RuntimeServiceRequest, type RuntimeServiceResponse, type RuntimeServiceStreamFrame } from '#engine/index.js';
import { encodeServiceFrame, ServiceFrameDecoder, ServiceFrameError, ServiceFrameStreamDecoder } from './framing.js';
import { assertOwnedSocket, LocalRuntimeSocketError, resolveSocketOptions, type LocalRuntimeSocketOptions } from './endpoint.js';

/** A refused connection to an owned socket path means no process listens there (a crashed host's stale socket): no live
 * service, like a missing endpoint. Every other connect failure stays a transport failure, not evidence of absence. */
function connectFailure(error: unknown): LocalRuntimeSocketError {
  const refused = error && typeof error === 'object' && 'code' in error && error.code === 'ECONNREFUSED';
  return new LocalRuntimeSocketError(refused ? 'LOCAL_RUNTIME_UNAVAILABLE' : 'LOCAL_RUNTIME_TRANSPORT', { cause: error });
}
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
  value: RuntimeServiceRequest | RuntimeServiceLifecycleRequest, signal?: AbortSignal): Promise<RuntimeServiceResponse> {
  if (signal?.aborted) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
  // An older lifecycle version is only for describing/stopping a service started from an older build.
  const legacy = value.schemaVersion !== RUNTIME_SERVICE_SCHEMA_VERSION ? runtimeServiceLifecycleRequestSchema.parse(value) : null;
  const request = legacy ?? runtimeServiceRequestSchema.parse(value);
  const resolved = await resolveSocketOptions(options);
  const frame = encodeServiceFrame(request, resolved.inputMaxBytes);
  await assertOwnedSocket(resolved.endpoint);
  const socket = new Socket({ allowHalfOpen: true });
  try { await connected(socket, resolved.endpoint, resolved.headerTimeoutMs, signal); }
  catch (error) { socket.destroy(); throw connectFailure(error); }
  const decoder = new ServiceFrameDecoder(resolved.responseMaxBytes);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      reject(error instanceof LocalRuntimeSocketError ? error : new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', { cause: error }));
    };
    // Aborting this client disconnects its wait; an accepted server operation is never cancelled here.
    const abort = () => fail(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('data', chunk => {
      try {
        if (!Buffer.isBuffer(chunk)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
        decoder.push(chunk);
      } catch (error) { fail(error); }
    });
    socket.once('end', () => {
      if (settled) return;
      try {
        const response = legacy ? parseRuntimeServiceLifecycleResponse(request.requestId, legacy.schemaVersion, decoder.finish())
          : parseRuntimeServiceResponse(request.requestId, decoder.finish());
        settled = true;
        signal?.removeEventListener('abort', abort);
        // A half-open socket stays ref'd after FIN and keeps the operator process alive after /exit.
        socket.unref();
        resolve(response);
      } catch (error) { fail(error); }
    });
    socket.once('close', () => { if (!settled) fail(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT')); });
    socket.once('error', error => fail(error));
    try { if (signal?.aborted) abort(); else socket.end(frame); }
    catch (error) { fail(error); }
  });
}

/**
 * Streamed operation (v11): ordered delta frames with this request's id, then exactly one response frame and EOF.
 * Frames are bounded individually and in total. Aborting disconnects the wait only; an accepted invocation continues
 * until a governed cancellation command reaches it, exactly as for the single-frame operation.
 */
export async function streamLocalRuntime(options: LocalRuntimeSocketOptions, value: RuntimeServiceRequest,
  onDeltas: (deltas: RuntimeServiceStreamFrame['deltas']) => void, signal?: AbortSignal): Promise<RuntimeServiceResponse> {
  const request = runtimeServiceRequestSchema.parse(value);
  if (!isRuntimeServiceStreamingOperation(request.operation)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
  // Delta frames share one response limit in total; the final frame has its own.
  return framedLocalRuntime(options, request, limit => 2 * (limit + 4), frame => {
    const delta = runtimeServiceStreamFrameSchema.safeParse(frame);
    if (!delta.success) return null;
    return { requestId: delta.data.requestId, sequence: delta.data.sequence, deliver: () => onDeltas(delta.data.deltas) };
  }, signal);
}

/**
 * Turn operation (v12 `chatTurn`): ordered event frames, then exactly one response frame and EOF. Each frame is bounded, the
 * stream is not (a turn has no budget). Event frames are required data; a consumer failure is the caller's to surface.
 * Aborting disconnects, and a disconnected peer cancels the turn on the service.
 */
export async function turnLocalRuntime(options: LocalRuntimeSocketOptions, value: RuntimeServiceRequest,
  onEvents: (events: RuntimeServiceEventFrame['events']) => void, signal?: AbortSignal): Promise<RuntimeServiceResponse> {
  const request = runtimeServiceRequestSchema.parse(value);
  if (!isRuntimeServiceTurnOperation(request.operation)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
  return framedLocalRuntime(options, request, () => null, frame => {
    const event = runtimeServiceEventFrameSchema.safeParse(frame);
    if (!event.success) return null;
    return { requestId: event.data.requestId, sequence: event.data.sequence, deliver: () => onEvents(event.data.events), required: true };
  }, signal);
}

type FramePart = { readonly requestId: string; readonly sequence: number; readonly deliver: () => void; readonly required?: boolean };
async function framedLocalRuntime(options: LocalRuntimeSocketOptions, request: RuntimeServiceRequest, total: (responseMaxBytes: number) => number | null,
  part: (frame: unknown) => FramePart | null, signal?: AbortSignal): Promise<RuntimeServiceResponse> {
  if (signal?.aborted) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
  const resolved = await resolveSocketOptions(options);
  const frame = encodeServiceFrame(request, resolved.inputMaxBytes);
  await assertOwnedSocket(resolved.endpoint);
  const socket = new Socket({ allowHalfOpen: true });
  try { await connected(socket, resolved.endpoint, resolved.headerTimeoutMs, signal); }
  catch (error) { socket.destroy(); throw connectFailure(error); }
  const decoder = new ServiceFrameStreamDecoder(resolved.responseMaxBytes, total(resolved.responseMaxBytes));
  return await new Promise((resolve, reject) => {
    let settled = false, sequence = 0, final: RuntimeServiceResponse | null = null;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort); socket.destroy();
      reject(error instanceof LocalRuntimeSocketError ? error : new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT', { cause: error }));
    };
    const abort = () => fail(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('data', chunk => {
      if (settled) return;
      try {
        if (!Buffer.isBuffer(chunk)) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT');
        for (const value of decoder.push(chunk)) {
          if (final) throw new ServiceFrameError('SERVICE_FRAME_EXTRA');
          const parsed = part(value);
          if (!parsed) { final = parseRuntimeServiceResponse(request.requestId, value); continue; }
          if (parsed.requestId !== request.requestId || parsed.sequence !== sequence) {
            throw new RuntimeServiceProtocolError('RUNTIME_SERVICE_CORRELATION');
          }
          sequence += 1;
          if (parsed.required) parsed.deliver();
          else try { parsed.deliver(); } catch { /* A presentation failure never changes the response. */ }
        }
      } catch (error) { fail(error); }
    });
    socket.once('end', () => {
      if (settled) return;
      try {
        decoder.finish();
        if (!final) throw new ServiceFrameError('SERVICE_FRAME_TRUNCATED');
        settled = true; signal?.removeEventListener('abort', abort); socket.unref(); resolve(final);
      } catch (error) { fail(error); }
    });
    socket.once('close', () => { if (!settled) fail(new LocalRuntimeSocketError('LOCAL_RUNTIME_TRANSPORT')); });
    socket.once('error', error => fail(error));
    try { if (signal?.aborted) abort(); else socket.end(frame); }
    catch (error) { fail(error); }
  });
}
