// Standalone Node bootstrap mounted read-only. No host package imports at runtime.
import { get } from 'node:http';
import { createServer, connect, type Socket } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

async function main() {
  const socketPath = '/run/deckent-connection.sock';
  const payload = await new Promise<string>((resolve, reject) => {
    const request = get({ socketPath, path: '/bootstrap', timeout: 10000 }, response => {
      let text = '';
      response.on('data', (part: Buffer) => { text += part.toString('utf8'); if (text.length > 131072) request.destroy(); });
      response.on('error', reject); response.on('end', () => response.statusCode === 200 ? resolve(text) : reject(new Error()));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error()));
  });
  const setup = JSON.parse(payload) as { schemaVersion: number; provider: string; home: string; file: string;
    credential: Record<string, unknown>; credentialEnvironment?: string; environment: Record<string, string>; limits: { connections: number; idleMs: number };
    preflight?: { schemaVersion: number; cliVersion: string; helpArgs: string[]; requiredFlags: string[] } };
  const home = '/tmp/deckent-home';
  if (setup.schemaVersion !== 1 || setup.home.includes('..') || setup.home.startsWith('/') || setup.file.includes('/')) throw new Error();
  const [executable, ...argv] = process.argv.slice(2); if (!executable) throw new Error();
  if (setup.preflight) {
    // Probe in a clean directory before credentials are written or task tools can run.
    const probe = '/tmp/deckent-preflight'; await mkdir(probe, { mode: 0o700 });
    try {
      const run = (args: string[]) => execFileSync(executable, args, { cwd: probe, timeout: 10000,
        maxBuffer: 1048576, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: probe, LANG: 'C.UTF-8', DISABLE_AUTOUPDATER: '1' } });
      const version = run(['--version']).trim(); const help = run(setup.preflight.helpArgs).split(/[\s,=]+/);
      if (setup.preflight.schemaVersion !== 1 || version !== setup.preflight.cliVersion
        || setup.preflight.requiredFlags.some(flag => !help.includes(flag))) throw new Error();
    } catch {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'native-coding-exit', code: 78,
        signal: null, outputBytes: 0, failure: 'preflight' }) + '\n');
      process.exitCode = 78; return;
    }
  }
  const authRoot = join(home, setup.home); await mkdir(authRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(authRoot, setup.file), JSON.stringify(setup.credential), { mode: 0o600, flag: 'wx' });
  if (setup.provider === 'claude') await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  if (setup.provider === 'cursor') {
    await mkdir(join(home, '.cursor'), { mode: 0o700 });
    await writeFile(join(home, '.cursor/cli-config.json'), JSON.stringify({ version: 1, editor: { vimMode: false },
      permissions: { allow: [], deny: [] }, network: { useHttp1ForAgent: true } }), { mode: 0o600 });
  }
  const sockets = new Set<Socket>();
  const relay = createServer(client => {
    const remote = connect(socketPath); sockets.add(client); sockets.add(remote);
    const close = () => { client.destroy(); remote.destroy(); sockets.delete(client); sockets.delete(remote); };
    client.on('error', close); remote.on('error', close); client.on('close', close); remote.on('close', close);
    client.setTimeout(setup.limits.idleMs, close); remote.setTimeout(setup.limits.idleMs, close);
    client.pipe(remote); remote.pipe(client);
  });
  relay.maxConnections = setup.limits.connections;
  await new Promise<void>((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
  const address = relay.address(); if (!address || typeof address === 'string') throw new Error();
  const proxy = `http://127.0.0.1:${address.port}`;
  const child = spawn(executable, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: home,
    LANG: 'C.UTF-8', ...setup.environment,
    ...(setup.credentialEnvironment && typeof setup.credential.accessToken === 'string' ? { [setup.credentialEnvironment]: setup.credential.accessToken } : {}),
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: '', no_proxy: '' } });
  // Native events can contain tool output and request headers. Never forward raw events.
  let tail = ''; let bytes = 0;
  const capture = (part: Buffer) => { bytes += part.length; tail = (tail + part.toString('utf8')).slice(-65536); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const result = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.on('error', () => resolve({ code: null, signal: null }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const failure = /unauthorized|authentication|log in|login|401|token.*expired/i.test(tail) ? 'authentication'
    : /quota|rate.limit|usage.limit|429/i.test(tail) ? 'capacity'
    : /model.*not.*(found|supported|available)|invalid.model/i.test(tail) ? 'model'
    : /connect|proxy|network|fetch failed|socket|ENOTFOUND|ECONN/i.test(tail) ? 'connection' : 'native';
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'native-coding-exit', ...result, outputBytes: bytes,
    failure: result.code === 0 ? null : failure }) + '\n');
  for (const socket of sockets) socket.destroy(); relay.close();
  process.exitCode = result.code === 0 ? 0 : 1;
}
main().catch(() => { process.stderr.write('NATIVE_BOOTSTRAP_FAILED\n'); process.exitCode = 78; });
