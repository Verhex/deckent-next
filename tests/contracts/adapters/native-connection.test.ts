import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import { connect, createServer } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it, describe } from 'vitest';
import { openNativeConnection, projectNativeCredential, readLocalNativeCredential, isPublicNativeAddress, inspectNativeClientHello } from '../../../dist/adapters/core/native-connection/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import type { SandboxRequest } from '#engine/index.js';

const roots: string[] = []; const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const jwt = () => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.synthetic';
const credential = () => ({ tokens: { access_token: jwt(), id_token: 'synthetic-id', refresh_token: 'never-forward' }, apiKey: 'unrelated' });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'dn-')); roots.push(root); return root; }
async function gateway(root: string) {
  const connection = await openNativeConnection({ binding: { schemaVersion: 1, provider: 'codex' }, directory: root, credential: credential(), deadlineMs: 20000 });
  closes.push(connection.close); return connection;
}
function bootstrap(socketPath: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = get({ socketPath, path: '/bootstrap' }, response => { let body = ''; response.on('data', p => body += p); response.on('end', () => resolve({ status: response.statusCode!, body })); });
    request.on('error', reject);
  });
}
it('projects only native short-lived credential fields for all three providers', () => {
  const data = [projectNativeCredential('codex', credential()),
    projectNativeCredential('claude', { claudeAiOauth: { accessToken: 'synthetic', expiresAt: Date.now() + 10000, refreshToken: 'never-forward' }, unrelated: 'never-forward' }),
    projectNativeCredential('cursor', { accessToken: jwt(), refreshToken: 'never-forward', unrelated: 'never-forward' })];
  expect(JSON.stringify(data)).not.toContain('never-forward'); expect(JSON.stringify(data)).not.toContain('unrelated');
  expect(() => projectNativeCredential('claude', { claudeAiOauth: { accessToken: 'synthetic', expiresAt: 0 } })).toThrow('NATIVE_CREDENTIAL_UNAVAILABLE');
  expect(() => projectNativeCredential('codex', { tokens: { access_token: 'invalid' } })).toThrow('NATIVE_CREDENTIAL_UNAVAILABLE');
});
it('reads only the owned private native file and rejects symlinks or broad permissions', async () => {
  const root = await fixture(); const home = join(root, '.codex'); await mkdir(home);
  const file = join(home, 'auth.json'); await writeFile(file, JSON.stringify(credential()), { mode: 0o600 });
  expect(JSON.stringify(await readLocalNativeCredential('codex', { HOME: root }))).not.toContain('never-forward');
  await rm(file); await writeFile(join(root, 'other'), JSON.stringify(credential()), { mode: 0o600 }); await symlink(join(root, 'other'), file);
  await expect(readLocalNativeCredential('codex', { HOME: root })).rejects.toThrow('NATIVE_CREDENTIAL_UNAVAILABLE');
  await rm(file); await writeFile(file, JSON.stringify(credential()), { mode: 0o644 });
  await expect(readLocalNativeCredential('codex', { HOME: root })).rejects.toThrow('NATIVE_CREDENTIAL_UNAVAILABLE');
});
it('delivers auth once over the private socket and closes capability on revocation', async () => {
  const connection = await gateway(await fixture()); const first = await bootstrap(connection.descriptor.socketPath);
  expect(first.status).toBe(200); expect(first.body).not.toContain('never-forward');
  expect((await bootstrap(connection.descriptor.socketPath)).status).toBe(403);
  expect(JSON.stringify(connection.descriptor)).not.toContain('synthetic');
  await connection.close(); await expect(bootstrap(connection.descriptor.socketPath)).rejects.toThrow();
});
it('rejects foreign destinations, arbitrary ports and private or non-IPv4 addresses', async () => {
  const connection = await gateway(await fixture());
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
  async function worker(argv: string[], deadlineMs = 10000) {
    const root = await fixture(); const workspace = join(root, 'work'); await mkdir(workspace); const connection = await gateway(root);
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!,
      uid: process.getuid!(), gid: process.getgid!(), logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1,
      tmpBytes: 67108864, deadlineMs, controlTimeoutMs: 10000, outputBytes: 65536, connection: connection.descriptor });
    const request: SandboxRequest = { protocolVersion: 1, identity: { runId: 'run', taskId: 'task', attemptId: randomUUID(), scopeId: 'test', generation: 1, layoutRevision: 'layout' }, workspace, argv };
    closes.push(async () => { await supervisor.cancel(request); await supervisor.release(request); });
    return { connection, supervisor, request };
  }
  it('keeps network none and host/foreign identities hidden; raw native output is suppressed', async () => {
    const f = await worker(['node', '-e', `const fs=require('node:fs');const os=require('node:os');const net=require('node:net');const http=require('node:http');
      (async()=>{const auth=JSON.parse(fs.readFileSync(process.env.HOME+'/.codex/auth.json'));
      const forbidden=['/var/run/docker.sock','/home/alperen/.codex/auth.json',process.env.HOME+'/.claude/.credentials.json',process.env.HOME+'/.config/cursor/auth.json'];
      if(auth.tokens.refresh_token!==''||forbidden.some(p=>fs.existsSync(p))||Object.keys(os.networkInterfaces()).some(k=>k!=='lo'))process.exit(11);
      for(const host of ['1.1.1.1','172.17.0.1','169.254.169.254'])await new Promise((resolve,reject)=>{const s=net.connect({host,port:443});s.setTimeout(500,()=>s.destroy());s.on('connect',()=>{s.destroy();reject(Error())});s.on('error',()=>{});s.on('close',resolve)});
      await new Promise((resolve,reject)=>{const proxy=new URL(process.env.HTTPS_PROXY);const req=http.request({hostname:proxy.hostname,port:proxy.port,method:'CONNECT',path:'example.com:443'});req.on('connect',()=>reject(Error()));req.on('error',resolve);req.end()});
      fs.writeFileSync('boundary.json',JSON.stringify({confined:true}));console.log('synthetic-sensitive-output');})().catch(()=>process.exit(12));`]);
    const result = await f.supervisor.execute(f.request);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 }); expect(result.stdout).not.toContain('synthetic-sensitive-output');
    expect(JSON.parse(await readFile(join(f.request.workspace, 'boundary.json'), 'utf8'))).toEqual({ confined: true });
    expect(f.connection.statistics().rejected).toBe(1);
  });
  it('restores exact custody without auth and cancels a live connected worker', async () => {
    const f = await worker(['node', '-e', "require('node:fs').writeFileSync('ready','yes');setInterval(()=>{},1000)"]);
    const profile = await f.supervisor.captureProfile(); const execution = f.supervisor.execute(f.request);
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = await readFile(join(f.request.workspace, 'ready'), 'utf8') === 'yes'; } catch { /* wait bounded */ } if (ready) break; await sleep(50); }
    expect(ready).toBe(true); await f.connection.close();
    const restored = await DockerSupervisor.restoreProfile(profile); const cancelled = await restored.cancel(f.request);
    expect(cancelled.result.kind).toBe('exited'); expect((await execution).result.kind).toBe('exited');
    const replay = await restored.execute(f.request); expect(replay.result.kind).toBe('exited');
    expect((await restored.recoverOutput(f.request)).completeness).toBe('partial');
  });
  it('rejects a different TLS SNI even after admitting the provider CONNECT destination', async () => {
    const connection = await gateway(await fixture());
    await new Promise<void>((resolve, reject) => {
      const socket = connect(connection.descriptor.socketPath, () => socket.write('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n'));
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
