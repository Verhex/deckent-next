import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { nativeEgressLimits, openNativeEgressGateway } from '#adapters/core/native-connection/index.js';
import { EMPTY_RECORD_STREAM, feedRecordStream, finishRecordStream, snapshotKnownSecrets } from '#platform/index.js';
import type { NativeAgentToolResult, ToolSessionPort } from '#capabilities/index.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).reverse().map(close => close())); });
const registry = nativeCliAgent('claude-code-stream-json')!;
const tool = { name: 'read_file', version: 1, toolClass: 'read' as const, description: 'Read a scoped file', inputSchema: { type: 'object' as const, properties: {} } };
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
const rpc = (id: number, name = tool.name, args: Record<string, unknown> = {}, meta: Record<string, unknown> = { 'claudecode/toolUseId': `tool-${id}` }) => ({
  jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: meta } });
type Answer = { status: number; headers: IncomingHttpHeaders; body: string };
const jsonMessages = (answer: Answer) => answer.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
const resultEnvelope = (answer: Answer) => JSON.parse(jsonMessages(answer).find(message => message.result)?.result.content[0].text) as NativeAgentToolResult;
async function fixture(over: Partial<Parameters<typeof createNativeToolBridge>[0]> = {}, propose?: ToolSessionPort['propose']) {
  const directory = await mkdtemp(join(tmpdir(), 'native-bridge-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const session = { schemaVersion: 1 as const, turnId: 'fixture-turn', generation: 1, tools: [tool], approvalTtlMs: 5000 };
  const submit = vi.fn(propose ?? (async (call) => ({ schemaVersion: 1, turnId: session.turnId, generation: session.generation,
    deckentCallId: call.id, outcome: { status: 'ok', text: 'scoped-result' } })));
  const closure = { turnId: session.turnId, generation: session.generation, pendingCallIds: [], termination: 'confirmed' as const, effects: 'unknown' as const };
  const port: ToolSessionPort = { session, propose: submit, cancel: vi.fn(async () => ({ ...closure, kind: 'cancelled' })), revoke: vi.fn(async () => ({ ...closure, kind: 'revoked' })) };
  const bridge = await createNativeToolBridge({ port, bridge: registry.bridge, correlationKind: 'claude-tool-use',
    limits: { idleMs: 300, maxConnections: 3, replayMaxEntries: 8, replayMaxBytes: registry.bridge.frameMaxBytes * 8 }, ...over });
  const gateway = await openNativeEgressGateway({ provider: registry.id, directory, mcp: bridge }); cleanup.push(() => gateway.close());
  const send = (body: unknown, options: { method?: string; headers?: Record<string, string>; path?: string; raw?: string } = {}) => new Promise<Answer>((resolve, reject) => {
    const req = httpRequest({ socketPath: gateway.socketPath, path: options.path ?? bridge.url, method: options.method ?? 'POST', agent: false,
      headers: { host: bridge.sentinelHost, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        [registry.bridge.tokenHeaderName]: bridge.tokenHeader, ...options.headers } }, response => {
      let text = ''; response.on('data', chunk => { text += String(chunk); }); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: text }));
    });
    req.on('error', reject); req.end(options.raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
  const initialize = async () => { const answer = await send(init); expect(answer.status).toBe(200); return { 'mcp-session-id': String(answer.headers['mcp-session-id']) }; };
  return { bridge, gateway, submit, port, send, initialize };
}

it('routes only the exact sentinel; exposes only session tools and sends correlated proposals through K1', async () => {
  const f = await fixture(), headers = await f.initialize();
  const list = await f.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { headers });
  expect(jsonMessages(list)[0].result.tools.map((entry: { name: string }) => entry.name)).toEqual(['read_file']);
  const answer = await f.send(rpc(3), { headers }); expect(resultEnvelope(answer)).toMatchObject({ generation: 1, outcome: { text: 'scoped-result' } });
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.submit.mock.calls[0]![1]).toMatchObject({ kind: 'claude-tool-use', toolUseId: 'tool-3' });
  const forbidden = await f.send(rpc(4, 'decide_approval'), { headers }); expect(resultEnvelope(forbidden).outcome.text).toBe('NATIVE_BRIDGE_TOOL_UNKNOWN');
  expect((await f.send(init, { path: '/mcp' })).status).toBe(403);
  expect((await f.send(init, { path: `${f.bridge.url}?redirect=1` })).status).toBe(403);
  expect((await f.send(init, { path: 'http://foreign.invalid/mcp' })).status).toBe(403);
  expect(f.gateway.egress()).toMatchObject({ refused: 3, other: 3 });
});

