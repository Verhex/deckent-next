import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalRuntimeSocketError, ServiceFrameError, ServiceFrameStreamDecoder, encodeServiceFrame, requestLocalRuntime, startLocalRuntimeSocketServer,
  streamLocalRuntime, type LocalRuntimeSocketOptions, type RuntimeServiceStreamChannel } from '../../../src/adapters/core/local-runtime-socket/index.js';
import type { ModelInvocationDelta } from '../../../src/domain/index.js';

const owned: string[] = [];
async function fixture(responseMaxBytes = 4096): Promise<LocalRuntimeSocketOptions> {
  const root = await mkdtemp(join(tmpdir(), 'deckent-runtime-stream-')); owned.push(root);
  const parent = join(root, 'private'); await mkdir(parent, { mode: 0o700 });
  return { endpoint: join(parent, 'runtime.sock'), maxConnections: 8, inputMaxBytes: 4096, responseMaxBytes,
    acceptRetryDelayMs: 25, acceptRetryLimit: 3, headerTimeoutMs: 1_000, responseTimeoutMs: 1_000 };
}
afterEach(async () => { await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const command = { schemaVersion: 1, commandId: 'command-1', scopeId: 'scope-1', reference, catalogRevision: 'catalog-1',
  expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64) },
  nativeRequest: { model: 'native-model', messages: [{ role: 'user', content: 'hi' }] } };
