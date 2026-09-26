import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { openSqliteAgentTurnStore, openSqliteModelActivationStore } from '#adapters/index.js';
import { AGENT_TURN_INTERRUPTED_NOTE, ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { cancelRuntimeChatTurn, createConfiguredRuntimeClient, runRuntimeChatTurn, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { streamTerminalAgentTurn } from '#composition/core/terminal-chat/index.js';
import { renderAssistantStream, startAssistantStream, type AssistantUnit } from '#surfaces/core/terminal-render/index.js';
import type { TurnDelta } from '#surfaces/index.js';
import { chatTurnCompactionCommandId, chatTurnRoundCommandId } from '#composition/core/agent-turn/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';

const roots: string[] = [], servers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const modelWith = (tokenCount: boolean) => ({ id: 'chat', version: 1, nativeId: 'native-chat', protocols: [{ family: 'openai-chat-completions', version: 'v1',
  capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }, ...(tokenCount ? [{ id: 'token-count', version: 1, state: 'supported' }] : [])] }] });
const catalogWith = (tokenCount: boolean) => ({ schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'local-openai', version: 1, models: [modelWith(tokenCount)] }] });
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const principal = { id: `os:${userInfo().uid}`, issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
const me = [{ issuer: principal.issuer, subject: principal.subject }];

type Script = { toolCall?: { name: string; arguments: string }; content?: string; hold?: boolean; summary?: string };
async function runtime(options: { toolGrant?: boolean | 'approval'; tokenize?: boolean; windowTokens?: number; countedTokens?: number;
  count?: (body: { messages: unknown[] }) => number; approvalTtlMs?: number; extraGrants?: Record<string, unknown>[] } = {}) {
  const model = modelWith(options.tokenize === true), catalog = catalogWith(options.tokenize === true);
  const root = await mkdtemp(join(tmpdir(), 'deckent-chat-turn-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(join(project, 'src'), { recursive: true }),
    mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  const state = { requests: [] as Record<string, unknown>[], tokenize: [] as Record<string, unknown>[], script: [] as Script[], closed: 0 };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chatcmpl-turn',
    object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id: 'chatcmpl-turn', object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const body: Buffer[] = []; req.on('data', part => body.push(part));
    req.on('end', () => {
      if (req.url === '/tokenize') {
        state.tokenize.push(JSON.parse(Buffer.concat(body).toString('utf8')) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' });
        const counted = JSON.parse(Buffer.concat(body).toString('utf8')) as { messages: unknown[] };
        res.end(JSON.stringify({ count: options.count ? options.count(counted) : options.countedTokens ?? 500, max_model_len: 131072, tokens: [] })); return;
      }
      state.requests.push(JSON.parse(Buffer.concat(body).toString('utf8')) as Record<string, unknown>);
      const step = state.script[state.requests.length - 1] ?? { content: 'no script' };
      if (step.summary !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-sum', object: 'chat.completion', created: 1, model: 'native-chat',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: step.summary } }],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } })); return;
      }
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
      definition: { endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, maxOutputTokens: 256, authentication: { type: 'none' }, tariff,
        ...(options.tokenize ? { tokenizeEndpoint: `http://127.0.0.1:${address.port}/tokenize` } : {}) } },
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 2 }, limits: { requestMaxBytes: 262144, responseMaxBytes: 65536, timeoutMs: 5000 },
    ...(options.windowTokens ? { contextWindowTokens: options.windowTokens } : {}) };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_spending: fixtureBudget(),
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 128 } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    ...(options.approvalTtlMs ? { approvals: { requestTtlMs: options.approvalTtlMs } } : {}),
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
  ...(options.toolGrant === false ? [] : options.toolGrant === 'approval' ? [
    { id: 'read-needs-approval', effect: 'require-approval', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['read_file'] } },
    { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }]
    : [{ id: 'read-tools', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me,
      resource: { kind: 'agent-tool', ids: ['read_file', 'list_dir', 'grep', 'glob'] } }]), ...(options.extraGrants ?? [])];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants }), { mode: 0o600 });
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const interrupted: unknown[] = [];
  const start = async () => {
    const service = await startConfiguredRuntimeService(project, { async onPage() {}, async onError() {},
      onAgentTurnsInterrupted(result) { interrupted.push(result); } }, { env });
    services.push(service); return service;
  };
  const rows = (sql: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const writePolicy = (next: unknown[]) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: `r-${next.length}`, restrictions: [], grants: next }), { mode: 0o600 });
  return { project, env, state, rows, ledger, start, interrupted, grants, writePolicy, client: () => createConfiguredRuntimeClient(project, { env }) };
}
const editGrants = (toolEffect: 'allow' | 'require-approval') => [
  { id: 'edit-tools', effect: toolEffect, actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['edit_file', 'write_file'] } },
  { id: 'file-write', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['workspace.file.write'] } },
  { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];
