import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import type { ModelInvocationCancellationCommand, ModelInvocationCommand, ModelInvocationDeltaSink } from '#domain/index.js';
import { openSqliteModelActivationStore } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationRequestDigest, modelInvocationTargetId,
  type ModelInvocationResult } from '#engine/index.js';
import { cancelRuntimeModelInvocation, createConfiguredRuntimeClient, invokeRuntimeModelStream,
  startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { streamTerminalChatTurn, type TerminalChatStreamPorts } from '#composition/core/terminal-chat/index.js';
import { clearConfigCache, DeckentError, prepareProductFile, resolveGlobalConfigPaths, resolveProductLayout } from '#platform/index.js';
import type { TurnDelta } from '#surfaces/index.js';
import { parseOpenAiChatHttpDefinition, parseOpenAiChatTextRequest } from '../../../src/adapters/core/provider-openai-chat/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';

const roots: string[] = [], servers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const model = { id: 'chat', version: 1, nativeId: 'native-chat', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] };
const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'local-openai', version: 1, models: [model] }] };
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
const messages = [{ role: 'user' as const, content: 'hi' }];
const collect = async (stream: AsyncIterable<TurnDelta>) => { const out: TurnDelta[] = []; for await (const delta of stream) out.push(delta); return out; };

function responded(content: string, reasoning = '', finish = 'stop', replayed = false): ModelInvocationResult {
  return { replayed, receipt: { outcome: { state: 'responded' } } as never, contentStatus: 'retained', purge: null,
    response: { schemaVersion: 1, native: { choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content,
      ...(reasoning ? { reasoning } : {}) } }] }, usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12,
      completion_tokens_details: { reasoning_tokens: 3 } } } } as unknown as ModelInvocationResult;
}
async function configured() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-chat-stream-')); roots.push(root);
  const home = join(root, 'home'), projectRoot = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  await Promise.all([mkdir(dirname(resolveGlobalConfigPaths(env).platformPath), { recursive: true }), mkdir(join(projectRoot, '.deckent'), { recursive: true })]);
  await writeFile(join(projectRoot, '.deckent', 'config.json'), JSON.stringify({ provider_catalog: catalog,
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 48 } } }));
  return { projectRoot, options: { env } };
}
function fakePorts(run: (command: ModelInvocationCommand, onDelta: ModelInvocationDeltaSink, signal?: AbortSignal) => Promise<ModelInvocationResult>) {
  const invoked: ModelInvocationCommand[] = [], cancelled: ModelInvocationCancellationCommand[] = [];
  const ports: TerminalChatStreamPorts = {
    async invokeStream(_root, command, onDelta, _options, signal) { invoked.push(command); return run(command, onDelta, signal); },
    async cancel(_root, command) { cancelled.push(command); return {}; },
  };
  return { ports, invoked, cancelled };
}

