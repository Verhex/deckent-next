import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { anthropicPublishedTariff, openSqliteModelActivationStore } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { streamTerminalAgentTurn } from '#surfaces/core/terminal-turn/index.js';
import { inspectConfiguredModelInvocationCommand } from '#composition/core/model-invocation/index.js';
import { settledProviderCacheUsage } from '#engine/index.js';
import { chatTurnRoundCommandId } from '#composition/core/agent-turn/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createLocalTls } from '../../fixtures/local-tls.js';

// The terminal agent turn (governed rounds, per-call tool authorization, stream events) with Claude as the model: a real runtime
// service, a real https server speaking the Messages wire, no real API. The key reaches the send only by reference (environment here).
const roots: string[] = [], servers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const SECRET = 'sk-ant-api03-turn_secret-7', MODEL = 'claude-sonnet-5-5';
const reference = { providerId: 'anthropic', providerVersion: 1, modelId: 'sonnet', modelVersion: 1 };
const principal = { id: `os:${userInfo().uid}`, issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
const me = [{ issuer: principal.issuer, subject: principal.subject }];
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const sse = (type: string, payload: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const head = () => sse('message_start', { message: { id: 'msg_t', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 60, output_tokens: 1 } } });
const tail = (stop: string) => sse('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } }) + sse('message_stop');
const round1 = head() + sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
  + sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'need the file' } }) + sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG-TURN' } })
  + sse('content_block_stop', { index: 0 }) + sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_turn', name: 'read_file', input: {} } })
  + sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"src/a.ts"}' } }) + sse('content_block_stop', { index: 1 }) + tail('tool_use');
const round2 = head() + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'It exports ' } }) + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'a.' } })
  + sse('content_block_stop', { index: 0 }) + tail('end_turn');
const ask = (turnId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content: 'what does src/a.ts export?' }], ...extra });

async function runtime(capabilities: readonly string[] = ['tool-calls', 'chat-template-enable-thinking'], thinking: Record<string, unknown> = { mode: 'adaptive', display: 'summarized', off: 'between_tools' }) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-anthropic-turn-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(join(project, 'src'), { recursive: true }), mkdir(home, { mode: 0o700 }), mkdir(data, { mode: 0o700 })]);
  await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  const { key, caPem } = await createLocalTls(root);
  const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  const server = createServer({ key, cert: caPem }, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', (part: Buffer) => chunks.push(part));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(requests.length === 1 ? round1 : round2);
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const model = { id: 'sonnet', version: 1, nativeId: MODEL, protocols: [{ family: 'anthropic-messages', version: '2023-06-01', capabilities: capabilities.map(id => ({ id, version: 1, state: 'supported' })) }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'anthropic', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'anthropic', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1, id: 'claude', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'anthropic-messages', version: '2023-06-01' }, adapter: { id: 'anthropic-messages-http', version: 2,
      definition: { endpoint: `https://127.0.0.1:${address.port}/v1/messages`, maxOutputTokens: 256, tls: { caPem }, tariff: anthropicPublishedTariff(MODEL), thinking,
        authentication: { type: 'header', name: 'x-api-key', credentialRef: 'ANTHROPIC_API_KEY' } } },
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 2 }, limits: { requestMaxBytes: 262144, responseMaxBytes: 65536, timeoutMs: 5000 }, contextWindowTokens: 200_000 };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog,
    provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    provider_spending: { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 100_000 }] },
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 128 } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 262144, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4, maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 50 } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  await new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1)
    .admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0, catalogRevision: 'catalog-1', expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'], principals: me, resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me, resource: { kind: 'scope', ids: ['scope'] } },
    { id: 'read-tools', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['read_file', 'list_dir', 'grep', 'glob'] } }] }), { mode: 0o600 });
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', ANTHROPIC_API_KEY: SECRET };
  const service = await startConfiguredRuntimeService(project, { async onPage() {}, async onError() {} }, { env }, {});
  services.push(service);
  return { project, env, requests, client: () => createConfiguredRuntimeClient(project, { env }) };
}