const toolText = (events: AgentTurnStreamEvent[]) => events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : [])[0] ?? '';
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
    expect((f.state.requests[0]!['tools'] as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual(['read_file', 'list_dir', 'grep', 'glob', 'edit_file', 'write_file']);
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

  it('reaches the terminal renderer: a tool line, the answer and one footer, from the real service through the surface stream', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'It exports a.' }];
    const deltas: TurnDelta[] = [];
    for await (const delta of streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 'scope', messages: ask('x').messages, options: { env: f.env } },
      { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn })) deltas.push(delta);
    expect(deltas.filter(delta => delta.kind === 'done')).toEqual([{ kind: 'done', finish: 'stop', note: null }]);
    expect(deltas.filter(delta => delta.kind === 'message').map(delta => delta.kind === 'message' && delta.message.role)).toEqual(['assistant', 'tool', 'assistant']);
    let state = startAssistantStream(0); const units: AssistantUnit[] = [];
    for (const delta of deltas) { const step = renderAssistantStream(state, delta, 10); state = step.state; units.push(...step.staticUnits, ...(step.footer ? [step.footer] : [])); }
    expect(units.map(unit => unit.kind)).toEqual(['tool', 'text', 'footer']);
    expect(units[0]).toMatchObject({ kind: 'tool', name: 'read_file', target: 'src/a.ts', status: 'ok' });
    expect(units[1]).toMatchObject({ kind: 'text', markdown: 'It exports a.' });
    expect(units[2]).toMatchObject({ kind: 'footer', finish: 'stop', promptTokens: 20, completionTokens: 16 });
  }, 30_000);

  it('measures each round with the provider counter on exactly what it sends, and refuses a round that cannot fit before any send (T-L5)', async () => {
    const f = await runtime({ tokenize: true, windowTokens: 100_000 }); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'It exports a.' }];
    const events: AgentTurnStreamEvent[] = [];
    expect(await f.client().chatTurn(ask('turn-ctx'), event => events.push(event))).toMatchObject({ finish: 'stop', rounds: 2 });
    // One count per round, of the same messages and tools the round sent (the anti-unit-mixing proof).
    expect(f.state.tokenize).toHaveLength(2);
    for (const [index, counted] of f.state.tokenize.entries()) {
      expect(counted['messages']).toEqual(f.state.requests[index]!['messages']);
      expect(counted['tools']).toEqual(f.state.requests[index]!['tools']);
    }
    // The window is the smaller of the profile's and the provider's.
    expect(events.filter(event => event.kind === 'context')).toEqual([
      { kind: 'context', round: 1, promptTokens: 500, windowTokens: 100_000, quality: 'provider-count' },
      { kind: 'context', round: 2, promptTokens: 500, windowTokens: 100_000, quality: 'provider-count' }]);

    const full = await runtime({ tokenize: true, windowTokens: 4_000, countedTokens: 3_000 }); await full.start();
    full.state.script = [{ content: 'never' }];
    const refused = await full.client().chatTurn(ask('turn-full'), () => undefined);
    expect(refused).toMatchObject({ finish: 'error', rounds: 1, answer: null });
    expect(refused.note).toMatch(/3000 prompt tokens \+ 2176 reserved > 4000.*Nothing was sent/);
    expect(full.state.requests).toEqual([]);
  }, 30_000);

  it('compacts a long history through a governed summary call and continues the turn with it (T-L5b)', async () => {
    const f = await runtime({ tokenize: true, windowTokens: 100_000, count: body => body.messages.length > 12 ? 90_000 : 900 }); await f.start();
    f.state.script = [{ summary: '```json\n{"objective":"understand a.ts","findings":["a.ts exports a"],"decisions":[],"unresolved":[],"nextActions":[],"inspectedAreas":["src/a.ts"]}\n```' },
      { content: 'Still a.' }];
    const history = [{ role: 'system' as const, content: 'SYS' }, ...Array.from({ length: 16 }, (_, i) => i % 2
      ? { role: 'assistant' as const, content: `answer ${i}`, toolCalls: [] } : { role: 'user' as const, content: `question ${i}` }),
    { role: 'user' as const, content: 'what does a.ts export now?' }];
    const events: AgentTurnStreamEvent[] = [];
    const result = await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-compact', messages: history }, event => events.push(event));
    expect(result).toMatchObject({ finish: 'stop', rounds: 1, answer: 'Still a.' });
    // The summary call is a governed, tools-off invocation under the compaction command id; then the round is sent compacted.
    expect(f.state.requests).toHaveLength(2);
    expect(f.state.requests[0]).toMatchObject({ stream: false }); expect(f.state.requests[0]!['tools']).toBeUndefined();
    expect(f.rows('SELECT command_id FROM model_invocations').map(row => (row as { command_id: string }).command_id).sort())
      .toEqual([chatTurnCompactionCommandId('scope', 'turn-compact', 1), chatTurnRoundCommandId('scope', 'turn-compact', 1)].sort());
    const compacted = events.find(event => event.kind === 'compacted') as Extract<AgentTurnStreamEvent, { kind: 'compacted' }>;
    expect(compacted.replacedMessages).toBe(9); expect(compacted.messages).toHaveLength(9);
    expect(compacted.messages[0]!.content).toContain('- a.ts exports a'); expect(compacted.messages[0]!.content).toContain('1. question 0');
    const sent = f.state.requests[1]!['messages'] as { role: string; content: string }[];
    expect(sent[0]).toEqual({ role: 'system', content: 'SYS' }); expect(sent).toHaveLength(10);
    expect(events.filter(event => event.kind === 'context').map(event => event.kind === 'context' && event.promptTokens)).toEqual([90_000, 900]);
  }, 30_000);

  it('uses a labelled upper bound and sends no counter request when the model has no counter', async () => {
    const f = await runtime({ windowTokens: 100_000 }); await f.start();
    f.state.script = [{ content: 'Plain answer.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-bound'), event => events.push(event));
    expect(f.state.tokenize).toEqual([]);
    const context = events.find(event => event.kind === 'context');
    expect(context).toMatchObject({ kind: 'context', round: 1, windowTokens: 100_000, quality: 'upper-bound' });
    // Never under-counts: at least one token per byte of what was sent.
    const sent = f.state.requests[0]!;
    expect((context as { promptTokens: number }).promptTokens).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify({ messages: sent['messages'], tools: sent['tools'] })));
  }, 30_000);

  it('waits for the owner on an approval-gated call: allow runs it once, deny never runs it, expiry and cancel close the request (T-L4, C12)', async () => {
    const f = await runtime({ toolGrant: 'approval' }); await f.start();
    const client = f.client();
    const decide = (decision: 'allow' | 'deny') => async (event: AgentTurnStreamEvent) => {
      if (event.kind !== 'approval.requested') return;
      await client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, commandId: `${decision}-${event.approvalId}`,
        expectedRevision: event.revision, decision, reason: 'Reviewed' });
    };
    const run = async (turnId: string, onApproval: (event: AgentTurnStreamEvent) => Promise<void>) => {
      const events: AgentTurnStreamEvent[] = [], pending: Promise<void>[] = [];
      const result = await client.chatTurn(ask(turnId), event => { events.push(event); pending.push(onApproval(event)); });
      await Promise.all(pending); return { result, events };
    };
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'It exports a.' },
      { toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'Not allowed.' }];
    const allowed = await run('turn-allow', decide('allow'));
    const requested = allowed.events.find(event => event.kind === 'approval.requested') as Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
    expect(requested).toMatchObject({ callId: 'call_1', revision: 0, summary: expect.stringMatching(/^read_file · src\/a\.ts · [0-9a-f]{12}$/),
      preview: expect.stringContaining('"path": "src/a.ts"') });
    expect(allowed.events.find(event => event.kind === 'approval.settled')).toMatchObject({ approvalId: requested.approvalId, outcome: 'allow' });
    expect(allowed.events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok' });
    expect(allowed.result).toMatchObject({ finish: 'stop', toolCalls: 1 });
    const record = JSON.parse((f.rows(`SELECT snapshot FROM approvals WHERE approval_id='${requested.approvalId}'`)[0] as { snapshot: string }).snapshot);
    expect(record).toMatchObject({ status: 'decided', request: { schemaVersion: 2, subject: { kind: 'agent-tool-call', turnId: 'turn-allow', round: 1, index: 0,
      tool: 'read_file', toolVersion: 1, resource: 'src/a.ts' } } });

    const denied = await run('turn-deny', decide('deny'));
    expect(denied.events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
    const toolMessage = denied.events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : [])[0];
    expect(toolMessage).toContain('denied-by-owner'); expect(toolMessage).not.toContain('export const a');
    // Single use: every call opens its own request; nothing was reused across turns.
    expect(f.rows("SELECT count(*) AS count FROM approvals WHERE subject_kind='agent-tool-call'")).toEqual([{ count: 2 }]);
  }, 60_000);

  it('re-evaluates policy after the owner allows: a call the policy denies meanwhile never runs (contract §2)', async () => {
    const f = await runtime({ toolGrant: 'approval' }); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'Blocked.' }];
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-revoked'), event => {
      events.push(event);
      if (event.kind !== 'approval.requested') return;
      pending.push((async () => {
        // The tool grant is withdrawn while the call waits; approvals stay decidable.
        await f.writePolicy(f.grants.filter(grant => grant.id !== 'read-needs-approval'));
        await client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, commandId: 'allow-revoked',
          expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' });
      })());
    });
    await Promise.all(pending);
    expect(events.find(event => event.kind === 'approval.settled')).toMatchObject({ outcome: 'deny' });
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
  }, 60_000);

  it('closes an approval that expires or whose turn is cancelled, and never runs the call', async () => {
    const f = await runtime({ toolGrant: 'approval', approvalTtlMs: 400 }); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'Expired.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-expire'), event => events.push(event));
    expect(events.find(event => event.kind === 'approval.settled')).toMatchObject({ outcome: 'expired' });
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'approval-expired' });
    expect(f.rows("SELECT snapshot FROM approvals").map(row => JSON.parse((row as { snapshot: string }).snapshot).status)).toEqual(['expired']);

    const g = await runtime({ toolGrant: 'approval' }); await g.start();
    g.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }];
    const client = g.client();
    const running = client.chatTurn(ask('turn-cancel-approval'), event => {
      if (event.kind === 'approval.requested') void client.cancelChatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-cancel-approval' });
    });
    expect(await running).toMatchObject({ finish: 'cancelled' });
    expect(g.rows("SELECT snapshot FROM approvals").map(row => JSON.parse((row as { snapshot: string }).snapshot).status)).toEqual(['expired']);
  }, 60_000);

  it('writes an approved edit as a C11 effect: the owner sees the diff, the file is written once and the effect is settled (T-L4 slice 2)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants('require-approval') }); await f.start();
    f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } }, { content: 'Done.' }];
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-edit', 'set a to 2'), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId,
        commandId: 'allow-edit', expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' }));
    });
    await Promise.all(pending);
    expect(events.find(event => event.kind === 'approval.requested')).toMatchObject({ summary: expect.stringMatching(/^edit_file · src\/a\.ts · /),
      preview: expect.stringContaining('-export const a = 1;\n+export const a = 2;') });
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok' });
    expect(toolText(events)).toMatch(/^\[deckent\] edit_file: wrote src\/a\.ts \(\+1 −1 lines/);
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(f.rows('SELECT target_kind, target_id, state FROM effect_intents')).toEqual([{ target_kind: 'workspace-file', target_id: 'src/a.ts', state: 'settled' }]);
  }, 60_000);

  it('refuses an approved edit whose file changed while the owner was reading the diff, and keeps what the other writer wrote (T-L4 slice 2)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants('require-approval') }); await f.start();
    f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } }, { content: 'Stale.' }];
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-stale', 'set a to 2'), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push((async () => {
        await writeFile(join(f.project, 'src', 'a.ts'), 'export const a = 7;\n');
        await client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, commandId: 'allow-stale',
          expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' });
      })());
    });
    await Promise.all(pending);
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'error' });
    expect(toolText(events)).toContain('changed since it was read');
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 7;\n');
    expect(f.rows('SELECT count(*) AS count FROM effect_intents')).toEqual([{ count: 0 }]);
  }, 60_000);

  it('asks the owner for a floor path even when policy allows the write, and writes an ordinary path without asking (contract §5)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants('allow') }); await f.start();
    f.state.script = [{ toolCall: { name: 'write_file', arguments: '{"path":"package.json","content":"{}\\n"}' } }, { content: 'Refused.' },
      { toolCall: { name: 'write_file', arguments: '{"path":"src/new.ts","content":"export {};\\n"}' } }, { content: 'Created.' }];
    const client = f.client(), floored: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-floor', 'write package.json'), event => {
      floored.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId,
        commandId: 'deny-floor', expectedRevision: event.revision, decision: 'deny', reason: 'No' }));
    });
    await Promise.all(pending);
    expect(floored.find(event => event.kind === 'approval.requested')).toMatchObject({ preview: expect.stringContaining('+++ b/package.json') });
    expect(floored.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
    await expect(readFile(join(f.project, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const plain: AgentTurnStreamEvent[] = [];
    await client.chatTurn(ask('turn-plain', 'create src/new.ts'), event => plain.push(event));
    expect(plain.some(event => event.kind === 'approval.requested')).toBe(false);
    expect(plain.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok' });
    expect(await readFile(join(f.project, 'src', 'new.ts'), 'utf8')).toBe('export {};\n');
  }, 60_000);

  it('asks the owner when the operation policy requires approval although the tool is allowed, and never offers a write the operation policy denies', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants('allow').map(grant => grant.id === 'file-write' ? { ...grant, effect: 'require-approval' } : grant) });
    await f.start();
    f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } }, { content: 'Done.' }];
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-op-approval', 'set a to 2'), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId,
        commandId: 'allow-op', expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' }));
    });
    await Promise.all(pending);
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok' });
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  }, 60_000);

  it('never writes when the operation policy does not grant workspace.file.write, even if the tool is allowed', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants('allow').filter(grant => grant.id !== 'file-write') }); await f.start();
    f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } }, { content: 'Denied.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-no-op-grant', 'set a to 2'), event => events.push(event));
    expect(events.some(event => event.kind === 'approval.requested')).toBe(false);
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
    expect(toolText(events)).toContain('denied-by-policy');
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  }, 60_000);

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
    // Wait for the provider's stream (the first event is now the pre-send `context` measurement).
    const running = client.chatTurn(ask('turn-cancel'), event => { if (event.kind === 'text') seen = true; });
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
    const pending = f.client().chatTurn(ask('turn-gone'), event => { if (event.kind === 'text' && ++seen === 3) controller.abort(); }, controller.signal);
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
