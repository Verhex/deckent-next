import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { createRuntimeChatTurnHost, runPeerConfiguredChatTurn, chatTurnRoundCommandId } from '#composition/core/agent-turn/index.js';
import { encodeModelBindingDefinition, agentTurnStreamEventSchema, type AgentTurnEvent, type AgentTurnMessage } from '#domain/index.js';
import { anthropicPublishedTariff, lookupOpenAiCompatibleTariff, openAiChatMessageFromInvocation, openAiChatNativeMessages,
  openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteProviderSpendIntegrityReader, openTerminalSessionStore, readLocalOsIdentity } from '#adapters/index.js';
import { type ModelInvocationResult, ModelActivationApplication, ModelBindingApplication, ModelInvocationControllers, modelInvocationProfileDigest, modelInvocationTargetId, runAgentTurn, verifyProviderSpendIntegrity } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

// Only the socket boundary is simulated. Production HTTP framing/evidence, native adapters, policy, activation, reservation,
// receipt, usage measurement and SQLite settlement all run. This proves fixture wiring, not TLS or vendor live acceptance.
const wire = vi.hoisted(() => ({ reply: (() => { throw new Error('UNSCRIPTED_NETWORK'); }) as (url: URL, body: string | undefined) => string, seen: [] as object[] }));
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request(url: URL, options: { method: string; headers: object }, callback: (value: EventEmitter) => void) {
    const req = new EventEmitter() as EventEmitter & { end(body?: string): void; destroy(): void };
    req.destroy = () => undefined;
    req.end = body => queueMicrotask(() => {
      try {
        const raw = wire.reply(url, body);
        wire.seen.push({ method: options.method, url: url.href, ...(body ? { body: JSON.parse(body) } : {}) });
        const incoming = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': raw.startsWith('data:') || raw.startsWith('event:') ? 'text/event-stream' : 'application/json' }, complete: true, destroy() {} });
        callback(incoming);
        // Multiple byte reads exercise retention and incremental assembly independently of TCP coalescing.
        const bytes = Buffer.from(raw);
        for (let offset = 0; offset < bytes.length; offset += 113) incoming.emit('data', bytes.subarray(offset, offset + 113));
        incoming.emit('end');
      } catch (error) { req.emit('error', error); }
    });
    return req;
  } };
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); wire.seen = []; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
const providers = {
  deepseek: { model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions' },
  zai: { model: 'glm-5.3', endpoint: 'https://api.z.ai/api/paas/v4/chat/completions' },
  openrouter: { model: 'anthropic/claude-sonnet-5.5', endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
  anthropic: { model: 'claude-sonnet-5-5', endpoint: 'https://api.anthropic.com/v1/messages' },
} as const;
// ORPRIVACY-STATUS: OpenRouter pricing also reads the official endpoint-level ZDR inventory; the fixture lists the selected Sonnet tag.
const zdrInventory = JSON.stringify({ data: [{ model_id: providers.openrouter.model, tag: 'anthropic' }] });
const metadataReply = (url: URL, metadata: string) => url.pathname === '/api/v1/endpoints/zdr' ? zdrInventory : metadata;
type Provider = keyof typeof providers;
const tool = { name: 'read', version: 1, toolClass: 'read' as const, description: 'Read fixture', inputSchema: { type: 'object' } };
const details = [{ type: 'reasoning.encrypted', data: 'opaque==', id: 'r1', format: 'anthropic-claude-v1', index: 0 },
  { type: 'reasoning.text', text: ' exact \n', signature: 'sig==', id: 'r2', index: 1 }];
const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 };
const sse = (type: string, value: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;

async function fixture(provider: Provider, cap = 65_536, allowActivate = true) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-w8-chain-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(data), mkdir(home)]);
  const { model: nativeId, endpoint } = providers[provider];
  const reference = { providerId: provider, providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const protocol = { family: provider === 'anthropic' ? 'anthropic-messages' : 'openai-chat-completions', version: provider === 'anthropic' ? '2023-06-01' : 'v1' };
  const model = { id: 'model', version: 1, nativeId, protocols: [{ ...protocol, capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }] }] };
  const catalog = { schemaVersion: 1, revision: 'catalog', providers: [{ id: provider, version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: provider, version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const tariff = provider === 'anthropic' ? anthropicPublishedTariff(nativeId) : provider === 'openrouter'
    ? { kind: 'openrouter-endpoint', version: 1, currency: 'USD', metadataEndpoint: `https://openrouter.ai/api/v1/models/${nativeId}/endpoints`, endpointTag: 'anthropic',
      metadataLimits: { maxAgeMs: 300_000, maxResponseBytes: 1_048_576, timeoutMs: 1000 } } : lookupOpenAiCompatibleTariff(endpoint, nativeId);
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest, protocol,
    adapter: { id: provider === 'anthropic' ? 'anthropic-messages-http' : 'openai-chat-http', version: provider === 'anthropic' ? 2 : 5,
      definition: { endpoint, maxOutputTokens: 1000, authentication: provider === 'anthropic' ? { type: 'header', name: 'x-api-key', credentialRef: 'FIXTURE_KEY' } : { type: 'bearer', credentialRef: 'FIXTURE_KEY' },
        tariff, ...(provider !== 'anthropic' ? { dialect: { tokenLimitField: 'max_tokens', streamUsage: 'omit', toolChoice: ['auto'], ...(provider === 'openrouter' ? { finalUsageChoice: 'repeat-finish' } : {}) } } : {}) } },
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 65_536, responseMaxBytes: cap, timeoutMs: 1000 } };
  const config = { layout: { root: data }, storage: { driver: 'sqlite', sqlite }, provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    provider_spending: { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 100_000 }] } };
  const configPath = join(project, '.deckent/config.json'); await writeFile(configPath, JSON.stringify(config));
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { ...readLocalOsIdentity(), scopeIds: ['scope', 'other'] };
  const activations = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), () => openSqliteModelActivationStore(ledger, sqlite), Date.now);
  await activations.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'invoke', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } },
    ...(allowActivate ? [{ id: 'activate', effect: 'allow', actions: ['activate'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }], resource: { kind: 'model-activation', ids: 'all' } }] : []),
  ] }), { mode: 0o600 });
  const options = { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' }, secretResolver: async () => 'fixture-key-only' };
  const command = (id: string, messages: readonly AgentTurnMessage[], streamed = true) => ({ schemaVersion: 1 as const, commandId: id, scopeId: 'scope', reference,
    catalogRevision: catalog.revision, expectedBinding: binding, nativeRequest: { model: nativeId, messages: openAiChatNativeMessages(messages, { scopeId: 'scope', reference, profileDigest: modelInvocationProfileDigest(profile as never) }),
      max_completion_tokens: 1000, stream: streamed, ...(streamed ? { stream_options: { include_usage: true } } : {}), tools: [{ type: 'function', function: { name: tool.name, parameters: tool.inputSchema } }], tool_choice: 'auto' } });
  const inspect = async (result: ModelInvocationResult) => {
    const reader = await openSqliteModelInvocationReader(ledger, { busyTimeoutMs: 1000 });
    try { return await reader.loadInspection('scope', result.receipt.claim.invocationId); } finally { reader.close(); }
  };
  return { root, project, options, command, inspect, config, configPath, catalog, activations, binding, reference, ledger };
}