describe.skipIf(process.platform !== 'linux')('agent chat turn with Claude through the runtime service', () => {
  it('runs a governed tool round with Messages wire, replays the thinking block in the same turn and streams reasoning and text', async () => {
    const f = await runtime();
    const events: AgentTurnStreamEvent[] = [];
    expect(await f.client().chatTurn(ask('turn-claude'), event => events.push(event))).toMatchObject({ finish: 'stop', rounds: 2 });
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) {
      expect(request.headers['x-api-key']).toBe(SECRET); expect(request.headers['authorization']).toBeUndefined();
      expect(request.headers['anthropic-version']).toBe('2023-06-01');
      expect(request.body).toMatchObject({ model: MODEL, stream: true, max_tokens: 128, tool_choice: { type: 'auto' }, thinking: { type: 'adaptive', display: 'summarized' } });
      expect(typeof request.body['system']).toBe('string'); const tools = request.body['tools'] as { name: string }[];
      expect(tools.map(tool => tool.name)).toContain('read_file'); expect(tools[0]).toHaveProperty('input_schema');
    }
    const second = f.requests[1]!.body['messages'] as unknown[];
    expect(second[1]).toMatchObject({ role: 'assistant', content: [{ type: 'thinking', thinking: 'need the file', signature: 'SIG-TURN' },
      { type: 'tool_use', id: 'toolu_turn', name: 'read_file', input: { path: 'src/a.ts' } }] });
    expect(second[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_turn', content: expect.stringContaining('export const a = 1') }] });
    const text = events.flatMap(event => event.kind === 'text' ? [event.text] : []).join('');
    expect(text).toContain('It exports a.');
    expect(events.some(event => event.kind === 'reasoning')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(SECRET); expect(JSON.stringify(events)).not.toContain('SIG-TURN');
  }, 30_000);

  it('switches reasoning off only through the profile-declared mode, and refuses it before any request when the catalog lacks the capability', async () => {
    const declared = await runtime();
    await declared.client().chatTurn(ask('turn-off', { reasoning: 'off' }), () => undefined);
    expect(declared.requests[0]!.body['thinking']).toEqual({ type: 'between_tools' });
    const missing = await runtime(['tool-calls']);
    await expect(missing.client().chatTurn(ask('turn-refused', { reasoning: 'off' }), () => undefined)).rejects.toMatchObject({ code: 'AGENT_TURN_REASONING_UNSUPPORTED' });
    expect(missing.requests).toHaveLength(0);
  }, 30_000);
});

it.skipIf(process.platform !== 'linux')('projects real settled Anthropic round dimensions through the unchanged runtime protocol', async () => {
  const f = await runtime();
  const deltas = [];
  for await (const delta of streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 'scope', reference, messages: ask('unused').messages, options: {} }, {
    chatTurn: (_root, command, onEvent) => f.client().chatTurn(command, onEvent),
    cancelChatTurn: (_root, command) => f.client().cancelChatTurn(command),
    settledUsage: async (root, command, round) => {
      const inspection = await inspectConfiguredModelInvocationCommand(root, { schemaVersion: 1, scopeId: command.scopeId,
        commandId: chatTurnRoundCommandId(command.scopeId, command.turnId, round), reference }, { env: f.env });
      expect(inspection?.invocationId).not.toBe(chatTurnRoundCommandId(command.scopeId, command.turnId, round));
      return settledProviderCacheUsage(inspection?.spending ?? null);
    },
  })) deltas.push(delta);
  const usages = deltas.filter(delta => delta.kind === 'usage');
  expect(usages).toHaveLength(2);
  for (const usage of usages) expect(usage).toMatchObject({ cache: { readTokens: 60, writeTokens: 10, promptTokens: 100 } });
  expect(deltas.at(-1)).toMatchObject({ kind: 'done', finish: 'stop' });
});
