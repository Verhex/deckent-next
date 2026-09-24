import type { Socket } from 'node:net';
import { splitModelInvocationDelta, type ModelInvocationDelta } from '#domain/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION, RUNTIME_SERVICE_STREAM_FRAME_DELTAS } from '#engine/index.js';
import { encodeServiceFrame } from './framing.js';

/** Presentation channel of one streamed request. Emitting never blocks or throws; the final response is separate. */
export interface RuntimeServiceStreamChannel { emit(delta: ModelInvocationDelta): void }
export interface ServerStreamChannel extends RuntimeServiceStreamChannel { finish(): void }

/**
 * Coalesces deltas per event-loop turn into ordered delta frames, each at most `maxFrameBytes`. All delta frames of
 * a request share `budgetBytes`; when the budget or the peer is exhausted the channel stops for good, so what the
 * client saw is always a prefix of the final result. Backpressure waits for drain while the budget bounds buffering.
 */
export function createServerStreamChannel(socket: Socket, requestId: string, maxFrameBytes: number, budgetBytes: number): ServerStreamChannel {
  let pending: ModelInvocationDelta[] = [], pendingBytes = 0, spent = 0, sequence = 0;
  let stopped = false, scheduled = false, waiting = false;
  const envelope = Buffer.byteLength(JSON.stringify({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId, kind: 'delta',
    sequence: Number.MAX_SAFE_INTEGER, deltas: [] }), 'utf8') + 4;
  // Worst case JSON escapes one UTF-16 code unit as six bytes; the fixed delta wrapper is under 32 bytes.
  const pieceUnits = Math.floor((maxFrameBytes - envelope - 32) / 6);
  const stop = () => { stopped = true; pending = []; pendingBytes = 0; };
  const write = (force: boolean) => {
    scheduled = false;
    if (stopped || pending.length === 0) return;
    if (socket.destroyed || !socket.writable) { stop(); return; }
    if (!force && socket.writableNeedDrain) {
      if (!waiting) { waiting = true; socket.once('drain', () => { waiting = false; write(false); }); }
      return;
    }
    const merged: ModelInvocationDelta[] = [];
    for (const delta of pending) {
      const last = merged.at(-1);
      if (last?.kind === delta.kind) merged[merged.length - 1] = { kind: delta.kind, text: last.text + delta.text };
      else merged.push(delta);
    }
    pending = []; pendingBytes = 0;
    const pieces = merged.flatMap(delta => splitModelInvocationDelta(delta.kind, delta.text, pieceUnits));
    let frame: ModelInvocationDelta[] = [], frameBytes = envelope;
    const send = (): boolean => {
      if (frame.length === 0) return true;
      let bytes: Buffer;
      try { bytes = encodeServiceFrame({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId, kind: 'delta', sequence, deltas: frame }, maxFrameBytes); }
      catch { stop(); return false; }
      if (spent + bytes.byteLength > budgetBytes) { stop(); return false; }
      spent += bytes.byteLength; sequence += 1; frame = []; frameBytes = envelope;
      try { socket.write(bytes); } catch { stop(); return false; }
      return true;
    };
    for (const piece of pieces) {
      const bytes = Buffer.byteLength(JSON.stringify(piece), 'utf8') + 1;
      if (frame.length > 0 && (frame.length >= RUNTIME_SERVICE_STREAM_FRAME_DELTAS || frameBytes + bytes > maxFrameBytes) && !send()) return;
      frame.push(piece); frameBytes += bytes;
    }
    send();
  };
  return Object.freeze({
    emit(delta: ModelInvocationDelta) {
      if (stopped || pieceUnits < 2) return;
      pending.push(delta); pendingBytes += Buffer.byteLength(delta.text, 'utf8');
      if (spent + pendingBytes > budgetBytes) { stop(); return; }
      if (!scheduled) { scheduled = true; setImmediate(() => write(false)); }
    },
    /** Writes what is pending (still bounded by the budget) so every delta precedes the final frame, then closes. */
    finish() { write(true); stop(); },
  });
}