it('authenticates before parsing, rejects second initialize/foreign sessions and invalid Origin', async () => {
  const f = await fixture();
  const unauth = await f.send(undefined, { raw: 'not-json', headers: { Authorization: '' } });
  expect(unauth.status).toBe(403); expect(unauth.body).toContain('NATIVE_BRIDGE_TOKEN_INVALID');
  const headers = await f.initialize();
  expect((await f.send(init)).body).toContain('NATIVE_BRIDGE_SESSION_INVALID');
  expect((await f.send(rpc(2), { headers: { 'mcp-session-id': 'foreign' } })).body).toContain('NATIVE_BRIDGE_SESSION_INVALID');
  expect((await f.send(rpc(2), { headers: { ...headers, Origin: 'https://foreign.invalid' } })).body).toContain('NATIVE_BRIDGE_ORIGIN_INVALID');
  expect(f.submit).not.toHaveBeenCalled(); expect(f.gateway.mcpStatistics().refused).toBe(4);
  expect((await f.send({ ...rpc(2), id: 'x'.repeat(registry.bridge.frameMaxBytes / 2) }, { headers })).status).toBe(400);
});

it('replays a pending and completed call once, refuses changed arguments and never evicts to re-execute', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ limits: { idleMs: 300, maxConnections: 3, replayMaxEntries: 1, replayMaxBytes: registry.bridge.frameMaxBytes } }, async (call) => {
    await wait; return { schemaVersion: 1, turnId: 'fixture-turn', generation: 1, deckentCallId: call.id, outcome: { status: 'ok', text: 'once' } };
  });
  const headers = await f.initialize(), first = f.send(rpc(2), { headers });
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  expect((await f.send(rpc(2), { headers })).status).toBe(409);
  const duplicate = f.send({ ...rpc(2), id: 3 }, { headers }); release();
  const [a, b] = await Promise.all([first, duplicate]); expect(resultEnvelope(a)).toEqual(resultEnvelope(b));
  expect(resultEnvelope(await f.send(rpc(2), { headers }))).toEqual(resultEnvelope(a));
  expect(resultEnvelope(await f.send(rpc(2, tool.name, { changed: true }), { headers })).outcome.text).toBe('NATIVE_BRIDGE_REPLAY_CONFLICT');
  expect(resultEnvelope(await f.send(rpc(5), { headers })).outcome.text).toBe('NATIVE_BRIDGE_REPLAY_LIMIT'); expect(f.submit).toHaveBeenCalledOnce();
});

it('returns after waiting longer than the configured idle bound with SSE keepalive', async () => {
  const f = await fixture({}, async call => { await new Promise(resolve => setTimeout(resolve, 750)); return {
    schemaVersion: 1, turnId: 'fixture-turn', generation: 1, deckentCallId: call.id, outcome: { status: 'ok', text: 'approved-later' } }; });
  const headers = await f.initialize(), answer = await f.send(rpc(2), { headers });
  expect(answer.body).toMatch(/:/u); expect(resultEnvelope(answer).outcome.text).toBe('approved-later');
});

it('cancels waiting K1 calls and closes persistent GET at turn end; stale tokens cannot enter the new generation', async () => {
  let signal: AbortSignal | undefined;
  const f = await fixture({}, async (_call, _correlation, abort) => { signal = abort; return new Promise(() => undefined); });
  const headers = await f.initialize();
  const stream = httpRequest({ socketPath: f.gateway.socketPath, path: f.bridge.url, method: 'GET', agent: false,
    headers: { host: f.bridge.sentinelHost, accept: 'text/event-stream', Authorization: f.bridge.tokenHeader, ...headers } });
  const streamClosed = new Promise<void>(resolve => { stream.on('response', response => { response.on('data', () => undefined); response.on('close', resolve); response.on('error', () => undefined); }); stream.on('error', () => resolve()); }); stream.end();
  const call = f.send(rpc(2), { headers }).catch(() => null);
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  expect(await f.bridge.cancel()).toMatchObject({ kind: 'cancelled', effects: 'unknown' });
  expect(signal?.aborted).toBe(true); await call; await streamClosed;
  expect((await f.send(rpc(2), { headers })).status).toBe(403);
  const next = await fixture({ port: { ...f.port, session: { ...f.port.session, generation: 2 } } });
  expect((await next.send(init, { headers: { Authorization: f.bridge.tokenHeader } })).status).toBe(403);
});

it('handles MCP cancellation without re-executing the cancelled proposal', async () => {
  let aborted: AbortSignal | undefined;
  const f = await fixture({}, async (_call, _correlation, signal) => { aborted = signal; return new Promise(() => undefined); });
  const headers = await f.initialize(), call = f.send(rpc(2), { headers });
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  expect((await f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }, { headers })).status).toBe(202);
  await call; expect(aborted?.aborted).toBe(true);
  await f.send(rpc(2), { headers }); expect(f.submit).toHaveBeenCalledOnce();
});