function chatReply(provider: Provider, round: number, finish = round === 1 ? 'tool_calls' : 'stop', streamed = true) {
  const model = providers[provider].model;
  const reasoning = provider === 'deepseek' ? { reasoning_content: ` exact\n${round} ` } : provider === 'openrouter' ? { reasoning_details: details } : {};
  const calls = round === 1 ? [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] : [];
  const message = { role: 'assistant', content: round === 1 ? '' : 'answer', ...reasoning, ...(calls.length ? { tool_calls: calls } : {}) };
  if (!streamed) return JSON.stringify({ id: 'chat', created: 1, model, ...(provider === 'zai' ? {} : { object: 'chat.completion' }), choices: [{ index: 0, message, finish_reason: finish }], usage });
  const frame = (delta: object, reason: string | null = null, ownUsage = false) => `data: ${JSON.stringify({ id: 'chat', created: 1, model,
    ...(provider === 'zai' ? {} : { object: 'chat.completion.chunk' }), choices: [{ index: 0, delta, finish_reason: reason }], ...(ownUsage ? { usage } : {}) })}\n\n`;
  return frame({ ...message, ...(calls.length ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}) }) + frame({}, finish, true) + 'data: [DONE]\n\n';
}
function anthropicReply(round: number, ending?: string) {
  const blocks = round === 1 ? [{ type: 'thinking', thinking: 'exact thought', signature: 'sig==' }, { type: 'tool_use', id: 'call', name: 'read', input: {} }]
    : [{ type: 'text', text: 'answer' }];
  return sse('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: providers.anthropic.model, usage: { input_tokens: 100, output_tokens: 1 } } })
    + blocks.map((block, index) => sse('content_block_start', { index, content_block: { ...block, text: '', thinking: '', signature: '', input: {} } })
      + (block.type === 'thinking' ? sse('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } }) + sse('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } })
        : block.type === 'text' ? sse('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } }) : sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '{}' } }))
      + sse('content_block_stop', { index })).join('')
    + sse('message_delta', { delta: { stop_reason: round === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }) + (ending ?? sse('message_stop'));
}

describe.skipIf(process.platform === 'win32')('W8 fixture producer → history → documented request → durable spending', () => {
  it.each(Object.keys(providers) as Provider[])('%s: user → tool → result → follow-up → next user; final usage settles', async provider => {
    const f = await fixture(provider), events: AgentTurnEvent[] = [], results: ModelInvocationResult[] = [];
    const metadata = await readFile(new URL('../../fixtures/openrouter-endpoints/sonnet-endpoints.json', import.meta.url), 'utf8');
    let posts = 0;
    wire.reply = (url, body) => {
      if (!body) { expect(url.href).toContain('/endpoints'); return metadataReply(url, metadata); }
      const request = JSON.parse(body); posts++;
      if (posts >= 2) {
        if (provider === 'anthropic') {
          expect(request.messages[1].content).toEqual([{ type: 'thinking', thinking: 'exact thought', signature: 'sig==' }, { type: 'tool_use', id: 'call', name: 'read', input: {} }]);
          expect(request.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call' });
        } else {
          expect(request.messages[1].tool_calls[0]).toMatchObject({ id: 'call', function: { name: 'read' } }); expect(request.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call' });
          if (provider === 'deepseek') expect(request.messages[1].reasoning_content).toBe(' exact\n1 ');
          if (provider === 'openrouter') expect(request.messages[1].reasoning_details).toEqual(details);
        }
      }
      if (posts === 3 && provider === 'deepseek') expect(request.messages[3].reasoning_content).toBe(' exact\n2 ');
      return provider === 'anthropic' ? anthropicReply(posts) : chatReply(provider, posts);
    };
    const result = await runAgentTurn({ messages: [{ role: 'user', content: 'read fixture' }], tools: [tool], signal: new AbortController().signal, emit: event => events.push(event) }, {
      async invokeRound(input, onDelta) {
        const response = await invokeConfiguredModel(f.project, f.command(`round-${input.round}`, input.messages), f.options); results.push(response);
        const message = openAiChatMessageFromInvocation(response)!; onDelta({ kind: 'text', text: message.content });
        return { status: 'responded', ...message, finish: String(message.finish), usage: { promptTokens: 100, completionTokens: 10 } };
      }, authorize: async () => 'allow', describe: () => 'fixture', execute: async () => ({ status: 'ok', text: 'tool result' }), now: Date.now,
    });
    expect(result).toMatchObject({ finish: 'stop', rounds: 2, toolCalls: 1 }); expect(posts).toBe(2);
    const history: AgentTurnMessage[] = [{ role: 'user', content: 'read fixture' }, ...events.flatMap(event => event.kind === 'message' ? [event.message] : [])];
    const directory = join(f.root, 'sessions'); await mkdir(directory);
    const store = openTerminalSessionStore(directory), sessionId = '11111111-2222-4333-8444-555555555555';
    await store.save({ schemaVersion: 1, sessionId, scopeId: 'scope', updatedAtMs: 1, messages: history });
    const restartedStore = openTerminalSessionStore(directory), loaded = (await restartedStore.load('scope', sessionId))!;
    expect(loaded).toEqual(history);
    results.push(await invokeConfiguredModel(f.project, f.command('next-user', [...loaded, { role: 'user', content: 'continue' }]), f.options));
    expect(posts).toBe(3);
    for (const response of results) expect((await f.inspect(response))?.spending).toMatchObject({ disposition: { state: provider === 'openrouter' ? 'settled-provider-reported' : 'settled-measured-tariff' }, measurement: { basis: provider === 'openrouter' ? 'provider-reported' : 'measured-tariff' } });
    const reader = await openSqliteProviderSpendIntegrityReader(f.ledger, { busyTimeoutMs: 1000 });
    try { expect(await verifyProviderSpendIntegrity(reader, 'scope', 10)).toMatchObject({ reservationCount: 3, reservedMinorUnits: 0 }); } finally { reader.close(); }
  });

  it.each(['contradictory', 'malformed', 'clean-cut'] as const)('Anthropic retention-cap %s: cached measurement is held or settled correctly', async ending => {
    const f = await fixture('anthropic', 2048);
    wire.reply = () => anthropicReply(2, Array.from({ length: 200 }, () => sse('ping')).join('')
      + (ending === 'contradictory' ? sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 900 } }) : ending === 'malformed' ? 'data: {broken}\n\n' : ''));
    const response = await invokeConfiguredModel(f.project, f.command('retention', [{ role: 'user', content: 'hi' }]), f.options);
    expect(response.receipt.outcome?.state).toBe('unknown');
    expect((await f.inspect(response))?.spending).toMatchObject(ending === 'clean-cut' ? { disposition: { state: 'settled-measured-tariff' } }
      : { disposition: { state: 'held', reason: 'unknown' }, measurement: null });
  });

  it.each([
    ['zai', 'sensitive'], ['zai', 'model_context_window_exceeded'], ['zai', 'network_error'],
    ['deepseek', 'insufficient_system_resource'], ['deepseek', 'aborted'],
  ] as const)('%s %s: JSON and SSE keep final usage; without it the full reservation remains held', async (provider, reason) => {
    for (const streamed of [false, true]) for (const measured of [true, false]) {
      const f = await fixture(provider);
      wire.reply = () => {
        const raw = chatReply(provider, 2, reason, streamed);
        return measured ? raw : raw.replace(/,"usage":\{[^}]*\}/gu, '');
      };
      const result = await invokeConfiguredModel(f.project, f.command('finish', [{ role: 'user', content: 'hi' }], streamed), f.options);
      if (measured) {
        expect(result.receipt.outcome?.state).toBe('responded'); expect(openAiChatMessageFromInvocation(result)?.providerStop).toBeTruthy();
        expect((await f.inspect(result))?.spending).toMatchObject({ disposition: { state: 'settled-measured-tariff' } });
      } else expect((await f.inspect(result))?.spending).toMatchObject({ disposition: { state: 'held' }, measurement: null });
    }
  });

  it.each(Object.keys(providers) as Provider[])('%s: an empty assistant settles usage but never persists a rejected next-request shape', async provider => {
    const f = await fixture(provider), events: AgentTurnEvent[] = [];
    const metadata = await readFile(new URL('../../fixtures/openrouter-endpoints/sonnet-endpoints.json', import.meta.url), 'utf8');
    wire.reply = (url, body) => !body ? metadataReply(url, metadata) : provider === 'anthropic' ? anthropicReply(2).replace('"text":"answer"', '"text":""')
      : chatReply(provider, 2).replace('"content":"answer"', '"content":null');
    let result!: ModelInvocationResult;
    const turn = await runAgentTurn({ messages: [{ role: 'user', content: 'hi' }], tools: [tool], signal: new AbortController().signal, emit: event => events.push(event) }, {
      async invokeRound(input) {
        result = await invokeConfiguredModel(f.project, f.command('empty', input.messages), f.options);
        const message = openAiChatMessageFromInvocation(result)!;
        return { status: 'responded', ...message, finish: String(message.finish), usage: { promptTokens: 100, completionTokens: 10 } };
      }, authorize: async () => 'allow', describe: () => null, execute: async () => { throw new Error('NO_TOOL_EXPECTED'); }, now: Date.now,
    });
    expect(turn.finish).toBe('error'); expect(events.filter(event => event.kind === 'message')).toEqual([]);
    expect(events.filter(event => event.kind === 'usage')).toHaveLength(1);
    expect((await f.inspect(result))?.spending?.disposition.state).toContain('settled-');
    const directory = join(f.root, 'sessions'); await mkdir(directory); const store = openTerminalSessionStore(directory);
    const sessionId = '11111111-2222-4333-8444-555555555555';
    await store.save({ schemaVersion: 1, scopeId: 'scope', sessionId, updatedAtMs: 1,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [] }] });
    const history = (await store.load('scope', sessionId))!; expect(history).toEqual([{ role: 'user', content: 'hi' }]);
    wire.reply = (url, body) => !body ? metadataReply(url, metadata) : provider === 'anthropic' ? anthropicReply(2) : chatReply(provider, 2);
    expect((await invokeConfiguredModel(f.project, f.command('after-empty', [...history, { role: 'user', content: 'next' }]), f.options)).receipt.outcome?.state).toBe('responded');
  });

  it.each([true, false])('another scope binds after a global catalog change: current scope repairs only with activate authority (%s)', async allow => {
    const f = await fixture('deepseek', 65_536, allow); wire.reply = () => chatReply('deepseek', 2);
    f.catalog.revision = 'catalog-after-other-scope'; await writeFile(f.configPath, JSON.stringify(f.config)); clearConfigCache();
    await f.activations.admit({ schemaVersion: 1, action: 'activate', commandId: 'other-connect', scopeId: 'other', reference: f.reference,
      expectedRevision: 0, catalogRevision: f.catalog.revision, expectedBinding: f.binding });
    const command = f.command('scope-turn', [{ role: 'user', content: 'hi' }]);
    if (allow) {
      const result = await invokeConfiguredModel(f.project, command, f.options);
      expect(result.receipt.outcome?.state).toBe('responded'); expect(result.receipt.activationRevision).toBe(2);
      expect(result.receipt.request.catalogRevision).toBe('catalog-after-other-scope');
    } else {
      await expect(invokeConfiguredModel(f.project, command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' }); expect(wire.seen).toEqual([]);
    }
    const store = await openSqliteModelActivationStore(f.ledger, sqlite, 'forbid');
    try { expect(await store.loadRecord('other', f.reference)).toMatchObject({ state: 'active', revision: 1 });
      expect(await store.loadRecord('scope', f.reference)).toMatchObject({ state: 'active', revision: allow ? 2 : 1 }); } finally { store.close(); }
  });

  it('binding drift and deactivation refuse before repair or sending', async () => {
    for (const changed of ['binding', 'inactive']) {
      const f = await fixture('deepseek'); wire.reply = () => { throw new Error('MUST_NOT_SEND'); };
      if (changed === 'binding') f.catalog.providers[0]!.models[0]!.nativeId = 'changed-model' as never;
      else await f.activations.admit({ schemaVersion: 1, action: 'deactivate', commandId: 'deactivate', scopeId: 'scope', reference: f.reference,
        expectedRevision: 1, expectedBinding: f.binding });
      f.catalog.revision = 'changed'; await writeFile(f.configPath, JSON.stringify(f.config)); clearConfigCache();
      await expect(invokeConfiguredModel(f.project, f.command('refused', [{ role: 'user', content: 'hi' }]), f.options)).rejects.toMatchObject({ code: changed === 'binding' ? 'MODEL_INVOCATION_BINDING_CONFLICT' : 'MODEL_INVOCATION_ACTIVATION_CONFLICT' });
      expect(wire.seen).toEqual([]);
    }
  });

});

