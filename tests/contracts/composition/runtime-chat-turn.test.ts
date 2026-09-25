import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { openSqliteAgentTurnStore, openSqliteModelActivationStore } from '#adapters/index.js';
import { AGENT_TURN_INTERRUPTED_NOTE, ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { chatTurnRoundCommandId } from '#composition/core/agent-turn/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';

const roots: string[] = [], servers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const model = { id: 'chat', version: 1, nativeId: 'native-chat',
  protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }] }] };
const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'local-openai', version: 1, models: [model] }] };
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const principal = { id: `os:${userInfo().uid}`, issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
const me = [{ issuer: principal.issuer, subject: principal.subject }];

type Script = { toolCall?: { name: string; arguments: string }; content?: string; hold?: boolean };
async function runtime(options: { toolGrant?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-chat-turn-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(join(project, 'src'), { recursive: true }),
    mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  const state = { requests: [] as Record<string, unknown>[], script: [] as Script[], closed: 0 };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chatcmpl-turn',
    object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id: 'chatcmpl-turn', object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const body: Buffer[] = []; req.on('data', part => body.push(part));
    req.on('end', () => {
      state.requests.push(JSON.parse(Buffer.concat(body).toString('utf8')) as Record<string, unknown>);
      const step = state.script[state.requests.length - 1] ?? { content: 'no script' };
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.on('close', () => { state.closed++; });
      const parts = step.hold ? [] : step.toolCall
        ? [chunk({ role: 'assistant', content: '' }), chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: step.toolCall.name, arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: step.toolCall.arguments } }] }), chunk({}, 'tool_calls'), usage, 'data: [DONE]\n\n']
        : [chunk({ role: 'assistant', content: '' }), chunk({ content: step.content!.slice(0, 3) }), chunk({ content: step.content!.slice(3) }), chunk({}, 'stop'), usage, 'data: [DONE]\n\n'];
      let index = 0;
      const next = () => {
        if (res.destroyed) return;
        if (step.hold) { res.write(chunk({ content: '.' })); setTimeout(next, 20); return; }
        if (index < parts.length) { res.write(parts[index++]); setTimeout(next, 5); } else res.end();
      };
      next();
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const definition = { encodingVersion: 1 as const, provider: { id: 'local-openai', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, maxOutputTokens: 256, authentication: { type: 'none' }, tariff } },
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 2 }, limits: { requestMaxBytes: 262144, responseMaxBytes: 65536, timeoutMs: 5000 } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_spending: fixtureBudget(),
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 128 } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 262144, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 50 } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  await new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1)
    .admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0,
      catalogRevision: 'catalog-1', expectedBinding: binding });
  const grants = [{ id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'],
    principals: me, resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } },
  { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me, resource: { kind: 'scope', ids: ['scope'] } },
  ...(options.toolGrant === false ? [] : [{ id: 'read-tools', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me,
    resource: { kind: 'agent-tool', ids: ['read_file', 'list_dir', 'grep', 'glob'] } }])];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants }), { mode: 0o600 });
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const interrupted: unknown[] = [];
  const start = async () => {
    const service = await startConfiguredRuntimeService(project, { async onPage() {}, async onError() {},
      onAgentTurnsInterrupted(result) { interrupted.push(result); } }, { env });
    services.push(service); return service;
  };
  const rows = (sql: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  return { project, env, state, rows, ledger, start, interrupted, client: () => createConfiguredRuntimeClient(project, { env }) };
}
const ask = (turnId: string, content = 'what does src/a.ts export?') => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content }] });

