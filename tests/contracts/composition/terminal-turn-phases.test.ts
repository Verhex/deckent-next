import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import type { AgentTurnMessage } from '#domain/index.js';
import { openSqliteModelActivationStore } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { cancelRuntimeChatTurn, runRuntimeChatTurn, startConfiguredRuntimeService } from '#composition/core/runtime-service/index.js';
import { assertTerminalChatReady } from '#composition/core/terminal-chat/index.js';
import { streamTerminalAgentTurn, terminalCompactionExpected } from '#surfaces/core/terminal-turn/index.js';
import type { TurnDelta } from '#surfaces/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { fixtureBudget } from '../../fixtures/priced-provider.js';

// TL-A D1 without a protocol change (v15 stays): the terminal derives "summarizing" from the service's own `context` event and the
// engine's compaction rule. This is the parity proof against the real runtime service: a `context` delta is marked `compacting`
// exactly when the service then compacts (token pressure, byte pressure, room for the next request), and never otherwise.
const roots: string[] = [], servers: Server[] = [], services: Awaited<ReturnType<typeof startConfiguredRuntimeService>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) { await service.stop().catch(() => undefined); await service.done.catch(() => undefined); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const reference = { providerId: 'local-openai', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const principal = { id: `os:${userInfo().uid}`, issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
const me = [{ issuer: principal.issuer, subject: principal.subject }];
const SUMMARY = '{"objective":"o","findings":[],"decisions":[],"unresolved":[],"nextActions":[],"inspectedAreas":[]}';

async function runtime(options: { windowTokens?: number; count?: (messages: unknown[]) => number; maxCompletionTokens?: number } = {}) {
  const tokenCount = options.count !== undefined;
  const model = { id: 'chat', version: 1, nativeId: 'native-chat', protocols: [{ family: 'openai-chat-completions', version: 'v1',
    capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }, ...(tokenCount ? [{ id: 'token-count', version: 1, state: 'supported' }] : [])] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'local-openai', version: 1, models: [model] }] };
  const root = await mkdtemp(join(tmpdir(), 'deckent-turn-phases-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  const calls = { summary: 0, round: 0 };
  const server = createServer((req, res) => {
    const body: Buffer[] = []; req.on('data', part => body.push(part));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(body).toString('utf8')) as { messages: unknown[]; stream?: boolean };
      if (req.url === '/tokenize') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ count: options.count!(parsed.messages), max_model_len: 131072, tokens: [] })); return;
      }
      if (parsed.stream === false) {
        calls.summary++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'sum', object: 'chat.completion', created: 1, model: 'native-chat',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: SUMMARY } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
        return;
      }
      calls.round++;
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 1,
        model: 'native-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${chunk({ role: 'assistant', content: 'ok' })}${chunk({}, 'stop')}data: [DONE]\n\n`);
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const definition = { encodingVersion: 1 as const, provider: { id: 'local-openai', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
  const profile = { schemaVersion: 1, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, maxOutputTokens: 20_000, authentication: { type: 'none' }, tariff,
        ...(tokenCount ? { tokenizeEndpoint: `http://127.0.0.1:${address.port}/tokenize` } : {}) } },
    allocation: { id: 'allocation', maxCalls: null, maxInFlight: 2 }, limits: { requestMaxBytes: 262144, responseMaxBytes: 65536, timeoutMs: 5000 },
    ...(options.windowTokens ? { contextWindowTokens: options.windowTokens } : {}) };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_spending: fixtureBudget(),
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: options.maxCompletionTokens ?? 128 } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 262144, responseMaxBytes: 65536, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 50 } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  await new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1)
    .admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0, catalogRevision: 'catalog-1', expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'invoke', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: ['scope'], principals: me,
      resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me, resource: { kind: 'scope', ids: ['scope'] } }] }), { mode: 0o600 });
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  services.push(await startConfiguredRuntimeService(project, { async onPage() {}, async onError() {} }, { env }));
  const turn = async (messages: readonly AgentTurnMessage[]) => {
    const deltas: TurnDelta[] = [];
    for await (const delta of streamTerminalAgentTurn({ projectRoot: project, scopeId: 'scope', messages, options: { env } },
      { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn, preflight: assertTerminalChatReady })) deltas.push(delta);
    return deltas;
  };
  return { calls, turn, project, env };
}
const talk = (pairs: number, answerBytes = 0): AgentTurnMessage[] => [{ role: 'system', content: 'SYS' }, ...Array.from({ length: pairs * 2 }, (_, i) => i % 2
  ? { role: 'assistant' as const, content: `answer ${i} ${'b'.repeat(answerBytes)}`, toolCalls: [] } : { role: 'user' as const, content: `question ${i}` }),
{ role: 'user', content: 'and now?' }];
/** Each context delta's mark, and whether the service compacted right after it. */
function marks(deltas: readonly TurnDelta[]) {
  return deltas.flatMap((delta, index) => delta.kind === 'context'
    ? [{ compacting: delta.compacting === true, compacted: deltas.slice(index + 1).find(next => next.kind === 'context' || next.kind === 'compacted')?.kind === 'compacted' }] : []);
}

