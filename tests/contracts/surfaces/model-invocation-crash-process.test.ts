import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createPricedProviderTls, fixtureBudget, pricedProviderDefinition, replyPricedProviderMetadata } from '../../fixtures/priced-provider.js';

// Owner 2026-09-28 (FIX-2143-SLOTS): a service process killed while its model call is open leaves a `claimed` call holding a slot. The next
// start, under endpoint custody, settles that call `unknown` (spending hold kept, lifetime count unchanged) and frees the slot; an open
// call of any other, still-running owner is left as it is.
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'delete' as const, durability: 'full' as const };
const roots: string[] = [], servers: Server[] = [], children: ChildProcess[] = [], releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(done => child.once('exit', done)); }
  }
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function bounded<T>(work: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function startRuntime(project: string, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let stderr = '', buffer = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  await bounded(new Promise<void>((done, reject) => {
    child.once('exit', () => reject(new Error(`RUNTIME_START_FAILED:${stderr.slice(-2048)}`)));
    child.stdout!.on('data', chunk => {
      buffer += String(chunk); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) { try { if ((JSON.parse(line) as { event?: string }).event === 'ready') done(); } catch { /* JSON lines only. */ } }
    });
  }), 'RUNTIME_READY_TIMEOUT');
  return child;
}

/** One installation (project, data root, ledger, activation, policy) with a TLS provider that holds the calls named in `hold`. */
async function installation(maxInFlight: number) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-crash-process-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  // The provider holds the calls named in `held` until released (or until their connection closes).
  const held = new Map<string, { seen: () => void; release?: () => void }>(), seen = new Map<string, Promise<void>>(), bodies: string[] = [];
  const hold = (name: string) => { seen.set(name, new Promise<void>(done => { held.set(name, { seen: done }); })); return seen.get(name)!; };
  const tls = await createPricedProviderTls(root), provider = createServer({ key: tls.key, cert: tls.caPem }, (request, reply) => {
    if (replyPricedProviderMetadata(request, reply)) return;
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8'); bodies.push(body);
      const name = [...held.keys()].find(key => body.includes(`prompt-${key}`));
      if (name) {
        const entry = held.get(name)!;
        await new Promise<void>(done => { entry.release = done; releases.push(done); reply.once('close', done); entry.seen(); });
        held.delete(name);
      }
      if (reply.destroyed) return;
      reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify({ id: `response-${bodies.length}`, object: 'chat.completion',
        created: 1, model: 'vendor/model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done', refusal: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  servers.push(provider); await new Promise<void>((done, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', done); });
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const reference = { providerId: 'openrouter', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const model = { id: 'model', version: 1, nativeId: 'vendor/model', protocols: [{ family: 'openrouter-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog-1', providers: [{ id: 'openrouter', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'openrouter', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1 as const, id: 'local', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openrouter-chat-completions', version: 'v1' }, adapter: { id: 'openrouter-chat-http', version: 1,
      definition: pricedProviderDefinition(`https://127.0.0.1:${address.port}`, tls.caPem) }, allocation: { id: 'allocation', maxCalls: 8, maxInFlight },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 2048, timeoutMs: 20_000 } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_spending: fixtureBudget('scope'),
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 1_048_576, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 2000 } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const identity = readLocalOsIdentity(), principals = [{ issuer: identity.issuer, subject: identity.subject }];
  await new ModelActivationApplication({ async verify() { return { ...identity, scopeIds: ['scope'] }; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1)
    .admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference, expectedRevision: 0, catalogRevision: catalog.revision, expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [{ id: 'invoke', effect: 'allow',
    actions: ['invoke', 'inspect'], scopes: ['scope'], principals, resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } }] }), { mode: 0o600 });
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const command = (commandId: string) => ({ schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: catalog.revision,
    expectedBinding: binding, nativeRequest: { model: 'vendor/model', messages: [{ role: 'user', content: `prompt-${commandId}` }], max_completion_tokens: 4 } });
  const query = <T>(statement: string) => { const db = new DatabaseSync(ledger, { readOnly: true }); try { return db.prepare(statement).all() as T[]; } finally { db.close(); } };
  const counters = () => query('SELECT lifetime_calls,in_flight FROM model_invocation_allocations')[0];
  const states = () => query('SELECT command_id,state FROM model_invocations ORDER BY command_id');
  const invokeThroughService = async (commandId: string) => {
    const input = join(root, `${commandId}.json`); await writeFile(input, JSON.stringify(command(commandId)), { mode: 0o600 });
    const child = spawn(process.execPath, [cli, 'models', 'invoke', '--input', input, '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += String(chunk); }); child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>(done => child.once('exit', code => done({ code, stdout, stderr })));
    return { child, exited, done: exited.then(result => result.stdout) };
  };

  return { root, project, ledger, env, held, hold, bodies, command, query, counters, states, invokeThroughService };
}

it.skipIf(process.platform !== 'linux')('a killed service leaves its open call to the next start, which settles it unknown; a live owner keeps its call', async () => {
  const { project, env, held, hold, bodies, command, query, counters, states, invokeThroughService } = await installation(2);
  // 1. A call through the service is open at the provider when the service process is killed.
  const first = await startRuntime(project, env), crashSeen = hold('crash');
  const crashClient = await invokeThroughService('crash');
  await bounded(crashSeen, 'CRASH_CALL_NOT_AT_PROVIDER');
  first.kill('SIGKILL'); await bounded(new Promise(done => first.once('exit', done)), 'RUNTIME_KILL_TIMEOUT');
  crashClient.child.kill('SIGKILL'); await crashClient.done;
  expect(states()).toEqual([{ command_id: 'crash', state: 'claimed' }]);
  expect(counters()).toEqual({ lifetime_calls: 1, in_flight: 1 });
  // 2. Another owner's call (this test process, invoking directly) is open while the service starts again.
  const foreignSeen = hold('foreign');
  const foreign = invokeConfiguredModel(project, command('foreign'), { env });
  await bounded(foreignSeen, 'FOREIGN_CALL_NOT_AT_PROVIDER');
  expect(counters()).toEqual({ lifetime_calls: 2, in_flight: 2 });
  await startRuntime(project, env);
  // 3. The killed service's call settled unknown and its slot is free; the live owner's call and slot are untouched.
  expect(states()).toEqual([{ command_id: 'crash', state: 'unknown' }, { command_id: 'foreign', state: 'claimed' }]);
  expect(counters()).toEqual({ lifetime_calls: 2, in_flight: 1 });
  const [crash] = query<{ record: string }>("SELECT record FROM model_invocations WHERE command_id='crash'");
  expect(JSON.parse(crash!.record).outcome).toMatchObject({ state: 'unknown', reason: 'transport-error', evidence: null, content: null });
  const [spend] = query<{ record: string }>(`SELECT r.record FROM model_invocation_spend_reservations r JOIN model_invocations i
    ON i.scope_id=r.scope_id AND i.invocation_id=r.invocation_id WHERE i.command_id='crash'`);
  expect(JSON.parse(spend!.record).disposition).toMatchObject({ state: 'held', reason: 'unknown' });
  // 4. The freed slot admits a new call through the service, which answers; then the live owner's own answer settles its call.
  const after = await invokeThroughService('after');
  expect(JSON.parse(await bounded(after.done, 'AFTER_CALL_TIMEOUT'))).toMatchObject({ replayed: false, receipt: { outcome: { state: 'responded' } } });
  held.get('foreign')!.release!();
  expect(await bounded(foreign, 'FOREIGN_CALL_TIMEOUT')).toMatchObject({ receipt: { outcome: { state: 'responded' } } });
  expect(states()).toEqual([{ command_id: 'after', state: 'responded' }, { command_id: 'crash', state: 'unknown' }, { command_id: 'foreign', state: 'responded' }]);
  expect(counters()).toEqual({ lifetime_calls: 3, in_flight: 0 });
  // The provider saw each call exactly once: nothing was sent again.
  expect(bodies.filter(body => body.includes('prompt-crash'))).toHaveLength(1);
}, 60_000);

// Astra 2145 R1 (ported from astra-2144-custody.test.ts.txt): endpoint custody proves only that no service is alive on THAT endpoint,
// and the runtime socket is a configurable layout resource. Since LEDGER-SINGLETON (owner 2026-09-28) a second service on another
// socket over the same ledger is refused before any start work, so the live service's open call is neither settled nor freed.
it.skipIf(process.platform !== 'linux')('a service on another socket over the same ledger never settles a live service\'s open call (Astra 2145 R1)', async () => {
  const { project, env, held, hold, states, counters, query, invokeThroughService } = await installation(1);
  const first = await startRuntime(project, env), liveSeen = hold('live');
  const liveClient = await invokeThroughService('live');
  await bounded(liveSeen, 'LIVE_CALL_NOT_AT_PROVIDER');
  expect(states()).toEqual([{ command_id: 'live', state: 'claimed' }]);
  // Same ledger, second endpoint: only the runtime socket moves.
  const configPath = join(project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  config.layout.resources = { runtimeSocket: 'state/second.sock' };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await expect(startRuntime(project, env)).rejects.toThrow(/LOCAL_RUNTIME_ALREADY_RUNNING/);
  process.kill(first.pid!, 0);
  expect(first.exitCode === null && first.signalCode === null).toBe(true);
  expect(held.has('live')).toBe(true);
  expect(states()).toEqual([{ command_id: 'live', state: 'claimed' }]);
  expect(counters()).toEqual({ lifetime_calls: 1, in_flight: 1 });
  // The first service's own late answer is still written to its call.
  held.get('live')!.release!();
  expect(JSON.parse(await bounded(liveClient.done, 'LIVE_CALL_TIMEOUT'))).toMatchObject({ receipt: { outcome: { state: 'responded' } } });
  expect(states()).toEqual([{ command_id: 'live', state: 'responded' }]);
  expect(counters()).toEqual({ lifetime_calls: 1, in_flight: 0 });
  const [live] = query<{ record: string }>("SELECT record FROM model_invocations WHERE command_id='live'");
  expect(JSON.parse(live!.record).outcome).toMatchObject({ state: 'responded' });
}, 60_000);
