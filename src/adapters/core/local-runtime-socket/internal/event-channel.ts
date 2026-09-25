import type { Socket } from 'node:net';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { RUNTIME_SERVICE_EVENT_FRAME_EVENTS, RUNTIME_SERVICE_SCHEMA_VERSION } from '#engine/index.js';
import { encodeServiceFrame } from './framing.js';

/**
 * Required-data channel of one `chatTurn` request (v12). Events are never dropped: the producer awaits `drained()` between steps,
 * so what waits in memory is at most one step's output plus `pendingMaxBytes`. The channel fails closed instead: a peer that
 * disconnects, an event that cannot fit one frame, or a peer that stops reading past the pending bound aborts `signal`, and the
 * turn is cancelled by its owner. There is no bound on the stream as a whole (a turn has no budget).
 */
export interface RuntimeServiceTurnChannel {
  emit(event: AgentTurnStreamEvent): void;
  drained(): Promise<void>;
  readonly signal: AbortSignal;
}
export interface ServerTurnChannel extends RuntimeServiceTurnChannel { finish(): void }

type Piece = AgentTurnStreamEvent;
const textual = (event: Piece): event is Extract<Piece, { kind: 'text' | 'reasoning' }> => event.kind === 'text' || event.kind === 'reasoning';

export function createServerTurnChannel(socket: Socket, requestId: string, maxFrameBytes: number, pendingMaxBytes: number): ServerTurnChannel {
  const controller = new AbortController();
  let pending: Piece[] = [], pendingBytes = 0, sequence = 0, scheduled = false, waiting = false, finished = false;
  let waiters: (() => void)[] = [];
  const envelope = Buffer.byteLength(JSON.stringify({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId, kind: 'event',
    sequence: Number.MAX_SAFE_INTEGER, events: [] }), 'utf8') + 4;
  // Worst case JSON escapes one UTF-16 code unit as six bytes; the fixed text wrapper is under 32 bytes.
  const pieceUnits = Math.max(1, Math.floor((maxFrameBytes - envelope - 32) / 6));
  const release = () => { const resume = waiters; waiters = []; for (const wake of resume) wake(); };
  const fail = () => { if (!controller.signal.aborted) controller.abort(); pending = []; pendingBytes = 0; release(); };
  const idle = () => pending.length === 0 && !socket.writableNeedDrain;
  const split = (event: Piece): Piece[] => {
    if (!textual(event)) return [event];
    const pieces: Piece[] = [];
    for (let start = 0; start < event.text.length;) {
      let end = Math.min(event.text.length, start + pieceUnits);
      // Never cut a surrogate pair.
      if (end < event.text.length && /[\uD800-\uDBFF]/.test(event.text[end - 1]!)) end -= 1;
      pieces.push({ kind: event.kind, text: event.text.slice(start, end) });
      start = end;
    }
    return pieces;
  };
  const write = (force: boolean) => {
    scheduled = false;
    if (controller.signal.aborted) return;
    if (socket.destroyed || !socket.writable) { fail(); return; }
    if (!force && socket.writableNeedDrain) {
      if (!waiting) { waiting = true; socket.once('drain', () => { waiting = false; write(false); }); }
      return;
    }
    const merged: Piece[] = [];
    for (const event of pending) {
      const last = merged.at(-1);
      if (last && textual(last) && textual(event) && last.kind === event.kind) merged[merged.length - 1] = { kind: event.kind, text: last.text + event.text };
      else merged.push(event);
    }
    pending = []; pendingBytes = 0;
    let frame: Piece[] = [], frameBytes = envelope;
    const send = (): boolean => {
      if (frame.length === 0) return true;
      let bytes: Buffer;
      try { bytes = encodeServiceFrame({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId, kind: 'event', sequence, events: frame }, maxFrameBytes); }
      catch { fail(); return false; }
      sequence += 1; frame = []; frameBytes = envelope;
      try { socket.write(bytes); } catch { fail(); return false; }
      return true;
    };
    for (const piece of merged.flatMap(split)) {
      const bytes = Buffer.byteLength(JSON.stringify(piece), 'utf8') + 1;
      // A structured event larger than one frame cannot be split: fail closed rather than drop it.
      if (envelope + bytes > maxFrameBytes) { fail(); return; }
      if (frame.length > 0 && (frame.length >= RUNTIME_SERVICE_EVENT_FRAME_EVENTS || frameBytes + bytes > maxFrameBytes) && !send()) return;
      frame.push(piece); frameBytes += bytes;
    }
    if (!send()) return;
    if (idle()) release();
    else if (!waiting) { waiting = true; socket.once('drain', () => { waiting = false; if (pending.length) write(false); else release(); }); }
  };
  const disconnected = () => { if (!finished) fail(); };
  socket.once('close', disconnected);
  socket.once('error', disconnected);
  return Object.freeze({
    signal: controller.signal,
    emit(event: AgentTurnStreamEvent) {
      if (controller.signal.aborted || finished) return;
      pending.push(event); pendingBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (pendingBytes > pendingMaxBytes) { fail(); return; }
      if (!scheduled) { scheduled = true; setImmediate(() => write(false)); }
    },
    drained() {
      if (controller.signal.aborted || (idle() && !scheduled)) return Promise.resolve();
      return new Promise<void>(resolve => { waiters.push(resolve); });
    },
    /** Writes what is pending so every event precedes the final frame; the channel then ignores further events. */
    finish() {
      if (finished) return;
      write(true); finished = true; release();
      socket.off('close', disconnected); socket.off('error', disconnected);
    },
  });
}