describe('summarizing is derived on the client exactly when the service compacts (TL-A D1, protocol v15 unchanged)', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] marks token pressure, and only the measurement before the summary; the same history under the mark is not marked', async () => {
    // 74 000 prompt tokens pass the 75 000 mark only with the whole reserve (128 completion + 2 048 safety): a drifted mirror is caught.
    const f = await runtime({ windowTokens: 100_000, count: messages => messages.length > 12 ? 74_000 : 900 });
    const compacting = await f.turn(talk(8));
    expect(marks(compacting)).toEqual([{ compacting: true, compacted: true }, { compacting: false, compacted: false }]);
    expect(f.calls.summary).toBe(1);
    const calm = await f.turn(talk(4));
    expect(marks(calm)).toEqual([{ compacting: false, compacted: false }]);
    expect(f.calls.summary).toBe(1);
  }, 30_000);

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] does not mark a full window when nothing older than the kept tail exists (the service cannot compact it)', async () => {
    const f = await runtime({ windowTokens: 100_000, count: () => 90_000 });
    const deltas = await f.turn(talk(2));
    expect(marks(deltas)).toEqual([{ compacting: false, compacted: false }]);
    expect(f.calls.summary).toBe(0);
  }, 30_000);

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] marks the service input bound when the window is unknown', async () => {
    const f = await runtime();
    const history = talk(20, 10_600);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(0.75 * 262_144);
    const deltas = await f.turn(history);
    expect(marks(deltas)[0]).toEqual({ compacting: true, compacted: true });
    expect(f.calls.summary).toBe(1);
  }, 30_000);

  it.skipIf(process.platform !== 'linux')("[requires Linux local runtime socket] marks the room the next request needs (this round's longest answer and one user message), as the service computes it", async () => {
    const f = await runtime({ maxCompletionTokens: 16_384 });
    const history = talk(20, 9_540);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(0.75 * 262_144);
    const deltas = await f.turn(history);
    expect(marks(deltas)[0]).toEqual({ compacting: true, compacted: true });
    // Just under that room: neither side compacts.
    const g = await runtime({ maxCompletionTokens: 128 });
    expect(marks(await g.turn(history))).toEqual([{ compacting: false, compacted: false }]);
    expect(g.calls.summary).toBe(0);
  }, 30_000);
});

// COMPOSITION-BUDGET: the service and the terminal read one admission formula (engine `agentTurnAdmission`), not a mirrored copy.
// The parity test above cannot see a drift of that one source (both sides move together), so each side is pinned on its own here:
// changing that safety reserve turns both of these red, which a client-side copy would not.
describe('one admission formula for the service and the terminal (engine agentTurnAdmission)', () => {
  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] service: 74 000 of 100 000 prompt tokens are summarized only because the whole reserve (128 + 2 048) is kept free', async () => {
    const f = await runtime({ windowTokens: 100_000, count: messages => messages.length > 12 ? 74_000 : 900 });
    const deltas = await f.turn(talk(8));
    expect(f.calls.summary).toBe(1);
    expect(deltas.some(delta => delta.kind === 'compacted')).toBe(true);
  }, 30_000);

  it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] terminal: the admission it derives from the configuration is the same formula, whatever the service does', async () => {
    const f = await runtime({ windowTokens: 100_000, count: () => 900 });
    const admission = await assertTerminalChatReady(f.project, { env: f.env });
    expect(admission).toEqual({ outputReserveTokens: 128, safetyReserveTokens: 2_048, requestMaxBytes: 262_144, requestReserveBytes: 128 * 4 + 32_768,
      completionLimitTokens: 128 });
    const history = talk(8);
    expect(terminalCompactionExpected(history, { promptTokens: 74_000, windowTokens: 100_000 }, admission)).toBe(true);
    expect(terminalCompactionExpected(history, { promptTokens: 72_000, windowTokens: 100_000 }, admission)).toBe(false);
  }, 30_000);
});
