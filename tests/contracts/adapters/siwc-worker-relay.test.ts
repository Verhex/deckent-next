import { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transform } from 'esbuild';
import { DockerSupervisor, dockerTaskHiddenPaths } from '#adapters/core/docker-supervisor/index.js';
import { compileNativeCodingDockerProfile } from '#adapters/core/native-coding/index.js';
import { openSiwcWorkerRelay, stopSiwcWorker, assertSiwcWorkerLaunchable, siwcWorkerResultError, siwcWorkerConnections, bindSiwcWorker, siwcWorkerTurn, SiwcWorkerSupervisor,
  type SiwcUpstream, type SiwcRelayRecord, type SiwcNativeApproval, type SiwcRelayAuditSubject } from '#adapters/core/siwc-worker/index.js';
import { auditEventSchema, instructionSurfacePaths, readWorkerFinalReport } from '#domain/index.js';
import { inactivityWatch, type SandboxRequest } from '#engine/index.js';

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
import { spawn, spawnSync } from 'node:child_process'; import { createServer, request } from 'node:http';
import { writeFileSync, readFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
const argv = process.argv.slice(2), mode = argv[0], config = {}, flag = name => argv[argv.indexOf(name) + 1];
for (let i = 1; i < argv.length; i++) if (argv[i] === '-c') { const text = argv[++i], at = text.indexOf('='); config[text.slice(0, at)] = JSON.parse(text.slice(at + 1)); }
const base = config['model_providers.deckent_relay.base_url'], helper = [config['model_providers.deckent_relay.auth.command'], config['model_providers.deckent_relay.auth.args']];
// Control: loopback WebSocket that accepts only the bearer whose SHA-256 is on argv (as --ws-auth capability-token --ws-token-sha256).
const listen = new URL(flag('--listen')), tokenSha256 = flag('--ws-token-sha256'); let peer = null, rx = Buffer.alloc(0);
const frame = text => { const data = Buffer.from(text), head = data.length < 126 ? Buffer.from([0x81, data.length]) : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255]) : null;
  if (!head) throw new Error('frame'); return Buffer.concat([head, data]); };
const send = message => peer?.write(frame(JSON.stringify(message)));
const control = createServer((_req, res) => res.writeHead(404).end());
control.on('upgrade', (req, socket) => {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (peer || !bearer || createHash('sha256').update(bearer).digest('hex') !== tokenSha256) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n'); peer = socket;
  socket.on('data', part => { rx = Buffer.concat([rx, part]);
    for (;;) { if (rx.length < 2) return; let len = rx[1] & 127, at = 2; if (len === 126) { len = rx.readUInt16BE(2); at = 4; } else if (len === 127) { len = Number(rx.readBigUInt64BE(2)); at = 10; }
      if (rx.length < at + 4 + len) return; const mask = rx.subarray(at, at + 4), data = Buffer.from(rx.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ mask[i % 4]), op = rx[0] & 15; rx = rx.subarray(at + 4 + len);
      if (op === 8) { socket.end(); process.exit(0); } if (op === 1) void onLine(data.toString()); } });
  socket.on('close', () => process.exit(0));
});
control.listen(Number(listen.port), '127.0.0.1');
const auth = (command = helper) => { const run = spawnSync(command[0], command[1], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return run.status === 0 && run.stdout.trim() ? run.stdout.trim() : null; };
const post = (path, token, body) => new Promise(resolve => { const url = new URL(base + path), data = JSON.stringify(body);
  const call = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: 'Bearer ' + token } : {}) } },
    response => { let text = ''; response.on('data', part => { text += part; }); response.on('end', () => resolve({ status: response.statusCode, body: text })); });
  call.on('error', error => resolve({ status: 0, body: String(error.code) })); call.end(data); });
