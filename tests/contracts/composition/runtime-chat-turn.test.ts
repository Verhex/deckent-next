import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import type { AgentTurnMessage, AgentTurnStreamEvent } from '#domain/index.js';
import { agentFileEffectCommandId, agentShellEffectCommandId, landlockShellSandbox, openSqliteAgentTurnStore, openSqliteModelActivationStore, openTerminalSessionStore, type ShellSandboxFactory } from '#adapters/index.js';
import { bindSessionScope } from '#surfaces/core/terminal/index.js';
import { mountWorkline, until } from '../support/workline-harness.js';
import { AGENT_TURN_INTERRUPTED_NOTE, ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import * as engine from '#engine/index.js';
import { attachRuntimeWorkspaceFile, cancelRuntimeChatTurn, createConfiguredRuntimeClient, findRuntimeWorkspaceFiles, runRuntimeChatTurn,
  startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { attachTerminalMentions, findTerminalMentions, streamTerminalAgentTurn } from '#surfaces/core/terminal-turn/index.js';
import { renderAssistantStream, startAssistantStream, type AssistantUnit } from '#surfaces/core/terminal-render/index.js';
import type { TurnDelta } from '#surfaces/index.js';
import { chatTurnCompactionCommandId, chatTurnRoundCommandId } from '#composition/core/agent-turn/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';
import { measureTestShellHost, linuxShellHost } from '../../fixtures/shell-host.js';

const roots: string[] = [], servers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
// S9: the real host measurement gates the bubblewrap turn; other shell tests pin the realm to `host` or inject `() => []`.
const measured = await measureTestShellHost();
const sandboxReady = measured.bubblewrap.status === 'available';
const kernelLandlockAbi = measured.landlock.status === 'available' ? measured.landlock.abi ?? 0 : 0;
/** S11 through the port: only the Landlock provider, judged against an injected measurement (the kernel's ABI, or one it does not have). */
const landlockOnly = (abi: number): ShellSandboxFactory => layout => [{ kind: 'landlock', usable: () => landlockShellSandbox(layout).usable(linuxShellHost({ landlock: { status: 'available', abi } })) }];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const modelWith = (tokenCount: boolean, thinkingSwitch = false) => ({ id: 'chat', version: 1, nativeId: 'native-chat', protocols: [{ family: 'openai-chat-completions', version: 'v1',
  capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }, ...(tokenCount ? [{ id: 'token-count', version: 1, state: 'supported' }] : []),
    ...(thinkingSwitch ? [{ id: 'chat-template-enable-thinking', version: 1, state: 'supported' }] : [])] }] });
const catalogWith = (tokenCount: boolean, thinkingSwitch = false) => ({ schemaVersion: 1 as const, revision: 'catalog-1',
  providers: [{ id: 'local-openai', version: 1, models: [modelWith(tokenCount, thinkingSwitch)] }] });
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const principal = { id: `os:${userInfo().uid}`, issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
const me = [{ issuer: principal.issuer, subject: principal.subject }];

type Script = { toolCall?: { name: string; arguments: string }; content?: string; hold?: boolean; summary?: string };
async function runtime(options: { toolGrant?: boolean | 'approval'; tokenize?: boolean; windowTokens?: number; countedTokens?: number;
  count?: (body: { messages: unknown[] }) => number; approvalTtlMs?: number; extraGrants?: Record<string, unknown>[];
  /** TL-C: the catalog declares the thinking switch; the data root lies inside the project (like the live `.deckent/live-data`). */
  thinkingSwitch?: boolean; dataInside?: boolean; shellRealm?: 'host' | 'prefer-sandbox' | 'require-sandbox' | 'absent';
  /** S9: the sandbox providers a turn may pick (code-only port); `() => []` is the "no sandbox mechanism usable" host. */
  sandboxes?: ShellSandboxFactory } = {}) {
  const model = modelWith(options.tokenize === true, options.thinkingSwitch === true), catalog = catalogWith(options.tokenize === true, options.thinkingSwitch === true);
  const root = await mkdtemp(join(tmpdir(), 'deckent-chat-turn-')); roots.push(root);
  const project = join(root, 'project'), data = options.dataInside ? join(project, '.deckent', 'live-data') : join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(join(project, 'src'), { recursive: true }), mkdir(home, { mode: 0o700 })]);
  await mkdir(data, { mode: 0o700 });
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
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 128 },
      ...(options.shellRealm === 'absent' ? {} : { shell: { schemaVersion: 1, realm: options.shellRealm ?? 'host' } }) },
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
  const interrupted: unknown[] = [], swept: unknown[] = [], released: unknown[] = [];
  const start = async (observed = true) => {
    const service = await startConfiguredRuntimeService(project, observed ? { async onPage() {}, async onError() {},
      onAgentTurnsInterrupted(result) { interrupted.push(result); }, onToolCallApprovalsExpired(result) { swept.push(result); },
      onModelAllocationSlotsReleased(result) { released.push(result); } }
      : { async onPage() {}, async onError() {} }, { env }, options.sandboxes ? { shellSandboxes: options.sandboxes } : {});
    services.push(service); return service;
  };
  const rows = (sql: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const writePolicy = (next: unknown[]) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: `r-${next.length}`, restrictions: [], grants: next }), { mode: 0o600 });
  return { project, data, env, state, rows, ledger, start, interrupted, swept, released, grants, writePolicy, binding, client: () => createConfiguredRuntimeClient(project, { env }) };
}
const editGrants = (toolEffect: 'allow' | 'require-approval') => [
  { id: 'edit-tools', effect: toolEffect, actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['edit_file', 'write_file'] } },
  { id: 'file-write', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['workspace.file.write'] } },
  { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];