describe('streamed terminal chat turn contract', () => {
  it('yields deltas in order, completes from the governed result, and ends with exactly one done', async () => {
    const f = await configured();
    const p = fakePorts(async (_command, onDelta) => {
      onDelta({ kind: 'reasoning', text: 'thi' }); onDelta({ kind: 'reasoning', text: 'nk' }); onDelta({ kind: 'text', text: 'Mer' });
      await new Promise(resolve => setTimeout(resolve, 5));
      return responded('Merhaba!', 'think');
    });
    const deltas = await collect(streamTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 'team', messages, options: f.options }, p.ports));
    expect(deltas).toEqual([{ kind: 'reasoning', text: 'thi' }, { kind: 'reasoning', text: 'nk' }, { kind: 'text', text: 'Mer' },
      { kind: 'text', text: 'haba!' }, { kind: 'usage', promptTokens: 5, completionTokens: 7, reasoningTokens: 3 }, { kind: 'done', finish: 'stop' }]);
    const definition = parseOpenAiChatHttpDefinition({ endpoint: 'http://127.0.0.1:18080/v1/chat/completions', maxOutputTokens: 64,
      authentication: { type: 'none' }, tariff });
    expect(parseOpenAiChatTextRequest(p.invoked[0]!.nativeRequest, definition)).toEqual({ model: 'native-chat', messages,
      max_completion_tokens: 48, stream: true, stream_options: { include_usage: true } });
    expect(p.invoked[0]).toMatchObject({ scopeId: 'team', reference, catalogRevision: 'catalog-1' }); expect(p.cancelled).toEqual([]);
  });

  it('shows a replayed answer whole, keeps reasoning-exhausted turns as length, and never merges a divergent stream', async () => {
    const f = await configured(), input = { projectRoot: f.projectRoot, scopeId: 'team', messages, options: f.options };
    expect(await collect(streamTerminalChatTurn(input, fakePorts(async () => responded('Tamam', '', 'stop', true)).ports)))
      .toEqual([{ kind: 'text', text: 'Tamam' }, { kind: 'usage', promptTokens: 5, completionTokens: 7, reasoningTokens: 3 }, { kind: 'done', finish: 'stop' }]);
    const length = await collect(streamTerminalChatTurn(input, fakePorts(async (_c, onDelta) => {
      onDelta({ kind: 'reasoning', text: 'long thought' }); return responded('', 'long thought', 'length');
    }).ports));
    expect(length.at(-1)).toEqual({ kind: 'done', finish: 'length' }); expect(length.some(delta => delta.kind === 'text')).toBe(false);
    const divergent = streamTerminalChatTurn(input, fakePorts(async (_c, onDelta) => { onDelta({ kind: 'text', text: 'Hello' }); return responded('Goodbye'); }).ports);
    await expect(collect(divergent)).rejects.toMatchObject({ code: 'TERMINAL_CHAT_STREAM_MISMATCH' });
    const unknown = { ...responded(''), receipt: { outcome: { state: 'unknown' } }, response: null } as unknown as ModelInvocationResult;
    await expect(collect(streamTerminalChatTurn(input, fakePorts(async () => unknown).ports)))
      .rejects.toMatchObject({ code: 'TERMINAL_CHAT_INVOCATION_FAILED', params: { state: 'unknown' } });
    await expect(collect(streamTerminalChatTurn(input, fakePorts(async () => responded('  ')).ports))).rejects.toMatchObject({ code: 'TERMINAL_CHAT_EMPTY' });
    const failing = fakePorts(async () => { throw new DeckentError('MODEL_INVOCATION_UNAVAILABLE', 'down'); });
    await expect(collect(streamTerminalChatTurn(input, failing.ports))).rejects.toMatchObject({ code: 'MODEL_INVOCATION_UNAVAILABLE' });
    expect(failing.invoked).toHaveLength(1); expect(failing.cancelled).toEqual([]);
  });

  it('requests governed cancellation of the exact invocation on abort and when the consumer stops early', async () => {
    const f = await configured(), controller = new AbortController();
    const held = (onDelta: ModelInvocationDeltaSink, signal?: AbortSignal) => new Promise<ModelInvocationResult>((_resolve, reject) => {
      onDelta({ kind: 'text', text: 'partial' });
      signal?.addEventListener('abort', () => reject(new Error('disconnected')), { once: true });
    });
    const aborted = fakePorts((_c, onDelta, signal) => held(onDelta, signal));
    const seen: TurnDelta[] = [];
    for await (const delta of streamTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 'team', messages, options: f.options,
      signal: controller.signal }, aborted.ports)) { seen.push(delta); if (delta.kind === 'text') controller.abort(); }
    expect(seen).toEqual([{ kind: 'text', text: 'partial' }, { kind: 'done', finish: 'cancelled' }]);
    expect(aborted.cancelled).toEqual([expect.objectContaining({ scopeId: 'team', targetCommandId: aborted.invoked[0]!.commandId, reference,
      expectedRequestDigest: modelInvocationRequestDigest(aborted.invoked[0]!) })]);
    const early = fakePorts((_c, onDelta, signal) => held(onDelta, signal));
    for await (const delta of streamTerminalChatTurn({ projectRoot: f.projectRoot, scopeId: 'team', messages, options: f.options }, early.ports)) {
      expect(delta).toEqual({ kind: 'text', text: 'partial' }); break;
    }
    expect(early.cancelled).toEqual([expect.objectContaining({ targetCommandId: early.invoked[0]!.commandId })]);
  });
});

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-chat-stream-runtime-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const state = { requests: 0, closed: 0, lastWriteAt: 0, hold: false };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [],
    usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`;
  const parts = [chunk({ role: 'assistant', content: '' }), chunk({ reasoning: 'Selam' }), chunk({ reasoning: ' vermeli' }),
    chunk({ content: 'Mer' }), chunk({ content: 'haba' }), chunk({ content: '!' }), chunk({}, 'stop'), usage, 'data: [DONE]\n\n'];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume(); req.on('end', () => {
      state.requests++; res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.on('close', () => { state.closed++; });
      let index = 0;
      const next = () => {
        if (res.destroyed) return;
        if (state.hold) { res.write(chunk({ content: '.' })); state.lastWriteAt = Date.now(); setTimeout(next, 20); return; }
        if (index < parts.length) { res.write(parts[index++]); state.lastWriteAt = Date.now(); setTimeout(next, 40); } else res.end();
      };
      next();
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const definition = { encodingVersion: 1 as const, provider: { id: 'local-openai', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
    digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, maxOutputTokens: 64, authentication: { type: 'none' }, tariff } },
    allocation: { id: 'allocation', maxCalls: 20, maxInFlight: 2 }, limits: { requestMaxBytes: 65536, responseMaxBytes: 8192, timeoutMs: 5000 } };
  const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_spending: fixtureBudget(),
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 48 } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 50 } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { id: `os:${userInfo().uid}`, issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
  await new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1)
    .admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0,
      catalogRevision: 'catalog-1', expectedBinding: binding });
  const grants = [{ id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'],
    principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } },
  { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }],
    resource: { kind: 'scope', ids: ['scope'] } }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants }), { mode: 0o600 });
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const service = await startConfiguredRuntimeService(project, { async onPage() {}, async onError() {} }, { env }); services.push(service);
  const rows = (sql: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const command = (commandId: string): ModelInvocationCommand => ({ schemaVersion: 1, commandId, scopeId: 'scope', reference,
    catalogRevision: 'catalog-1', expectedBinding: binding, nativeRequest: { model: 'native-chat', messages, max_completion_tokens: 48,
      stream: true, stream_options: { include_usage: true } } });
  return { project, env, state, rows, command };
}

describe.skipIf(process.platform !== 'linux')('streamed terminal chat through the runtime service', () => {
  it('streams governed deltas before the provider finishes, settles once, and replays without a second provider request', async () => {
    const f = await runtime(), ports = { invokeStream: invokeRuntimeModelStream, cancel: cancelRuntimeModelInvocation };
    const started = Date.now(), timeline: { delta: TurnDelta; at: number }[] = [];
    for await (const delta of streamTerminalChatTurn({ projectRoot: f.project, scopeId: 'scope', messages, options: { env: f.env } }, ports)) {
      timeline.push({ delta, at: Date.now() });
    }
    const firstDeltaMs = timeline[0]!.at - started, lastWriteMs = f.state.lastWriteAt - started;
    console.info(`stream-e2e: first delta ${firstDeltaMs} ms, provider finished ${lastWriteMs} ms, deltas ${timeline.length}`);
    expect(firstDeltaMs).toBeLessThan(lastWriteMs);
    const deltas = timeline.map(entry => entry.delta);
    expect(deltas.filter(delta => delta.kind === 'reasoning').map(delta => (delta as { text: string }).text).join('')).toBe('Selam vermeli');
    expect(deltas.filter(delta => delta.kind === 'text').map(delta => (delta as { text: string }).text).join('')).toBe('Merhaba!');
    expect(deltas.slice(-2)).toEqual([{ kind: 'usage', promptTokens: 9, completionTokens: 6, reasoningTokens: 2 }, { kind: 'done', finish: 'stop' }]);
    expect(deltas.filter(delta => delta.kind === 'done')).toHaveLength(1);
    expect(f.state.requests).toBe(1);
    expect(f.rows('SELECT count(*) AS count FROM model_invocations')).toEqual([{ count: 1 }]);

    const client = createConfiguredRuntimeClient(f.project, { env: f.env }), command = f.command('replayable'), first: string[] = [], again: string[] = [];
    const fresh = await client.invokeModelStream(command, delta => first.push(delta.text));
    expect(fresh).toMatchObject({ replayed: false, receipt: { outcome: { state: 'responded' } } }); expect(first.join('')).toBe('Selam vermeliMerhaba!');
    const replay = await client.invokeModelStream(command, delta => again.push(delta.text));
    expect(replay).toMatchObject({ replayed: true, receipt: fresh.receipt }); expect(again).toEqual([]); expect(f.state.requests).toBe(2);
    const inspected = await client.inspectModelInvocation({ schemaVersion: 2, scopeId: 'scope', invocationId: fresh.receipt.claim.invocationId, reference });
    expect(inspected.spending).toMatchObject({ disposition: { state: 'settled-local', amountMinorUnits: 0 } });
  }, 20_000);

  it('aborting mid-stream disconnects, records the governed cancellation and aborts the provider request', async () => {
    const f = await runtime(), controller = new AbortController(), ports = { invokeStream: invokeRuntimeModelStream, cancel: cancelRuntimeModelInvocation };
    f.state.hold = true; const seen: TurnDelta[] = [];
    for await (const delta of streamTerminalChatTurn({ projectRoot: f.project, scopeId: 'scope', messages, options: { env: f.env },
      signal: controller.signal }, ports)) { seen.push(delta); if (seen.length === 3) controller.abort(); }
    expect(seen.at(-1)).toEqual({ kind: 'done', finish: 'cancelled' });
    const until = Date.now() + 5_000;
    while (f.state.closed === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.state.closed).toBe(1); expect(f.state.requests).toBe(1);
    while (Date.now() < until && (f.rows(`SELECT count(*) AS count FROM model_invocations WHERE state <> 'claimed'`)[0] as { count: number }).count === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // The partial stream is an uncertain outcome (never a response, never retried); the cancellation is its own record.
    expect(f.rows('SELECT state FROM model_invocations')).toEqual([{ state: 'unknown' }]);
    expect(f.rows('SELECT count(*) AS count FROM model_invocation_cancellations')).toEqual([{ count: 1 }]);
  }, 20_000);
});