describe.skipIf(process.platform !== 'linux')('agent chat turn through the runtime service', () => {
  it('runs a governed tool round and answers, streaming the history as events, and replays the finished turn without a model call', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'It exports a.' }];
    const events: AgentTurnStreamEvent[] = [];
    const result = await f.client().chatTurn(ask('turn-1'), event => events.push(event));
    expect(result).toEqual({ schemaVersion: 1, turnId: 'turn-1', finish: 'stop', note: null, rounds: 2, toolCalls: 1, answer: 'It exports a.',
      answerBytes: 13, replayed: false, recorded: true });
    expect(events.filter(event => event.kind.startsWith('tool.'))).toEqual([{ kind: 'tool.started', callId: 'call_1', name: 'read_file', target: 'src/a.ts' },
      expect.objectContaining({ kind: 'tool.finished', callId: 'call_1', name: 'read_file', status: 'ok' })]);
    const history = events.flatMap(event => event.kind === 'message' ? [event.message] : []);
    expect(history.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(history[1]).toMatchObject({ role: 'tool', toolCallId: 'call_1', content: expect.stringContaining('export const a = 1;') });
    expect(events.filter(event => event.kind === 'text').map(event => (event as { text: string }).text).join('')).toBe('It exports a.');
    // The model saw the declared tools and, in round 2, the tool result.
    expect(f.state.requests).toHaveLength(2);
    expect((f.state.requests[0]!['tools'] as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual(['read_file', 'list_dir', 'grep', 'glob']);
    expect(f.state.requests[1]!['messages']).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' })]));
    // Each round is one governed invocation under the command id derived from turn and round.
    expect(f.rows("SELECT command_id FROM model_invocations ORDER BY command_id").map(row => (row as { command_id: string }).command_id).sort())
      .toEqual([chatTurnRoundCommandId('scope', 'turn-1', 1), chatTurnRoundCommandId('scope', 'turn-1', 2)].sort());
    expect(f.rows("SELECT state FROM agent_turns")).toEqual([{ state: 'finished' }]);
    expect(f.rows('SELECT count(*) AS count FROM agent_turn_tool_calls')).toEqual([{ count: 1 }]);

    const again: AgentTurnStreamEvent[] = [];
    const replay = await f.client().chatTurn(ask('turn-1'), event => again.push(event));
    expect(replay).toMatchObject({ replayed: true, finish: 'stop', rounds: 2, toolCalls: 1, answer: 'It exports a.' });
    expect(again).toEqual([{ kind: 'text', text: 'It exports a.' }]); expect(f.state.requests).toHaveLength(2);
    await expect(f.client().chatTurn(ask('turn-1', 'something else'), () => undefined)).rejects.toMatchObject({ code: 'AGENT_TURN_CONFLICT' });
    expect(f.state.requests).toHaveLength(2);
  }, 30_000);

  it('answers a tool call the policy does not grant as denied, never runs it, and still finishes the turn', async () => {
    const f = await runtime({ toolGrant: false }); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'I may not read it.' }];
    const events: AgentTurnStreamEvent[] = [];
    const result = await f.client().chatTurn(ask('turn-deny'), event => events.push(event));
    expect(result).toMatchObject({ finish: 'stop', rounds: 2, toolCalls: 0 });
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
    const tool = events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message] : [])[0];
    expect(tool?.content).toContain('denied-by-policy'); expect(tool?.content).not.toContain('export const a');
  }, 30_000);

  it('cancels a running turn at once for the same principal, and reports an unknown turn as not running', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ hold: true }];
    const client = f.client(); let seen = false;
    const running = client.chatTurn(ask('turn-cancel'), () => { seen = true; });
    const until = performance.now() + 5_000;
    while (!seen && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen).toBe(true);
    const cancelledAt = performance.now();
    expect(await client.cancelChatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-cancel' })).toEqual({ schemaVersion: 1, turnId: 'turn-cancel', state: 'cancelling' });
    expect(await running).toMatchObject({ finish: 'cancelled', replayed: false });
    // At once: the held provider stream is aborted, not waited out.
    expect(performance.now() - cancelledAt).toBeLessThan(1_000);
    expect(await client.cancelChatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-cancel' })).toMatchObject({ state: 'not-running' });
    expect(await client.cancelChatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: randomUUID() })).toMatchObject({ state: 'not-running' });
    while (f.state.closed === 0 && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.state.closed).toBe(1);
  }, 30_000);

  it('cancels the turn on the service when the client disconnects mid-stream', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ hold: true }];
    const controller = new AbortController(); let seen = 0;
    const pending = f.client().chatTurn(ask('turn-gone'), () => { if (++seen === 3) controller.abort(); }, controller.signal);
    await expect(pending).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
    const until = performance.now() + 5_000;
    const state = () => f.rows("SELECT state FROM agent_turns WHERE turn_id='turn-gone'") as { state: string }[];
    while (state()[0]?.state !== 'finished' && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    const record = JSON.parse((f.rows("SELECT record FROM agent_turns WHERE turn_id='turn-gone'")[0] as { record: string }).record);
    expect(record.outcome).toMatchObject({ finish: 'cancelled' });
    while (f.state.closed === 0 && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.state.closed).toBe(1);
  }, 30_000);

  it('closes turns a stopped service left running at the next start, and a second start beside a live service touches none', async () => {
    const f = await runtime(); const live = await f.start();
    const store = await openSqliteAgentTurnStore(f.ledger, sqlite, 'forbid');
    try { await store.claim({ scopeId: 'scope', turnId: 'left', principalKey: 'p'.repeat(8), requestDigest: 'a'.repeat(64), claimedAtMs: 1 }); }
    finally { store.close(); }
    await expect(f.start()).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_ALREADY_RUNNING' });
    expect(f.rows("SELECT state FROM agent_turns WHERE turn_id='left'")).toEqual([{ state: 'running' }]);
    await live.stop(); await live.done.catch(() => undefined); services.splice(services.indexOf(live), 1);
    await f.start();
    expect(f.interrupted).toEqual([{ interrupted: 1, corrupt: [] }]);
    const record = JSON.parse((f.rows("SELECT record FROM agent_turns WHERE turn_id='left'")[0] as { record: string }).record);
    expect(record.outcome).toMatchObject({ finish: 'error', note: AGENT_TURN_INTERRUPTED_NOTE });
  }, 30_000);
});
