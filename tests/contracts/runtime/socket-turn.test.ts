import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalRuntimeSocketServer, turnLocalRuntime, type LocalRuntimeSocketOptions,
  type RuntimeServiceTurnChannel } from '../../../src/adapters/core/local-runtime-socket/index.js';
import type { AgentTurnStreamEvent } from '../../../src/domain/index.js';

const owned: string[] = [];
async function fixture(responseMaxBytes = 4096): Promise<LocalRuntimeSocketOptions> {
  const root = await mkdtemp(join(tmpdir(), 'deckent-runtime-turn-')); owned.push(root);
  const parent = join(root, 'private'); await mkdir(parent, { mode: 0o700 });
  return { endpoint: join(parent, 'runtime.sock'), maxConnections: 8, inputMaxBytes: 4096, responseMaxBytes,
    acceptRetryDelayMs: 25, acceptRetryLimit: 3, headerTimeoutMs: 1_000, responseTimeoutMs: 1_000 };
}
afterEach(async () => { await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const turnRequest = (requestId = 'request-1') => ({ schemaVersion: 12 as const, requestId, operation: 'chatTurn' as const, delivery: { maxResultBytes: 2048 },
  input: { schemaVersion: 1, scopeId: 'scope-1', turnId: 'turn-1', messages: [{ role: 'user', content: 'hi' }] } });
const toolMessage = (i: number): AgentTurnStreamEvent => ({ kind: 'message', message: { role: 'tool', toolCallId: `c${i}`, name: 'read_file', content: `${i}:${'r'.repeat(900)}` } });

describe.skipIf(process.platform !== 'linux')('local runtime socket turn stream', () => {
  it('delivers every event in order, far past any per-response total, before exactly one final response', async () => {
    const options = await fixture();
    const server = await startLocalRuntimeSocketServer(options, async (request, _peer, stream, turn) => {
      expect(stream).toBeUndefined();
      // 200 tool messages of ~1 KiB each: ~50 × responseMaxBytes, with the producer waiting for the peer between steps.
      for (let i = 0; i < 200; i++) { turn!.emit(toolMessage(i)); if (i % 10 === 9) await turn!.drained(); }
      turn!.emit({ kind: 'text', text: 'It ' }); turn!.emit({ kind: 'text', text: 'exports a.' });
      return { schemaVersion: 12, requestId: request.requestId, ok: true, result: { done: true } };
    });
    try {
      const events: AgentTurnStreamEvent[] = [];
      const response = await turnLocalRuntime(options, turnRequest(), batch => events.push(...batch));
      expect(response).toEqual({ schemaVersion: 12, requestId: 'request-1', ok: true, result: { done: true } });
      const messages = events.filter(event => event.kind === 'message');
      expect(messages).toEqual(Array.from({ length: 200 }, (_, i) => toolMessage(i)));
      // Adjacent text is coalesced, never reordered.
      expect(events.filter(event => event.kind === 'text')).toEqual([{ kind: 'text', text: 'It exports a.' }]);
      expect(events.at(-1)).toEqual({ kind: 'text', text: 'It exports a.' });
    } finally { await server.dispose(); }
  });

  it('aborts the turn signal after the first write that follows a peer disconnect, without any further write', async () => {
    const options = await fixture(); let channel: RuntimeServiceTurnChannel | undefined;
    let resolveSeen!: () => void; const seen = new Promise<void>(resolve => { resolveSeen = resolve; });
    let resolveGone!: () => void; const gone = new Promise<void>(resolve => { resolveGone = resolve; });
    let resolveAborted!: (value: boolean) => void; const aborted = new Promise<boolean>(resolve => { resolveAborted = resolve; });
    const server = await startLocalRuntimeSocketServer(options, async (request, _peer, _stream, turn) => {
      channel = turn; turn!.emit({ kind: 'text', text: 'working' });
      await gone;
      // A peer that closed after sending its request is seen at the next write (EPIPE); exactly one write happens here.
      turn!.emit({ kind: 'reasoning', text: 'still thinking' }); await turn!.drained();
      const until = performance.now() + 2_000;
      while (!turn!.signal.aborted && performance.now() < until) await new Promise(wake => setTimeout(wake, 10));
      resolveAborted(turn!.signal.aborted);
      return { schemaVersion: 12, requestId: request.requestId, ok: true, result: null };
    });
    try {
      const controller = new AbortController();
      const pending = turnLocalRuntime(options, turnRequest(), () => { resolveSeen(); }, controller.signal);
      await seen; controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
      await new Promise(wake => setTimeout(wake, 50)); resolveGone();
      expect(await aborted).toBe(true);
      // A cancelled channel never blocks its producer.
      await expect(channel!.drained()).resolves.toBeUndefined();
    } finally { await server.dispose(); }
  });

  it('fails closed instead of dropping a structured event that cannot fit one frame', async () => {
    const options = await fixture(2048); let signal: AbortSignal | undefined;
    const server = await startLocalRuntimeSocketServer(options, async (request, _peer, _stream, turn) => {
      signal = turn!.signal;
      turn!.emit({ kind: 'message', message: { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'x'.repeat(4096) } });
      await turn!.drained();
      return { schemaVersion: 12, requestId: request.requestId, ok: true, result: { aborted: turn!.signal.aborted } };
    });
    try {
      const events: AgentTurnStreamEvent[] = [];
      const response = await turnLocalRuntime(options, turnRequest(), batch => events.push(...batch));
      expect(events).toEqual([]);
      expect(response).toMatchObject({ ok: true, result: { aborted: true } }); expect(signal?.aborted).toBe(true);
    } finally { await server.dispose(); }
  });

  it('refuses a turn stream for a non-turn operation before connecting', async () => {
    const options = await fixture();
    await expect(turnLocalRuntime(options, { schemaVersion: 12, requestId: 'r', operation: 'inspectRun', input: {} }, () => undefined))
      .rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
  });
});
