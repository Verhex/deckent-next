// EXT-SERVICE-ENTRY: a separate distribution consumes only public exports, with a Standard Schema adapter and durable target evidence.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const OVERLAY = `import { registerOperationAdapterModule, CORE_API_VERSION } from 'deckent/extensions';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const optionsSchema = { '~standard': { version: 1, vendor: 'smoke', validate: value =>
  value && typeof value.kind === 'string' && typeof value.log === 'string' ? { value } : { issues: [{ message: 'invalid options' }] } } };
registerOperationAdapterModule({ manifest: { schemaVersion: 1, module: { id: 'smoke.module', version: '1.0.0', tier: 'custom', namespace: 'smoke' },
  requires: { coreApi: { min: CORE_API_VERSION, max: CORE_API_VERSION } }, signature: null,
  provides: { targetAdapters: [{ adapterId: 'smoke.record', version: 1 }], operations: [{ schemaVersion: 1,
    operation: { id: 'smoke.post', version: 1 }, targetKind: 'smoke-record', effectClass: 'write', approval: 'policy',
    precondition: 'none', compensation: null, inputMaxBytes: 4096 }] } }, factories: { 'smoke.record': { optionsSchema, create: options => {
      const state = () => existsSync(options.log) ? JSON.parse(readFileSync(options.log, 'utf8')) : { writes: [] };
      return { kind: options.kind, identity: () => 'smoke-record@fixture', observe: async () => ({ version: null }),
        apply: async request => { const next = state(), version = String(next.writes.length + 1);
          next.writes.push({ key: request.idempotencyKey, input: request.input, version }); writeFileSync(options.log, JSON.stringify(next)); return { version }; },
        lookup: async (_target, key) => { const hit = state().writes.find(write => write.key === key);
          return hit ? { status: 'applied', version: hit.version } : { status: 'absent' }; } };
    } } } });
appendFileSync(new URL('./registrations.jsonl', import.meta.url), JSON.stringify({ pid: process.pid }) + '\\n');
`;

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

/** Isolated filesystem, real service transport, real MCP stdio and the same registered operation; no ERP/Enterprise feature claim. */
export async function checkExtensions({ root, base, node, env }) {
  const distribution = join(base, 'overlay-distribution'), project = join(distribution, 'project'), data = join(distribution, 'data');
  mkdirSync(join(distribution, 'node_modules'), { recursive: true, mode: 0o700 });
  symlinkSync(root, join(distribution, 'node_modules/deckent'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(distribution, 'package.json'), '{"type":"module","private":true}');
  writeFileSync(join(distribution, 'overlay.mjs'), OVERLAY);
  const cli = join(distribution, 'cli.mjs'), mcpEntry = join(distribution, 'mcp.mjs'), driver = join(distribution, 'driver.mjs');
  writeFileSync(cli, `import './overlay.mjs'; import { runCli } from 'deckent/extensions'; process.exitCode = await runCli();`);
  writeFileSync(mcpEntry, `import './overlay.mjs'; import { runMcp } from 'deckent/extensions'; await runMcp();`);
  // The bridge is a zero-dependency SDK consumer; the service is the operation owner.
  writeFileSync(driver, `import './overlay.mjs'; import { createConfiguredRuntimeClient } from 'deckent';
const client = createConfiguredRuntimeClient(process.cwd());
try { console.log(JSON.stringify(await (process.argv[2] === 'describeService' ? client.describeService()
  : client[process.argv[2]](JSON.parse(process.argv[3] ?? '{}'))))); }
catch (error) { console.log(JSON.stringify({ code: error.code ?? error.message })); process.exitCode = 2; }`);
  // W3-AUTHORITY: MCP calls run as the separate `<host>/mcp` actor; the operation rule names it explicitly, shutdown stays owner-only.
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }], withMcp = [...principals, { issuer: `${hostname()}/mcp`, subject: String(userInfo().uid) }], grants = [
    { id: 'ops', effect: 'allow', actions: ['execute', 'inspect'], scopes: ['smoke'], principals: withMcp, resource: { kind: 'operation', ids: ['smoke.post'] } },
    { id: 'service', effect: 'allow', actions: ['shutdown'], scopes: ['smoke'], principals, resource: { kind: 'service', ids: ['runtime'] } }];
  const config = { layout: { root: data }, runRuntime: { pollIntervalMs: 2147483647 },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['smoke'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { identity: { scopeId: 'smoke', serviceId: 'runtime' }, inputMaxBytes: 65536, responseMaxBytes: 65536,
      maxConnections: 8, maxConcurrentRequests: 4, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, responseTimeoutMs: 5000, shutdownGraceMs: 1000 },
    operations: { catalog: [], targets: [{ adapter: 'smoke.record', options: { kind: 'smoke-record', log: join(distribution, 'target.json') } }] } };
  mkdirSync(join(project, '.deckent'), { recursive: true, mode: 0o700 }); mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(project, '.deckent/config.json'), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'smoke-overlay', restrictions: [], grants }), { mode: 0o600 });
  const run = async (entry, args, cwd = project) => {
    try { const result = await exec(node, [entry, ...args], { cwd, env, timeout: 20_000 }); return { status: 0, ...result }; }
    catch (error) { return { status: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  };
  const bridge = async (method, input = {}, cwd = project) => {
    const result = await run(driver, [method, JSON.stringify(input)], cwd);
    try { return JSON.parse(result.stdout); } catch { throw new Error(`SDK_BRIDGE_FAILED:${JSON.stringify(result)}`); }
  };
  // Fixture provisioning only: seed an installed ledger using the existing storage composition helper (no Docker/worker needed).
  // The overlay, distribution entries and every tested request use public exports exclusively; this is not a customer installer test.
  const seed = join(distribution, 'seed.mjs');
  writeFileSync(seed, `import './overlay.mjs';