const shellGrants = (toolEffect: 'allow' | 'require-approval') => [
  { id: 'shell-tool', effect: toolEffect, actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['run_shell'] } },
  { id: 'shell-run', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['host.shell.run'] } },
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
    expect((f.state.requests[0]!['tools'] as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual(['read_file', 'list_dir', 'grep', 'glob', 'edit_file', 'write_file', 'run_shell',
      'scratch_write', 'scratch_read', 'scratch_list', 'propose_mcp_server']);
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

  // D2 (TL-B, owner): the same real-service round trip for grep — the tool line shows the pattern (not the engine's
  // path-first wire target, analysis §2/§4 "grep src") and a result summary, entirely through the surface stream.
  it('reaches the terminal renderer for grep: the tool line shows the pattern and a match summary, from the real service', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ toolCall: { name: 'grep', arguments: '{"pattern":"export const a","path":"src"}' } }, { content: 'Found it.' }];
    const deltas: TurnDelta[] = [];
    for await (const delta of streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 'scope', messages: ask('grep it').messages, options: { env: f.env } },
      { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn })) deltas.push(delta);
    let state = startAssistantStream(0); const units: AssistantUnit[] = [];
    for (const delta of deltas) { const step = renderAssistantStream(state, delta, 10); state = step.state; units.push(...step.staticUnits, ...(step.footer ? [step.footer] : [])); }
    expect(units[0]).toMatchObject({ kind: 'tool', name: 'grep', target: '"export const a" src', status: 'ok',
      summary: { kind: 'matches', count: 1, more: false } });
  }, 30_000);

  // Astra 2091 R1 (inverted repro) at the real boundary: workline → service → model request → session snapshot → /resume. A long
  // conversation of short exchanges is sent whole (the runtime measures and compacts it); no count cut drops the first instruction.
  it('sends a long conversation whole from the terminal through the service, saves it and resumes it without losing the first instruction', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ content: 'Answer one.' }, { content: 'Answer two.' }];
    await mkdir(join(f.data, 'sessions'), { mode: 0o700 });
    const sessions = bindSessionScope(openTerminalSessionStore(join(f.data, 'sessions')), 'scope');
    const earlier: AgentTurnMessage[] = Array.from({ length: 21 }, (_, index) => [{ role: 'user' as const, content: `directive-${index}` },
      { role: 'assistant' as const, content: `ok-${index}`, toolCalls: [] }]).flat();
    await sessions.save({ sessionId: '11111111-2222-4333-8444-555555555555', messages: earlier });
    const streamTurn = (messages: readonly AgentTurnMessage[], signal: AbortSignal) => streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 'scope',
      messages, options: { env: f.env }, signal }, { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn });
    const sent = (index: number) => (f.state.requests[index]!['messages'] as { content: string }[]).map(message => message.content);
    for (const [turn, question] of [[0, 'next'], [1, 'again']] as const) {
      const view = mountWorkline({ streamTurn, sessions, historyMessages: 40 });
      try {
        await until(() => view.stdout.text.includes('READY'), 'ready');
        view.stdin.write('/resume 11111111-2222-4333-8444-555555555555\r');
        await until(() => view.stdout.text.includes(`RESUMED ${42 + 2 * turn} 11111111`), 'resumed');
        view.stdin.write(`${question}\r`); await until(() => f.state.requests.length === turn + 1 && view.stdout.text.includes(turn ? 'Answer two.' : 'Answer one.'), 'answer');
        // The snapshot is written after the turn: wait for it before the next mount reads it.
        let saved: readonly AgentTurnMessage[] | null = null;
        for (let attempt = 0; attempt < 200 && saved?.length !== 44 + 2 * turn; attempt++) {
          saved = await sessions.load('11111111-2222-4333-8444-555555555555'); await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(saved).toHaveLength(44 + 2 * turn); expect(saved![0]).toMatchObject({ content: 'directive-0' });
      } finally { view.instance.unmount(); }
      // system + 42 earlier (+ the previous exchange) + the question: every message reached the model, the first instruction included.
      expect(sent(turn)).toHaveLength(44 + 2 * turn);
      expect(sent(turn)[1]).toBe('directive-0'); expect(sent(turn).at(-1)).toBe(question);
    }
    expect(sent(1)).toContain('Answer one.');
  }, 60_000);

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
    expect(refused.note).toMatch(/3000 prompt tokens \(provider-count\) \+ 2176 reserved > 4000.*Nothing was sent/);
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
    // One system message: the service segment ahead of the client's own prompt (TL-C D4); the client's history never holds the segment.
    expect(sent[0]!.role).toBe('system'); expect(sent[0]!.content).toMatch(/^\[Deckent runtime instructions v8\][\s\S]*\n\nSYS$/); expect(sent).toHaveLength(10);
    expect(sent.filter(message => message.role === 'system')).toHaveLength(1);
    expect(compacted.messages.some(message => message.content.includes('Deckent runtime instructions'))).toBe(false);
    // The summary call never carries the switch when the model does not declare it (TL-C D8).
    expect(f.state.requests[0]!['chat_template_kwargs']).toBeUndefined();
    expect(events.filter(event => event.kind === 'context').map(event => event.kind === 'context' && event.promptTokens)).toEqual([90_000, 900]);
  }, 30_000);

  // TERM-FEEDBACK-1 (live turn 975da614): the recorded summary answer (list fields as strings) compacts and the turn goes on; an unreadable
  // answer compacts with Deckent's labelled mechanical excerpt and the turn's note says so.
  it('continues the turn with the live summary answer, and with a labelled mechanical excerpt when the answer is unreadable', async () => {
    const live = JSON.parse(await readFile(join(import.meta.dirname, '../../fixtures/agent-turn/compaction-response-975da614.json'), 'utf8')) as { content: string };
    const history = [...Array.from({ length: 16 }, (_, i) => i % 2 ? { role: 'assistant' as const, content: `answer ${i}`, toolCalls: [] }
      : { role: 'user' as const, content: `question ${i}` }), { role: 'user' as const, content: 'go on' }];
    for (const [summary, note, kept] of [[live.content, null, 'arch.json: tier order'], ['I summarized it.', engine.AGENT_TURN_MECHANICAL_COMPACTION_NOTE, 'not written by the model']] as const) {
      const f = await runtime({ tokenize: true, windowTokens: 100_000, count: body => body.messages.length > 12 ? 90_000 : 900 }); await f.start();
      f.state.script = [{ summary }, { content: 'Going on.' }];
      const events: AgentTurnStreamEvent[] = [];
      expect(await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-summary', messages: history }, event => events.push(event)))
        .toMatchObject({ finish: 'stop', answer: 'Going on.', note });
      expect(events.flatMap(event => event.kind === 'compacted' ? [event.messages[0]!.content] : [])).toEqual([expect.stringContaining(kept)]);
    }
  }, 60_000);

  // TL-C (D4): the model-facing system prompt is the service's, in code, versioned; the client's catalog text follows it.
  it('sends one system message: the service segment with the workspace layout and tool rules, then the client prompt, with no contradiction (D4)', async () => {
    const f = await runtime({ dataInside: true }); await f.start();
    f.state.script = [{ content: 'Hello.' }, { content: 'Again.' }];
    // The shortened catalog prompt proposed in i18n-delta.json (the lead applies it to the locale files).
    const clientPrompt = 'You are the Deckent operator terminal assistant. Reply in English.';
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-prompt', messages: [{ role: 'system', content: clientPrompt },
      { role: 'user', content: 'hello' }], sessionId: 'session-d4' }, event => events.push(event));
    const sent = f.state.requests[0]!['messages'] as { role: string; content: string }[];
    expect(sent.map(message => message.role)).toEqual(['system', 'user']);
    const system = sent[0]!.content;
    expect(system.startsWith('[Deckent runtime instructions v8]')).toBe(true); expect(system.endsWith(`\n\n${clientPrompt}`)).toBe(true);
    expect(system).toContain('Context contract: carry v1, render v1.'); expect(system).toContain(`Project root: ${f.project}`);
    expect(system).toContain('Deckent data root: .deckent/live-data'); expect(system).not.toContain('terminal-sessions'); expect(system).toMatch(/saved conversations[^\n]*protected/);
    expect(system).toContain('.deckent/config.json'); expect(system).toContain('you are native-chat (Deckent catalog: provider local-openai v1, model chat v1), running inside Deckent');
    expect(system).toContain('Read tools: read_file, list_dir, grep, glob'); expect(system).toContain('Edit tools: edit_file, write_file');
    expect(system).toContain('Shell tool: run_shell'); expect(system).toContain('hasMore=true'); expect(system).toMatch(/one short line/);
    // The old catalog sentence contradicted the declared tools; neither the segment nor the proposed client text says it.
    expect(system).not.toMatch(/cannot (run|approve|change)|can't (run|approve|change)/i);
    // The segment is service-side only: nothing the client keeps (message events, saved history) carries it.
    expect(events.some(event => event.kind === 'message' && event.message.content.includes('Deckent runtime instructions'))).toBe(false);
    // Without a client system message the segment is the whole system message.
    // The same conversation (v16 `sessionId`): the same scratch area, so the same segment.
    await f.client().chatTurn({ ...ask('turn-prompt-2'), sessionId: 'session-d4' }, () => undefined);
    const bare = f.state.requests[1]!['messages'] as { role: string; content: string }[];
    expect(bare[0]).toEqual({ role: 'system', content: system.slice(0, -(clientPrompt.length + 2)) });
  }, 30_000);

  it('refuses the approval and preview directories of a data root inside the project to the agent tools, and still reads other files there (D4)', async () => {
    const f = await runtime({ dataInside: true });
    await mkdir(join(f.data, 'approvals'), { recursive: true, mode: 0o700 }); await mkdir(join(f.data, 'state', 'approval-previews'), { recursive: true, mode: 0o700 });
    await writeFile(join(f.data, 'approvals', 'held.txt'), 'owner-only approval record', { mode: 0o600 });
    await writeFile(join(f.data, 'state', 'approval-previews', 'diff.txt'), 'owner-only full diff', { mode: 0o600 });
    await writeFile(join(f.data, 'notes.txt'), 'ordinary data file', { mode: 0o600 });
    // TERM-FEEDBACK-1: another saved conversation of the same scope; the ledger is the fixture's own.
    await mkdir(join(f.data, 'state', 'terminal-sessions'), { recursive: true, mode: 0o700 });
    await writeFile(join(f.data, 'state', 'terminal-sessions', 'other.json'), '{"messages":[{"role":"user","content":"owner-only other conversation"}]}', { mode: 0o600 });
    await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":".deckent/live-data/state/approval-previews/diff.txt"}' } },
      { toolCall: { name: 'read_file', arguments: '{"path":".deckent/live-data/approvals/held.txt"}' } },
      { toolCall: { name: 'grep', arguments: '{"pattern":"owner-only","path":".deckent/live-data"}' } },
      { toolCall: { name: 'read_file', arguments: '{"path":".deckent/live-data/notes.txt"}' } },
      { toolCall: { name: 'list_dir', arguments: '{"path":".deckent/live-data/state/terminal-sessions"}' } },
      { toolCall: { name: 'read_file', arguments: '{"path":".deckent/live-data/state/terminal-sessions/other.json"}' } },
      { toolCall: { name: 'read_file', arguments: '{"path":".deckent/live-data/state/ledger.db"}' } },
      { toolCall: { name: 'read_file', arguments: '{"path":".deckent/config.json"}' } }, { content: 'Done.' }];
    const events: AgentTurnStreamEvent[] = [];
    expect(await f.client().chatTurn(ask('turn-deny', 'read the approvals'), event => events.push(event))).toMatchObject({ finish: 'stop', answer: 'Done.' });
    const results = events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : []);
    expect(results).toHaveLength(8);
    expect(results[0]).toContain('error=path-denied'); expect(results[1]).toContain('error=path-denied');
    expect(results.join('\n')).not.toContain('owner-only'.concat(' full diff')); expect(results.join('\n')).not.toContain('owner-only approval record');
    expect(results.join('\n')).not.toContain('owner-only other conversation');
    expect(results[3]).toContain('ordinary data file'); expect(results[7]).toContain('"provider_catalog"');
    for (const index of [4, 5, 6]) expect(results[index]).toContain('error=path-denied');
  }, 30_000);

  // TL-C (D8): the compaction call runs without thinking when (and only when) the catalog declares the switch.
  it('turns thinking off for the compaction call of a model that declares the switch, never for a round (D8)', async () => {
    const f = await runtime({ tokenize: true, windowTokens: 100_000, count: body => body.messages.length > 12 ? 90_000 : 900, thinkingSwitch: true }); await f.start();
    f.state.script = [{ summary: '{"objective":"o","findings":[],"decisions":[],"unresolved":[],"nextActions":[],"inspectedAreas":[]}' }, { content: 'Still a.' }];
    const history = [{ role: 'system' as const, content: 'SYS' }, ...Array.from({ length: 16 }, (_, i) => i % 2
      ? { role: 'assistant' as const, content: `answer ${i}`, toolCalls: [] } : { role: 'user' as const, content: `question ${i}` }),
    { role: 'user' as const, content: 'what now?' }];
    expect(await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-think', messages: history }, () => undefined)).toMatchObject({ finish: 'stop' });
    expect(f.state.requests).toHaveLength(2);
    expect(f.state.requests[0]).toMatchObject({ stream: false, chat_template_kwargs: { enable_thinking: false } });
    expect(f.state.requests[1]!['chat_template_kwargs']).toBeUndefined();
  }, 30_000);

  // OPEN-REASONING-FILE (protocol v16): `reasoning: 'off'` turns thinking off in every round of a model that declares the switch; the counter
  // counts the same body; the request digest binds the field; a model without the switch refuses the turn by name before anything runs.
  it("sends enable_thinking:false in every round and the counter body when the turn asks reasoning 'off', and binds it in the digest (v16)", async () => {
    const f = await runtime({ tokenize: true, thinkingSwitch: true }); await f.start();
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }, { content: 'It exports a.' }, { content: 'Default.' }];
    expect(await f.client().chatTurn({ ...ask('turn-off'), reasoning: 'off' }, () => undefined)).toMatchObject({ finish: 'stop', rounds: 2, answer: 'It exports a.' });
    expect(f.state.requests).toHaveLength(2);
    for (const request of f.state.requests) expect(request['chat_template_kwargs']).toEqual({ enable_thinking: false });
    expect(f.state.tokenize.length).toBeGreaterThanOrEqual(2);
    for (const counted of f.state.tokenize) expect(counted['chat_template_kwargs']).toEqual({ enable_thinking: false });
    // The same turn id without the field is another request: a conflict, never the stored answer of the thinking-off turn.
    await expect(f.client().chatTurn(ask('turn-off'), () => undefined)).rejects.toMatchObject({ code: 'AGENT_TURN_CONFLICT' });
    // Without the field (or with 'on') the rounds are today's request.
    const counted = f.state.tokenize.length;
    expect(await f.client().chatTurn({ ...ask('turn-default'), reasoning: 'on' }, () => undefined)).toMatchObject({ answer: 'Default.' });
    expect(f.state.requests[2]!['chat_template_kwargs']).toBeUndefined();
    for (const body of f.state.tokenize.slice(counted)) expect(body['chat_template_kwargs']).toBeUndefined();
  }, 30_000);

  it("refuses reasoning 'off' for a model that does not declare the switch, before any claim, model call or spending (v16)", async () => {
    const f = await runtime({ tokenize: true }); await f.start();
    f.state.script = [{ content: 'Thinking as usual.' }];
    await expect(f.client().chatTurn({ ...ask('turn-no-switch'), reasoning: 'off' }, () => undefined)).rejects.toMatchObject({ code: 'AGENT_TURN_REASONING_UNSUPPORTED' });
    expect(f.state.requests).toHaveLength(0); expect(f.state.tokenize).toHaveLength(0);
    expect(f.rows('SELECT count(*) AS count FROM agent_turns')).toEqual([{ count: 0 }]);
    expect(f.rows('SELECT count(*) AS count FROM model_invocations')).toEqual([{ count: 0 }]);
    // The same model without the field (today's request) still answers.
    expect(await f.client().chatTurn(ask('turn-no-switch-2'), () => undefined)).toMatchObject({ answer: 'Thinking as usual.' });
    expect(f.state.requests[0]!['chat_template_kwargs']).toBeUndefined();
  }, 30_000);

  it('turns model thinking off from the terminal: /reasoning off hides the preview and the next turn asks the service for it (v16)', async () => {
    const f = await runtime({ thinkingSwitch: true }); await f.start();
    f.state.script = [{ content: 'First.' }, { content: 'Second.' }, { content: 'Third.' }];
    const streamTurn = (messages: readonly AgentTurnMessage[], signal: AbortSignal, turn?: { readonly reasoning?: 'off' }) => streamTerminalAgentTurn({
      projectRoot: f.project, scopeId: 'scope', messages, options: { env: f.env }, signal, ...(turn?.reasoning ? { reasoning: turn.reasoning } : {}) },
    { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn });
    const view = mountWorkline({ streamTurn });
    try {
      await until(() => view.stdout.text.includes('READY'), 'ready');
      view.stdin.write('one\r'); await until(() => f.state.requests.length === 1 && view.stdout.text.includes('First.'), 'first');
      view.stdin.write('/reasoning off\r'); await until(() => /Reasoning (preview )?off/u.test(view.stdout.text), 'off notice');
      view.stdin.write('two\r'); await until(() => f.state.requests.length === 2 && view.stdout.text.includes('Second.'), 'second');
      view.stdin.write('/reasoning on\r'); await until(() => /Reasoning (preview )?on/u.test(view.stdout.text), 'on notice');
      view.stdin.write('three\r'); await until(() => f.state.requests.length === 3 && view.stdout.text.includes('Third.'), 'third');
    } finally { view.instance.unmount(); }
    expect(f.state.requests.map(request => request['chat_template_kwargs'] ?? null)).toEqual([null, { enable_thinking: false }, null]);
  }, 30_000);

  // Astra 2091 R1: with no provider count and no configured window, the service input bound (262144 here) is the compaction pressure,
  // so the history the client sends next stays under it instead of growing until the frame is refused.
  it('compacts on the service input bound when the window is unknown, so the next request keeps fitting (T-L5, Astra 2091 R1)', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ summary: '{"objective":"long talk","findings":[],"decisions":[],"unresolved":[],"nextActions":[],"inspectedAreas":[]}' }, { content: 'Fits.' }];
    const history = [{ role: 'system' as const, content: 'SYS' }, ...Array.from({ length: 40 }, (_, i) => i % 2
      ? { role: 'assistant' as const, content: `answer ${i} ${'b'.repeat(10_600)}`, toolCalls: [] } : { role: 'user' as const, content: `question ${i}` }),
    { role: 'user' as const, content: 'and now?' }];
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(0.75 * 262_144);
    const events: AgentTurnStreamEvent[] = [];
    const result = await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-bytes', messages: history }, event => events.push(event));
    expect(result).toMatchObject({ finish: 'stop', answer: 'Fits.' });
    expect(f.state.requests).toHaveLength(2); expect(f.state.requests[0]).toMatchObject({ stream: false });
    const compacted = events.find(event => event.kind === 'compacted') as Extract<AgentTurnStreamEvent, { kind: 'compacted' }>;
    expect(compacted.replacedMessages).toBeGreaterThan(0);
    const next = [history[0], ...compacted.messages, ...events.flatMap(event => event.kind === 'message' ? [event.message] : [])];
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(0.75 * 262_144);
  }, 30_000);

  // Astra 2106 R2 (inverted repro; owner 2026-09-26: headroom on the service): a history under the high-water mark is still compacted
  // when this round's longest answer plus the next user message would not fit the next request, so the following turn goes through;
  // a request that cannot fit even so is refused by name before anything is sent.
  it('keeps room for the longest answer and the next message, and refuses an oversized request by name (Astra 2106 R2)', async () => {
    const f = await runtime();
    const cfgPath = join(f.project, '.deckent/config.json'), cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    cfg.provider_invocation_profiles.profiles[0].adapter.definition.maxOutputTokens = 20_000;
    cfg.terminal.chat.maxCompletionTokens = 16_384;
    await writeFile(cfgPath, JSON.stringify(cfg)); await f.start();
    f.state.script = [{ summary: '{"objective":"o","findings":[],"decisions":[],"unresolved":[],"nextActions":[],"inspectedAreas":[]}' },
      { content: 'b'.repeat(64_000) }, { content: 'Next answer.' }];
    const history: AgentTurnMessage[] = [{ role: 'system', content: 'SYS' }, ...Array.from({ length: 40 }, (_, i) => i % 2
      ? { role: 'assistant' as const, content: 'a'.repeat(9_550), toolCalls: [] } : { role: 'user' as const, content: `question ${i}` }), { role: 'user', content: 'finish' }];
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(0.75 * 262_144);
    const events: AgentTurnStreamEvent[] = [];
    expect(await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'before-bound', messages: history }, event => events.push(event)))
      .toMatchObject({ finish: 'stop' });
    const compacted = events.find(event => event.kind === 'compacted') as Extract<AgentTurnStreamEvent, { kind: 'compacted' }>;
    expect(compacted).toBeDefined();
    const after = events.slice(events.indexOf(compacted) + 1).flatMap(event => event.kind === 'message' ? [event.message] : []);
    const next: AgentTurnMessage[] = [history[0]!, ...compacted.messages, ...after, { role: 'user', content: `next ${'q'.repeat(8_000)}` }];
    expect(await f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'after-bound', messages: next }, () => undefined)).toMatchObject({ finish: 'stop', answer: 'Next answer.' });
    expect(f.state.requests).toHaveLength(3);
    const huge: AgentTurnMessage[] = [history[0]!, { role: 'user', content: 'x'.repeat(300_000) }];
    await expect(f.client().chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'too-large', messages: huge }, () => undefined))
      .rejects.toMatchObject({ code: 'RUNTIME_CHAT_TURN_TOO_LARGE' });
    expect(f.state.requests).toHaveLength(3);
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
      await client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability, commandId: `${decision}-${event.approvalId}`,
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
    expect(record).toMatchObject({ status: 'decided', request: { schemaVersion: 3, subject: { kind: 'agent-tool-call', turnId: 'turn-allow', round: 1, index: 0,
      tool: 'read_file', toolVersion: 1, resource: 'src/a.ts' } } });

    const denied = await run('turn-deny', decide('deny'));
    expect(denied.events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
    const toolMessage = denied.events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : [])[0];
    expect(toolMessage).toContain('denied-by-owner'); expect(toolMessage).not.toContain('export const a');
    // Single use: every call opens its own request; nothing was reused across turns.
    expect(f.rows("SELECT count(*) AS count FROM approvals WHERE subject_kind='agent-tool-call'")).toEqual([{ count: 2 }]);
  }, 60_000);

  // D2 checkpoint (TL-B, owner): the tool line may show grep's pattern first (call-approvals.ts's displayTarget shows
  // `path` before `pattern` today); the C12 approval subject/resource must stay byte-identical regardless — it is built
  // once from `describeAgentCall` at the request and again at the effect gate, and this PR never touches that function.
  it('keeps the C12 approval resource path-first for grep even though the tool line may show the pattern first (owner)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: [
      { id: 'grep-approval', effect: 'require-approval', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['grep'] } },
      { id: 'other-read-tools', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['read_file', 'list_dir', 'glob'] } },
      { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }] });
    await f.start();
    const client = f.client();
    f.state.script = [{ toolCall: { name: 'grep', arguments: '{"pattern":"needle","path":"src"}' } }, { content: 'Found it.' }];
    const events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-grep-approval'), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
        commandId: `allow-${event.approvalId}`, expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' }));
    });
    await Promise.all(pending);
    const requested = events.find(event => event.kind === 'approval.requested') as Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
    expect(requested).toMatchObject({ summary: expect.stringMatching(/^grep · src · [0-9a-f]{12}$/) });
    const record = JSON.parse((f.rows(`SELECT snapshot FROM approvals WHERE approval_id='${requested.approvalId}'`)[0] as { snapshot: string }).snapshot);
    expect(record).toMatchObject({ request: { subject: { kind: 'agent-tool-call', tool: 'grep', resource: 'src' } } });
    // The wire event the engine sent is the same value the resource above is built from — unaffected by the surface's display fix.
    expect(events.find(event => event.kind === 'tool.started')).toMatchObject({ target: 'src' });
  }, 30_000);

  // D3 (TL-B, owner): `terminal.chat.readResultMaxBytes` reaches the workspace-read adapter through `turn.ts`; a
  // narrower configured limit measurably changes tool behavior (a second round) versus the (new, larger) default.
  it('passes terminal.chat.readResultMaxBytes to the workspace-read adapter (T-L5c)', async () => {
    const f = await runtime(); await f.start();
    const body = Array.from({ length: 900 }, (_, i) => `line ${i} of the fixture file with enough padding to add up`).join('\n') + '\n';
    await writeFile(join(f.project, 'src', 'big.ts'), body);
    // The fixture indexes `script` by the cumulative request count across every turn of this service, not per turn
    // (the C12 test above sets its whole 4-entry script the same way): both turns' rounds are listed up front.
    f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/big.ts"}' } }, { content: 'Read it.' },
      { toolCall: { name: 'read_file', arguments: '{"path":"src/big.ts"}' } }, { content: 'Read it again.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-default-limit'), event => events.push(event));
    expect(toolText(events)).toMatch(/hasMore=false/);
    const cfg = JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8')) as { terminal: { chat: Record<string, unknown> } };
    cfg.terminal.chat['readResultMaxBytes'] = 4096;
    await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify(cfg), { mode: 0o600 });
    const narrowed: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-narrow-limit'), event => narrowed.push(event));
    expect(toolText(narrowed)).toMatch(/hasMore=true/);
  }, 30_000);

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

  // Astra 2092 R2 end to end: the close of a cancelled turn's approval fails in the ledger; the stream says `unsettled` (never
  // `cancelled` over a pending record), nothing runs, and the next service start closes the orphaned request — whether or not the
  // host observes the sweep (Astra 2096 R1); without the integrity key nothing is closed and that is reported, never a key created.
  for (const restart of ['observed', 'unobserved', 'key-missing'] as const) {
    it(`reports an approval whose close failed as unsettled, runs nothing, and settles it at the next start (${restart})`, async () => {
      const f = await runtime({ toolGrant: 'approval' }); const live = await f.start();
      f.state.script = [{ toolCall: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }];
      const client = f.client(), events: AgentTurnStreamEvent[] = [];
      const running = client.chatTurn(ask('turn-unsettled'), event => {
        events.push(event);
        if (event.kind !== 'approval.requested') return;
        const db = new DatabaseSync(f.ledger);
        try { db.exec("CREATE TRIGGER fail_close BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END"); } finally { db.close(); }
        void client.cancelChatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-unsettled' });
      });
      expect(await running).toMatchObject({ finish: 'cancelled' });
      expect(events.find(event => event.kind === 'approval.settled')).toMatchObject({ outcome: 'unsettled' });
      expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'cancelled' });
      const status = () => f.rows('SELECT snapshot FROM approvals').map(row => JSON.parse((row as { snapshot: string }).snapshot).status);
      expect(status()).toEqual(['pending']);
      const db = new DatabaseSync(f.ledger); try { db.exec('DROP TRIGGER fail_close'); } finally { db.close(); }
      await live.stop(); await live.done.catch(() => undefined); services.splice(services.indexOf(live), 1);
      const keys = (await readdir(f.data, { recursive: true })).filter(path => path.endsWith('authority.key'));
      expect(keys).toHaveLength(1);
      if (restart === 'key-missing') await rename(join(f.data, keys[0]!), join(f.data, 'moved.key'));
      await f.start(restart !== 'unobserved');
      if (restart === 'key-missing') {
        expect(f.swept).toEqual([{ expired: 0, failed: 0, keyUnavailable: true }]);
        expect(status()).toEqual(['pending']);
        expect((await readdir(f.data, { recursive: true })).filter(path => path.endsWith('authority.key'))).toEqual([]);
      } else {
        expect(f.swept).toEqual(restart === 'observed' ? [{ expired: 1, failed: 0, keyUnavailable: false }] : []);
        expect(status()).toEqual(['expired']);
      }
      expect(f.state.requests).toHaveLength(1);
    }, 60_000);
  }

  // Astra 2094 R3 (inverted repro): a large change (35,000 characters, single- and multi-byte) reaches the owner as a bounded preview
  // with a first-line marker and the whole diff kept owner-only while pending; the real terminal shows the card, `y` writes the file.
  // Multi-byte uses 20,000 characters: its tool call must fit the fixture model's 65,536-byte response; the diff (~80 KB) still exceeds a frame.
  for (const [before, after, count] of [['a', 'b', 35_000], ['ç', 'ş', 20_000]] as const) {
    it(`shows a bounded preview of a large ${before === 'a' ? 'single-byte' : 'multi-byte'} change and keeps the whole diff until it settles (Astra 2094 R3)`, async () => {
      const f = await runtime({ toolGrant: false, extraGrants: editGrants('require-approval') }); await f.start();
      await writeFile(join(f.project, 'src', 'a.ts'), before.repeat(count));
      f.state.script = [{ toolCall: { name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts', content: after.repeat(count) }) } }, { content: 'Written.' }];
      const client = f.client(), previews: string[] = [];
      const kept = async () => (await readdir(f.data, { recursive: true })).filter(path => path.includes('approval-previews/') && path.endsWith('.txt'));
      const streamTurn = async function* (messages: readonly AgentTurnMessage[], signal: AbortSignal) {
        for await (const delta of streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 'scope', messages, options: { env: f.env }, signal },
          { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn })) {
          if (delta.kind === 'approval' && delta.phase === 'requested') previews.push(delta.preview);
          yield delta;
        }
      };
      const ledger = { scopeId: 'scope', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope', sources: [] } as never; }, async inspectRun() { return null; },
        async decideApproval(approval: { approvalId: string; revision: number }, decision: 'allow' | 'deny') {
          const record = await client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: approval.approvalId, commandId: `decide-${approval.approvalId}`,
            expectedRevision: approval.revision, decision, reason: 'Reviewed' }) as { revision: number; status: 'decided' };
          return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: record.revision, status: record.status, decision, expiresAt: 0 };
        } };
      const view = mountWorkline({ streamTurn, ledger: ledger as never });
      try {
        await until(() => view.stdout.text.includes('READY'), 'ready');
        view.stdin.write('rewrite it\r');
        await until(() => view.stdout.text.includes('n deny (Enter/Esc too)'), 'approval card')
        const preview = previews[0]!;
        expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(16_384);
        expect(preview.split('\n')[0]).toMatch(/^\[Deckent: preview cut to \d+ of \d+ lines \(\d+ of \d+ bytes\); whole text sha256 [0-9a-f]{64}; complete at .*approval-previews\/[0-9a-f]{64}\.txt\]$/);
        expect(view.stdout.text).toContain('Preview shortened: the first'); // the window says the engine's cut marker in catalog words expect(view.stdout.text).not.toContain('[Deckent: preview cut to');
        const files = await kept(); expect(files).toHaveLength(1);
        const whole = await readFile(join(f.data, files[0]!), 'utf8');
        expect(whole).toContain(`-${before.repeat(count)}`); expect(whole).toContain(`+${after.repeat(count)}`);
        expect(preview.split('\n')[0]).toContain(createHash('sha256').update(whole).digest('hex'));
        await new Promise(resolve => setTimeout(resolve, 60)); view.stdin.write('y');
        await until(() => view.stdout.text.includes('Written.'), 'turn finished');
      } finally { view.instance.unmount(); }
      expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe(after.repeat(count));
      expect(await kept()).toEqual([]);
    }, 60_000);
  }

  it('S5 default prefer-sandbox shows host fallback before output and in the durable/model result', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow'), shellRealm: 'absent', sandboxes: () => [] }); await f.start();
    f.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"cat src/a.ts"}' } }, { content: 'Done.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-realm-prefer'), event => events.push(event));
    const output = events.filter(event => event.kind === 'tool.output');
    expect(output[0]).toMatchObject({ stream: 'stderr', text: expect.stringContaining('sandbox: none') });
    expect(toolText(events)).toMatch(/^\[deckent\] run_shell: sandbox: none; /);
    expect(JSON.stringify(f.state.requests[1])).toContain('sandbox: none');
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok' });
    expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'host-shell', state: 'settled' }]);
  });

  it('S5 require-sandbox refuses before approval, effect intent and process creation', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow'), shellRealm: 'require-sandbox', sandboxes: () => [] }); await f.start();
    f.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"touch must-not-exist"}' } }, { content: 'Refused.' }];
    const events: AgentTurnStreamEvent[] = [];
    const client = f.client(), pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-realm-require'), event => {
      events.push(event);
      // If the realm gate regresses, approve this harmless fixture write so assertions observe the forbidden process/effect.
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
        commandId: 'unexpected-realm-approval', expectedRevision: event.revision, decision: 'allow', reason: 'Mutation sentinel only' }));
    });
    await Promise.all(pending);
    expect(toolText(events)).toContain('SHELL_SANDBOX_UNAVAILABLE');
    expect(events.some(event => event.kind === 'approval.requested')).toBe(false);
    expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([]);
    await expect(readFile(join(f.project, 'must-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // S9: on a host with bubblewrap and a user namespace, require-sandbox runs the command in the bubblewrap realm through the same
  // policy → classification → approval → C11 path: the card says so, no fallback note anywhere, the deny floor and HOME are hidden,
  // the project write lands, and the scratch area (TMPDIR) is writable.
  it.skipIf(!sandboxReady)('S9 require-sandbox runs a modifying command in the bubblewrap realm after approval, hiding secrets and HOME', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow'), shellRealm: 'require-sandbox' }); await f.start();
    await writeFile(join(f.project, '.env'), 'SECRET-ENV\n');
    // The command's HOME is the service process's own (host-shell allowlist), not the fixture's: a regular file that exists there must not exist inside.
    const serviceHome = process.env['HOME'] ?? homedir();
    const homeFile = (await readdir(serviceHome, { withFileTypes: true })).find(entry => entry.isFile())?.name ?? '.no-such-file';
    const command = `cat .env 2>&1; test -e "$HOME/${homeFile}"; echo "home-file=$?"; echo "home-files=$(find "$HOME" -maxdepth 1 -type f | wc -l)"; echo made > made.txt; echo scratch > "$TMPDIR/s.txt"`;
    f.state.script = [{ toolCall: { name: 'run_shell', arguments: JSON.stringify({ command }) } }, { content: 'Done.' }];
    const events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    const client = f.client();
    await client.chatTurn(ask('turn-realm-bwrap'), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
        commandId: 'allow-bwrap', expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' }));
    });
    await Promise.all(pending);
    expect(events.find(event => event.kind === 'approval.requested')).toMatchObject({ preview: expect.stringContaining('bubblewrap sandbox') });
    expect(events.find(event => event.kind === 'approval.requested')).not.toMatchObject({ preview: expect.stringContaining('not a sandbox') });
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ name: 'run_shell', status: 'ok', cleanup: 'clean' });
    expect(JSON.stringify(events)).not.toContain('sandbox: none'); expect(JSON.stringify(events)).not.toContain('SECRET');
    expect(toolText(events)).toMatch(/^\[deckent\] run_shell: sandbox: bubblewrap; exit 0 after [\d.]+s \(cat \.env/u);
    expect(toolText(events)).toMatch(/cat: \.env: Permission denied/u); expect(toolText(events)).toMatch(/home-file=1\nhome-files=0\n/u);
    expect(await readFile(join(serviceHome, homeFile))).toBeDefined();
    expect(await readFile(join(f.project, 'made.txt'), 'utf8')).toBe('made\n');
    expect((await readdir(join(f.data, 'state', 'scratch'), { recursive: true })).some(entry => String(entry).endsWith('s.txt'))).toBe(true);
    expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'host-shell', state: 'settled' }]);
  }, 30_000);

  // T-L4 slice 3c (Jev 82858581): run_shell as a C11 effect of host.shell.run. Only a read-only command of bounded reach runs silently.
  it('runs a read-only command of bounded reach without asking, streams its output and settles a host.shell.run effect (T-L4 slice 3c)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow') }); await f.start();
    f.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"cat src/a.ts"}' } }, { content: 'Done.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-shell-read'), event => events.push(event));
    expect(events.some(event => event.kind === 'approval.requested')).toBe(false);
    expect(events.filter(event => event.kind === 'tool.output').map(event => event.kind === 'tool.output' && event.text).join('')).toBe('export const a = 1;\n');
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ name: 'run_shell', status: 'ok' });
    expect(toolText(events)).toMatch(/^\[deckent\] run_shell: exit 0 after [\d.]+s \(cat src\/a\.ts\)\nexport const a = 1;\n$/u);
    expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'host-shell', state: 'settled' }]);
  }, 30_000);

  it('asks before a modifying, traversing or destructive command even when policy allows, runs it once on allow, never on deny (T-L4 slice 3c)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow') }); await f.start();
    const client = f.client();
    const run = async (turnId: string, commandLine: string, decision: 'allow' | 'deny') => {
      f.state.script = [...f.state.script.slice(0, f.state.requests.length), { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command: commandLine }) } }, { content: 'Ok.' }];
      const events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
      await client.chatTurn(ask(turnId), event => {
        events.push(event);
        if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
          commandId: `${decision}-${turnId}`, expectedRevision: event.revision, decision, reason: 'Reviewed' }));
      });
      await Promise.all(pending);
      return events;
    };
    const modify = await run('turn-touch', 'touch made.txt', 'allow');
    expect(modify.find(event => event.kind === 'approval.requested')).toMatchObject({ preview: expect.stringContaining('$ touch made.txt\nrisk: modify') });
    expect(modify.find(event => event.kind === 'approval.requested')).toMatchObject({ preview: expect.stringContaining('not a sandbox') });
    expect(await readFile(join(f.project, 'made.txt'), 'utf8')).toBe('');
    const traversal = await run('turn-grep', 'grep -r a .', 'deny');
    expect(traversal.find(event => event.kind === 'approval.requested')).toMatchObject({ preview: expect.stringContaining('risk: safe-read') });
    expect(traversal.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
    expect(traversal.some(event => event.kind === 'tool.output')).toBe(false);
    const destructive = await run('turn-rm', 'rm -rf src', 'deny');
    expect(destructive.find(event => event.kind === 'approval.requested')).toMatchObject({ preview: expect.stringContaining('risk: destructive') });
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(f.rows('SELECT state FROM effect_intents')).toEqual([{ state: 'settled' }]);

    // A company policy that asks for the tool asks even for a read-only command of bounded reach.
    const asking = await runtime({ toolGrant: false, extraGrants: shellGrants('require-approval') }); await asking.start();
    asking.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"cat src/a.ts"}' } }, { content: 'Ok.' }];
    const askingClient = asking.client(), askingEvents: AgentTurnStreamEvent[] = [];
    await askingClient.chatTurn(ask('turn-policy-asks'), event => {
      askingEvents.push(event);
      if (event.kind === 'approval.requested') void askingClient.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
        commandId: 'deny-policy-asks', expectedRevision: event.revision, decision: 'deny', reason: 'Reviewed' });
    });
    expect(askingEvents.find(event => event.kind === 'approval.requested')).toMatchObject({ preview: expect.stringContaining('risk: safe-read') });
    expect(askingEvents.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
  }, 60_000);

  // Astra 2111 repro (ported, asserting the corrected behavior): bash opens `linked/../public.txt` as the parent of the link's target.
  it('asks before a path whose `..` follows a symlink, since the shell opens the parent of the link target; a `..` through a real directory stays silent (Astra 2111)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow') }); await f.start();
    const outside = await mkdtemp(join(tmpdir(), 'deckent-outside-fixture-')); roots.push(outside);
    await mkdir(join(outside, 'sub'));
    await writeFile(join(outside, 'public.txt'), 'OUTSIDE_SYNTHETIC_SENTINEL');
    await writeFile(join(f.project, 'public.txt'), 'INSIDE_PUBLIC');
    await symlink(join(outside, 'sub'), join(f.project, 'linked'));
    f.state.script = [{ toolCall: { name: 'run_shell', arguments: JSON.stringify({ command: 'cat linked/../public.txt' }) } }, { content: 'Done.' },
      { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command: 'cat src/../public.txt' }) } }, { content: 'Done.' }];
    const client = f.client(), linked: AgentTurnStreamEvent[] = [];
    await client.chatTurn(ask('turn-shell-dotdot'), event => {
      linked.push(event);
      if (event.kind === 'approval.requested') void client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
        commandId: 'deny-dotdot', expectedRevision: event.revision, decision: 'deny', reason: 'Reviewed' });
    });
    expect(linked.find(event => event.kind === 'approval.requested')).toMatchObject({ preview: expect.stringContaining('$ cat linked/../public.txt') });
    expect(linked.find(event => event.kind === 'tool.finished')).toMatchObject({ name: 'run_shell', status: 'denied' });
    expect(linked.some(event => event.kind === 'tool.output')).toBe(false);
    expect(toolText(linked)).not.toContain('OUTSIDE_SYNTHETIC_SENTINEL');
    expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([]);
    const plain: AgentTurnStreamEvent[] = [];
    await client.chatTurn(ask('turn-shell-dotdot-plain'), event => plain.push(event));
    expect(plain.some(event => event.kind === 'approval.requested')).toBe(false);
    expect(toolText(plain)).toMatch(/^\[deckent\] run_shell: exit 0 after [\d.]+s \(cat src\/\.\.\/public\.txt\)\nINSIDE_PUBLIC$/u);
  }, 30_000);

  // Astra 2124: the host shell reports what it could verify about processes the command left (`cleanup`); the tool result says it,
  // and (CLEANUP-MARK, protocol v15) the same value rides `tool.finished` and reaches the terminal renderer's finished unit.
  it('says in the tool result when the cleanup is unverified or group members were ended, and keeps a clean result unchanged (Astra 2124)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow') }); await f.start();
    const client = f.client();
    const toolUnitOf = (events: AgentTurnStreamEvent[]) => {
      let state = startAssistantStream(0); const units: AssistantUnit[] = [];
      for (const event of events) {
        const delta = event.kind === 'tool.started' ? { kind: 'tool' as const, phase: 'started' as const, callId: event.callId, name: event.name, target: event.target, status: null, ms: null }
          : event.kind === 'tool.finished' ? { kind: 'tool' as const, phase: 'finished' as const, callId: event.callId, name: event.name, target: null, status: event.status, ms: event.ms,
            ...(event.cleanup !== undefined ? { cleanup: event.cleanup } : {}) } : null;
        if (!delta) continue;
        const step = renderAssistantStream(state, delta, 0); state = step.state; units.push(...step.staticUnits);
      }
      return units.find((unit): unit is Extract<AssistantUnit, { kind: 'tool' }> => unit.kind === 'tool') ?? null;
    };
    const run = async (turnId: string, commandLine: string) => {
      f.state.script = [...f.state.script.slice(0, f.state.requests.length), { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command: commandLine }) } }, { content: 'Ok.' }];
      const events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
      const started = performance.now();
      await client.chatTurn(ask(turnId), event => {
        events.push(event);
        if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
          commandId: `allow-${turnId}`, expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' }));
      });
      await Promise.all(pending);
      return { events, ms: performance.now() - started };
    };
    // A descendant that left the process group (setsid) holds the pipes: they are released after the bounded drain.
    let escaped: number | null = null;
    try {
      const unverified = await run('turn-shell-escaped', "setsid sh -c 'echo $$ > escaped.pid; echo ready; exec sleep 5' & sleep 0.2; exit 0");
      escaped = Number((await readFile(join(f.project, 'escaped.pid'), 'utf8')).trim());
      expect(unverified.ms).toBeLessThan(4_000);
      expect(unverified.events.find(event => event.kind === 'tool.finished')).toMatchObject({ name: 'run_shell', status: 'ok', cleanup: 'unverified' });
      expect(toolUnitOf(unverified.events)).toMatchObject({ name: 'run_shell', status: 'ok', cleanup: 'unverified' });
      const text = toolText(unverified.events);
      expect(text).toMatch(/^\[deckent\] run_shell: exit 0 after /u);
      expect(text).toContain('[deckent] cleanup unverified:');
      expect(text).toContain('the output may be incomplete');
      expect(text).toContain('outside its process group');
      expect(text).not.toMatch(/processes? (?:were|was) ended|verified (?:dead|ended)/u);
      // The owner sees it on the call's streamed output, the display the surfaces show for a running call.
      expect(unverified.events.filter(event => event.kind === 'tool.output').map(event => event.kind === 'tool.output' && event.text).join(''))
        .toContain('[deckent] cleanup unverified:');
    } finally { if (escaped) try { process.kill(-escaped, 'SIGKILL'); } catch { /* already gone */ } }
    // A background member of the group still alive when the shell exits is ended; the group is then observed empty.
    const ended = await run('turn-shell-group-ended', 'sleep 5 & echo started');
    expect(ended.ms).toBeLessThan(4_000);
    const endedText = toolText(ended.events);
    expect(endedText).toMatch(/^\[deckent\] run_shell: exit 0 after [\d.]+s \(sleep 5 & echo started\)\nstarted\n/u);
    expect(endedText).toContain('[deckent] cleanup: processes the command left running in its process group were ended');
    expect(endedText).not.toContain('cleanup unverified');
    expect(ended.events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok', cleanup: 'group-ended' });
    expect(toolUnitOf(ended.events)).toMatchObject({ status: 'ok', cleanup: 'group-ended' });
    // Clean: the result is exactly as before (no note), and the durable marker carries the verified-clean value too.
    const clean = await run('turn-shell-clean', 'echo hi > clean.txt');
    expect(toolText(clean.events)).toMatch(/^\[deckent\] run_shell: exit 0 after [\d.]+s \(echo hi > clean\.txt\)\n$/u);
    expect(clean.events.some(event => event.kind === 'tool.output')).toBe(false);
    expect(clean.events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok', cleanup: 'clean' });
    expect(toolUnitOf(clean.events)).toMatchObject({ status: 'ok', cleanup: 'clean' });
  }, 60_000);

  // Astra 2113 repro (ported, asserting the corrected behavior): the fixture provider names every tool call `call_1`.
  it('runs the same command again in a later round as its own effect, although the provider reuses the call id (Astra 2113)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow') }); await f.start();
    const step = { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command: 'echo again' }) } };
    f.state.script = [step, step, { content: 'Done.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-shell-repeat'), event => events.push(event));
    expect(events.filter(event => event.kind === 'tool.finished')).toEqual([expect.objectContaining({ callId: 'call_1', status: 'ok' }),
      expect.objectContaining({ callId: 'call_1', status: 'ok' })]);
    expect(events.filter(event => event.kind === 'tool.output').map(event => event.kind === 'tool.output' && event.text)).toEqual(['again\n', 'again\n']);
    expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'host-shell', state: 'settled' }, { target_kind: 'host-shell', state: 'settled' }]);
  }, 30_000);

  it('writes the same change again after the file returned to the same version, never answering it as a replay of the first write (Astra 2113)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants('allow') }); await f.start();
    const write = (content: string) => ({ toolCall: { name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts', content }) } });
    f.state.script = [write('export const a = 2;\n'), write('export const a = 1;\n'), write('export const a = 2;\n'), { content: 'Done.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-edit-aba'), event => events.push(event));
    expect(events.filter(event => event.kind === 'tool.finished').map(event => event.kind === 'tool.finished' && event.status)).toEqual(['ok', 'ok', 'ok']);
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(f.rows('SELECT target_id, state FROM effect_intents')).toEqual(Array.from({ length: 3 }, () => ({ target_id: 'src/a.ts', state: 'settled' })));
  }, 30_000);

  it('derives one effect per execution: a replay of the same round and index is the same command, another round or index is another (Astra 2113)', () => {
    const digest = 'd'.repeat(64);
    const shell = agentShellEffectCommandId('scope', 'turn', { round: 2, index: 0 }, digest);
    expect(agentShellEffectCommandId('scope', 'turn', { round: 2, index: 0 }, digest)).toBe(shell);
    expect(new Set([shell, agentShellEffectCommandId('scope', 'turn', { round: 3, index: 0 }, digest), agentShellEffectCommandId('scope', 'turn', { round: 2, index: 1 }, digest),
      agentShellEffectCommandId('scope', 'other', { round: 2, index: 0 }, digest), agentShellEffectCommandId('scope', 'turn', { round: 2, index: 0 }, 'e'.repeat(64))]).size).toBe(5);
    const file = agentFileEffectCommandId('scope', 'turn', { round: 2, index: 0 }, digest, 'v1');
    expect(agentFileEffectCommandId('scope', 'turn', { round: 2, index: 0 }, digest, 'v1')).toBe(file);
    expect(new Set([file, agentFileEffectCommandId('scope', 'turn', { round: 4, index: 0 }, digest, 'v1'), agentFileEffectCommandId('scope', 'turn', { round: 2, index: 1 }, digest, 'v1'),
      agentFileEffectCommandId('scope', 'turn', { round: 2, index: 0 }, digest, 'v2')]).size).toBe(4);
  });

  it('keeps the turn alive on a very large output: the display is skipped visibly when the client lags, the result stays bounded (T-L4 slice 3c)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow') }); await f.start();
    await writeFile(join(f.project, 'big.txt'), 'x'.repeat(2_000_000));
    f.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"cat big.txt"}' } }, { content: 'Read.' }];
    const events: AgentTurnStreamEvent[] = [];
    // A slow reader: the client handles events only after a delay, so unread bytes pile up on the service side.
    const result = await f.client().chatTurn(ask('turn-big'), event => { events.push(event); const until = Date.now() + 2; while (Date.now() < until) { /* lag */ } });
    expect(result).toMatchObject({ finish: 'stop' });
    const shown = events.filter(event => event.kind === 'tool.output').map(event => event.kind === 'tool.output' ? event.text : '').join('');
    expect(shown.length === 2_000_000 || shown.includes('[deckent] output display skipped')).toBe(true);
    expect(Buffer.byteLength(toolText(events))).toBeLessThan(17_000);
    expect(toolText(events)).toMatch(/bytes of output omitted/u);
  }, 60_000);

  it('never offers a command the policy does not grant, and kills a running command when the turn is cancelled (T-L4 slice 3c)', async () => {
    const denied = await runtime({ toolGrant: false, extraGrants: [] }); await denied.start();
    denied.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"touch never.txt"}' } }, { content: 'No.' }];
    const deniedEvents: AgentTurnStreamEvent[] = [];
    await denied.client().chatTurn(ask('turn-denied'), event => deniedEvents.push(event));
    expect(deniedEvents.some(event => event.kind === 'approval.requested')).toBe(false);
    expect(deniedEvents.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
    await expect(readFile(join(denied.project, 'never.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow') }); await f.start();
    f.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"sleep 20; touch late.txt"}' } }];
    const client = f.client();
    const running = client.chatTurn(ask('turn-cancel-shell'), event => {
      if (event.kind === 'approval.requested') void client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
        commandId: 'allow-sleep', expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' });
      if (event.kind === 'approval.settled') setTimeout(() => void client.cancelChatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-cancel-shell' }), 300);
    });
    const started = Date.now();
    expect(await running).toMatchObject({ finish: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'host-shell', state: 'unknown' }]);
    await new Promise(resolve => setTimeout(resolve, 300));
    await expect(readFile(join(f.project, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Each run is its own record: the uncertain run above does not make the shell busy for the next command.
    f.state.script = [...f.state.script.slice(0, f.state.requests.length), { toolCall: { name: 'run_shell', arguments: '{"command":"cat src/a.ts"}' } }, { content: 'Again.' }];
    const next: AgentTurnStreamEvent[] = [];
    await client.chatTurn(ask('turn-after-cancel'), event => next.push(event));
    expect(next.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok' });

    // The tool alone is not enough: without the host.shell.run operation grant the command is denied and never offered.
    const toolOnly = await runtime({ toolGrant: false, extraGrants: [shellGrants('allow')[0]!] }); await toolOnly.start();
    toolOnly.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"cat src/a.ts"}' } }, { content: 'No.' }];
    const toolOnlyEvents: AgentTurnStreamEvent[] = [];
    await toolOnly.client().chatTurn(ask('turn-tool-only'), event => toolOnlyEvents.push(event));
    expect(toolOnlyEvents.some(event => event.kind === 'approval.requested' || event.kind === 'tool.output')).toBe(false);
    expect(toolOnlyEvents.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'denied' });
  }, 60_000);

  it('writes an approved edit as a C11 effect: the owner sees the diff, the file is written once and the effect is settled (T-L4 slice 2)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants('require-approval') }); await f.start();
    f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } }, { content: 'Done.' }];
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-edit', 'set a to 2'), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
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

  // C12 G3 red evidence: before G3 the in-turn gates admitted from their own turn state, so a turn that believed "allow" wrote and ran.
  it('never writes or runs a call whose stored approval is still pending, although the turn was told allow (C12 G3)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: [...editGrants('require-approval'), ...shellGrants('require-approval').filter(grant => grant.id !== 'decide')] });
    await f.start();
    // The wait reports allow, but nobody decided: the durable record stays pending.
    const wait = vi.spyOn(engine, 'awaitAgentToolApproval').mockResolvedValue('allow');
    try {
      f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } }, { content: 'Done.' },
        { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command: 'touch made.txt' }) } }, { content: 'Ok.' }];
      const client = f.client(), edit: AgentTurnStreamEvent[] = [], shell: AgentTurnStreamEvent[] = [];
      await client.chatTurn(ask('turn-unrecorded-edit', 'set a to 2'), event => edit.push(event));
      await client.chatTurn(ask('turn-unrecorded-shell', 'touch it'), event => shell.push(event));
      expect(wait).toHaveBeenCalledTimes(2);
      for (const events of [edit, shell]) {
        expect(events.find(event => event.kind === 'approval.settled')).toMatchObject({ outcome: 'allow' });
        expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'error' });
        expect(toolText(events)).toContain('approval for this call could not be verified (APPROVAL_REQUIRED)');
      }
      expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      await expect(readFile(join(f.project, 'made.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.rows('SELECT count(*) AS count FROM effect_intents')).toEqual([{ count: 0 }]);
      expect(f.rows("SELECT json_extract(snapshot, '$.status') AS status FROM approvals WHERE subject_kind='agent-tool-call'")).toEqual([{ status: 'pending' }, { status: 'pending' }]);
    } finally { wait.mockRestore(); }
  }, 60_000);

  it('never writes or runs a call whose owner-allowed record approves another call (digest bound to the executed arguments) (C12 G3)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: [...editGrants('require-approval'), ...shellGrants('require-approval').filter(grant => grant.id !== 'decide')] });
    await f.start();
    // The stored request names other arguments than the call that is executed; the owner really allows it.
    const original = engine.requestAgentToolApproval;
    const request = vi.spyOn(engine, 'requestAgentToolApproval').mockImplementation((store, integrity, input) =>
      original(store, integrity, { ...input, subject: { ...input.subject, argsDigest: 'f'.repeat(64) } }));
    try {
      f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } }, { content: 'Done.' },
        { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command: 'touch made.txt' }) } }, { content: 'Ok.' }];
      const client = f.client();
      const run = async (turnId: string) => {
        const events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
        await client.chatTurn(ask(turnId), event => {
          events.push(event);
          if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
            commandId: `allow-${turnId}`, expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' }));
        });
        await Promise.all(pending); return events;
      };
      for (const events of [await run('turn-other-edit'), await run('turn-other-shell')]) {
        expect(events.find(event => event.kind === 'approval.settled')).toMatchObject({ outcome: 'allow' });
        expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'error' });
        expect(toolText(events)).toContain('approval for this call could not be verified (APPROVAL_CONFLICT)');
      }
      expect(request).toHaveBeenCalledTimes(2);
      expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      await expect(readFile(join(f.project, 'made.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.rows('SELECT count(*) AS count FROM effect_intents')).toEqual([{ count: 0 }]);
      expect(f.rows("SELECT json_extract(snapshot, '$.decision.decision') AS decision FROM approvals WHERE subject_kind='agent-tool-call'")).toEqual([{ decision: 'allow' }, { decision: 'allow' }]);
    } finally { request.mockRestore(); }
  }, 60_000);

  it('pins the consumed approval in the intent of an approved edit and shell run, and a replayed turn is still one effect (C12 G3)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: [...editGrants('require-approval'), ...shellGrants('require-approval').filter(grant => grant.id !== 'decide')] });
    await f.start();
    f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } }, { content: 'Done.' },
      { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command: 'echo made >> made.txt' }) } }, { content: 'Ok.' }];
    const client = f.client();
    const run = async (turnId: string) => {
      const events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
      const result = await client.chatTurn(ask(turnId), event => {
        events.push(event);
        if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
          commandId: `allow-${turnId}`, expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' }));
      });
      await Promise.all(pending); return { events, result };
    };
    const edit = await run('turn-pinned-edit'), shell = await run('turn-pinned-shell');
    for (const { events } of [edit, shell]) expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok' });
    const pins = f.rows("SELECT e.target_kind AS kind, json_extract(e.record, '$.intent.approval.approvalId') AS approvalId, json_extract(e.record, '$.intent.approval.actionDigest') AS digest, "
      + "a.action_digest AS stored, json_extract(a.snapshot, '$.request.subject.turnId') AS turn FROM effect_intents e JOIN approvals a ON a.approval_id = json_extract(e.record, '$.intent.approval.approvalId') ORDER BY kind");
    expect(pins).toEqual([{ kind: 'host-shell', approvalId: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/), stored: expect.any(String), turn: 'turn-pinned-shell' },
      { kind: 'workspace-file', approvalId: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/), stored: expect.any(String), turn: 'turn-pinned-edit' }]);
    for (const pin of pins as { digest: string; stored: string }[]) expect(pin.digest).toBe(pin.stored);
    // Replaying either finished turn asks nothing, runs nothing and adds no effect.
    const replayedEdit = await run('turn-pinned-edit'), replayedShell = await run('turn-pinned-shell');
    for (const { events, result } of [replayedEdit, replayedShell]) {
      expect(result).toMatchObject({ replayed: true });
      expect(events.some(event => event.kind === 'approval.requested' || event.kind === 'tool.started')).toBe(false);
    }
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(await readFile(join(f.project, 'made.txt'), 'utf8')).toBe('made\n');
    expect(f.rows('SELECT count(*) AS count FROM effect_intents')).toEqual([{ count: 2 }]);
    expect(f.state.requests).toHaveLength(4);
  }, 60_000);

  it('refuses an approved edit whose file changed while the owner was reading the diff, and keeps what the other writer wrote (T-L4 slice 2)', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants('require-approval') }); await f.start();
    f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } }, { content: 'Stale.' }];
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(ask('turn-stale', 'set a to 2'), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push((async () => {
        await writeFile(join(f.project, 'src', 'a.ts'), 'export const a = 7;\n');
        await client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability, commandId: 'allow-stale',
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
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
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
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
        commandId: 'allow-op', expectedRevision: event.revision, decision: 'allow', reason: 'Reviewed' }));
    });
    await Promise.all(pending);
    expect(events.find(event => event.kind === 'tool.finished')).toMatchObject({ status: 'ok' });
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  }, 60_000);

  it('answers a policy-denied edit before planning it, so the result never depends on the file content', async () => {
    const f = await runtime({ toolGrant: false }); await f.start();
    f.state.script = [{ toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"a = 1","new_string":"a = 2"}' } },
      { toolCall: { name: 'edit_file', arguments: '{"path":"src/a.ts","old_string":"absent text","new_string":"a = 2"}' } }, { content: 'Denied.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(ask('turn-denied-oracle', 'probe'), event => events.push(event));
    const results = events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : []);
    expect(results).toEqual(['[deckent] edit_file: error=denied-by-policy', '[deckent] edit_file: error=denied-by-policy']);
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
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

  // INFLIGHT-FIX (TL-A PTY symptom, live ledger 2026-09-28): a cancelled round settles `unknown` after its provider request is closed and
  // frees its concurrency slot; the uncertain record and the lifetime count stay. Open requests still bound maxInFlight (2).
  it('frees the slot of a cancelled round once its request is closed, so a third turn answers after two cancelled ones', async () => {
    const f = await runtime(); await f.start();
    f.state.script = [{ hold: true }, { hold: true }, { content: 'third answer' }];
    const counters = () => f.rows('SELECT lifetime_calls,in_flight FROM model_invocation_allocations')[0];
    const states = () => f.rows('SELECT state,count(*) AS count FROM model_invocations GROUP BY state ORDER BY state');
    const waitUntil = async (check: () => boolean, label: string) => {
      const until = performance.now() + 5_000;
      while (!check()) { if (performance.now() >= until) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    const client = f.client(), leaving = new AbortController(); let firstSeen = false, secondSeen = false;
    const first = client.chatTurn(ask('turn-held-1'), event => { if (event.kind === 'text') firstSeen = true; });
    const second = f.client().chatTurn(ask('turn-held-2'), event => { if (event.kind === 'text') secondSeen = true; }, leaving.signal);
    await waitUntil(() => firstSeen && secondSeen, 'HELD_STREAMS_NOT_OPEN');
    expect(counters()).toEqual({ lifetime_calls: 2, in_flight: 2 });
    // Two really open calls: a third call (a direct invocation with its own process-local controllers) meets the ledger limit.
    const direct = { schemaVersion: 1 as const, commandId: 'direct-over-limit', scopeId: 'scope', reference, catalogRevision: 'catalog-1',
      expectedBinding: f.binding, nativeRequest: { model: 'native-chat', messages: [{ role: 'user', content: 'over the limit' }], max_completion_tokens: 8 } };
    await expect(invokeConfiguredModel(f.project, direct, { env: f.env })).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CAPACITY_EXHAUSTED' });
    expect(f.state.requests).toHaveLength(2);
    // Cancel both: one through the cancel operation, one by the client leaving mid-stream (the terminal's Esc closes its stream).
    expect(await client.cancelChatTurn({ schemaVersion: 1, scopeId: 'scope', turnId: 'turn-held-1' })).toMatchObject({ state: 'cancelling' });
    expect(await first).toMatchObject({ finish: 'cancelled' });
    leaving.abort();
    await expect(second).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
    // The provider saw both requests closed before the slots are counted free.
    await waitUntil(() => f.state.closed === 2, 'HELD_REQUESTS_NOT_CLOSED');
    await waitUntil(() => JSON.stringify(states()) === JSON.stringify([{ state: 'unknown', count: 2 }]), 'CANCELLED_ROUNDS_NOT_SETTLED');
    expect(counters()).toEqual({ lifetime_calls: 2, in_flight: 0 });
    const third = await f.client().chatTurn(ask('turn-third'), () => undefined);
    expect(third).toMatchObject({ finish: 'stop', answer: 'third answer', rounds: 1 });
    expect(f.state.requests).toHaveLength(3);
    // Both uncertain records remain, and every claim stays counted.
    expect(states()).toEqual([{ state: 'responded', count: 1 }, { state: 'unknown', count: 2 }]);
    expect(counters()).toEqual({ lifetime_calls: 3, in_flight: 0 });
  }, 30_000);

  // INFLIGHT-FIX repair: the live ledger holds slots an earlier build kept for settled `unknown` rounds; the next start (under endpoint
  // custody) releases exactly those and reports it. Stopping and starting the fixed build is the whole operator action.
  it('releases at start the slots an earlier build kept for cancelled rounds, and the terminal is usable again', async () => {
    const f = await runtime(); const first = await f.start();
    f.state.script = [{ hold: true }, { hold: true }, { content: 'after repair' }];
    const client = f.client();
    for (const turnId of ['turn-old-1', 'turn-old-2']) {
      let seen = false;
      const running = client.chatTurn(ask(turnId), event => { if (event.kind === 'text') seen = true; });
      const until = performance.now() + 5_000;
      while (!seen && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      await client.cancelChatTurn({ schemaVersion: 1, scopeId: 'scope', turnId });
      expect(await running).toMatchObject({ finish: 'cancelled' });
    }
    await first.stop(); await first.done.catch(() => undefined); services.splice(services.indexOf(first), 1);
    expect(f.released).toEqual([]);
    // Rewrite the counter as the earlier build left it (both settled unknown rounds still holding their slots, maxInFlight 2).
    const db = new DatabaseSync(f.ledger);
    let stuckRevision: number;
    try {
      const current = db.prepare(`SELECT a.record,c.revision FROM model_invocation_allocations a JOIN model_invocation_allocation_checkpoints c
        ON c.scope_id=a.scope_id AND c.allocation_id=a.allocation_id`).get() as { record: string; revision: number };
      const stuck = engine.createModelAllocationCheckpoint({ ...JSON.parse(current.record), inFlight: 2 }, current.revision + 1);
      db.prepare('UPDATE model_invocation_allocations SET in_flight=?,record=?').run(2, JSON.stringify(stuck.allocation));
      db.prepare('UPDATE model_invocation_allocation_checkpoints SET revision=?,digest=?').run(stuck.revision, stuck.digest);
      stuckRevision = stuck.revision;
    } finally { db.close(); }
    await f.start();
    expect(f.released).toEqual([{ allocations: 1, released: 2, settled: 0, inconsistent: [] }]);
    expect(f.rows(`SELECT a.lifetime_calls,a.in_flight,c.revision FROM model_invocation_allocations a JOIN model_invocation_allocation_checkpoints c
      ON c.scope_id=a.scope_id AND c.allocation_id=a.allocation_id`)).toEqual([{ lifetime_calls: 2, in_flight: 0, revision: stuckRevision + 1 }]);
    expect(await f.client().chatTurn(ask('turn-after-repair'), () => undefined)).toMatchObject({ finish: 'stop', answer: 'after repair' });
    expect(f.rows('SELECT state,count(*) AS count FROM model_invocations GROUP BY state ORDER BY state'))
      .toEqual([{ state: 'responded', count: 1 }, { state: 'unknown', count: 2 }]);
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

// T-L5 `@file` (owner 2026-09-27, protocol v15): the real workline asks the real service for candidates and content; the surface reads no file.
describe.skipIf(process.platform !== 'linux')('composer @file and slash keys through the runtime service', () => {
  async function workspace() {
    const f = await runtime(); await f.start();
    const put = async (path: string, body: string | Buffer) => { await mkdir(join(f.project, path, '..'), { recursive: true }); await writeFile(join(f.project, path), body); };
    await Promise.all([put('src/app.ts', 'export const app = 2;\n'), put('docs/environment.md', '# env notes\n'), put('.env', 'SECRET_TOKEN=hunter2\n'),
      put('config/.env.local', 'SECRET_TOKEN=local\n'), put('secrets.json', '{"SECRET_TOKEN":1}\n'), put('.git/config', '[core]\n'), put('keys/id_rsa', 'SECRET_KEY\n'),
      put('node_modules/pkg/index.js', 'module.exports = 1;\n'), put('src/big.log', Buffer.alloc(102_400, 'x'))]);
    await symlink('/etc/hostname', join(f.project, 'src', 'outside.ts'));
    const ports = { find: findRuntimeWorkspaceFiles, attach: attachRuntimeWorkspaceFile }, options = { env: f.env };
    const props = {
      mentions: (query: string, signal: AbortSignal) => findTerminalMentions({ projectRoot: f.project, scopeId: 'scope', query, options, signal }, ports),
      attachMentions: (text: string, paths: readonly string[], signal: AbortSignal) => attachTerminalMentions({ projectRoot: f.project, scopeId: 'scope', text, paths, options, signal }, ports),
      streamTurn: (messages: readonly AgentTurnMessage[], signal: AbortSignal) => streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 'scope', messages, options, signal },
        { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn }),
      mentionDelayMs: 0,
    };
    return { f, props };
  }
  const DENIED = ['.env', 'config/.env.local', 'secrets.json', '.git/config', 'keys/id_rsa', 'node_modules/pkg/index.js', 'src/outside.ts'];
  const typeInto = async (view: ReturnType<typeof mountWorkline>, text: string) => { for (const char of text) { view.stdin.write(char); await new Promise(resolve => setTimeout(resolve, 3)); } };

  // OPEN-REASONING-FILE: `@file` uses the agent tools' deny floor for this layout (TL-C D4): approval records and whole pending diffs
  // under a data root inside the project are neither candidates nor attachable; other data files and the default layout's previews too.
  it('never offers or attaches approval records or approval previews of the layout, and still offers other files there', async () => {
    const f = await runtime({ dataInside: true });
    await mkdir(join(f.data, 'approvals'), { recursive: true, mode: 0o700 }); await mkdir(join(f.data, 'state', 'approval-previews'), { recursive: true, mode: 0o700 });
    await writeFile(join(f.data, 'approvals', 'held.txt'), 'owner-only approval record', { mode: 0o600 });
    await writeFile(join(f.data, 'state', 'approval-previews', 'diff.txt'), 'owner-only full diff', { mode: 0o600 });
    await writeFile(join(f.data, 'notes.txt'), 'ordinary data file', { mode: 0o600 });
    // TERM-FEEDBACK-1: a saved conversation is product state too (explicit limit: the owner no longer attaches one with `@`).
    await mkdir(join(f.data, 'state', 'terminal-sessions'), { recursive: true, mode: 0o700 });
    await writeFile(join(f.data, 'state', 'terminal-sessions', 'other.json'), '{}', { mode: 0o600 });
    await f.start();
    const held = '.deckent/live-data/approvals/held.txt', diff = '.deckent/live-data/state/approval-previews/diff.txt', session = '.deckent/live-data/state/terminal-sessions/other.json';
    for (const query of ['', 'held', 'diff', 'approval', 'live-data', 'other', 'sessions']) {
      const found = await f.client().findWorkspaceFiles({ schemaVersion: 1, scopeId: 'scope', query, limit: 50 });
      expect(found.paths).not.toContain(held); expect(found.paths).not.toContain(diff); expect(found.paths).not.toContain(session);
      expect(found.paths.some(path => path.startsWith('.deckent/live-data/state/') || path === '.deckent/live-data/policy.json')).toBe(false);
    }
    expect((await f.client().findWorkspaceFiles({ schemaVersion: 1, scopeId: 'scope', query: 'notes', limit: 50 })).paths).toContain('.deckent/live-data/notes.txt');
    for (const path of [held, diff, session]) {
      expect(await f.client().attachWorkspaceFile({ schemaVersion: 1, scopeId: 'scope', path, maxBytes: 1024 })).toEqual({ schemaVersion: 1, path, status: 'refused', reason: 'path-denied' });
    }
    expect(await f.client().attachWorkspaceFile({ schemaVersion: 1, scopeId: 'scope', path: '.deckent/live-data/notes.txt', maxBytes: 1024 }))
      .toMatchObject({ status: 'attached', content: 'ordinary data file' });
  }, 30_000);

  it('lists allowed workspace files for the picker and never a denied, ignored or linked one', async () => {
    const { f, props } = await workspace();
    const all = await f.client().findWorkspaceFiles({ schemaVersion: 1, scopeId: 'scope', query: '', limit: 50 });
    expect(all.paths).toEqual(expect.arrayContaining(['src/a.ts', 'src/app.ts', 'docs/environment.md', 'src/big.log']));
    for (const path of DENIED) expect(all.paths).not.toContain(path);
    for (const query of ['env', 'secret', 'id_rsa', 'git', 'index.js', 'outside']) {
      const found = await f.client().findWorkspaceFiles({ schemaVersion: 1, scopeId: 'scope', query, limit: 50 });
      for (const path of DENIED) expect(found.paths).not.toContain(path);
    }
    // Name matches rank before path matches; shallow and short paths first.
    expect((await f.client().findWorkspaceFiles({ schemaVersion: 1, scopeId: 'scope', query: 'a', limit: 3 })).paths.slice(0, 2)).toEqual(['src/a.ts', 'src/app.ts']);
    // A principal outside the scope gets nothing.
    await expect(f.client().findWorkspaceFiles({ schemaVersion: 1, scopeId: 'other', query: '', limit: 5 })).rejects.toBeDefined();
    expect((await f.client().attachWorkspaceFile({ schemaVersion: 1, scopeId: 'scope', path: 'src/outside.ts', maxBytes: 100 }))).toMatchObject({ status: 'refused', reason: 'path-outside-workspace' });

    const view = mountWorkline(props);
    try {
      await until(() => view.stdout.text.includes('READY'), 'ready');
      await typeInto(view, 'open @env');
      await until(() => view.stdout.text.includes('> @docs/environment.md'), 'allowed candidate offered by the service');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(view.stdout.text).not.toContain('@.env'); expect(view.stdout.text).not.toContain('.env.local');
    } finally { view.instance.unmount(); }
  }, 30_000);

  it('sends a picked file and a large file to the model bounded and labelled, and reports a denied one without its content', async () => {
    const { f, props } = await workspace();
    f.state.script = [{ content: 'Seen.' }];
    const view = mountWorkline(props);
    try {
      await until(() => view.stdout.text.includes('READY'), 'ready');
      await typeInto(view, 'explain @src/a');
      await until(() => view.stdout.text.includes('> @src/a.ts'), 'picker');
      await typeInto(view, '\r');
      await until(() => view.stdout.text.includes('> explain @src/a.ts |'), 'picked');
      await typeInto(view, 'and @src/big.log and @.env\r');
      await until(() => f.state.requests.length === 1 && view.stdout.text.includes('Seen.'), 'answered');
      const user = (f.state.requests[0]!['messages'] as { role: string; content: string }[]).at(-1)!;
      expect(user.role).toBe('user');
      expect(user.content.startsWith('explain @src/a.ts and @src/big.log and @.env\n\n')).toBe(true);
      expect(user.content).toContain('--- attached file src/a.ts (20 bytes) ---\nexport const a = 1;\n--- end of src/a.ts ---');
      expect(user.content).toContain(`--- attached file src/big.log (first 32768 of 102400 bytes; the rest was not attached) ---\n${'x'.repeat(32_768)}\n--- end of src/big.log ---`);
      expect(user.content).not.toContain('x'.repeat(32_769));
      expect(user.content).not.toContain('hunter2');
      await until(() => view.stdout.text.includes('@src/a.ts · 20 B') && view.stdout.text.includes('@src/big.log · 32768/102400 B')
        && view.stdout.text.includes('@.env · path-denied'), 'attachment notices');
    } finally { view.instance.unmount(); }
  }, 30_000);

  // Astra 2134 R3: a picked spaced name used to reach the service as its first word, so a file with that shorter name was sent instead.
  it('sends the content of the picked spaced file, never of the file named by its first word', async () => {
    const { f, props } = await workspace();
    await Promise.all([writeFile(join(f.project, 'src', 'a'), 'SHORT-NAME\n'), writeFile(join(f.project, 'src', 'a b.ts'), 'SPACED-NAME\n')]);
    f.state.script = [{ content: 'Seen.' }];
    const view = mountWorkline(props);
    try {
      await until(() => view.stdout.text.includes('READY'), 'ready');
      await typeInto(view, 'explain @"a b');
      await until(() => view.stdout.text.includes('> @"src/a b.ts"'), 'picker offers the spaced file quoted');
      await typeInto(view, '\t');
      await until(() => view.stdout.text.includes('> explain @"src/a b.ts" |'), 'picked');
      await typeInto(view, '\r');
      await until(() => f.state.requests.length === 1 && view.stdout.text.includes('Seen.'), 'answered');
      const user = (f.state.requests[0]!['messages'] as { role: string; content: string }[]).at(-1)!;
      expect(user.content).toContain('--- attached file src/a b.ts (12 bytes) ---\nSPACED-NAME\n--- end of src/a b.ts ---');
      expect(user.content).not.toContain('SHORT-NAME');
      await until(() => view.stdout.text.includes('@src/a b.ts · 12 B'), 'attachment notice');
    } finally { view.instance.unmount(); }
  }, 30_000);

  it('runs /help on Enter and /resume on Enter (its picker opens at once), then resumes the chosen conversation', async () => {
    const { f, props } = await workspace();
    await mkdir(join(f.data, 'sessions'), { mode: 0o700 });
    const sessions = bindSessionScope(openTerminalSessionStore(join(f.data, 'sessions')), 'scope');
    await sessions.save({ sessionId: '11111111-2222-4333-8444-555555555555', messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok', toolCalls: [] }] });
    const view = mountWorkline({ ...props, sessions });
    try {
      await until(() => view.stdout.text.includes('READY'), 'ready');
      await typeInto(view, '/hel');
      await until(() => view.stdout.text.includes('> /help'), 'palette');
      await typeInto(view, '\r');
      await until(() => view.stdout.text.includes('  /watch-runs\n  /watch-stop\n'), 'help ran (grouped, indented rows: T2 L3)');
      await typeInto(view, '/res');
      await until(() => view.stdout.text.includes('> /resume'), 'palette');
      await typeInto(view, '\r');
      // SLASH-WINDOWS: Enter on the palette row runs `/resume` at once (no completion that waits); the picker lists the conversations.
      await until(() => view.stdout.text.includes('SESSION 1 11111111 2 earlier'), 'picker opened by the first Enter');
      await typeInto(view, '\r');
      await until(() => view.stdout.text.includes('RESUMED 2 11111111'), 'resumed from the picker');
      await typeInto(view, '/clear\r');
      await until(() => view.stdout.text.includes('NEW-SESSION'), 'new session');
      await typeInto(view, '/resume\r');
      await until(() => view.stdout.text.includes('SESSION 1 11111111 2 earlier'), 'listed');
      expect(view.stdout.text).not.toContain('UNKNOWN');
    } finally { view.instance.unmount(); }
  }, 30_000);
});

// S11: a real turn through the service with Landlock chosen from injected capabilities (its own block: line bound of the main one).
describe.skipIf(process.platform !== 'linux')('agent shell in the Landlock realm (S11)', () => {
  it.skipIf(kernelLandlockAbi < 1)('S11 a sandbox that cannot be set up runs nothing: the effect is refused and the reason reaches the model', async () => {
    // The measured posture promises more than the kernel offers (a probe older than the kernel): the helper refuses before exec.
    {
      const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow'), shellRealm: 'require-sandbox', sandboxes: landlockOnly(kernelLandlockAbi + 1) }); await f.start();
      f.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"cat src/a.ts"}' } }, { content: 'Done.' }];
      const events: AgentTurnStreamEvent[] = [];
      await f.client().chatTurn(ask('turn-realm-landlock-setup'), event => events.push(event));
      expect(toolText(events)).toMatch(/^\[deckent\] run_shell: sandbox: landlock; spawn-failed after [\d.]+s \(cat src\/a\.ts\)\n\[deckent\] shell-sandbox: .*; nothing was run\.$/u);
      expect(toolText(events)).not.toContain('export const a');
      expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'host-shell', state: 'refused' }]);
    }
  });
  it.skipIf(kernelLandlockAbi < 1)('S11 prefer-sandbox with Landlock runs the command confined: realm named in preview and result, outside files unreadable', async () => {
    {
      const f = await runtime({ toolGrant: false, extraGrants: shellGrants('allow'), shellRealm: 'absent', sandboxes: landlockOnly(kernelLandlockAbi) }); await f.start();
      const outside = join(f.project, '..', 'home', 'secret.txt');
      await writeFile(outside, 'OUTSIDE_SECRET\n', { mode: 0o600 });
      f.state.script = [{ toolCall: { name: 'run_shell', arguments: '{"command":"cat src/a.ts"}' } },
        { toolCall: { name: 'run_shell', arguments: JSON.stringify({ command: `cat ${outside}` }) } }, { content: 'Done.' }];
      const events: AgentTurnStreamEvent[] = [], client = f.client(), pending: Promise<unknown>[] = [];
      await client.chatTurn(ask('turn-realm-landlock'), event => {
        events.push(event);
        if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, decisionCapability: event.decisionCapability,
          commandId: 'landlock-outside', expectedRevision: event.revision, decision: 'allow', reason: 'The sandbox must refuse it' }));
      });
      await Promise.all(pending);
      const texts = events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : []);
      expect(texts[0]).toMatch(/^\[deckent\] run_shell: sandbox: landlock; exit 0 after [\d.]+s \(cat src\/a\.ts\)\nexport const a = 1;\n$/u);
      expect(texts[1]).toMatch(/^\[deckent\] run_shell: sandbox: landlock; exit 1 /u);
      expect(texts[1]).toContain('Permission denied'); expect(texts[1]).not.toContain('OUTSIDE_SECRET');
      expect(events.find(event => event.kind === 'approval.requested')).toMatchObject({ preview: expect.stringContaining('Landlock') });
      expect(events.some(event => event.kind === 'tool.output' && event.text.includes('sandbox: none'))).toBe(false);
      expect(f.rows('SELECT target_kind, state FROM effect_intents')).toEqual([{ target_kind: 'host-shell', state: 'settled' }, { target_kind: 'host-shell', state: 'settled' }]);
    }
  });
});
