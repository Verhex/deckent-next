import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteAgentTurnStore, openSqliteModelActivationStore, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationTargetId } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { createPricedProviderTls, fixtureBudget, pricedProviderDefinition, replyPricedProviderMetadata } from '../../fixtures/priced-provider.js';

// Owner 2026-09-28 (LEDGER-SINGLETON; Astra 2145/2147 class finding): one runtime service per ledger. The start work that assumes
// "no live service of this installation" (ledger upgrade, closing running turns, settling open model calls of an ended owner,
// sweeping previews, expiring orphaned approvals) runs only under a custody bound to the ledger itself, not to the configurable
// endpoint: a second service started against the same ledger through another socket is refused before it touches anything.
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
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve() : new Promise<void>(done => child.once('exit', () => done()));

type Start = { ready: true; child: ChildProcess } | { ready: false; code: number | null; stdout: string; stderr: string };
/** `runtime serve --json` either reports ready or exits; both outcomes are returned, never guessed. */
async function serve(project: string, env: Record<string, string>): Promise<Start> {
  const child = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let stderr = '', stdout = '', buffer = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  return await bounded(new Promise<Start>(done => {
    child.once('exit', code => done({ ready: false, code, stdout, stderr }));
    child.stdout!.on('data', chunk => {
      stdout += String(chunk); buffer += String(chunk); const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) { try { if ((JSON.parse(line) as { event?: string }).event === 'ready') done({ ready: true, child }); } catch { /* JSON lines only. */ } }
    });
  }), 'RUNTIME_START_TIMEOUT');
}
async function started(project: string, env: Record<string, string>): Promise<ChildProcess> {
  const start = await serve(project, env);
  if (!start.ready) throw new Error(`RUNTIME_START_FAILED:${start.code}:${start.stdout.slice(-1024)}${start.stderr.slice(-1024)}`);
  return start.child;
}

