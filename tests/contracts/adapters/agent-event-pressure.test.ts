import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createServerTurnChannel } from '#adapters/core/local-runtime-socket/index.js';
import { openSqliteAgentTurnStore, ServiceFrameError, ServiceFrameStreamDecoder } from '#adapters/index.js';
import { runAgentTurn, runDurableAgentTurn, type AgentRoundOutcome } from '#engine/index.js';
import type { AgentTurnEvent, AgentTurnMessage } from '#domain/index.js';
import { streamTerminalAgentTurn } from '#composition/core/terminal-chat/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

const roots: string[] = [], mounted: ReturnType<typeof mountWorkline>[] = [];
afterEach(async () => {
  for (const view of mounted.splice(0)) view.instance.unmount();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function transport() {
  const socket = new PassThrough(), chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { channel: createServerTurnChannel(socket as unknown as Socket, 'request', 2048, 8192), socket, chunks };
}

it.each(['en', 'tr'] as const)('preserves a producer frame failure through SQLite replay and renders it in %s without rebilling', async language => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-frame-pressure-')); roots.push(root);
  await mkdir(join(root, 'store'));
  const path = join(root, 'store', 'turns.sqlite'), options = { journalMode: 'wal' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
  let store = await openSqliteAgentTurnStore(path, options);
  const { channel, socket } = transport();
  const input = { messages: [{ role: 'user' as const, content: 'read' }], tools: [], language, signal: channel.signal,
    emit: (event: AgentTurnEvent) => { if (event.kind !== 'done') channel.emit(event); },
    claim: { scopeId: 'scope', turnId: 'frame-pressure', principalKey: 'person', requestDigest: 'a'.repeat(64), claimedAtMs: 1 } };
  const invokeRound = vi.fn(async (): Promise<AgentRoundOutcome> => ({ status: 'responded', content: '🙂漢字'.repeat(2_000), reasoning: '',
    toolCalls: [], usage: null, finish: 'stop' }));
  const ports = { invokeRound, contextFailure: () => channel.signal.reason instanceof ServiceFrameError ? 'RUNTIME_CHAT_EVENT_TOO_LARGE' as const : null,
    authorize: async () => 'allow' as const, execute: async () => ({ status: 'ok' as const, text: '' }), describe: () => null, now: () => 1 };
  try {
    const failed = await runDurableAgentTurn(input, store, ports);
    expect(channel.signal.reason).toMatchObject({ code: 'SERVICE_FRAME_LIMIT' });
    expect(failed).toMatchObject({ finish: 'error', recorded: true, replayed: false });
    expect(failed.note).toContain('RUNTIME_CHAT_EVENT_TOO_LARGE');
    store.close(); store = await openSqliteAgentTurnStore(path, options);
    // Fresh channel and abort signal: the failure must come from the persisted outcome, not from the original signal.
    const replay = await runDurableAgentTurn({ ...input, signal: new AbortController().signal, emit: () => undefined }, store, { ...ports, contextFailure: () => null });
    expect(replay).toMatchObject({ finish: 'error', replayed: true, note: failed.note });
    expect(invokeRound).toHaveBeenCalledTimes(1);
    const view = mountWorkline({ streamTurn: (messages, signal) => streamTerminalAgentTurn({ projectRoot: root, scopeId: 'scope', messages, signal, options: {} }, {
      chatTurn: async () => ({ schemaVersion: 1, turnId: input.claim.turnId, ...replay, answer: null, answerBytes: 0 }),
      cancelChatTurn: async () => undefined,
    }) }); mounted.push(view);
    await settle(); view.stdin.write('replay\r');
    await until(() => view.stdout.text.includes('RUNTIME_CHAT_EVENT_TOO_LARGE'), 'durable frame failure on terminal');
    expect(view.stdout.text).toContain(language === 'tr' ? 'tek çerçeve kapasitesini aşıyor' : 'exceeds the single-frame capacity');
    expect(view.stdout.text).toContain('/clear');
  } finally { channel.finish(); socket.destroy(); store.close(); }
});

it('fails before a large compacted replacement can be delivered, including JSON escaping overhead', () => {
  const { channel, socket, chunks } = transport();
  const messages: AgentTurnMessage[] = [{ role: 'user', content: '\u0000'.repeat(400) }];
  channel.emit({ kind: 'compacted', messages, replacedMessages: 10 }); channel.finish();
  expect(channel.signal.reason).toMatchObject({ code: 'SERVICE_FRAME_LIMIT' });
  expect(chunks).toEqual([]); socket.destroy();
});

it.each(['arguments', 'result'] as const)('stops after oversized %s without executing or repeating subsequent effects', async oversized => {
  const { channel, socket } = transport(), huge = '漢'.repeat(4_000);
  const execute = vi.fn(async () => ({ status: 'ok' as const, text: huge })), settled = vi.fn(async () => undefined);
  const invokeRound = vi.fn(async (): Promise<AgentRoundOutcome> => ({ status: 'responded', content: '', reasoning: '', usage: null, finish: 'tool_calls',
    toolCalls: [{ id: 'c', name: 'read', argumentsJson: JSON.stringify({ payload: oversized === 'arguments' ? huge : 'small' }) }] }));
  const result = await runAgentTurn({ messages: [{ role: 'user', content: 'read' }], signal: channel.signal,
    tools: [{ name: 'read', version: 1, description: 'read', toolClass: 'read', inputSchema: { type: 'object', properties: { payload: { type: 'string' } } } }],
    emit: event => { if (event.kind !== 'done') channel.emit(event); } }, {
    invokeRound, execute, settled, authorize: async () => 'allow', describe: () => null, now: () => 0,
    contextFailure: () => channel.signal.reason instanceof ServiceFrameError ? 'RUNTIME_CHAT_EVENT_TOO_LARGE' : null,
  });
  expect(result).toMatchObject({ finish: 'error', toolCalls: oversized === 'arguments' ? 0 : 1 });
  expect(execute).toHaveBeenCalledTimes(oversized === 'arguments' ? 0 : 1);
  expect(invokeRound).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: oversized === 'arguments' ? 'cancelled' : 'ok',
    ...(oversized === 'result' ? { content: huge } : {}) }));
  channel.finish(); socket.destroy();
});

it('still splits presentation text without cutting Unicode and keeps ordinary required data in order', async () => {
  const { channel, socket, chunks } = transport(), text = '🙂漢字'.repeat(200);
  channel.emit({ kind: 'text', text });
  channel.emit({ kind: 'message', message: { role: 'user', content: 'kept' } });
  await channel.drained(); channel.finish();
  expect(channel.signal.aborted).toBe(false);
  const decoder = new ServiceFrameStreamDecoder(2048, null);
  const frames = chunks.flatMap(chunk => decoder.push(chunk)) as { events: { kind: string; text?: string; message?: AgentTurnMessage }[] }[];
  decoder.finish();
  const events = frames.flatMap(frame => frame.events);
  expect(events.filter(event => event.kind === 'text').map(event => event.text).join('')).toBe(text);
  expect(events.at(-1)).toEqual({ kind: 'message', message: { role: 'user', content: 'kept' } });
  socket.destroy();
});