it('bounds declared/chunked bodies and output frames, without invoking unknown effects or leaking secret values', async () => {
  const canary = 'LOGIN-CANARY-facade-fixture', f = await fixture({ bridge: { ...registry.bridge, bodyMaxBytes: 4096, frameMaxBytes: 2048 },
    knownSecrets: snapshotKnownSecrets([{ name: null, value: canary }]) }, async call => ({ schemaVersion: 1, turnId: 'fixture-turn', generation: 1,
    deckentCallId: call.id, outcome: { status: 'ok', text: canary + 'x'.repeat(3000) } }));
  const headers = await f.initialize();
  expect(resultEnvelope(await f.send(rpc(2), { headers })).outcome.text).toBe('NATIVE_BRIDGE_FRAME_LIMIT');
  const tooLarge = await f.send(undefined, { raw: 'x'.repeat(4097), headers: { ...headers, 'Content-Length': '4097' } });
  expect(tooLarge.status).toBe(413); expect(f.submit).toHaveBeenCalledOnce();
  expect((await f.send(undefined, { raw: 'x'.repeat(4097), headers: { ...headers, 'Transfer-Encoding': 'chunked' } })).status).toBe(413);
  expect(JSON.stringify(f.gateway.statistics())).not.toContain(canary);
});

it('preserves unknown outcomes, validates result identity, and redacts the Deckent token from tool output', async () => {
  let text = '', kind = 'ok';
  const f = await fixture({}, async call => { if (kind === 'throw') throw new Error('private-canary'); return {
    schemaVersion: 1, turnId: 'fixture-turn', generation: kind === 'wrong' ? 2 : 1, deckentCallId: call.id, outcome: { status: 'ok', text } }; });
  const headers = await f.initialize(); text = f.bridge.turnToken;
  expect(JSON.stringify(f.bridge)).not.toContain(text);
  expect((await f.send(rpc(2), { headers })).body).not.toContain(text);
  kind = 'wrong'; expect(resultEnvelope(await f.send(rpc(3), { headers })).outcome.text).toBe('NATIVE_BRIDGE_RESULT_INVALID');
  kind = 'throw'; const unknown = await f.send(rpc(4), { headers }); expect(resultEnvelope(unknown).outcome.text).toBe('NATIVE_BRIDGE_RESULT_UNKNOWN');
  expect(unknown.body).not.toContain('private-canary'); await f.send(rpc(4), { headers }); expect(f.submit).toHaveBeenCalledTimes(3);
  expect(await f.bridge.revoke()).toMatchObject({ kind: 'revoked', effects: 'unknown' });
  // A chat answer ending in an ordinary character is never masked as a turn-token fragment; a real fragment still is.
  const token = f.bridge.turnToken, known = snapshotKnownSecrets([{ name: f.bridge.tokenEnvName, value: token }]);
  const finish = (answer: string) => { const fed = feedRecordStream(EMPTY_RECORD_STREAM, answer, known); return fed.text + finishRecordStream(fed.state, known); };
  // Before the fixed head, an answer ending in the random token's first character showed "complete[REDACTED]" (~1/64).
  const ordinary = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!?)`';
  for (const end of ordinary) expect(finish(`agent complete${end}`)).toBe(`agent complete${end}`);
  for (const fragment of [token.slice(0, 1), token.slice(0, 12), token.slice(0, -1)]) {
    const shown = finish(`agent completed ${fragment}`);
    expect(shown).toMatch(/^agent completed \[REDACTED\]$/u); expect(shown).not.toContain(token.slice(0, 2));
  }
});

it('uses Codex metadata correlation and refuses absent correlation without invoking K1', async () => {
  const f = await fixture({ correlationKind: 'codex-mcp' }), headers = await f.initialize();
  expect(resultEnvelope(await f.send(rpc(2), { headers })).outcome.text).toBe('NATIVE_BRIDGE_CORRELATION_INVALID');
  await f.send(rpc(3, tool.name, {}, { callId: 'call_3', itemId: 'fc_3' }), { headers });
  expect(f.submit.mock.calls[0]![1]).toMatchObject({ kind: 'codex-mcp', callId: 'call_3', itemId: 'fc_3' });
});

it('reserves MCP connections within the existing gateway cap and keeps provider refusals separate', async () => {
  const f = await fixture();
  await expect(openNativeEgressGateway({ provider: registry.id, directory: '.', mcp: { ...f.bridge, maxConnections: nativeEgressLimits().connections } })).rejects.toMatchObject({ code: 'NATIVE_CONNECTION_UNAVAILABLE' });
  const headers = await f.initialize();
  const requests = Array.from({ length: 3 }, (_, index) => f.send(rpc(index + 2), { headers })); await Promise.all(requests);
  expect(f.gateway.mcpStatistics().requests).toBe(4); expect(f.gateway.egress().refused).toBe(0);
  expect(f.gateway.statistics().bytes).toBeGreaterThan(0);
});

it('refuses excess live MCP streams and fences new proposals on external turn abort', async () => {
  const controller = new AbortController();
  const f = await fixture({ signal: controller.signal, limits: { idleMs: 300, maxConnections: 1, replayMaxEntries: 2, replayMaxBytes: registry.bridge.frameMaxBytes * 2 } }, async () => new Promise(() => undefined));
  const headers = await f.initialize(), waiting = f.send(rpc(2), { headers }).catch(() => null);
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  expect((await f.send(rpc(3), { headers })).status).toBe(429);
  controller.abort(); await waiting;
  expect((await f.send(rpc(3), { headers })).status).toBe(403); expect(f.submit).toHaveBeenCalledOnce();
});
