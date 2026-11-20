import { request as httpRequest, ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { nativeEgressLimits, openNativeEgressGateway } from '#adapters/core/native-connection/index.js';
import { EMPTY_RECORD_STREAM, feedRecordStream, finishRecordStream, snapshotKnownSecrets } from '#platform/index.js';
import { agentToolArgumentsDigest, runAgentTurn } from '#engine/core/agent-turn/index.js';
import type { NativeAgentToolResult, SameTurnPlanningPort, ToolSessionPort } from '#capabilities/index.js';

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
  const send = (body: unknown, options: { method?: string; headers?: Record<string, string>; path?: string; raw?: string; onData?: () => void } = {}) => new Promise<Answer>((resolve, reject) => {
    const req = httpRequest({ socketPath: gateway.socketPath, path: options.path ?? bridge.url, method: options.method ?? 'POST', agent: false,
      headers: { host: bridge.sentinelHost, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        [registry.bridge.tokenHeaderName]: bridge.tokenHeader, ...options.headers } }, response => {
      let text = ''; response.on('data', chunk => { text += String(chunk); options.onData?.(); }); response.on('error', reject);
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
  expect(jsonMessages(forbidden)[0].result.isError).toBe(true);
  expect(resultEnvelope(forbidden).outcome.status).toBe('error');
  expect(f.submit).toHaveBeenCalledOnce();
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

it('refuses a batched POST before any tool execution or plan finalization', async () => {
  let preparation = false, reply: Answer | undefined;
  const tools = [{ ...tool, name: 'propose_work' }], finishPlanning = vi.fn(async () => 'proposed');
  const planning: SameTurnPlanningPort = {
    get active() { return preparation; }, pin: null, normalClosed: true, beforeTool: vi.fn(),
    privateResult: () => null, bindNativeSession: vi.fn(), bindDeliveryProjection: vi.fn(), preparationSettled: vi.fn(),
    preparationDelivered: vi.fn(), terminalEnvelope: vi.fn(), nativeClosed: vi.fn(), responseBody: vi.fn(), abandon: vi.fn(),
  };
  const execute = vi.fn(async () => {
    preparation = true;
    return { status: 'ok' as const, text: 'prepared' };
  });
  const result = await runAgentTurn({ nativeSession: { schemaVersion: 1, turnId: 'fixture-turn', generation: 1, approvalTtlMs: 5000, tools },
    messages: [{ role: 'user', content: 'fixture' }], tools, emit: vi.fn(), signal: new AbortController().signal, language: 'en' }, {
    planning, finishPlanning, execute, now: Date.now, authorize: async () => 'allow', describe: () => null,
    invokeRound: async () => { throw new Error('unexpected model round'); },
    invokeAgent: async ({ session }) => {
      const f = await fixture({ port: session }), headers = await f.initialize();
      reply = await f.send([rpc(2, 'propose_work'), rpc(3, 'propose_work')], { headers });
      return { status: 'responded', content: 'done', reasoning: '', finish: 'stop', toolCalls: [], usage: null };
    },
  });
  expect({ status: reply?.status, executions: execute.mock.calls.length, finalizations: finishPlanning.mock.calls.length })
    .toEqual({ status: 400, executions: 0, finalizations: 0 });
  expect(JSON.parse(reply!.body)).toMatchObject({ id: null, error: { data: { reason: 'NATIVE_BRIDGE_REQUEST_INVALID' } } });
  expect(result).toMatchObject({ finish: 'stop', answer: 'done' });
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

it('selects pending results against the live K1 session and preserves ordinary chat replay', async () => {
  for (const prepare of [false, true]) {
    const waiting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), duplicateStream = Promise.withResolvers<void>();
    const executions: string[] = [], deliveries: string[] = [];
    let candidate: string | undefined;
    const planning: SameTurnPlanningPort = {
      get active() { return candidate !== undefined; }, pin: null, normalClosed: true,
      beforeTool(id) { if (candidate && candidate !== id) throw new Error('stale call'); },
      privateResult: () => null, bindNativeSession: vi.fn(), bindDeliveryProjection: vi.fn(),
      preparationSettled: vi.fn(), preparationDelivered: vi.fn(), terminalEnvelope: vi.fn(), nativeClosed: vi.fn(), responseBody: vi.fn(), abandon: vi.fn(),
    };
    const tools = [tool, { ...tool, name: 'propose_work' }], finishPlanning = vi.fn(async () => 'proposed');
    const result = await runAgentTurn({ nativeSession: { schemaVersion: 1, turnId: 'fixture-turn', generation: 1, approvalTtlMs: 5000, tools },
      messages: [{ role: 'user', content: 'fixture' }], tools, emit: vi.fn(), signal: new AbortController().signal, language: 'en' }, {
      planning, finishPlanning, now: Date.now, authorize: async () => 'allow', describe: () => null,
      invokeRound: async () => { throw new Error('unexpected model round'); },
      execute: async (spec, _args, _signal, id) => {
        executions.push(spec.name);
        if (spec.name === 'propose_work') candidate = id;
        return { status: 'ok', text: spec.name };
      },
      invokeAgent: async ({ session }) => {
        const f = await fixture({ port: { ...session, async propose(call, correlation, signal) {
          const result = await session.propose(call, correlation, signal);
          if (call.name === tool.name) { waiting.resolve(); await release.promise; }
          return result;
        } } });
        const headers = await f.initialize();
        const first = f.send(rpc(2), { headers });
        await waiting.promise;
        const repeat = f.send({ ...rpc(2), id: 3 }, { headers, onData: duplicateStream.resolve });
        // The pending duplicate's own SSE emits a keepalive before preparation can begin.
        try {
          await duplicateStream.promise;
          if (prepare) {
            const prepared = resultEnvelope(await f.send(rpc(4, 'propose_work'), { headers }));
            expect(prepared.outcome).toEqual({ status: 'ok', text: 'propose_work' });
            deliveries.push(prepared.outcome.text);
          }
        } finally { release.resolve(); }
        for (const answer of await Promise.all([first, repeat])) {
          const outcome = resultEnvelope(answer).outcome;
          if (outcome.status === 'ok') deliveries.push(outcome.text);
          expect.soft(outcome).toEqual(prepare ? { status: 'error', text: 'BRAIN_SAME_TURN_REFUSED' } : { status: 'ok', text: tool.name });
        }
        return { status: 'responded', content: 'done', reasoning: '', finish: 'stop', toolCalls: [], usage: null };
      },
    });
    expect.soft(deliveries).toEqual(prepare ? ['propose_work'] : [tool.name, tool.name]);
    expect.soft(executions).toEqual(prepare ? [tool.name, 'propose_work'] : [tool.name]);
    expect.soft(result.finish).toBe(prepare ? 'error' : 'stop');
    expect.soft(finishPlanning).not.toHaveBeenCalled();
  }
});

it('checks both first and replay delivery behind HTTP backpressure and closes preparation during an uncertain earlier write', async () => {
  for (const mode of ['first', 'replay', 'ordinary', 'uncertain'] as const) {
    const blocked = Promise.withResolvers<() => void>(), selected = Promise.withResolvers<void>(), releaseResult = Promise.withResolvers<void>();
    const executions: string[] = [], written: string[] = [];
    let candidate: string | undefined, selections = 0, armed = true;
    const finishPlanning = vi.fn(async () => 'proposed'), beforeTool = vi.fn((id: string) => {
      if (candidate && candidate !== id) throw new Error('stale-terminal');
    });
    const planning: SameTurnPlanningPort = {
      get active() { return candidate !== undefined; }, pin: null, normalClosed: true, beforeTool,
      privateResult: () => null, bindNativeSession: vi.fn(), bindDeliveryProjection: vi.fn(), preparationSettled: vi.fn(),
      preparationDelivered: vi.fn(), terminalEnvelope: vi.fn(), nativeClosed: vi.fn(), responseBody: vi.fn(), abandon: vi.fn(),
    };
    const tools = [tool, { ...tool, name: 'propose_work' }];
    const write = ServerResponse.prototype.write;
    const spy = vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (this: ServerResponse, ...args: Parameters<typeof write>) {
      const chunk = String(args[0]), early = chunk.includes('read_file');
      if (armed && this.req.headers['x-fixture-block-write'] === 'yes' && (mode === 'uncertain' ? early : chunk.startsWith(':'))) {
        armed = false;
        blocked.resolve(() => {
          Reflect.apply(write, this, args);
          this.emit('drain');
        });
        if (early) written.push(chunk);
        return false;
      }
      written.push(chunk);
      return Reflect.apply(write, this, args) as boolean;
    });
    let unexpected: unknown;
    try {
      const result = await runAgentTurn({ nativeSession: { schemaVersion: 1, turnId: 'fixture-turn', generation: 1, approvalTtlMs: 5000, tools },
        messages: [{ role: 'user', content: 'fixture' }], tools, emit: vi.fn(), signal: new AbortController().signal, language: 'en' }, {
        planning, finishPlanning, now: Date.now, authorize: async () => 'allow', describe: () => null,
        invokeRound: async () => { throw new Error('unexpected model round'); },
        execute: async (spec, _args, _signal, id) => {
          executions.push(spec.name);
          if (spec.name === 'propose_work') candidate = id;
          return { status: 'ok', text: spec.name };
        },
        invokeAgent: async ({ session }) => {
          const f = await fixture({ port: { ...session, checkResultDelivery(call) {
            if (call.name === tool.name && ++selections === (mode === 'replay' ? 2 : 1)) selected.resolve();
            return session.checkResultDelivery!(call);
          }, async propose(call, correlation, signal) {
            const answer = await session.propose(call, correlation, signal);
            if (call.name === tool.name && mode !== 'uncertain') await releaseResult.promise;
            return answer;
          } } });
          const headers = await f.initialize();
          const blockedHeaders = { ...headers, 'x-fixture-block-write': 'yes' };
          const first = f.send(rpc(2), { headers: mode === 'replay' ? headers : blockedHeaders }).catch(() => null);
          if (mode === 'replay') await vi.waitFor(() => expect(executions).toEqual([tool.name]));
          const repeat = mode === 'replay' ? f.send({ ...rpc(2), id: 3 }, { headers: blockedHeaders }).catch(() => null) : first;
          const resume = await blocked.promise;
          releaseResult.resolve();
          try {
            await selected.promise;
            if (mode === 'replay') expect(resultEnvelope((await first)!)).toMatchObject({ outcome: { status: 'ok', text: tool.name } });
            if (mode !== 'ordinary') await f.send(rpc(4, 'propose_work'), { headers }).catch(() => null);
          } catch (error) { unexpected = error; }
          finally { resume(); }
          await repeat;
          return { status: 'responded', content: 'done', reasoning: '', finish: 'stop', toolCalls: [], usage: null };
        },
      });
      if (unexpected) throw unexpected;
      const writtenEarlier = written.filter(frame => frame.includes('read_file'));
      expect.soft(writtenEarlier, mode).toHaveLength(mode === 'first' ? 0 : 1);
      expect.soft(written.filter(frame => frame.includes('propose_work')), mode).toHaveLength(mode === 'first' || mode === 'replay' ? 1 : 0);
      expect.soft(executions, mode).toEqual(mode === 'ordinary' ? [tool.name] : [tool.name, 'propose_work']);
      expect.soft(result.finish, mode).toBe(mode === 'ordinary' ? 'stop' : 'error');
      expect.soft(finishPlanning, mode).not.toHaveBeenCalled();
      if (candidate) expect.soft(beforeTool.mock.results.some(result => result.type === 'throw' && result.value.message === 'stale-terminal'), mode).toBe(true);
    } finally { spy.mockRestore(); releaseResult.resolve(); }
  }
});

it('closes a bound preparation on changed replay arguments without executing again', async () => {
  let candidate: { id: string; digest: string } | undefined, executions = 0;
  const finishPlanning = vi.fn(async () => 'proposed');
  const beforeTool = vi.fn((id: string, digest: string) => {
    if (candidate && (candidate.id !== id || candidate.digest !== digest)) throw new Error('stale-terminal');
  });
  const planning: SameTurnPlanningPort = {
    get active() { return candidate !== undefined; }, pin: null, normalClosed: true, beforeTool,
    privateResult: () => null, bindNativeSession: vi.fn(), bindDeliveryProjection: vi.fn(),
    preparationSettled: vi.fn(), preparationDelivered: vi.fn(), terminalEnvelope: vi.fn(), nativeClosed: vi.fn(), responseBody: vi.fn(), abandon: vi.fn(),
  };
  const tools = [{ ...tool, name: 'propose_work' }];
  let identical: NativeAgentToolResult | undefined, first: NativeAgentToolResult | undefined, conflict: NativeAgentToolResult | undefined;
  let sessionStopped = false;
  const turn = await runAgentTurn({ nativeSession: { schemaVersion: 1, turnId: 'fixture-turn', generation: 1, approvalTtlMs: 5000, tools },
    messages: [{ role: 'user', content: 'fixture' }], tools, emit: vi.fn(), signal: new AbortController().signal, language: 'en' }, {
    planning, finishPlanning, now: Date.now, authorize: async () => 'allow', describe: () => null,
    invokeRound: async () => { throw new Error('unexpected model round'); },
    execute: async (spec, args, _signal, id) => {
      executions++;
      candidate = { id, digest: agentToolArgumentsDigest(spec.name, args) };
      return { status: 'ok', text: 'prepared' };
    },
    invokeAgent: async ({ session }, _delta, signal) => {
      const f = await fixture({ port: session }), headers = await f.initialize(), original = rpc(2, 'propose_work');
      first = resultEnvelope(await f.send(original, { headers }));
      identical = resultEnvelope(await f.send({ ...original, id: 3 }, { headers }));
      conflict = resultEnvelope(await f.send({ ...original, id: 4, params: { ...original.params, arguments: { changed: true } } }, { headers }));
      sessionStopped = signal.aborted;
      return { status: 'responded', content: 'done', reasoning: '', finish: 'stop', toolCalls: [], usage: null };
    },
  });
  expect(first?.outcome).toEqual({ status: 'ok', text: 'prepared' });
  expect(identical).toEqual(first);
  expect(conflict?.outcome).toEqual({ status: 'error', text: 'NATIVE_BRIDGE_REPLAY_CONFLICT' });
  expect(executions).toBe(1);
  expect.soft(beforeTool).toHaveBeenCalledWith(first!.deckentCallId, agentToolArgumentsDigest('propose_work', { changed: true }));
  expect.soft(sessionStopped).toBe(true);
  expect.soft(turn.finish).toBe('error');
  expect.soft(finishPlanning).not.toHaveBeenCalled();
});

it('serves the ninth call through the registry budget of 128 calls and refuses the next call without an effect', async () => {
  const { maxConnections, replayMaxEntries, replayMaxBytes } = registry.bridge;
  const f = await fixture({ limits: { idleMs: 300, maxConnections: maxConnections!, replayMaxEntries: replayMaxEntries!, replayMaxBytes: replayMaxBytes! } });
  const headers = await f.initialize();
  for (let call = 1; call <= 128; call++) {
    expect(resultEnvelope(await f.send(rpc(call + 1), { headers })).outcome).toEqual({ status: 'ok', text: 'scoped-result' });
  }
  expect(resultEnvelope(await f.send(rpc(130), { headers })).outcome.text).toBe('NATIVE_BRIDGE_REPLAY_LIMIT');
  expect(f.submit).toHaveBeenCalledTimes(128);
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