describe.skipIf(process.platform !== 'linux')('W8 production chat composition fixture', () => {
  it.each(Object.keys(providers) as Provider[])('%s: production chat composition emits and reloads the continuation, executes a real read tool and settles all rounds', async provider => {
    const f = await fixture(provider), history: AgentTurnMessage[] = [{ role: 'user', content: 'Read fixture' }];
    await writeFile(f.configPath, JSON.stringify({ ...f.config, terminal: { chat: { schemaVersion: 1, reference: f.reference, maxCompletionTokens: 1000 } } }));
    await writeFile(join(f.project, 'fixture.txt'), 'fixture tool result');
    const policyPath = join(f.root, 'data/policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.grants.push({ id: 'read-tool', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [{ issuer: readLocalOsIdentity().issuer, subject: readLocalOsIdentity().subject }], resource: { kind: 'agent-tool', ids: ['read_file'] } });
    await writeFile(policyPath, JSON.stringify(policy)); clearConfigCache();
    const controller = new AbortController(), host = createRuntimeChatTurnHost({ ownerId: 'fixture-runtime', controllers: new ModelInvocationControllers(2) }, controller.signal, undefined, undefined, () => []);
    // Trusted in-process peer-port input for this process/account; native SO_PEERCRED socket capture is outside fixture proof.
    const peer = { pid: process.pid, uid: process.getuid!(), gid: process.getgid!(), assurance: 'linux-so-peercred' as const, connection: controller.signal, isConnectionActive: () => true };
    const metadata = await readFile(new URL('../../fixtures/openrouter-endpoints/sonnet-endpoints.json', import.meta.url), 'utf8'); let posts = 0;
    wire.reply = (url, body) => {
      if (!body) return metadataReply(url, metadata);
      if (url.pathname.endsWith('/count_tokens')) return JSON.stringify({ input_tokens: 100 });
      const request = JSON.parse(body); posts++;
      if (posts >= 2) {
        const assistant = request.messages.find((message: { role: string }) => message.role === 'assistant');
        if (provider === 'deepseek') expect(assistant.reasoning_content).toBe(' exact\n1 ');
        if (provider === 'openrouter') expect(assistant.reasoning_details).toEqual(details);
        const result = request.messages.find((message: { role: string; content: unknown }) => message.role === 'tool' || (message.role === 'user' && Array.isArray(message.content)));
        expect(JSON.stringify(result)).toContain('fixture tool result');
        if (provider === 'anthropic') expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'exact thought', signature: 'sig==' });
      }
      return (provider === 'anthropic' ? anthropicReply(posts) : chatReply(provider, posts)).replaceAll('"name":"read"', '"name":"read_file"')
        .replaceAll(JSON.stringify('{}'), JSON.stringify(JSON.stringify({ path: 'fixture.txt' })));
    };
    const turn = (turnId: string, messages: readonly AgentTurnMessage[], emit: (event: AgentTurnEvent) => void) => runPeerConfiguredChatTurn(f.project,
      { schemaVersion: 1, scopeId: 'scope', turnId, sessionId: 'fixture-conversation', messages }, peer, f.options, { maxResultBytes: 65_536 }, host,
      { signal: controller.signal, drained: async () => undefined, emit: event => emit(agentTurnStreamEventSchema.parse(event)) });
    try {
      expect(await turn('production-1', history, event => { if (event.kind === 'message') history.push(event.message); })).toMatchObject({ finish: 'stop', toolCalls: 1, rounds: 2, recorded: true });
      const directory = join(f.root, 'production-sessions'); await mkdir(directory); const sessionId = '11111111-2222-4333-8444-555555555555';
      await openTerminalSessionStore(directory).save({ schemaVersion: 1, sessionId, scopeId: 'scope', updatedAtMs: 1, messages: history });
      const loaded = (await openTerminalSessionStore(directory).load('scope', sessionId))!; expect(loaded).toEqual(history);
      expect(await turn('production-2', [...loaded, { role: 'user', content: 'Next' }], () => undefined)).toMatchObject({ finish: 'stop', rounds: 1, recorded: true }); expect(posts).toBe(3);
      const reader = await openSqliteModelInvocationReader(f.ledger, { busyTimeoutMs: 1000 });
      try { for (const [turnId, round] of [['production-1', 1], ['production-1', 2], ['production-2', 1]] as const) {
        const record = (await reader.loadReceipt('scope', chatTurnRoundCommandId('scope', turnId, round)))!;
        expect((await reader.loadInspection('scope', record.receipt.claim.invocationId))?.spending?.disposition.state).toContain('settled-');
      } } finally { reader.close(); }
    } finally { controller.abort(); }
  });
});
