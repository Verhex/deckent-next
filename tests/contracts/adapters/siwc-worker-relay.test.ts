import { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transform } from 'esbuild';
import { DockerSupervisor } from '#adapters/core/docker-supervisor/index.js';
import { openSiwcWorkerRelay, stopSiwcWorker, assertSiwcWorkerLaunchable, siwcWorkerResultError, type SiwcUpstream, type SiwcRelayRecord } from '#adapters/core/siwc-worker/index.js';
import type { SandboxRequest } from '#engine/index.js';

// Source integration: the relay hashes its own standalone programs; tests mount esbuild transpilations of the exact candidate sources.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (path: Parameters<typeof actual.readFile>[0], ...args: unknown[]) => actual.readFile(typeof path === 'string' && /\/siwc-worker\/internal\/(bootstrap|helper)\.js$/u.test(path) ? path.slice(0, -3) + '.ts' : path, ...args as []) };
});
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close().catch(() => undefined); });

// Synthetic app-server stdio peer: reads its provider config from `-c` overrides exactly as handed to the real binary, runs the auth helper,
// sends Responses requests to the base URL, asks a command approval and (only when accepted) runs a tool child that attacks the boundary.
const FAKE_APP_SERVER = String.raw`
import { spawnSync } from 'node:child_process'; import { createInterface } from 'node:readline'; import { request } from 'node:http';
import { writeFileSync, readFileSync, existsSync } from 'node:fs'; import { createHash } from 'node:crypto';
const argv = process.argv.slice(2), mode = argv[0], config = {};
for (let i = 1; i < argv.length; i++) if (argv[i] === '-c') { const text = argv[++i], at = text.indexOf('='); config[text.slice(0, at)] = JSON.parse(text.slice(at + 1)); }
const base = config['model_providers.deckent_relay.base_url'], helper = [config['model_providers.deckent_relay.auth.command'], config['model_providers.deckent_relay.auth.args']];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const auth = () => { const run = spawnSync(helper[0], helper[1], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return run.status === 0 ? run.stdout.trim() : null; };
const post = (path, token, body) => new Promise(resolve => { const url = new URL(base + path), data = JSON.stringify(body);
  const call = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: 'Bearer ' + token } : {}) } },
    response => { let text = ''; response.on('data', part => { text += part; }); response.on('end', () => resolve({ status: response.statusCode, body: text })); });
  call.on('error', error => resolve({ status: 0, body: String(error.code) })); call.end(data); });
const body = (extra = {}) => ({ model: config.model, input: [{ role: 'user', content: 'hi' }], instructions: 'x', tools: [{ type: 'function', name: 'shell', parameters: {} }], store: false, stream: true, ...extra });
const pending = new Map(); let next = 100, token = null;
const ask = (method, params) => new Promise(resolve => { const id = next++; pending.set(id, resolve); send({ id, method, params }); });
async function turn() {
  const report = { mode }; token = auth(); report.capability = token !== null; report.cHash = token ? createHash('sha256').update(token).digest('hex') : null;
  if (mode === 'replay') token = readFileSync('/workspace/stolen.txt', 'utf8');
  report.first = await post('/responses', token, body());
  if (mode === 'shapes') { report.shapes = {}; for (const [name, extra] of Object.entries({ tool: { tools: [{ type: 'web_search' }] }, model: { model: 'other-model' }, field: { background: true }, store: { store: true } }))
    report.shapes[name] = (await post('/responses', token, body(extra))).status; report.files = (await post('/files', token, body())).status; }
  if (mode === 'leak') writeFileSync('/workspace/leaked.txt', token ?? '');
  if (mode === 'rotate') { report.second = await post('/responses', token, body()); report.reauth = auth() !== null; }
  if (mode === 'hold') { writeFileSync('/workspace/app.json', JSON.stringify(report)); return; }
  const approval = await ask('item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1', cwd: '/workspace', command: 'node /workspace/tool.mjs' });
  report.decision = approval.result?.decision ?? null;
  if (report.decision === 'accept') report.tool = spawnSync('node', ['/workspace/tool.mjs', JSON.stringify({ helper: helper[1], base, parent: process.pid })], { encoding: 'utf8' }).status;
  writeFileSync('/workspace/app.json', JSON.stringify(report));
  const failed = report.first.status !== 200 || (report.second && report.second.status !== 200);
  send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: failed ? 'failed' : 'completed', error: failed ? { message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } } : null } } });
}
createInterface({ input: process.stdin }).on('line', async line => { const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'synthetic' } });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_1' } } });
  else if (message.method === 'turn/start') { send({ id: message.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } }); void turn(); }
  else if (message.method === 'turn/interrupt') { const after = await post('/responses', token, body()); writeFileSync('/workspace/after.json', JSON.stringify(after));
    send({ id: message.id, result: {} }); send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'interrupted' } } }); }
}).on('close', () => process.exit(0));
`;
// Synthetic tool child (a native shell effect): tries to read ancestors' memory, re-run the auth helper, reach the host relay directly and the
// model shim without the capability, then scans every readable environ/cmdline and worker file for later absence checks.
const TOOL = String.raw`
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; import { request } from 'node:http';
const { helper, base, parent } = JSON.parse(process.argv[2]), out = { memory: {} };
for (const pid of [1, parent]) { try { readFileSync('/proc/' + pid + '/mem'); out.memory[pid] = 'read'; } catch (error) { out.memory[pid] = error.code; } }
const again = spawnSync('node', helper, { encoding: 'utf8' }); out.helper = { status: again.status, stdout: again.stdout };
let blob = '';
for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) for (const file of ['environ', 'cmdline']) { try { blob += readFileSync('/proc/' + pid + '/' + file, 'latin1') + '\n'; } catch {} }
const walk = dir => { for (const name of readdirSync(dir)) { const path = dir + '/' + name; try { const stat = statSync(path); if (stat.isDirectory()) walk(path); else if (stat.isFile() && stat.size < 4194304) blob += readFileSync(path, 'latin1') + '\n'; } catch {} } };
for (const dir of ['/tmp', '/workspace', '/run']) { try { walk(dir); } catch {} }
writeFileSync('/workspace/scan.bin', blob);
const call = (options, data) => new Promise(resolve => { const req = request(options, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', error => resolve(error.code)); req.end(data); });
out.relay = await call({ socketPath: '/run/deckent-relay.sock', method: 'POST', path: '/capability', headers: { 'content-length': '0' } });
const url = new URL(base + '/responses');
out.shim = await call({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-length': '2', authorization: 'Bearer ' + 'x'.repeat(43) } }, '{}');
out.hostRoot = existsSync(process.argv[3] ?? '/nonexistent-host-root');
writeFileSync('/workspace/effect.txt', 'native effect'); writeFileSync('/workspace/tool.json', JSON.stringify(out));
`;
const capabilityIn = (text: string, cHash: string | null) => !!cHash && [...text.matchAll(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu)].some(match => hash(match[0]) === cHash);

