import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { openSqliteModelActivationStore, type ShellSandboxFactory } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { createConfiguredRuntimeClient, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';

/**
 * Real runtime service (in process) for the permission-mode matrix (T-L4 slice 4a): a local OpenAI-chat fixture answers each round
 * with the next scripted tool call, and the company policy (v2) and the person's bindings (v2, `modes`) are real layout files read
 * through the file policy source, as in production.
 */
const roots: string[] = [], servers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
export async function closeModeRuntimes() {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
}
export const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const model = { id: 'chat', version: 1, nativeId: 'native-chat', protocols: [{ family: 'openai-chat-completions', version: 'v1',
  capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }] }] };
const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'local-openai', version: 1, models: [model] }] };
const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
export const principal = { id: `os:${userInfo().uid}`, issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
export const me = [{ issuer: principal.issuer, subject: principal.subject }];
/** A bindings v2 mode name (read through the v3 mapping since MODES-3), or a v3 entry. */
export type Mode = 'ask' | 'auto-edit' | 'full-auto' | { readonly mode: 'standart' | 'full-auto' | 'full-access'; readonly askEdits?: true };
type Effect = 'allow' | 'deny' | 'require-approval';

/** One company rule; `eligible` sets the policy v2 `modeEligible` flag (only meaningful on require-approval). */
export const rule = (id: string, kind: string, ids: string[], effect: Effect, eligible = false, actions = kind === 'operation' ? ['execute'] : ['invoke']) =>
  ({ id, effect, actions, scopes: ['scope'], principals: me, resource: { kind, ids }, ...(eligible ? { modeEligible: true } : {}) });
const baseGrants = [
  { id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'], principals: me,
    resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } },
  { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me, resource: { kind: 'scope', ids: ['scope'] } },
  { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];

export async function modeRuntime(input: { grants: Record<string, unknown>[]; mode: Mode | null;
  /** SHELL-AUTONOMY: the `terminal.shell` section (realm) and the sandbox providers (code-only port) when a test pins them. */
  shell?: Record<string, unknown>; sandboxes?: ShellSandboxFactory; dataRoot?: string }) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-modes-')); roots.push(root);
  const project = join(root, 'project'), data = input.dataRoot ? join(project, input.dataRoot) : join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(join(project, 'src'), { recursive: true }),
    mkdir(home, { mode: 0o700 })]);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
  // `sent`: every request body the model endpoint received, in order (PROMPT-POSTURE reads the sent system prompt).
  const state = { requests: 0, script: [] as { name: string; arguments: string }[], sent: [] as { messages: { role: string; content: string }[] }[] };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chatcmpl-turn',
    object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${JSON.stringify({ id: 'chatcmpl-turn', object: 'chat.completion.chunk', created: 1, model: 'native-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const body: Buffer[] = []; req.on('data', (part: Buffer) => body.push(part));
    req.on('end', () => {
      state.sent.push(JSON.parse(Buffer.concat(body).toString('utf8')) as (typeof state.sent)[number]);
      // Odd requests are the call round of a turn, even ones its closing round.
      const call = state.requests++ % 2 === 0 ? state.script.shift() : undefined;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts = call
        ? [chunk({ role: 'assistant', content: '' }), chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: call.name, arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: call.arguments } }] }), chunk({}, 'tool_calls'), usage, 'data: [DONE]\n\n']
        : [chunk({ role: 'assistant', content: 'Ok.' }), chunk({}, 'stop'), usage, 'data: [DONE]\n\n'];
      res.end(parts.join(''));
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
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 128 }, ...(input.shell ? { shell: input.shell } : {}) },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 262144, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 50 } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  await new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1)
    .admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0,
      catalogRevision: 'catalog-1', expectedBinding: binding });
  const writeAuthority = async (grants: Record<string, unknown>[], mode: Mode | null, revision = 'r1') => {
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 2, revision: `p-${revision}`, roles: [], separationOfDuties: [],
      restrictions: [], grants: [...baseGrants, ...grants] }), { mode: 0o600 });
    await writeFile(join(data, 'bindings.json'), JSON.stringify(mode === null ? { schemaVersion: 1, revision: `b-${revision}`, bindings: [] }
      : typeof mode === 'string' ? { schemaVersion: 2, revision: `b-${revision}`, bindings: [], modes: [{ id: 'me-mode', principal: me[0], scopes: ['scope'], mode }] }
        : { schemaVersion: 3, revision: `b-${revision}`, bindings: [], modes: [{ id: 'me-mode', principal: me[0], scopes: ['scope'], ...mode }] }), { mode: 0o600 });
  };
  await writeAuthority(input.grants, input.mode);
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const service = await startConfiguredRuntimeService(project, { async onPage() {}, async onError() {} }, { env }, input.sandboxes ? { shellSandboxes: input.sandboxes } : {});
  services.push(service);
  const rows = (sql: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const exec = (sql: string) => { const db = new DatabaseSync(ledger); try { db.exec(sql); } finally { db.close(); } };
  const client = createConfiguredRuntimeClient(project, { env });
  let turns = 0;
  /** One turn with one tool call; an approval card is answered with `decision` (default deny) so a card never runs anything. `fullAccess`:
   * the turn is launched in full access (MODES-3, v17 `chatTurn.fullAccess`). */
  const call = async (name: string, args: Record<string, unknown>, decision: 'allow' | 'deny' = 'deny', options: { readonly fullAccess?: boolean } = {}) => {
    state.script.push({ name, arguments: JSON.stringify(args) });
    const events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [], turnId = `turn-${++turns}`;
    await client.chatTurn({ schemaVersion: 1, scopeId: 'scope', turnId, messages: [{ role: 'user', content: 'go' }], ...(options.fullAccess ? { fullAccess: true as const } : {}) }, event => {
      events.push(event);
      // The harness answers as the terminal card of the turn it started: it forwards the turn's one-time capability (B1).
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId,
        commandId: `${decision}-${turnId}`, expectedRevision: event.revision, decision, reason: 'Reviewed', ...(event.decisionCapability ? { decisionCapability: event.decisionCapability } : {}) }));
    });
    await Promise.all(pending);
    const finished = events.find(event => event.kind === 'tool.finished');
    const text = events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : [])[0] ?? '';
    return { events, card: events.some(event => event.kind === 'approval.requested'), status: finished?.kind === 'tool.finished' ? finished.status : null, text, turnId };
  };
  const audit = () => rows('SELECT record FROM audit_events ORDER BY sequence').map(row => JSON.parse(String((row as { record: string }).record)) as
    { event: { eventId: string; policyRevision: string; principal: unknown; subject: Record<string, unknown> & { call: Record<string, unknown> } } });
  const counters = () => Object.fromEntries(rows('SELECT counter, count FROM audit_counters').map(row => [(row as { counter: string }).counter, (row as { count: number }).count]));
  return { project, data, ledger, rows, exec, call, audit, counters, writeAuthority, sent: state.sent, client, env,
    /** Queues the next turn's one tool call (for a test that drives `client.chatTurn` itself). */
    script: (name: string, args: Record<string, unknown>) => { state.script.push({ name, arguments: JSON.stringify(args) }); } };
}
