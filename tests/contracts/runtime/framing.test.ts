import { describe, expect, it } from 'vitest';
import { ServiceFrameDecoder, ServiceFrameError, encodeServiceFrame }
  from '../../../src/adapters/core/local-runtime-socket/index.js';

function expectCode(work: () => unknown, code: ServiceFrameError['code']): void {
  try { work(); } catch (error) {
    expect(error).toBeInstanceOf(ServiceFrameError);
    expect((error as ServiceFrameError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('local runtime framing', () => {
  it('decodes a chunked frame only after finish proves exact EOF', () => {
    const value = { schemaVersion: 1, requestId: 'request-1', input: { text: 'Türkçe' } };
    const frame = encodeServiceFrame(value, 1024);
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4);
    const decoder = new ServiceFrameDecoder(1024);
    for (const byte of frame) expect(decoder.push(Buffer.from([byte]))).toBeUndefined();
    expect(decoder.finish()).toEqual(value);
    expectCode(() => decoder.finish(), 'SERVICE_FRAME_FINISHED');
    expectCode(() => decoder.push(Buffer.alloc(0)), 'SERVICE_FRAME_FINISHED');
  });

  it('rejects declared and encoded payloads above the limit', () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(9);
    expectCode(() => new ServiceFrameDecoder(8).push(prefix), 'SERVICE_FRAME_LIMIT');
    expectCode(() => encodeServiceFrame({ value: 'too large' }, 4), 'SERVICE_FRAME_LIMIT');
  });

  it('rejects any bytes after the one declared frame', () => {
    const frame = encodeServiceFrame({ ok: true }, 128);
    const decoder = new ServiceFrameDecoder(128);
    expectCode(() => decoder.push(Buffer.concat([frame, Buffer.from([0])])), 'SERVICE_FRAME_EXTRA');
    const second = new ServiceFrameDecoder(128);
    second.push(frame);
    expectCode(() => second.push(frame), 'SERVICE_FRAME_EXTRA');
  });

  it('detects empty and truncated EOF', () => {
    expectCode(() => new ServiceFrameDecoder(128).finish(), 'SERVICE_FRAME_TRUNCATED');
    const partialPrefix = new ServiceFrameDecoder(128);
    partialPrefix.push(Buffer.from([0, 0]));
    expectCode(() => partialPrefix.finish(), 'SERVICE_FRAME_TRUNCATED');
    const frame = encodeServiceFrame({ ok: true }, 128);
    const partialPayload = new ServiceFrameDecoder(128);
    partialPayload.push(frame.subarray(0, -1));
    expectCode(() => partialPayload.finish(), 'SERVICE_FRAME_TRUNCATED');
  });

  it('uses fatal UTF-8 and strict JSON decoding', () => {
    const utf8 = new ServiceFrameDecoder(16);
    utf8.push(Buffer.from([0, 0, 0, 2, 0xc3, 0x28]));
    expectCode(() => utf8.finish(), 'SERVICE_FRAME_UTF8');
    const json = new ServiceFrameDecoder(16);
    json.push(Buffer.from([0, 0, 0, 1, 0x7b]));
    expectCode(() => json.finish(), 'SERVICE_FRAME_JSON');
    const empty = new ServiceFrameDecoder(16);
    empty.push(Buffer.from([0, 0, 0, 0]));
    expectCode(() => empty.finish(), 'SERVICE_FRAME_JSON');
  });
});
