import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { get, request } from 'node:http';
import { connect, createServer } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it, describe } from 'vitest';
import { openNativeConnection, projectNativeCredential, readLocalNativeCredential, isPublicNativeAddress, inspectNativeClientHello } from '../../../dist/adapters/core/native-connection/index.js';
import { DockerSupervisor, readLocalOsOwner } from '#adapters/index.js';
import type { SandboxRequest } from '#engine/index.js';

const roots: string[] = []; const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const jwt = () => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.synthetic';
const credential = () => ({ tokens: { access_token: jwt(), id_token: 'synthetic-id', refresh_token: 'never-forward' }, apiKey: 'unrelated' });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'dn-')); roots.push(root); return root; }
type Preflight = Parameters<typeof openNativeConnection>[0]['binding']['preflight'];
type Delivery = Parameters<typeof openNativeConnection>[0]['binding']['promptDelivery'];
type Upstream = NonNullable<Parameters<typeof openNativeConnection>[0]['relayUpstream']>;
async function gateway(root: string, preflight?: Preflight, promptDelivery?: Delivery, provider: 'codex' | 'cursor' = 'codex', relayUpstream?: Upstream) {
  const connection = await openNativeConnection({ principal: readLocalOsOwner(), binding: { schemaVersion: 1, provider, ...(preflight ? { preflight } : {}),
    ...(promptDelivery ? { promptDelivery } : {}) }, directory: root, credential: provider === 'cursor' ? { accessToken: jwt(), refreshToken: 'never-forward' } : credential(), deadlineMs: 20000,
    ...(relayUpstream ? { relayUpstream } : {}) });
  closes.push(connection.close); return connection;
}
/** A fake provider origin: records what the host relay sent and answers with an echo of the bearer it received (the relay must mask it). */
function fakeOrigin() {
  const calls: { method: string; url: string; headers: Readonly<Record<string, string>>; body: string }[] = []; let gate = Promise.resolve();
  const upstream: Upstream = async input => { calls.push({ method: input.method, url: input.url, headers: input.headers, body: input.body.toString('utf8') }); await gate;
    return { status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'never-forward' }, body: (async function* () { yield Buffer.from(`data: ${input.headers['authorization']}\n\n`); })() }; };
  /** Holds every answer until the returned release is called (an in-flight request). */
  const hold = () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return () => { gate = Promise.resolve(); release(); }; };
  return { calls, upstream, hold };
}
function relayCall(socketPath: string, path: string, bearer: string, body?: object) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const call = request({ socketPath, path, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } },
      response => { let text = ''; response.on('data', p => text += p); response.on('end', () => resolve({ status: response.statusCode!, body: text })); });
    call.on('error', reject); call.end(data);
  });
}
function bootstrap(socketPath: string, capability?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = get({ socketPath, path: '/bootstrap', headers: capability ? { authorization: capability } : {} }, response => { let body = ''; response.on('data', p => body += p); response.on('end', () => resolve({ status: response.statusCode!, body })); });
    request.on('error', reject);
  });
}
it('projects only native short-lived credential fields; a CLI without a Docker subscription path is never projected', () => {
  const data = [projectNativeCredential('codex', credential()),
    projectNativeCredential('cursor', { accessToken: jwt(), refreshToken: 'never-forward', unrelated: 'never-forward' })];
  expect(JSON.stringify(data)).not.toContain('never-forward'); expect(JSON.stringify(data)).not.toContain('unrelated');
  // Owner 2026-11-08: Claude's local login is never read, projected or served into a container (Anthropic terms); refused typed even when present.
  expect(() => projectNativeCredential('claude', { claudeAiOauth: { accessToken: 'synthetic', expiresAt: Date.now() + 10000 } })).toThrow('NATIVE_DOCKER_SUBSCRIPTION_UNAVAILABLE');
  expect(() => projectNativeCredential('codex', { tokens: { access_token: 'invalid' } })).toThrow('NATIVE_CREDENTIAL_UNAVAILABLE');
});
it.skipIf(process.platform === 'win32')('requires POSIX private native credential ownership — reads only the owned private native file and rejects symlinks or broad permissions', async () => {
  const root = await fixture(); const home = join(root, '.codex'); await mkdir(home);
  const file = join(home, 'auth.json'); await writeFile(file, JSON.stringify(credential()), { mode: 0o600 });
  expect(JSON.stringify(await readLocalNativeCredential('codex', { HOME: root, USERPROFILE: root }))).not.toContain('never-forward');
  await rm(file); await writeFile(join(root, 'other'), JSON.stringify(credential()), { mode: 0o600 }); await symlink(join(root, 'other'), file);
  await expect(readLocalNativeCredential('codex', { HOME: root, USERPROFILE: root })).rejects.toThrow('NATIVE_CREDENTIAL_UNAVAILABLE');
  await rm(file); await writeFile(file, JSON.stringify(credential()), { mode: 0o644 });
  await expect(readLocalNativeCredential('codex', { HOME: root, USERPROFILE: root })).rejects.toThrow('NATIVE_CREDENTIAL_UNAVAILABLE');
});
it.skipIf(process.platform === 'win32')('requires POSIX private native gateway ownership — delivers auth once over the private socket and closes capability on revocation; Codex is relayed only with this Attempt\'s capability', async () => {
  const connection = await gateway(await fixture());
  expect(connection.descriptor.socketPath.startsWith(`/tmp/dk-ipc-${process.getuid?.()}/connection-`)).toBe(true);
  expect(dirname(connection.descriptor.capabilityPath)).toBe(dirname(connection.descriptor.socketPath));
  expect((await bootstrap(connection.descriptor.socketPath)).status).toBe(403);
  expect(connection.statistics().bootstrapReads).toBe(0);
  const first = await bootstrap(connection.descriptor.socketPath, await readFile(connection.descriptor.capabilityPath, 'utf8'));
  expect(first.status).toBe(200); expect(first.body).not.toContain('never-forward');
  expect((await bootstrap(connection.descriptor.socketPath)).status).toBe(403);
  expect(JSON.stringify(connection.descriptor)).not.toContain('synthetic');
  await connection.close(); await expect(bootstrap(connection.descriptor.socketPath)).rejects.toThrow();
  // Owner 2026-11-08 (alpha.64 card): Codex is relayed. Its worker gets a placeholder and this Attempt's one-time capability; the host attaches the login.
  // The capability binds to the login's owner: another person's Attempt gets no gateway, so it can never bootstrap.
  const owner = readLocalOsOwner();
  await expect(openNativeConnection({ principal: { issuer: owner.issuer, subject: String(Number(owner.subject) + 1) }, binding: { schemaVersion: 1, provider: 'codex' }, directory: await fixture(),
    credential: credential(), deadlineMs: 20000 })).rejects.toMatchObject({ code: 'NATIVE_SUBSCRIPTION_OTHER_PERSON' });
  const origin = fakeOrigin(), other = fakeOrigin(), modelId = 'exact-relay-model';
  const open = async (upstream: Upstream) => { const connection = await openNativeConnection({ principal: readLocalOsOwner(), binding: { schemaVersion: 2, provider: 'codex', model: { channelId: 'c', modelId, auxiliaryModelIds: [] } },
    directory: await fixture(), credential: { tokens: { access_token: jwt(), id_token: 'synthetic-id', account_id: 'account-synthetic-1', refresh_token: 'never-forward' } }, deadlineMs: 20000, relayUpstream: upstream });
    closes.push(connection.close); return connection; };
  const a = await open(origin.upstream), b = await open(other.upstream), keyA = await readFile(a.descriptor.capabilityPath, 'utf8');
  expect((await relayCall(a.descriptor.socketPath, '/backend-api/codex/responses', 'early', { model: modelId })).status).toBe(401); // no capability before bootstrap
  const setupA = JSON.parse((await bootstrap(a.descriptor.socketPath, keyA)).body), setupB = JSON.parse((await bootstrap(b.descriptor.socketPath, await readFile(b.descriptor.capabilityPath, 'utf8'))).body);
  // The container's bootstrap payload carries no login: only the placeholder, the capability and the CLI configuration that points at the relay.
  expect(setupA.credential).toBeUndefined(); expect(JSON.stringify(setupA)).not.toMatch(/header\.|synthetic-id|account-synthetic-1|never-forward/u);
  expect(setupA.relay).toMatchObject({ placeholder: 'deckent-relay-placeholder', config: { 'model_providers.deckent_relay.auth.refresh_interval_ms': 0 } });
  const capabilityA = setupA.relay.capability as string;
  expect((await bootstrap(a.descriptor.socketPath, keyA)).status).toBe(403); // issued once
  const answered = await relayCall(a.descriptor.socketPath, '/backend-api/codex/responses', capabilityA, { model: modelId, input: [] });
  expect(answered.status).toBe(200); expect(answered.body).toBe('data: Bearer [REDACTED]\n\n');
  expect(origin.calls).toHaveLength(1);
  expect(origin.calls[0]).toMatchObject({ method: 'POST', url: 'https://chatgpt.com/backend-api/codex/responses', headers: { 'chatgpt-account-id': 'account-synthetic-1' } });
  expect(origin.calls[0]!.headers['authorization']).toMatch(/^Bearer header\./u);
  expect((await relayCall(a.descriptor.socketPath, '/backend-api/codex/models?client_version=0.166.0', capabilityA)).status).toBe(200);
  // Refusals: another Attempt's capability, the bootstrap key a tool can read, a placeholder, another model, another route — none reaches the origin.
  for (const [bearer, path, body, status] of [[setupB.relay.capability, '/backend-api/codex/responses', { model: modelId }, 401], [keyA, '/backend-api/codex/responses', { model: modelId }, 401],
    ['deckent-relay-placeholder', '/backend-api/codex/responses', { model: modelId }, 401], [capabilityA, '/backend-api/codex/responses', { model: 'other-model' }, 400],
    [capabilityA, '/backend-api/codex/other', { model: modelId }, 404]] as const) expect((await relayCall(a.descriptor.socketPath, path, bearer, body)).status).toBe(status);
  expect(origin.calls).toHaveLength(2); expect(other.calls).toHaveLength(0);
  expect(a.statistics()).toMatchObject({ relay: { relayed: 2, refused: 6 } });
  // Relay accounting: one model call in flight per Attempt, a registry-bounded total, both refused with the typed code before the origin. A models
  // fetch beside the held call passes: the CLI overlaps them at start (codex-cli 0.166.0 probe 2026-11-09).
  const limitRefusal = JSON.stringify({ error: { type: 'deckent_relay_refused', code: 'NATIVE_RELAY_LIMIT' } });
  const release = origin.hold(), held = relayCall(a.descriptor.socketPath, '/backend-api/codex/responses', capabilityA, { model: modelId });
  while (origin.calls.length < 3) await sleep(5);
  expect(await relayCall(a.descriptor.socketPath, '/backend-api/codex/responses', capabilityA, { model: modelId })).toEqual({ status: 429, body: limitRefusal });
  const beside = relayCall(a.descriptor.socketPath, '/backend-api/codex/models', capabilityA); while (origin.calls.length < 4) await sleep(5);
  release(); expect((await held).status).toBe(200); expect((await beside).status).toBe(200);
  const { maxRequests, maxAbandoned } = JSON.parse(await readFile(new URL('../../../src/adapters/core/native-connection/internal/providers.json', import.meta.url), 'utf8')).providers.codex.relay;
  // A model call the client drops frees the slot but counts against maxAbandoned; past it model calls are refused (start-and-drop review finding).
  for (let n = 0; n < maxAbandoned; n++) {
    const hold = origin.hold(), seen = origin.calls.length, call = request({ socketPath: a.descriptor.socketPath, path: '/backend-api/codex/responses', method: 'POST',
      headers: { authorization: `Bearer ${capabilityA}`, 'content-type': 'application/json' } });
    call.on('error', () => undefined); call.end(JSON.stringify({ model: modelId }));
    while (origin.calls.length <= seen) await sleep(5);
    call.destroy(); await sleep(50); hold(); await sleep(50);
  }
  expect(await relayCall(a.descriptor.socketPath, '/backend-api/codex/responses', capabilityA, { model: modelId })).toEqual({ status: 429, body: limitRefusal });
  let last; do last = await relayCall(a.descriptor.socketPath, '/backend-api/codex/models', capabilityA); while (last.status === 200 && origin.calls.length <= maxRequests);
  expect(last).toEqual({ status: 429, body: limitRefusal }); expect(origin.calls).toHaveLength(maxRequests - 1); // the other-model request counted, never reached the origin
  await new Promise<void>((resolve, reject) => { // a relayed CLI gets no CONNECT tunnel
    const socket = connect(a.descriptor.socketPath, () => socket.write('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n'));
    socket.on('data', () => reject(new Error('unexpected permit'))); socket.on('close', resolve); socket.on('error', reject);
  });
  await a.close(); await expect(relayCall(a.descriptor.socketPath, '/backend-api/codex/responses', capabilityA, { model: modelId })).rejects.toThrow();
});
// BeUser D-05: a worker's gateway under a project whose `.deckent/workspaces` path is too long for sun_path (104 bytes) still opens, in a private
// 0700 directory under /tmp removed on close; before the fix the first run failed NATIVE_CONNECTION_UNAVAILABLE (the M-01 class, worker side).
it.skipIf(process.platform === 'win32')('NEGATIVE: a long workspace directory still opens a private worker gateway socket and removes it on close', async () => {
  const deep = join(await fixture(), 'a'.repeat(60), 'b'.repeat(40)); await mkdir(deep, { recursive: true, mode: 0o700 });
  const connection = await gateway(deep), socketPath = connection.descriptor.socketPath;
  expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103); expect(socketPath.startsWith(`/tmp/dk-ipc-${process.getuid?.()}/connection-`)).toBe(true);
  expect((await stat(dirname(socketPath))).mode & 0o777).toBe(0o700); expect((await bootstrap(socketPath, await readFile(connection.descriptor.capabilityPath, 'utf8'))).status).toBe(200);
  await connection.close(); await expect(stat(dirname(socketPath))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.skipIf(process.platform === 'win32')('requires POSIX private native gateway ownership — rejects foreign destinations, arbitrary ports and private or non-IPv4 addresses', async () => {
  const connection = await gateway(await fixture(), undefined, undefined, 'cursor');
  for (const target of ['api.anthropic.com:443', '127.0.0.1:443', 'chatgpt.com:80', 'chatgpt.com.evil.example:443']) {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(connection.descriptor.socketPath, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      socket.on('data', () => reject(new Error('unexpected permit'))); socket.on('close', resolve); socket.on('error', reject);
    });
  }
  expect(connection.statistics().rejected).toBe(4);
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.17.0.1', '192.168.0.1', '100.64.0.1', '::1', '::ffff:8.8.8.8', '224.0.0.1']) expect(isPublicNativeAddress(address)).toBe(false);
  expect(isPublicNativeAddress('8.8.8.8')).toBe(true);
});


const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
it('checks a real TLS ClientHello, TCP/record fragmentation, wrong SNI, non-TLS and oversized lengths', async () => {
  const hello = await new Promise<Buffer>((resolve, reject) => {
    const server = createServer(socket => { socket.once('data', data => { resolve(data); socket.destroy(); server.close(); }); });
    server.on('error', reject); server.listen(0, '127.0.0.1', () => {
      const address = server.address(); if (!address || typeof address === 'string') { reject(new Error()); return; }
      const client = tlsConnect({ host: '127.0.0.1', port: address.port, servername: 'chatgpt.com' }); client.on('error', () => client.destroy());
    });
  });
  expect(inspectNativeClientHello(hello, 'chatgpt.com', 8192)).toBe('accepted');
  for (let i = 0; i < hello.length; i++) expect(inspectNativeClientHello(hello.subarray(0, i), 'chatgpt.com', 8192)).toBe('pending');
  expect(inspectNativeClientHello(hello, 'foreign.example', 8192)).toBe('rejected');
  const nameOffset = hello.indexOf(Buffer.from('chatgpt.com')); expect(nameOffset).toBeGreaterThan(9);
  const missingName = Buffer.from(hello); missingName.writeUInt16BE(0xfefe, nameOffset - 9);
  expect(inspectNativeClientHello(missingName, 'chatgpt.com', 8192)).toBe('rejected');
  const encryptedName = Buffer.from(hello); encryptedName.writeUInt16BE(0xfe0d, nameOffset - 9);
  expect(inspectNativeClientHello(encryptedName, 'chatgpt.com', 8192)).toBe('rejected');
  const invalid = Buffer.from(hello); invalid[0] = 23;
  expect(inspectNativeClientHello(invalid, 'chatgpt.com', 8192)).toBe('rejected');
  invalid[0] = 22; invalid.writeUInt16BE(65535, 3);
  expect(inspectNativeClientHello(invalid, 'chatgpt.com', 8192)).toBe('rejected');
  const payload = hello.subarray(5);
  const record = (body: Buffer) => { const header = Buffer.from([22, 3, 1, 0, 0]); header.writeUInt16BE(body.length, 3); return Buffer.concat([header, body]); };
  const fragmented = Buffer.concat([record(payload.subarray(0, 17)), record(payload.subarray(17))]);
  expect(inspectNativeClientHello(fragmented, 'chatgpt.com', 8192)).toBe('accepted');
});
describe.skipIf(!imageId)('real connected Docker confinement and custody', () => {
  async function worker(argv: string[], deadlineMs = 10000, preflight?: Preflight, promptDelivery?: Delivery, deep = false, provider: 'codex' | 'cursor' = 'codex', relayUpstream?: Upstream) {
    // D-05: `deep` puts the installation under a path too long for sun_path, so the gateway socket the container binds lives under /tmp.
    const root = deep ? join(await fixture(), 'a'.repeat(60), 'b'.repeat(40)) : await fixture(); await mkdir(root, { recursive: true, mode: 0o700 }); const workspace = join(root, 'work'); await mkdir(workspace); const connection = await gateway(root, preflight, promptDelivery, provider, relayUpstream);
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!,
      uid: process.getuid!(), gid: process.getgid!(), logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1,
      tmpBytes: 67108864, deadlineMs, controlTimeoutMs: 10000, outputBytes: 65536, connection: connection.descriptor });
    const request: SandboxRequest = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test', generation: 1, layoutRevision: 'layout' }, workspace, argv };
    closes.push(async () => { await supervisor.cancel(request); await supervisor.release(request); });
    return { connection, supervisor, request };
  }
  it('hands off bound core/task content inside Docker, records only hashes and refuses changed dispatch argv', async () => {
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    const argv = ['node', '-e', "const fs=require('fs');fs.writeFileSync('received',fs.readFileSync('/tmp/deckent-prompt/core.txt','utf8')+'|'+process.argv.at(-1));console.log('suppressed-native-data')", '--',
      '-c', 'model_instructions_file="/tmp/deckent-prompt/core.txt"', '-c', 'project_doc_max_bytes=0', '--', '__DECKENT_TASK_PROMPT__'];
    const body = { schemaVersion: 1 as const, channel: 'codex-instructions-file' as const, core: 'private-core-görev-🧩', task: 'private-task',
      segments: (['core', 'task', 'scope', 'acceptance'] as const).map(kind => ({ kind, id: kind, version: 1, sha256: hash(kind) })) };
    const delivery = { ...body, sha256: hash(JSON.stringify(body)), argvSha256: hash(JSON.stringify(argv)) };
    const cliVersion = execFileSync('/usr/bin/docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', imageId!, '--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    const preflight = { schemaVersion: 1 as const, cliVersion, discovery: 'repository' as const, helpArgs: ['--help'], requiredFlags: ['--help'] };
    const f = await worker(argv, 20000, preflight, delivery, true);
    expect(f.connection.descriptor.socketPath.startsWith(`/tmp/dk-ipc-${process.getuid?.()}/connection-`)).toBe(true);
    const result = await f.supervisor.execute(f.request);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
    expect(await readFile(join(f.request.workspace, 'received'), 'utf8')).toBe('private-core-görev-🧩|private-task');
    const receipt = JSON.parse(result.stdout.split('\n')[0]!);
    expect(receipt).toMatchObject({ kind: 'native-prompt-delivery', phase: 'spawned', sha256: delivery.sha256, coreSha256: hash(body.core), taskSha256: hash(body.task) });
    expect(receipt.argvSha256).not.toBe(delivery.argvSha256);
    for (const hidden of ['private-core', 'private-task', 'synthetic', 'suppressed-native-data']) expect(result.stdout).not.toContain(hidden);
    const bad = await worker([...argv.slice(0, -1), 'changed'], 20000, preflight, delivery);
    const rejected = await bad.supervisor.execute(bad.request);
    expect(rejected.result).toEqual({ kind: 'exited', exitCode: 78 });
    expect(rejected.stdout).not.toContain('native-prompt-delivery');
    await expect(readFile(join(bad.request.workspace, 'received'))).rejects.toThrow();
    expect(bad.connection.statistics().connected).toBe(0);
  });
  it('keeps network none and host/foreign identities hidden; raw native output is suppressed', async () => {
    const f = await worker(['node', '-e', `const fs=require('node:fs');const os=require('node:os');const net=require('node:net');const http=require('node:http');
      (async()=>{const auth=JSON.parse(fs.readFileSync(process.env.HOME+'/.config/cursor/auth.json'));
      const forbidden=['/var/run/docker.sock','/home/alperen/.codex/auth.json',process.env.HOME+'/.claude/.credentials.json',process.env.HOME+'/.codex/auth.json'];
      if(Object.keys(auth).join()!=='accessToken'||forbidden.some(p=>fs.existsSync(p))||Object.keys(os.networkInterfaces()).some(k=>k!=='lo'))process.exit(11);
      for(const host of ['1.1.1.1','172.17.0.1','169.254.169.254'])await new Promise((resolve,reject)=>{const s=net.connect({host,port:443});s.setTimeout(500,()=>s.destroy());s.on('connect',()=>{s.destroy();reject(Error())});s.on('error',()=>{});s.on('close',resolve)});
      await new Promise((resolve,reject)=>{const proxy=new URL(process.env.HTTPS_PROXY);const req=http.request({hostname:proxy.hostname,port:proxy.port,method:'CONNECT',path:'example.com:443'});req.on('connect',()=>reject(Error()));req.on('error',resolve);req.end()});
      fs.writeFileSync('boundary.json',JSON.stringify({confined:true}));console.log('synthetic-sensitive-output');})().catch(()=>process.exit(12));`], 10000, undefined, undefined, false, 'cursor');
    const result = await f.supervisor.execute(f.request);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 }); expect(result.stdout).not.toContain('synthetic-sensitive-output');
    expect(JSON.parse(await readFile(join(f.request.workspace, 'boundary.json'), 'utf8'))).toEqual({ confined: true });
    expect(f.connection.statistics().bootstrapReads).toBe(1);
    expect(f.connection.statistics().rejected).toBe(1);
  });
  it('refuses a mismatched CLI version before executing a task or using provider egress', async () => {
    const f = await worker(['node', '-e', "require('fs').writeFileSync('unexpected','executed')"], 20000,
      { schemaVersion: 1, cliVersion: 'unmatched-version', discovery: 'repository', helpArgs: ['--help'], requiredFlags: ['--help'] });
    const result = await f.supervisor.execute(f.request);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 78 });
    expect(JSON.parse(result.stdout)).toMatchObject({ failure: 'preflight', outputBytes: 0 });
    await expect(readFile(join(f.request.workspace, 'unexpected'))).rejects.toThrow();
    expect(f.connection.statistics().connected).toBe(0);
  });
  // Owner 2026-11-08 (alpha.64 card): the live worker is a fake Codex CLI. Its env, files and argv hold only the placeholder; its model call reaches
  // the origin with the login attached on the host, and the bootstrap key a tool can read is refused by the relay.
  it('restores exact custody without auth and cancels a live connected worker', async () => {
    const origin = fakeOrigin();
    const f = await worker(['node', '-e', `const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
      const files=[];const walk=d=>{let names=[];try{names=fs.readdirSync(d)}catch{return}for(const n of names){const p=path.join(d,n);let st;try{st=fs.lstatSync(p)}catch{continue}
        if(st.isDirectory())walk(p);else if(st.isFile())try{files.push(p+'='+fs.readFileSync(p,'latin1'))}catch{}}};
      for(const root of [process.env.HOME,'/tmp','/run'])walk(root);
      const pair=process.argv.find(a=>a.startsWith('model_providers.deckent_relay.base_url='));const base=JSON.parse(pair.slice(pair.indexOf('=')+1));
      const call=(p,bearer,body,socketPath)=>new Promise((resolve,reject)=>{const u=new URL(base+p);const r=http.request({...(socketPath?{socketPath}:{host:u.hostname,port:u.port}),path:u.pathname+u.search,method:'POST',
        headers:{authorization:'Bearer '+bearer,'content-type':'application/json'}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>resolve(res.statusCode+' '+t))});r.on('error',reject);r.end(JSON.stringify(body))});
      (async()=>{const answer=await call('/responses','deckent-relay-placeholder',{model:'m'});
        const key=fs.readFileSync('/run/deckent-bootstrap.key','utf8');const direct=await call('/responses',key,{model:'m'},'/run/deckent-connection.sock');
        fs.writeFileSync('dump.json',JSON.stringify({env:process.env,argv:process.argv,files,answer,direct}));fs.writeFileSync('ready','yes');setInterval(()=>{},1000);})().catch(()=>process.exit(12));`,
      '--', 'task', '--', 'prompt'], 20000, undefined, undefined, false, 'codex', origin.upstream);
    const profile = await f.supervisor.captureProfile(); const execution = f.supervisor.execute(f.request);
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = await readFile(join(f.request.workspace, 'ready'), 'utf8') === 'yes'; } catch { /* wait bounded */ } if (ready) break; await sleep(50); }
    expect(ready).toBe(true);
    const dump = await readFile(join(f.request.workspace, 'dump.json'), 'utf8'), seen = JSON.parse(dump);
    expect(dump).not.toMatch(/header\.ey|synthetic-id|never-forward/u); expect(dump).toContain('deckent-relay-placeholder');
    expect(seen.files.some((row: string) => row.includes('/.codex/auth.json'))).toBe(false); expect(seen.env.HTTPS_PROXY).toBeUndefined();
    expect(seen.answer).toBe('200 data: Bearer [REDACTED]\n\n'); expect(seen.direct.startsWith('401 ')).toBe(true);
    expect(origin.calls).toHaveLength(1); expect(origin.calls[0]!.headers['authorization']).toMatch(/^Bearer header\./u);
    expect(f.connection.statistics()).toMatchObject({ bootstrapReads: 1, relay: { relayed: 1, refused: 1 } });
    await f.connection.close();
    const restored = await DockerSupervisor.restoreProfile(profile); const cancelled = await restored.cancel(f.request);
    expect(cancelled.result.kind).toBe('exited'); expect((await execution).result.kind).toBe('exited');
    const replay = await restored.execute(f.request); expect(replay.result.kind).toBe('exited');
    expect((await restored.recoverOutput(f.request)).completeness).toBe('partial');
  });
  it('rejects a different TLS SNI even after admitting the provider CONNECT destination', async () => {
    const connection = await gateway(await fixture(), undefined, undefined, 'cursor');
    await new Promise<void>((resolve, reject) => {
      const socket = connect(connection.descriptor.socketPath, () => socket.write('CONNECT api2.cursor.sh:443 HTTP/1.1\r\nHost: api2.cursor.sh:443\r\n\r\n'));
      socket.once('data', header => {
        if (!header.toString().startsWith('HTTP/1.1 200')) { reject(new Error('not admitted')); socket.destroy(); return; }
        const client = tlsConnect({ socket, servername: 'foreign.example' });
        client.on('secureConnect', () => reject(new Error('unexpected TLS permit')));
        client.on('error', () => client.destroy()); client.on('close', resolve);
      });
      socket.on('error', reject);
    });
    expect(connection.statistics().connected).toBe(0); expect(connection.statistics().rejected).toBe(1);
  });
});