import { composeCore } from ${JSON.stringify(pathToFileURL(join(root, 'dist/composition/core/root/index.js')).href)};
import { openConfiguredAttemptStore } from ${JSON.stringify(pathToFileURL(join(root, 'dist/composition/core/storage/index.js')).href)};
composeCore(); (await openConfiguredAttemptStore(process.cwd())).store.close();`);
  const provision = async cwd => { const result = await run(seed, [], cwd); if (result.status !== 0) throw new Error(`FIXTURE_SEED_FAILED:${JSON.stringify(result)}`); };
  const children = [], detached = new Set(); let stderr = '';
  function child(entry, args, cwd = project) {
    const process = spawn(node, [entry, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise(done => { process.once('close', done); });
    children.push({ process, closed }); process.stderr.on('data', chunk => { stderr += String(chunk); }); return process;
  }
  async function start(entry, cwd = project) {
    const service = child(entry, ['runtime', 'serve', '--json'], cwd);
    await bounded(new Promise((done, reject) => { let stdout = '';
      service.stdout.on('data', chunk => { stdout += String(chunk); if (/"event":"ready"/u.test(stdout)) done(); });
      service.once('error', reject); service.once('close', code => reject(new Error(`SERVICE_EXIT:${code}:${stderr}`)));
    }), 20_000, 'SERVICE_READY_TIMEOUT');
    return service;
  }
  function peer(entry, cwd = project) {
    const process = child(entry, ['--project', cwd], cwd), waiting = new Map(); let buffer = '', id = 0;
    const fail = error => { for (const pending of waiting.values()) pending.reject(error); waiting.clear(); };
    process.once('error', fail); process.once('close', code => fail(new Error(`MCP_EXIT:${code}:${stderr}`)));
    process.stdout.on('data', chunk => { buffer += String(chunk); const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) { const reply = JSON.parse(line), pending = waiting.get(reply.id); if (pending) { waiting.delete(reply.id); pending.resolve(reply); } } });
    const send = value => process.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
    const request = (method, params) => { const requestId = ++id;
      const result = new Promise((resolve, reject) => { waiting.set(requestId, { resolve, reject }); send({ id: requestId, method, params }); });
      return bounded(result, 10_000, `MCP_TIMEOUT:${method}`).finally(() => waiting.delete(requestId)); };
    return { request, async initialize() { const reply = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'overlay-smoke', version: '1' } });
      if (!reply.result?.serverInfo) throw new Error(`MCP_INIT_FAILED:${JSON.stringify(reply)}`); send({ method: 'notifications/initialized' }); } };
  }
  const command = id => ({ schemaVersion: 1, commandId: id, scopeId: 'smoke', operation: { id: 'smoke.post', version: 1 },
    target: { kind: 'smoke-record', id: 'R-1' }, idempotencyKey: id, input: { note: id }, expectedVersion: null });
  const unpack = reply => reply.result?.structuredContent ?? JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
  const results = {};
  try {
    await provision(project);
    await start(cli);
    const first = await bridge('describeService');
    results.firstDescriptor = first;
    results.service = await bridge('executeOperation', command('via-service'));
    const mcp = peer(mcpEntry); await mcp.initialize();
    const tools = await mcp.request('tools/list', {});
    results.hints = tools.result?.tools.find(tool => tool.name === 'execute_operation')?.annotations;
    results.mcp = unpack(await mcp.request('tools/call', { name: 'execute_operation', arguments: command('via-mcp') }));
    results.replay = unpack(await mcp.request('tools/call', { name: 'execute_operation', arguments: command('via-mcp') }));
    results.denied = unpack(await mcp.request('tools/call', { name: 'execute_operation', arguments: { ...command('denied'), scopeId: 'elsewhere' } }));
    results.inspected = unpack(await mcp.request('tools/call', { name: 'inspect_operation', arguments: { schemaVersion: 1, scopeId: 'smoke', commandId: 'via-service' } }));
    // Negative: the owner-only shutdown rule does not reach the MCP actor.
    results.mcpShutdown = unpack(await mcp.request('tools/call', { name: 'shutdown_runtime_service', arguments: { schemaVersion: 1, commandId: 'mcp-shutdown',
      serviceId: 'runtime', instanceId: first.instanceId, reason: 'no MCP grant' } }));
    const restarted = await run(cli, ['runtime', 'restart', '--json']);
    if (restarted.status === 0) { const readiness = JSON.parse(restarted.stdout); if (Number.isSafeInteger(readiness.pid)) detached.add(readiness.pid); }
    results.restart = { status: restarted.status, stderr: restarted.stderr };
    const second = await bridge('describeService');
    results.secondDescriptor = second;
    if (second.processId !== first.processId && Number.isSafeInteger(second.processId)) detached.add(second.processId);
    results.restart.replaced = second.processId !== first.processId;
    results.afterRestart = await bridge('executeOperation', command('after-restart'));
    results.registrations = readFileSync(join(distribution, 'registrations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    results.restart.registered = results.registrations.some(entry => entry.pid === second.processId);
    results.writes = existsSync(join(distribution, 'target.json')) ? JSON.parse(readFileSync(join(distribution, 'target.json'), 'utf8')).writes : [];

    // An unregistered executable cannot silently accept the overlay's configured adapter, on either surface.
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const coreCli = join(root, manifest.bin.deckent), coreMcp = join(root, manifest.bin['deckent-mcp']);
    results.unregisteredService = await run(coreCli, ['runtime', 'serve', '--json']);
    results.unregisteredMcp = await run(coreMcp, ['--project', project]);
    // With an otherwise valid Core-only configuration, the missing operation also stays unavailable over service and MCP.
    const negative = join(distribution, 'negative'), negativeData = join(distribution, 'negative-data');
    mkdirSync(join(negative, '.deckent'), { recursive: true, mode: 0o700 }); mkdirSync(negativeData, { mode: 0o700 });
    writeFileSync(join(negative, '.deckent/config.json'), JSON.stringify({ ...config, layout: { root: negativeData }, operations: { catalog: [], targets: [] } }), { mode: 0o600 });
    writeFileSync(join(negativeData, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'negative', restrictions: [], grants }), { mode: 0o600 });
    await provision(negative);
    await start(coreCli, negative);
    results.absentService = await bridge('executeOperation', command('absent'), negative);
    const negativeMcp = peer(coreMcp, negative); await negativeMcp.initialize();
    results.absentMcp = unpack(await negativeMcp.request('tools/call', { name: 'execute_operation', arguments: command('absent-mcp') }));
    const ok = results.service.status === 'settled' && results.mcp.status === 'settled' && results.afterRestart.status === 'settled'
      && JSON.stringify(results.replay) === JSON.stringify(results.mcp) && results.denied.code === 'POLICY_DENIED' && results.mcpShutdown.code === 'POLICY_DENIED'
      && results.inspected.record?.state === 'settled' && results.hints?.readOnlyHint === false && results.hints?.destructiveHint === true
      && results.restart.status === 0 && results.restart.replaced && results.restart.registered && results.writes.length === 3
      && results.unregisteredService.status !== 0 && results.unregisteredService.stderr.includes('OPERATIONS_INVALID')
      && results.unregisteredMcp.status !== 0 && results.unregisteredMcp.stderr.includes('MCP_START_FAILED')
      && results.absentService.code === 'EFFECT_OPERATION_UNKNOWN' && results.absentMcp.code === 'EFFECT_OPERATION_UNKNOWN';
    return { ok, ...results };
  } finally {
    for (const { process } of children) if (process.exitCode === null) process.kill('SIGTERM');
    for (const pid of detached) { try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ } }
    await Promise.all(children.map(async ({ process, closed }) => {
      await bounded(closed, 5000, 'CHILD_CLOSE_TIMEOUT').catch(async () => { process.kill('SIGKILL'); await closed; });
    }));
    // Detached launch has no child handle; wait for absence before the caller removes its fixture.
    for (const pid of detached) for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(done => setTimeout(done, 50));
      if (attempt === 99) { try { process.kill(pid, 'SIGKILL'); } catch { /* stopped */ } }
    }
  }
}