const streamRequest = (requestId = 'request-1') => ({ schemaVersion: 13 as const, requestId, operation: 'invokeModelStream' as const,
  input: command, delivery: { maxResultBytes: 2048 } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function rawServer(endpoint: string, onRequest: (socket: Socket) => void) {
  const raw = createServer({ allowHalfOpen: true }, socket => { socket.resume(); socket.once('end', () => onRequest(socket)); });
  await new Promise<void>((resolve, reject) => { raw.once('error', reject); raw.listen(endpoint, () => { raw.off('error', reject); resolve(); }); });
  await chmod(endpoint, 0o600);
  return raw;
}

describe('service frame stream decoder', () => {
  it('yields complete frames across arbitrary chunking and enforces frame, total and truncation bounds', () => {
    const frames = Buffer.concat([encodeServiceFrame({ a: 1 }, 64), encodeServiceFrame({ b: 'two' }, 64)]);
    const decoder = new ServiceFrameStreamDecoder(64, 200), seen: unknown[] = [];
    for (let offset = 0; offset < frames.byteLength; offset += 3) seen.push(...decoder.push(frames.subarray(offset, offset + 3)));
    decoder.finish();
    expect(seen).toEqual([{ a: 1 }, { b: 'two' }]);
    const code = (call: () => unknown) => { try { call(); } catch (error) { return (error as ServiceFrameError).code; } return null; };
    expect(code(() => new ServiceFrameStreamDecoder(8, 64).push(encodeServiceFrame({ long: 'xxxxxxxx' }, 64)))).toBe('SERVICE_FRAME_LIMIT');
    expect(code(() => new ServiceFrameStreamDecoder(16, 20).push(frames))).toBe('SERVICE_FRAME_LIMIT');
    const truncated = new ServiceFrameStreamDecoder(64, 200); truncated.push(frames.subarray(0, 5));
    expect(code(() => truncated.finish())).toBe('SERVICE_FRAME_TRUNCATED');
    expect(code(() => new ServiceFrameStreamDecoder(64, 200).push(Buffer.from([0, 0, 0, 1, 0xff])))).toBe('SERVICE_FRAME_UTF8');
  });
});

describe.skipIf(process.platform !== 'linux')('local runtime socket streaming', () => {
  it('delivers ordered coalesced delta frames before exactly one final response, and only to streamed operations', async () => {
    const options = await fixture(); const channels: (RuntimeServiceStreamChannel | undefined)[] = [];
    const server = await startLocalRuntimeSocketServer(options, async (request, _peer, stream) => {
      channels.push(stream);
      if (stream) {
        stream.emit({ kind: 'reasoning', text: 'th' }); stream.emit({ kind: 'reasoning', text: 'ink' });
        await tick(); stream.emit({ kind: 'text', text: 'Mer' }); await tick(); stream.emit({ kind: 'text', text: 'haba' });
      }
      return { schemaVersion: 13, requestId: request.requestId, ok: true, result: { done: true } };
    });
    try {
      const batches: ModelInvocationDelta[][] = [];
      const response = await streamLocalRuntime(options, streamRequest(), deltas => batches.push([...deltas]));
      expect(response).toEqual({ schemaVersion: 13, requestId: 'request-1', ok: true, result: { done: true } });
      expect(batches.flat()).toEqual([{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'Mer' }, { kind: 'text', text: 'haba' }]);
      expect(batches[0]).toEqual([{ kind: 'reasoning', text: 'think' }]);
      await expect(requestLocalRuntime(options, { schemaVersion: 13, requestId: 'request-2', operation: 'inspectRun', input: {} }))
        .resolves.toMatchObject({ ok: true });
      expect(channels[0]).toBeDefined(); expect(channels[1]).toBeUndefined();
      await expect(streamLocalRuntime(options, { schemaVersion: 13, requestId: 'request-3', operation: 'inspectRun', input: {} }, () => undefined))
        .rejects.toBeInstanceOf(LocalRuntimeSocketError);
    } finally { await server.dispose(); }
  });

  it('splits escape-heavy text across frames within the frame limit and stops at the delta budget with a prefix', async () => {
    const options = await fixture(4096);
    const control = '\u0001'.repeat(1200), words = Array.from({ length: 60 }, (_, index) => `w${String(index).padStart(2, '0')}`.padEnd(100, '.'));
    const server = await startLocalRuntimeSocketServer(options, async (request, _peer, stream) => {
      if (request.requestId === 'escape') stream!.emit({ kind: 'text', text: control });
      else for (const word of words) { stream!.emit({ kind: 'text', text: word }); await tick(); }
      return { schemaVersion: 13, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const escaped: ModelInvocationDelta[][] = [];
      await expect(streamLocalRuntime(options, streamRequest('escape'), deltas => escaped.push([...deltas]))).resolves.toMatchObject({ ok: true });
      const shown = escaped.flat().map(delta => delta.text).join('');
      // JSON escaping makes 1,200 code units about 7 KiB: only the first frame fits the 4 KiB budget.
      expect(shown.length).toBeGreaterThan(0); expect(shown.length).toBeLessThan(control.length); expect(control.startsWith(shown)).toBe(true);
      const batches: ModelInvocationDelta[][] = [];
      await expect(streamLocalRuntime(options, streamRequest('words'), deltas => batches.push([...deltas]))).resolves.toMatchObject({ ok: true });
      const text = batches.flat().map(delta => delta.text).join(''), all = words.join('');
      expect(batches.length).toBeGreaterThan(5); expect(all.startsWith(text)).toBe(true);
      expect(text.length).toBeLessThan(4096); expect(text.length).toBeGreaterThan(1500);
    } finally { await server.dispose(); }
  });

  it('keeps the admitted handler running when the streaming client disconnects; emitting afterwards is harmless', async () => {
    const options = await fixture(); const controller = new AbortController();
    let finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; });
    const server = await startLocalRuntimeSocketServer(options, async (request, _peer, stream) => {
      stream!.emit({ kind: 'text', text: 'first' });
      for (let index = 0; index < 10; index++) { await new Promise(resolve => setTimeout(resolve, 10)); stream!.emit({ kind: 'text', text: '.' }); }
      finished();
      return { schemaVersion: 13, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const pending = streamLocalRuntime(options, streamRequest(), () => controller.abort(), controller.signal);
      await expect(pending).rejects.toBeInstanceOf(LocalRuntimeSocketError);
      await done;
    } finally { await server.dispose(); }
  });

  it('rejects out-of-order, foreign, missing-final and trailing frames from a peer', async () => {
    const options = await fixture();
    const frame = (value: unknown) => encodeServiceFrame(value, 4096);
    const delta = (sequence: number, requestId = 'request-1') => frame({ schemaVersion: 13, requestId, kind: 'delta', sequence, deltas: [{ kind: 'text', text: 'x' }] });
    const final = frame({ schemaVersion: 13, requestId: 'request-1', ok: true, result: null });
    for (const [replies, expected] of [[[delta(1), final], 'RUNTIME_SERVICE_CORRELATION'], [[delta(0, 'other'), final], 'RUNTIME_SERVICE_CORRELATION'],
      [[delta(0)], 'SERVICE_FRAME_TRUNCATED'], [[final, delta(0)], 'SERVICE_FRAME_EXTRA']] as const) {
      const raw = await rawServer(options.endpoint, socket => { for (const reply of replies) socket.write(reply); socket.end(); });
      try {
        const seen: unknown[] = [];
        const error = await streamLocalRuntime(options, streamRequest(), deltas => seen.push(...deltas)).then(() => null, (cause: unknown) => cause);
        expect(error).toBeInstanceOf(LocalRuntimeSocketError);
        expect(((error as LocalRuntimeSocketError).cause as { code?: string }).code).toBe(expected);
      } finally { await new Promise<void>(resolve => raw.close(() => resolve())); }
    }
  });
});