async function installation() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-ledger-singleton-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }), mkdir(data, { mode: 0o700 }), mkdir(home, { mode: 0o700 })]);
  // The provider holds the calls named in `held` until released (or until their connection closes).
  const held = new Map<string, { seen: () => void; release?: () => void }>(), bodies: string[] = [];
  const hold = (name: string) => new Promise<void>(done => { held.set(name, { seen: done }); });
  const release = (name: string) => held.get(name)?.release?.();
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
      definition: pricedProviderDefinition(`https://127.0.0.1:${address.port}`, tls.caPem) }, allocation: { id: 'allocation', maxCalls: 8, maxInFlight: 1 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 2048, timeoutMs: 20_000 } };
  const configPath = join(project, '.deckent/config.json');
  const config = { layout: { root: data } as { root: string; resources?: Record<string, string> }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] }, provider_spending: fixtureBudget('scope'),
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 1_048_576, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 2000 } };
  /** The configured endpoint changes while the ledger stays the same one (`layout.resources.runtimeSocket`). */
  const useSocket = async (socket: string | null) => {
    if (socket) config.layout.resources = { runtimeSocket: socket }; else delete config.layout.resources;
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
  };
  await useSocket(null);
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
  const query = <T>(statement: string) => { const db = new DatabaseSync(ledger, { readOnly: true, timeout: 5_000 }); try { return db.prepare(statement).all() as T[]; } finally { db.close(); } };
  const invoke = async (commandId: string) => {
    const input = join(root, `${commandId}.json`); await writeFile(input, JSON.stringify(command(commandId)), { mode: 0o600 });
    const child = spawn(process.execPath, [cli, 'models', 'invoke', '--input', input, '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let stdout = '';
    child.stdout!.on('data', chunk => { stdout += String(chunk); });
    return new Promise<string>(done => child.once('exit', () => done(stdout)));
  };
  /** A running agent turn, as a live service holds one while it works. */
  const runningTurn = async (turnId: string) => {
    const store = await openSqliteAgentTurnStore(ledger, sqlite, 'forbid');
    try { await store.claim({ scopeId: 'scope', turnId, principalKey: 'host:1', requestDigest: 'a'.repeat(64), claimedAtMs: Date.now() }); }
    finally { store.close(); }
  };
  /** A kept full preview of a pending approval (swept at a start of the only service of this ledger). */
  const preview = async () => {
    const directory = join(data, 'state/approval-previews'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${'b'.repeat(64)}.txt`; await writeFile(join(directory, name), 'preview', { mode: 0o600 }); return name;
  };
  const previews = async () => { try { return await readdir(join(data, 'state/approval-previews')); } catch { return []; } };
  const backups = async () => { try { return await readdir(join(data, 'state/backups')); } catch { return []; } };
  return { project, data, env, ledger, useSocket, hold, release, held, invoke, runningTurn, preview, previews, backups,
    turns: () => query<{ turn_id: string; state: string }>('SELECT turn_id,state FROM agent_turns ORDER BY turn_id'),
    calls: () => query<{ command_id: string; state: string }>('SELECT command_id,state FROM model_invocations ORDER BY command_id'),
    counters: () => query<{ lifetime_calls: number; in_flight: number }>('SELECT lifetime_calls,in_flight FROM model_invocation_allocations')[0] };
}

it.skipIf(process.platform !== 'linux')('a second service on another endpoint of the same ledger is refused before it touches the live service\'s state', async () => {
  const f = await installation();
  const first = await started(f.project, f.env), seen = f.hold('live');
  const live = f.invoke('live');
  await bounded(seen, 'LIVE_CALL_NOT_AT_PROVIDER');
  await f.runningTurn('live-turn');
  const kept = await f.preview();
  expect(f.calls()).toEqual([{ command_id: 'live', state: 'claimed' }]);

  // Only the endpoint moves; the ledger is the one the live service is using.
  await f.useSocket('state/second.sock');
  const second = await serve(f.project, f.env);
  const observed = { secondReady: second.ready, firstAlive: first.exitCode === null && first.signalCode === null, providerCallHeld: f.held.has('live'),
    calls: f.calls(), counters: f.counters(), turns: f.turns(), previews: await f.previews(), backups: await f.backups() };
  expect(observed).toEqual({ secondReady: false, firstAlive: true, providerCallHeld: true,
    calls: [{ command_id: 'live', state: 'claimed' }], counters: { lifetime_calls: 1, in_flight: 1 },
    turns: [{ turn_id: 'live-turn', state: 'running' }], previews: [kept], backups: [] });
  if (second.ready) throw new Error('SECOND_SERVICE_STARTED');
  // Typed refusal; it names neither the other endpoint nor its path.
  expect(second.code).not.toBe(0);
  expect(`${second.stdout}${second.stderr}`).toContain('LOCAL_RUNTIME_ALREADY_RUNNING');
  expect(`${second.stdout}${second.stderr}`).not.toContain('runtime.sock');
  // The live service still owns its call: released at the provider, it records its own answer.
  f.release('live');
  await bounded(live, 'LIVE_CALL_TIMEOUT');
  expect(f.calls()).toEqual([{ command_id: 'live', state: 'responded' }]);
  expect(f.counters()).toEqual({ lifetime_calls: 1, in_flight: 0 });

  // Once the first service stops, the service on the other endpoint starts and reconciles the ledger under its custody.
  first.kill('SIGTERM'); await bounded(exited(first), 'FIRST_STOP_TIMEOUT');
  expect(first.exitCode).toBe(0);
  const next = await started(f.project, f.env);
  expect(f.turns()).toEqual([{ turn_id: 'live-turn', state: 'finished' }]);
  expect(await f.previews()).toEqual([]);
  next.kill('SIGTERM'); await bounded(exited(next), 'NEXT_STOP_TIMEOUT');
}, 90_000);

it.skipIf(process.platform !== 'linux')('after SIGKILL the kernel frees the ledger custody: a start on another endpoint and on the same endpoint reconciles', async () => {
  const f = await installation();
  const first = await started(f.project, f.env);
  await f.runningTurn('orphan-1');
  first.kill('SIGKILL'); await bounded(exited(first), 'FIRST_KILL_TIMEOUT');
  // Another endpoint of the same ledger.
  await f.useSocket('state/second.sock');
  const second = await started(f.project, f.env);
  expect(f.turns()).toEqual([{ turn_id: 'orphan-1', state: 'finished' }]);
  await f.runningTurn('orphan-2');
  second.kill('SIGKILL'); await bounded(exited(second), 'SECOND_KILL_TIMEOUT');
  // The same endpoint again (a stale endpoint file is left by the kill).
  const third = await started(f.project, f.env);
  expect(f.turns()).toEqual([{ turn_id: 'orphan-1', state: 'finished' }, { turn_id: 'orphan-2', state: 'finished' }]);
  // The lock file is the ledger's private companion, never the ledger itself.
  const lock = await readFile(`${f.ledger}-lock`);
  expect(lock.length).toBe(0);
  third.kill('SIGTERM'); await bounded(exited(third), 'THIRD_STOP_TIMEOUT');
}, 90_000);
