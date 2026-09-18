export type ServiceFrameErrorCode = 'SERVICE_FRAME_LIMIT' | 'SERVICE_FRAME_TRUNCATED' | 'SERVICE_FRAME_EXTRA'
  | 'SERVICE_FRAME_UTF8' | 'SERVICE_FRAME_JSON' | 'SERVICE_FRAME_FINISHED';
export class ServiceFrameError extends Error {
  constructor(readonly code: ServiceFrameErrorCode) { super(code); this.name = 'ServiceFrameError'; }
}
function limit(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) throw new ServiceFrameError('SERVICE_FRAME_LIMIT');
  return value;
}
export function encodeServiceFrame(value: unknown, maxBytes: number): Buffer {
  const maximum = limit(maxBytes); let payload: Buffer;
  try { payload = Buffer.from(JSON.stringify(value), 'utf8'); } catch { throw new ServiceFrameError('SERVICE_FRAME_JSON'); }
  if (payload.byteLength > maximum) throw new ServiceFrameError('SERVICE_FRAME_LIMIT');
  const frame = Buffer.allocUnsafe(4 + payload.byteLength); frame.writeUInt32BE(payload.byteLength, 0); payload.copy(frame, 4); return frame;
}
/** Buffers at most one declared bounded payload. Callers dispatch only after finish(), which proves EOF contained exactly one frame. */
export class ServiceFrameDecoder {
  private readonly maximum: number; private readonly chunks: Buffer[] = []; private size = 0; private expected: number | null = null; private finished = false;
  constructor(maxBytes: number) { this.maximum = limit(maxBytes); }
  push(chunk: Buffer): void {
    if (this.finished) throw new ServiceFrameError('SERVICE_FRAME_FINISHED');
    if (!Buffer.isBuffer(chunk)) throw new ServiceFrameError('SERVICE_FRAME_TRUNCATED');
    if (chunk.byteLength === 0) return;
    this.size += chunk.byteLength;
    if (this.size > this.maximum + 4) throw new ServiceFrameError(this.expected !== null && this.size > this.expected + 4 ? 'SERVICE_FRAME_EXTRA' : 'SERVICE_FRAME_LIMIT');
    this.chunks.push(chunk);
    if (this.expected === null && this.size >= 4) {
      const prefix = this.peekPrefix(); this.expected = prefix.readUInt32BE(0);
      if (this.expected > this.maximum) throw new ServiceFrameError('SERVICE_FRAME_LIMIT');
      if (this.size > this.expected + 4) throw new ServiceFrameError('SERVICE_FRAME_EXTRA');
    } else if (this.expected !== null && this.size > this.expected + 4) throw new ServiceFrameError('SERVICE_FRAME_EXTRA');
  }
  finish(): unknown {
    if (this.finished) throw new ServiceFrameError('SERVICE_FRAME_FINISHED'); this.finished = true;
    if (this.expected === null || this.size !== this.expected + 4) throw new ServiceFrameError('SERVICE_FRAME_TRUNCATED');
    const frame = Buffer.concat(this.chunks, this.size); let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4)); }
    catch { throw new ServiceFrameError('SERVICE_FRAME_UTF8'); }
    try { return JSON.parse(text); } catch { throw new ServiceFrameError('SERVICE_FRAME_JSON'); }
  }
  private peekPrefix() {
    if (this.chunks[0]!.byteLength >= 4) return this.chunks[0]!.subarray(0, 4);
    const prefix = Buffer.allocUnsafe(4); let offset = 0;
    for (const chunk of this.chunks) { const count = Math.min(4 - offset, chunk.byteLength); chunk.copy(prefix, offset, 0, count); offset += count; if (offset === 4) break; }
    return prefix;
  }
}