async function harness(mode: string, options: { approve?: boolean; upstream?: SiwcUpstream; leases?: string[]; workspaceFiles?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-siwc-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'work'); await mkdir(workspace);
  await writeFile(join(workspace, 'fake-app-server.mjs'), FAKE_APP_SERVER); await writeFile(join(workspace, 'tool.mjs'), TOOL);
  for (const [name, text] of Object.entries(options.workspaceFiles ?? {})) await writeFile(join(workspace, name), text);
  const artifacts: Record<string, { path: string; sha256: string }> = {};
  for (const name of ['bootstrap', 'helper']) {
    const code = (await transform(await readFile(new URL(`../../../src/adapters/core/siwc-worker/internal/${name}.ts`, import.meta.url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node24' })).code;
    const path = join(root, `${name}.mjs`); await writeFile(path, code, { mode: 0o600 }); artifacts[name] = { path, sha256: hash(code) };
  }
  const leases = options.leases ?? [`synthetic-access-A-${randomUUID()}`], upstreamSeen: { authorization: string; body: string }[] = [], records: SiwcRelayRecord[] = [];
  let leaseCount = 0;
  const upstream: SiwcUpstream = options.upstream ?? (async input => { upstreamSeen.push({ authorization: input.headers['authorization']!, body: input.body });
    // Reflects the upstream credential to prove the relay masks it before the worker sees the stream.
    return { status: 200, contentType: 'text/event-stream', body: (async function* () { yield Buffer.from(`data: {"type":"response.completed","echo":"${input.headers['authorization']}"}\n\n`); })() }; });
  const identity = { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test', generation: 1, layoutRevision: 'layout' };
  const relay = await openSiwcWorkerRelay({ directory: root, prompt: 'Do the task', deadlineMs: 60000, version: 'test', upstream,
    binding: { schemaVersion: 1, connectionId: randomUUID(), installationId: 'inst', companyId: 'co', person: { issuer: 'local', subject: 'person' }, attempt: identity,
      model: 'fixture-model', generations: { connection: 1, custody: 1, consent: 1 } },
    lease: async () => ({ accessToken: leases[Math.min(leaseCount++, leases.length - 1)]!, expiresAtMs: Date.now() + 3_600_000 }),
    approve: async () => options.approve ?? true, live: () => true, onRecord: record => records.push(record),
    appServer: { executable: 'node', args: ['/workspace/fake-app-server.mjs', mode] } });
  cleanups.push(relay.close);
  const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1, tmpBytes: 67108864, deadlineMs: 60000, controlTimeoutMs: 10000, outputBytes: 65536,
    relay: { ...relay.descriptor, bootstrapPath: artifacts['bootstrap']!.path, bootstrapSha256: artifacts['bootstrap']!.sha256, helperPath: artifacts['helper']!.path, helperSha256: artifacts['helper']!.sha256 } },
  undefined, { created: id => relay.bindContainer(id) });
  const request: SandboxRequest = { protocolVersion: 1, identity, workspace, argv: ['unused'] };
  cleanups.push(async () => { await supervisor.cancel(request); await supervisor.release(request); });
  const read = async (name: string) => readFile(join(workspace, name), 'utf8').catch(() => null);
  return { root, workspace, relay, supervisor, request, leases, upstreamSeen, records, read };
}

describe.skipIf(!imageId || process.platform !== 'linux')('SIWC worker relay with a synthetic app-server inside the pinned Docker image (U9-6/7)', () => {
  it('worker-app-server-capability-only: only the app-server gets C via its helper; tools get neither C nor A, nor the host relay (U9-6a, U9-7a)', async () => {
    const h = await harness('normal');
    const result = await h.supervisor.execute(h.request);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
    expect(await h.relay.outcome).toMatchObject({ status: 'completed', approvals: { accepted: 1, declined: 0 } });
    const app = JSON.parse((await h.read('app.json'))!), tool = JSON.parse((await h.read('tool.json'))!), scan = (await h.read('scan.bin'))!;
    expect(app).toMatchObject({ capability: true, first: { status: 200 }, decision: 'accept', tool: 0 });
    expect(Object.values(tool.memory)).toEqual(['EACCES', 'EACCES']);
    expect(tool).toMatchObject({ helper: { stdout: '' }, shim: 403, hostRoot: false }); expect(tool.helper.status).not.toBe(0); expect(tool.relay).not.toBe(200);
    expect(await h.read('effect.txt')).toBe('native effect');
    const A = h.leases[0]!, everything = [scan, result.stdout, result.stderr, JSON.stringify(h.records), app.first.body].join('\n');
    // The scan really covers the app-server's argv/environ (positive control) yet holds neither secret.
    expect(scan).toContain('deckent_relay'); expect(scan).toContain('CODEX_HOME=');
    expect(everything).not.toContain(A); expect(capabilityIn(everything, app.cHash)).toBe(false);
    expect(h.relay.statistics()).toMatchObject({ capabilityIssued: 1, capabilityRefused: 0, upstreamSends: 1, relayed: 1 });
    expect(h.relay.statistics().peersRefused).toBeGreaterThanOrEqual(1);
  }, 60000);

  it('host-bearer-model-relay: upstream sees A never C, the worker C never A; shapes, endpoints and a foreign Attempt\'s C refuse before send (U9-6b)', async () => {
    const leak = await harness('shapes');
    expect((await leak.supervisor.execute(leak.request)).result).toEqual({ kind: 'exited', exitCode: 0 });
    const app = JSON.parse((await leak.read('app.json'))!);
    expect(app.first.status).toBe(200); expect(app.first.body).toContain('[REDACTED]'); expect(app.first.body).not.toContain(leak.leases[0]!);
    expect(app.shapes).toEqual({ tool: 400, model: 400, field: 400, store: 400 }); expect(app.files).toBe(403);
    expect(leak.upstreamSeen).toHaveLength(1);
    expect(leak.upstreamSeen[0]!.authorization).toBe(`Bearer ${leak.leases[0]}`);
    expect(capabilityIn(JSON.stringify(leak.upstreamSeen), app.cHash)).toBe(false);
    expect(leak.records.filter(row => row.kind === 'model-refused').map(row => row.reason).sort()).toEqual(['model', 'shape', 'shape', 'tool']);
    // A capability exfiltrated from Attempt X is refused by Attempt Y's relay (bound to Y's own C, channel and peer).
    const x = await harness('leak'); await x.supervisor.execute(x.request);
    const stolen = (await x.read('leaked.txt'))!; expect(capabilityIn(stolen, JSON.parse((await x.read('app.json'))!).cHash)).toBe(true);
    const y = await harness('replay', { workspaceFiles: { 'stolen.txt': stolen } }); await y.supervisor.execute(y.request);
    expect(JSON.parse((await y.read('app.json'))!).first.status).toBe(401);
    expect(y.upstreamSeen).toHaveLength(0); expect(y.records).toContainEqual(expect.objectContaining({ kind: 'model-refused', reason: 'capability' }));
  }, 90000);

  it('app-server-bound-turn-lifecycle: host A rotates without entering the worker; an upstream 401 fails the turn and C is never re-issued or replayed (U9-6c)', async () => {
    let calls = 0;
    const h = await harness('rotate', { leases: [`synthetic-access-A1-${randomUUID()}`, `synthetic-access-A2-${randomUUID()}`], upstream: async input => {
      calls++; h.upstreamSeen.push({ authorization: input.headers['authorization']!, body: input.body });
      return calls === 1 ? { status: 200, contentType: 'text/event-stream', body: (async function* () { yield Buffer.from('data: {"type":"response.completed"}\n\n'); })() }
        : { status: 401, contentType: 'application/json', body: (async function* () { yield Buffer.from(`{"error":{"code":"invalid_token","echo":"${input.headers['authorization']}"}}`); })() };
    } });
    await h.supervisor.execute(h.request);
    const app = JSON.parse((await h.read('app.json'))!);
    expect(h.upstreamSeen.map(row => row.authorization)).toEqual(h.leases.map(lease => `Bearer ${lease}`));
    expect(app).toMatchObject({ first: { status: 200 }, second: { status: 401 }, reauth: false });
    expect(app.second.body).not.toContain(h.leases[1]!);
    expect(await h.relay.outcome).toMatchObject({ status: 'failed', reason: 'capability' });
    expect(siwcWorkerResultError(await h.relay.outcome, null)).toMatchObject({ code: 'SIWC_RELAY_REFUSED', params: { reason: 'capability' } });
    expect(h.relay.statistics()).toMatchObject({ capabilityIssued: 1, upstreamSends: 2 });
  }, 60000);

  it('native-tools-stay-in-worker: a declined approval runs no tool and leaves no effect (U9-7a)', async () => {
    const h = await harness('normal', { approve: false });
    await h.supervisor.execute(h.request);
    expect(JSON.parse((await h.read('app.json'))!)).toMatchObject({ decision: 'decline' });
    expect(await h.read('effect.txt')).toBeNull(); expect(await h.read('tool.json')).toBeNull();
    expect(await h.relay.outcome).toMatchObject({ approvals: { accepted: 0, declined: 1 } });
  }, 60000);

  it('worker-relay-stop-proof: revoke first, later sends fail, the container is stopped and the private socket removed; unproven kill stays visible (U9-7b)', async () => {
    const h = await harness('hold');
    const running = h.supervisor.execute(h.request);
    for (let i = 0; i < 200 && !(await h.read('app.json')); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const stop = await stopSiwcWorker({ reason: 'cancel', relay: h.relay, cancel: () => h.supervisor.cancel(h.request) });
    expect(stop).toMatchObject({ phase: 'stopped', reason: 'cancel', outcome: { status: 'interrupted' } });
    expect(JSON.parse((await h.read('after.json'))!).status).toBe(401);
    expect((await running).interrupted || (await running).result.kind === 'exited').toBe(true);
    await expect(lstat(h.relay.descriptor.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.relay.statistics()).toMatchObject({ revoked: 'cancel', upstreamSends: 1 });
    const unproven = await stopSiwcWorker({ reason: 'logout', relay: h.relay, cancel: () => Promise.reject(new Error('daemon unavailable')) });
    expect(unproven.phase).toBe('cleanup-unproven'); expect(siwcWorkerResultError(stop.outcome, unproven)?.code).toBe('SIWC_WORKER_CLEANUP_UNPROVEN');
    expect(siwcWorkerResultError(stop.outcome, stop)).toBeNull();
    expect(siwcWorkerResultError({ ...stop.outcome!, status: 'lost', approvals: { accepted: 1, declined: 0 } }, stop)?.code).toBe('SIWC_APP_SERVER_EFFECT_UNKNOWN');
  }, 60000);
});

it('launch gate: activation hold, missing Yama scope, foreign platform or a Codex-less image refuse typed with no fallback launch (U9-6a)', () => {
  const refusal = (input: Parameters<typeof assertSiwcWorkerLaunchable>[0]) => { try { assertSiwcWorkerLaunchable(input); return null; } catch (error) { return error as { code: string; params?: unknown }; } };
  expect(refusal({ platform: 'darwin', imageCodexVersion: '0.164.0', ptraceScope: 1 })).toMatchObject({ code: 'SIWC_WORKER_ISOLATION_UNAVAILABLE', params: { check: 'platform' } });
  expect(refusal({ platform: 'linux', imageCodexVersion: '0.164.0', ptraceScope: 0 })).toMatchObject({ code: 'SIWC_WORKER_ISOLATION_UNAVAILABLE', params: { check: 'ptrace-scope' } });
  expect(refusal({ platform: 'linux', imageCodexVersion: null, ptraceScope: 1 })).toMatchObject({ code: 'SIWC_APP_SERVER_AUTH_UNAVAILABLE', params: { reason: 'image-codex-missing' } });
  // Real activation stays held until the operator's real-binary proof: even a fully provable host refuses.
  expect(refusal({ platform: 'linux', imageCodexVersion: '0.164.0', ptraceScope: 1 })).toMatchObject({ code: 'SIWC_APP_SERVER_AUTH_UNAVAILABLE', params: { reason: 'activation-hold' } });
});