const body = (extra = {}) => ({ model: config.model, input: [{ role: 'user', content: 'hi' }], instructions: 'x', tools: [{ type: 'function', name: 'shell', parameters: {} }], store: false, stream: true, ...extra });
const pending = new Map(); let next = 100, token = null, outputSchema = null;
const ask = (method, params) => new Promise(resolve => { const id = next++; pending.set(id, resolve); send({ id, method, params }); });
const item = item => send({ method: 'item/started', params: { threadId: 'thr_1', turnId: 'turn_1', item } });
async function turn(early) {
  const report = { mode, early: early.error ? 'refused' : early.result?.decision ?? null, config, outputSchema: outputSchema !== null };
  try { report.core = readFileSync('/tmp/deckent-prompt/core.txt', 'utf8'); } catch { report.core = null; }
  // Wrong helper processes first: a grandchild (via sh) and a direct child with another cmdline get nothing and consume nothing.
  report.grandchild = auth(['sh', ['-c', 'node ' + helper[1].join(' ') + '; exit $?']]) !== null;
  report.otherCmdline = auth(['node', ['-e', "require('http').request({ host: '127.0.0.1', port: process.argv[1], method: 'POST', path: '/capability', headers: { 'content-length': '0' } }, r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => { if (r.statusCode === 200) process.stdout.write(b); else process.exitCode = 1; }); }).end()", helper[1][1]]]) !== null;
  token = auth(); report.capability = token !== null; report.cHash = token ? createHash('sha256').update(token).digest('hex') : null;
  if (mode === 'replay') token = readFileSync('/workspace/stolen.txt', 'utf8');
  report.first = mode === 'nomodel' ? { status: 200, body: '' } : await post('/responses', token, body());
  if (mode === 'shapes') { report.shapes = {}; for (const [name, extra] of Object.entries({ tool: { tools: [{ type: 'web_search' }] }, model: { model: 'other-model' }, field: { background: true }, store: { store: true } }))
    report.shapes[name] = (await post('/responses', token, body(extra))).status; report.files = (await post('/files', token, body())).status; }
  if (mode === 'leak') writeFileSync('/workspace/leaked.txt', token ?? '');
  if (mode === 'rotate') { report.second = await post('/responses', token, body()); report.reauth = auth() !== null; }
  if (mode === 'hold') { writeFileSync('/workspace/app.json', JSON.stringify(report)); return; }
  const command = 'node /workspace/tool.mjs';
  item({ id: 'item_1', type: 'commandExecution', command, cwd: '/workspace' });
  report.decision = (await ask('item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1', cwd: '/workspace', command })).result?.decision ?? null;
  item({ id: 'item_2', type: 'commandExecution', command: 'curl example.com', cwd: '/workspace' });
  report.network = (await ask('item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_2', cwd: '/workspace', networkApprovalContext: { host: 'example.com', protocol: 'https' } })).result?.decision ?? null;
  item({ id: 'item_3', type: 'fileChange', changes: [{ path: '/workspace/../etc/passwd', kind: 'add', diff: 'x' }] });
  report.escape = (await ask('item/fileChange/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_3' })).result?.decision ?? null;
  item({ id: 'item_4', type: 'fileChange', changes: [{ path: 'src/a.txt', kind: 'add', diff: '+hello' }] });
  report.file = (await ask('item/fileChange/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_4' })).result?.decision ?? null;
  // Asynchronous: the tool also knocks on this process's control listener, which must stay responsive.
  if (report.decision === 'accept') report.tool = await new Promise(resolve => spawn('node', ['/workspace/tool.mjs', JSON.stringify({ helper: helper[1], base, parent: process.pid, ctl: listen.port })], { stdio: 'ignore' }).on('exit', resolve));
  writeFileSync('/workspace/app.json', JSON.stringify(report));
  const failed = report.first.status !== 200 || (report.second && report.second.status !== 200);
  // A strict-schema final answer (transport nulls included), as the real binary returns it under the turn's outputSchema.
  if (outputSchema && !failed) send({ method: 'item/completed', params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'msg_1', type: 'agentMessage', text: JSON.stringify({ schemaVersion: 1,
    summary: 'done', changedFiles: ['src/a.txt'], checks: [{ command: 'true', outcome: 'passed', checkId: null, role: null }], openIssues: [], handoff: null, exit: null, lessons: null }) } } });
  send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: failed ? 'failed' : 'completed', error: failed ? { message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } } : null } } });
}
async function onLine(line) { const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'synthetic' } });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_1' } } });
  else if (message.method === 'turn/start') {
    outputSchema = message.params.outputSchema ?? null;
    // An approval before the turn id is known is refused (never matched to "any turn").
    const early = await ask('item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_0', cwd: '/workspace', command: 'true' });
    send({ id: message.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } }); void turn(early); }
  else if (message.method === 'turn/interrupt') { const after = await post('/responses', token, body()); writeFileSync('/workspace/after.json', JSON.stringify(after));
    send({ id: message.id, result: {} }); send({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'interrupted' } } }); }
}
`;
// Synthetic tool child (a native shell effect): tries to read ancestors' memory, re-run the auth helper, reach the host relay directly and the
// model shim without the capability, then scans every readable environ/cmdline and worker file for later absence checks.
const TOOL = String.raw`
import { readFileSync, readdirSync, readlinkSync, statSync, writeFileSync, existsSync } from 'node:fs'; import { spawnSync } from 'node:child_process'; import { request } from 'node:http';
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
// The app-server control WebSocket without its bearer, and every reopenable pipe of pid 1 / the app-server (none may exist).
out.control = await call({ host: '127.0.0.1', port: JSON.parse(process.argv[2]).ctl, path: '/', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
out.init = {}; for (const file of ['fd', 'maps', 'environ']) { try { readdirSync('/proc/1/' + file); out.init[file] = 'open'; } catch (error) { try { readFileSync('/proc/1/' + file); out.init[file] = 'open'; } catch (inner) { out.init[file] = inner.code; } } }
const pipes = pid => { try { return readdirSync('/proc/' + pid + '/fd').map(fd => { try { return readlinkSync('/proc/' + pid + '/fd/' + fd); } catch { return ''; } }).filter(link => link.startsWith('pipe:')); } catch { return []; } };
const ownPipes = new Set(pipes(parent)); out.sharedPipes = pipes(1).filter(link => ownPipes.has(link));
writeFileSync('/workspace/effect.txt', 'native effect'); writeFileSync('/workspace/tool.json', JSON.stringify(out));
`;
const TEMPLATE = { id: 't', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456,
  pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 } };
const INVOCATION = { schemaVersion: 4, provider: 'codex', cliVersion: 'codex-cli 0.164.0', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
  model: { channelId: 'c', modelId: 'm', auxiliaryModelIds: [] }, composition: { schemaVersion: 1, task: 'Edit note.txt', scope: 'note.txt', acceptance: 'Zero exit' } };
const capabilityIn = (text: string, cHash: string | null) => !!cHash && [...text.matchAll(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu)].some(match => hash(match[0]) === cHash);

async function harness(mode: string, options: { approve?: boolean; upstream?: SiwcUpstream; leases?: string[]; workspaceFiles?: Record<string, string>;
  /** U9F: the production supervisor class, the durable audit sink and the frozen native turn shape. */
  production?: boolean; audit?: (subject: SiwcRelayAuditSubject) => Promise<void>; turn?: { config: readonly string[]; instructions: string; finalReport: boolean } } = {}) {
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
  let leaseCount = 0, approveCalls = 0; const asked: SiwcNativeApproval[] = [];
  const upstream: SiwcUpstream = options.upstream ?? (async input => { upstreamSeen.push({ authorization: input.headers['authorization']!, body: input.body });
    // Reflects the upstream credential to prove the relay masks it before the worker sees the stream.
    return { status: 200, contentType: 'text/event-stream', body: (async function* () { yield Buffer.from(`data: {"type":"response.completed","echo":"${input.headers['authorization']}"}\n\n`); })() }; });
  const identity = { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test', generation: 1, layoutRevision: 'layout' };
  const relay = await openSiwcWorkerRelay({ directory: root, prompt: 'Do the task', deadlineMs: 60000, version: 'test', upstream,
    binding: { schemaVersion: 1, connectionId: randomUUID(), installationId: 'inst', companyId: 'co', person: { issuer: 'local', subject: 'person' }, attempt: identity,
      model: 'fixture-model', imageId: imageId!, codexVersion: 'synthetic', generations: { connection: 1, custody: 1, consent: 1 } },
    lease: async () => ({ accessToken: leases[Math.min(leaseCount++, leases.length - 1)]!, expiresAtMs: Date.now() + 3_600_000 }),
    approve: async request => { approveCalls++; asked.push(request); return options.approve ?? true; }, live: () => true, onRecord: record => records.push(record),
    appServer: { executable: 'node', args: ['/workspace/fake-app-server.mjs', mode] }, ...options.turn, ...(options.audit ? { audit: options.audit } : {}) });
  cleanups.push(relay.close);
  const mounted = { ...relay, descriptor: { ...relay.descriptor, bootstrapPath: artifacts['bootstrap']!.path, bootstrapSha256: artifacts['bootstrap']!.sha256,
    helperPath: artifacts['helper']!.path, helperSha256: artifacts['helper']!.sha256 } };
  const docker = { executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
    logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1, tmpBytes: 67108864, deadlineMs: 60000, controlTimeoutMs: 10000, outputBytes: 65536 };
  const supervisor = options.production ? new SiwcWorkerSupervisor(docker, mounted)
    : new DockerSupervisor({ ...docker, relay: mounted.descriptor }, undefined, { created: id => relay.bindContainer(id) });
  const request: SandboxRequest = { protocolVersion: 1, identity, workspace, argv: ['unused'] };
  cleanups.push(async () => { await supervisor.cancel(request); await supervisor.release(request); });
  const read = async (name: string) => readFile(join(workspace, name), 'utf8').catch(() => null);
  return { root, workspace, relay, supervisor, request, leases, upstreamSeen, records, read, approveCalls: () => approveCalls, asked };
}

describe.skipIf(!imageId || process.platform !== 'linux')('SIWC worker relay with a synthetic app-server inside the pinned Docker image (U9-6/7)', () => {
  it('worker-app-server-capability-only: only the app-server gets C via its helper; tools get neither C nor A, nor the host relay (U9-6a, U9-7a)', async () => {
    const h = await harness('normal');
    const result = await h.supervisor.execute(h.request);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
    // The decision sees the exact command and file targets/diff; permission expansion, a path outside /workspace and an approval before the
    // turn id is known never reach it.
    expect(await h.relay.outcome).toMatchObject({ status: 'completed', approvals: { accepted: 2, declined: 2 }, refusedRequests: 1 }); expect(h.approveCalls()).toBe(2);
    expect(h.asked).toEqual([expect.objectContaining({ kind: 'command', command: 'node /workspace/tool.mjs', cwd: '/workspace', changes: [] }),
      expect.objectContaining({ kind: 'file-change', command: null, changes: [{ path: '/workspace/src/a.txt', kind: 'add', diff: '+hello' }] })]);
    const app = JSON.parse((await h.read('app.json'))!), tool = JSON.parse((await h.read('tool.json'))!), scan = (await h.read('scan.bin'))!;
    expect(app).toMatchObject({ early: 'refused', grandchild: false, otherCmdline: false, capability: true, first: { status: 200 }, decision: 'accept', network: 'decline', escape: 'decline', file: 'accept', tool: 0 });
    expect(Object.values(tool.memory)).toEqual(['EACCES', 'EACCES']);
    // The bootstrap (pid 1) is non-dumpable: its fd table, maps and environ cannot be opened; no pipe links it to the app-server.
    expect(tool).toMatchObject({ helper: { stdout: '' }, shim: 403, hostRoot: false, control: 401, init: { fd: 'EACCES', maps: 'EACCES', environ: 'EACCES' }, sharedPipes: [] }); expect(tool.helper.status).not.toBe(0); expect(tool.relay).not.toBe(200);
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

  it('native-tools-stay-in-worker: a declined approval runs no tool and leaves no effect; a bare turn/completed is not success (U9-7a)', async () => {
    // `nomodel`: the app-server claims completion without any relayed model exchange — host-side evidence is missing, so it is a failure.
    const h = await harness('nomodel', { approve: false });
    await h.supervisor.execute(h.request);
    expect(JSON.parse((await h.read('app.json'))!)).toMatchObject({ decision: 'decline' });
    expect(await h.read('effect.txt')).toBeNull(); expect(await h.read('tool.json')).toBeNull();
    expect(await h.relay.outcome).toMatchObject({ status: 'failed', reason: 'protocol', approvals: { accepted: 0, declined: 4 } });
    expect(h.relay.statistics()).toMatchObject({ relayed: 0, upstreamSends: 0 });
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

  it('U9F audit + delivery: relay records are sealed audit subjects without A/C; a completed relayed turn exits 0 with the native report line; an unrecorded capability is never issued', async () => {
    const native = compileNativeCodingDockerProfile(TEMPLATE, { ...INVOCATION, discovery: { schemaVersion: 1, mode: 'disabled' } });
    const delivery = (native.parameters['nativeSubscription'] as { promptDelivery: { core: string; task: string } }).promptDelivery;
    const audited: SiwcRelayAuditSubject[] = [], event = (subject: SiwcRelayAuditSubject) => auditEventSchema.parse({ schemaVersion: 1, eventId: randomUUID(), scopeId: 'test',
      principal: { issuer: 'local', subject: 'runtime' }, policyRevision: 'r1', atMs: Date.now(), subject });
    const h = await harness('normal', { production: true, audit: async subject => { event(subject); audited.push(subject); },
      turn: { ...siwcWorkerTurn(native.parameters['argv'] as string[], delivery), finalReport: true } });
    const result = await h.supervisor.execute(h.request);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
    // Delivery reads exactly what it reads from a native Codex worker: one `native-worker-report` line, transport nulls dropped.
    expect(readWorkerFinalReport(result.stdout)).toEqual({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported',
      report: { schemaVersion: 1, summary: 'done', changedFiles: ['src/a.txt'], checks: [{ command: 'true', outcome: 'passed' }], openIssues: [] } });
    // The worker ran with the native profile's own discovery/instructions config and core prompt file, and the turn asked for the report schema.
    const app = JSON.parse((await h.read('app.json'))!);
    expect(app).toMatchObject({ outputSchema: true, core: delivery.core, config: { 'skills.include_instructions': false, 'skills.bundled.enabled': false, project_doc_max_bytes: 0 } });
    await h.relay.close();
    expect(audited.map(row => row.action)).toEqual(expect.arrayContaining(['capability-issued', 'approval', 'model-relayed', 'revoked', 'closed']));
    expect(audited.at(-1)).toMatchObject({ action: 'closed', counters: { capabilityIssued: 1, relayed: 1, suppressed: 0 } });
    // Every asked decision is sealed before its answer (expansion and out-of-workspace requests are declined without asking).
    expect(audited.filter(row => row.action === 'approval').map(row => row.reason)).toEqual(['command:accept', 'file-change:accept']);
    expect(JSON.stringify(audited)).not.toContain(h.leases[0]!); expect(capabilityIn(JSON.stringify(audited), app.cHash)).toBe(false);
    expect(JSON.stringify(audited)).not.toContain('tool.mjs');
    // No audit, no capability: a failing audit sink spends the single issue, hands out no C and nothing reaches upstream.
    const refused = await harness('normal', { production: true, audit: async () => { throw new Error('ledger unavailable'); } });
    expect((await refused.supervisor.execute(refused.request)).result).not.toEqual({ kind: 'exited', exitCode: 0 });
    expect(refused.upstreamSeen).toHaveLength(0); expect(await refused.read('effect.txt')).toBeNull(); expect(refused.relay.statistics()).toMatchObject({ capabilityIssued: 0, upstreamSends: 0, revoked: 'audit' });
  }, 90000);

  it('U9F silence: the R3 watch on the relay counters stops a quiet relay worker, C is revoked before the kill, and the Attempt never settles as success', async () => {
    const h = await harness('hold', { production: true });
    const silence = new AbortController(); let revokedAtAbort: string | null = 'unset';
    const running = h.supervisor.execute(h.request, silence.signal);
    silence.signal.addEventListener('abort', () => { revokedAtAbort = h.relay.statistics().revoked; });
    // The watch starts once the worker is up (hold mode writes app.json right after its one model exchange), so Docker latency cannot stop it early.
    for (let i = 0; i < 200 && !(await h.read('app.json')); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const watch = inactivityWatch({ warnAfterMs: 200, stopAfterMs: 2500 }, Date.now()), seen = { events: 0, bytes: 0 };
    for (let i = 0; i < 300 && !silence.signal.aborted; i++) {
      const counters = h.relay.statistics(); seen.events = counters.events; seen.bytes = counters.bytes;
      if (watch(Date.now(), counters) === 'stop') silence.abort('inactivity'); else await new Promise(resolve => setTimeout(resolve, 100));
    }
    const result = await running;
    // Activity was counted (control lines, model bytes) before the silence; the abort revoked C synchronously, before the supervisor's kill.
    expect(seen.events).toBeGreaterThan(0); expect(seen.bytes).toBeGreaterThan(0); expect(revokedAtAbort).toBe('inactivity');
    expect(result.interruptCause).toBe('inactivity'); expect(result.result).not.toEqual({ kind: 'exited', exitCode: 0 });
    expect(readWorkerFinalReport(result.stdout).status).toBe('unavailable');
    await expect(lstat(h.relay.descriptor.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
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

it('producer: only a consented, personally custodied connection of the same person binds a Codex worker on its exact model, and nothing while held (U9-7)', async () => {
  const person = { issuer: 'local', subject: 'person' }, id = randomUUID(), other = randomUUID();
  const siwc = (connectionId: string, modelId: string, owner = person, classes: string[] | null = ['system'], scopeId = 's') => ({ schemaVersion: 2, billingAxis: 'subscription', id: `p-${modelId}`, version: 1, scopeId,
    reference: { providerId: 'chatgpt-login', providerVersion: 1, modelId, modelVersion: 1 }, bindingDigest: 'a'.repeat(64), protocol: { family: 'responses', version: 'v1' },
    adapter: { id: 'siwc-responses', version: 1, definition: { schemaVersion: 1, connectionId, owner, rawUse: 'person', apiContinuation: null,
      delegatedUse: classes ? { consentedBy: owner, atMs: 7, classes } : null } }, allocation: { id: 'a', maxCalls: null, maxInFlight: 1 },
    limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } });
  const profiles = { profiles: [siwc(id, 'm'), siwc(id, 'm-ai', person, ['ai']), siwc(id, 'm-none', person, null), siwc(randomUUID(), 'm-other', { issuer: 'local', subject: 'else' }),
    siwc(other, 'm-uncustodied'), siwc(id, 'm-elsewhere', person, ['system'], 'b')] };
  const custody: string[] = [], read = (activation: 'hold' | 'open') => siwcWorkerConnections({ profiles, scopeIds: ['s'], actor: person, activation,
    custody: async (_scope, connectionId) => { custody.push(connectionId); return connectionId === id; } });
  expect(await read('hold')).toEqual([]); expect(custody).toEqual([]);
  const rows = await read('open');
  expect(rows).toEqual([{ scopeId: 's', connectionId: id, owner: person, modelId: 'm', consentAtMs: 7 }]); expect(new Set(custody)).toEqual(new Set([id, other]));
  const template = { id: 't', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456,
    pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 } };
  const worker = (modelId: string) => compileNativeCodingDockerProfile(template, { schemaVersion: 4, provider: 'codex', cliVersion: 'codex-cli 0.164.0', discovery: { schemaVersion: 1, mode: 'repository' },
    permissionMode: 'unattended', model: { channelId: 'c', modelId, auxiliaryModelIds: [] }, composition: { schemaVersion: 1, task: 'Edit note.txt', scope: 'note.txt', acceptance: 'Zero exit' } });
  expect(bindSiwcWorker(worker('m'), rows, 's').parameters['siwcWorker']).toMatchObject({ schemaVersion: 1, connectionId: id, owner: person });
  // Another model, another scope or no consented connection keeps the profile exactly as compiled (its existing route).
  for (const [profile, scope, given] of [[worker('m-ai'), 's', rows], [worker('m'), 'b', rows], [worker('m'), 's', []]] as const) expect(bindSiwcWorker(profile, given, scope)).toEqual(profile);
});

it('U9F discovery: a relay worker keeps its native profile\'s instruction discovery — same checkout shaping, same delivery floor, same `-c` config, core prompt as instructions', () => {
  const rows = [{ scopeId: 's', connectionId: randomUUID(), owner: { issuer: 'local', subject: 'person' }, modelId: 'm', consentAtMs: 1 }];
  for (const mode of ['repository', 'disabled'] as const) {
    const native = compileNativeCodingDockerProfile(TEMPLATE, { ...INVOCATION, discovery: { schemaVersion: 1, mode } }), relay = bindSiwcWorker(native, rows, 's');
    expect(relay.parameters['siwcWorker']).toBeDefined();
    expect(dockerTaskHiddenPaths(relay)).toEqual(dockerTaskHiddenPaths(native)); expect(instructionSurfacePaths(relay.parameters)).toEqual(instructionSurfacePaths(native.parameters));
    const argv = native.parameters['argv'] as string[], delivery = (native.parameters['nativeSubscription'] as { promptDelivery: { core: string; task: string } }).promptDelivery;
    const turn = siwcWorkerTurn(argv, delivery, { text: 'context' });
    expect(turn.config).toEqual(argv.slice(0, argv.indexOf('--')).filter((_, at, all) => all[at - 1] === '-c'));
    // Native Codex never auto-loads AGENTS.md with a compiled prompt; `disabled` alone also turns its skills off.
    expect(turn.config).toContain('project_doc_max_bytes=0');
    expect(turn.config.includes('skills.include_instructions=false')).toBe(mode === 'disabled');
    expect(turn).toMatchObject({ instructions: delivery.core, prompt: `${delivery.task}\n\ncontext` });
  }
});
