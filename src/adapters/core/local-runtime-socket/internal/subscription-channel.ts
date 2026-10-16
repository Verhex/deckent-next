import type { Socket } from 'node:net';
import { RUNTIME_SERVICE_SCHEMA_VERSION, runtimeEventsItemSchema, RuntimeEventsError, type RuntimeEventsItem } from '#engine/index.js';
import { encodeServiceFrame, ServiceFrameError } from '#engine/index.js';
/** Observation channel: one bounded frame in the socket, no execution signal and no producer wait. The application's own
 * subscriber queue absorbs changes independently. A stalled peer ends only this subscription at the drain deadline. */
export interface RuntimeServiceSubscriptionChannel {
  readonly signal: AbortSignal;
  disconnect(): void;
  send(item: RuntimeEventsItem, drainTimeoutMs: number): Promise<void>;
}
export interface ServerSubscriptionChannel extends RuntimeServiceSubscriptionChannel { finish(): void; disconnect(): void }
export function createServerSubscriptionChannel(socket: Socket, requestId: string, maxFrameBytes: number): ServerSubscriptionChannel {
  const controller = new AbortController(); let sequence = 0, finished = false;
  const disconnect = () => { if (!controller.signal.aborted) controller.abort(); };
  socket.on('close', disconnect); socket.on('error', disconnect);
  return {
    signal: controller.signal,
    async send(value, drainTimeoutMs) {
      if (finished || controller.signal.aborted) return;
      const item = runtimeEventsItemSchema.parse(value);
      let frame: Buffer;
      try { frame = encodeServiceFrame({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId, kind: 'subscription', sequence, item }, maxFrameBytes); }
      catch (error) { if (error instanceof ServiceFrameError && error.code === 'SERVICE_FRAME_LIMIT') throw new RuntimeEventsError('RUNTIME_EVENTS_TOO_LARGE'); throw error; }
      sequence++;
      if (!socket.write(frame)) await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); socket.off('drain', drain); controller.signal.removeEventListener('abort', abort); };
        const drain = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new Error('RUNTIME_EVENTS_DISCONNECTED')); };
        const timer = setTimeout(() => { cleanup(); socket.destroy(); disconnect(); reject(new Error('RUNTIME_EVENTS_SLOW_CONSUMER')); }, drainTimeoutMs);
        socket.once('drain', drain); controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      });
    },
    disconnect() { socket.destroy(); disconnect(); },
    finish() { if (!finished) { finished = true; socket.off('close', disconnect); socket.off('error', disconnect); } },
  };
}
