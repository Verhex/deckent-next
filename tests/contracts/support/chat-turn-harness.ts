import { createHash } from 'node:crypto';
import { createTerminalRuntimeClient } from './terminal-runtime-client.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, type HttpFetchTransport, type ShellSandboxFactory } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';

// A real runtime service over a project, a scripted local OpenAI-compatible model and a real policy file (copied from the
// runtime-chat-turn harness for the SCR-A scratch tests, with the `terminal.scratch` and `terminal.shell` sections as options).
const roots: string[] = [], servers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
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
export const principal = { id: `os:${userInfo().uid}`, issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
export const me = [{ issuer: principal.issuer, subject: principal.subject }];

export type Script = { toolCall?: { name: string; arguments: string }; content?: string; hold?: boolean; summary?: string; status?: number;
  /** TRUNCATED-TOOLCALL: the usage chunk's completion count (default 8); the fixture's `maxCompletionTokens` is 128. */
  completionTokens?: number };
export async function runtime(options: { toolGrant?: boolean | 'approval'; tokenize?: boolean; windowTokens?: number; countedTokens?: number;
  /** Seedless connection fixture: a free GET, separate from every model call. */
  modelList?: () => readonly string[];
  /** Config/catalog tests use an injected discovery transport and need no listener or runtime start. */
  noServer?: boolean;
  count?: (body: { messages: unknown[] }) => number; approvalTtlMs?: number; extraGrants?: Record<string, unknown>[];
  /** TL-C: the catalog declares the thinking switch; the data root lies inside the project (like the live `.deckent/live-data`). */
  thinkingSwitch?: boolean; dataInside?: boolean;
  /** Astra 2162: the data root at this project-relative path (e.g. under the ignored `.cache`). */
  dataRoot?: string;
  /** SCR-A: the `terminal.scratch` and `terminal.shell` sections, when a test sets them. */
  scratch?: Record<string, unknown>; shell?: Record<string, unknown>;
  /** FETCH: the `terminal.fetch` section, and the test-only transport handed to the in-process service (never config or env). */
  fetch?: Record<string, unknown>; fetchTransport?: HttpFetchTransport;
  /** S9/S11: the sandbox providers a shell call may pick (code-only port); `() => []` is the "no sandbox mechanism usable" host. */
  sandboxes?: ShellSandboxFactory;
  /** LANG-CRASH: the service's own locale (its environment); absent = no locale in the environment (English). */
  serviceLanguage?: string } = {}) {
  const model = modelWith(options.tokenize === true, options.thinkingSwitch === true), catalog = catalogWith(options.tokenize === true, options.thinkingSwitch === true);
  const root = await mkdtemp(join(tmpdir(), 'deckent-chat-turn-')); roots.push(root);
  const project = join(root, 'project'), data = options.dataRoot ? join(project, options.dataRoot) : options.dataInside ? join(project, '.deckent', 'live-data') : join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(join(project, 'src'), { recursive: true }), mkdir(home, { mode: 0o700 })]);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  const state = { requests: [] as Record<string, unknown>[], raw: [] as string[], tokenize: [] as Record<string, unknown>[], script: [] as Script[], closed: 0 };
  // The answering model echoes the requested one (T4-B: a connected seed model is served by the same scripted server).
  let served = 'native-chat';
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chatcmpl-turn',
    object: 'chat.completion.chunk', created: 1, model: served, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usageOf = (completion = 8) => `data: ${JSON.stringify({ id: 'chatcmpl-turn', object: 'chat.completion.chunk', created: 1, model: served, choices: [],
    usage: { prompt_tokens: 20, completion_tokens: completion, total_tokens: 20 + completion } })}\n\n`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const body: Buffer[] = []; req.on('data', part => body.push(part));
    req.on('end', () => {
      if (options.modelList && req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: options.modelList().map(id => ({ id })) })); return;
      }
      if (req.url === '/tokenize') {
        state.tokenize.push(JSON.parse(Buffer.concat(body).toString('utf8')) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' });
        const counted = JSON.parse(Buffer.concat(body).toString('utf8')) as { messages: unknown[] };
        res.end(JSON.stringify({ count: options.count ? options.count(counted) : options.countedTokens ?? 500, max_model_len: 131072, tokens: [] })); return;
      }
      state.raw.push(Buffer.concat(body).toString('utf8'));
      state.requests.push(JSON.parse(Buffer.concat(body).toString('utf8')) as Record<string, unknown>);
      served = typeof state.requests.at(-1)!['model'] === 'string' ? state.requests.at(-1)!['model'] as string : 'native-chat';
      const step = state.script[state.requests.length - 1] ?? { content: 'no script' };
      if (step.status !== undefined) {
        // A provider rejection shaped like the owner's vLLM answer to a lone surrogate (SURROGATE-CUT 2026-09-30).
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]',
          type: 'BadRequestError', param: null, code: step.status } })); return;
      }
      if (step.summary !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-sum', object: 'chat.completion', created: 1, model: served,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: step.summary } }],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } })); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.on('close', () => { state.closed++; });
      const usage = usageOf(step.completionTokens);
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
  let address: { port: number } = { port: 8000 };
  if (!options.noServer) {
    servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const listening = server.address(); if (!listening || typeof listening === 'string') throw new Error('FIXTURE_ADDRESS');
    address = listening;
  }
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
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 128 }, ...(options.scratch ? { scratch: options.scratch } : {}),
      ...(options.shell ? { shell: options.shell } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) },
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
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', ...(options.serviceLanguage ? { DECKENT_LANGUAGE: options.serviceLanguage } : {}) };
  const interrupted: unknown[] = [], swept: unknown[] = [], released: unknown[] = [], scratchSwept: unknown[] = [];
  const start = async (observed = true) => {
    const service = await startConfiguredRuntimeService(project, observed ? { async onPage() {}, async onError() {},
      onAgentTurnsInterrupted(result) { interrupted.push(result); }, onToolCallApprovalsExpired(result) { swept.push(result); },
      onModelAllocationSlotsReleased(result) { released.push(result); }, onScratchSwept(result) { scratchSwept.push(result); } }
      : { async onPage() {}, async onError() {} }, { env }, { ...(options.fetchTransport ? { fetchTransport: options.fetchTransport } : {}), ...(options.sandboxes ? { shellSandboxes: options.sandboxes } : {}) });
    services.push(service); return service;
  };
  const rows = (sql: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const writePolicy = (next: unknown[]) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: `r-${next.length}`, restrictions: [], grants: next }), { mode: 0o600 });
  return { project, data, env, state, rows, ledger, start, interrupted, swept, released, scratchSwept, grants, writePolicy, binding, client: (headless = false) => headless ? createConfiguredRuntimeClient(project, { env }) : createTerminalRuntimeClient(project, { env }) };
}
