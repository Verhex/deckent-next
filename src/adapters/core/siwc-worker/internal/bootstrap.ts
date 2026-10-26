// Standalone SIWC worker bootstrap, mounted read-only as the container's init process. No host package imports at runtime.
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const RELAY = '/run/deckent-relay.sock', HELPER = '/run/deckent-siwc-helper.mjs', HARDENING = '/run/deckent-hardening.node';
type Launch = { schemaVersion: 1; executable: string; args: string[]; native: { vendorRoots: Record<string, string>; fallbackVendorRoot: string; triples: Record<string, string>; binary: string; pathDir: string; managedEnv: string };
  limits: { requestMaxBytes: number; controlLineBytes: number; connections: number; idleMs: number; helperTimeoutMs: number; drainMs: number; controlConnectMs: number; controlPollMs: number } };

/** Socket inode of the client end of one loopback TCP connection (container network namespace). */
export function loopbackInode(tables: readonly string[], clientPort: number, serverPort: number): string | null {
  const port = (address: string | undefined) => parseInt(address?.split(':')[1] ?? '', 16);
  for (const table of tables) for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/u);
    if (port(cols[1]) === clientPort && port(cols[2]) === serverPort && cols[9] && cols[9] !== '0') return cols[9];
  }
  return null;
}
/** Every process holding that socket (kernel /proc facts, read as the same uid; a non-readable holder makes the owner unknown). */
function holders(inode: string): number[] {
  const owners: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    let fds: string[]; try { fds = readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) { try { if (readlinkSync(`/proc/${entry}/fd/${fd}`) === `socket:[${inode}]`) { owners.push(Number(entry)); break; } } catch { /* closed meanwhile */ } }
  }
  return owners;
}
const stat = (pid: number) => { const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'), text = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { ppid: Number(text[1]), start: text[19] ?? '' }; };
/** The single process owning the client end of an accepted loopback connection, or null. */
function peerOf(socket: { remotePort?: number | undefined; localPort?: number | undefined }): { pid: number; start: string } | null {
  try {
    if (!socket.remotePort || !socket.localPort) return null;
    const tables = ['/proc/net/tcp', '/proc/net/tcp6'].map(path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } });
    const inode = loopbackInode(tables, socket.remotePort, socket.localPort), owners = inode ? holders(inode) : [];
    return owners.length === 1 ? { pid: owners[0]!, start: stat(owners[0]!).start } : null;
  } catch { return null; }
}
const host = (method: string, path: string, headers: Record<string, string> = {}) => request({ socketPath: RELAY, method, path, headers });
const fetchText = (method: string, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const call = host(method, path, { 'content-length': '0' }); call.on('error', reject);
  call.on('response', response => { let body = ''; response.setEncoding('utf8'); response.on('data', (part: string) => { body += part; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body })); });
  call.end();
});
const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); resolve(typeof address === 'object' && address ? address.port : 0); });
});

/** The npm launcher (a `.js` file) is resolved to its vendored native binary so the app-server is this process's DIRECT child (the pin). */
function nativeAppServer(launch: Launch, env: Record<string, string>): string {
  const n = launch.native, found = (env['PATH'] ?? '').split(':').map(dir => `${dir}/${launch.executable}`).find(path => { try { return statSync(path).isFile(); } catch { return false; } });
  const real = launch.executable.startsWith('/') ? realpathSync(launch.executable) : found ? realpathSync(found) : null;
  if (!real) throw new Error();
  if (!real.endsWith('.js')) return real;
  const root = dirname(dirname(real)), triple = n.triples[process.arch], vendor = n.vendorRoots[process.arch];
  if (!triple) throw new Error();
  for (const base of [...(vendor ? [`${root}/${vendor}`] : []), `${root}/${n.fallbackVendorRoot}`]) {
    const binary = `${base}/${triple}/${n.binary}`;
    try { if (statSync(binary).isFile()) { env['PATH'] = `${base}/${triple}/${n.pathDir}:${env['PATH'] ?? ''}`; env[n.managedEnv] = '1'; return binary; } } catch { /* next root */ }
  }
  throw new Error();
}
/** The process owning a loopback LISTEN socket on `port` (state 0A), or null. */
function listener(port: number): number | null {
  for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let table: string; try { table = readFileSync(path, 'utf8'); } catch { continue; }
    for (const line of table.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/u);
      if (cols[3] === '0A' && parseInt(cols[1]?.split(':')[1] ?? '', 16) === port && cols[9]) { const owners = holders(cols[9]); return owners.length === 1 ? owners[0]! : null; }
    }
  }
  return null;
}
const freePort = async () => { const probe = createServer(); const port = await listen(probe); await new Promise(resolve => probe.close(resolve)); return port; };

/**
 * Container init: (1) read the nonsecret launch spec from the host relay; (2) start the app-server as its DIRECT child (pinned: pid + start
 * time) with no stdio pipes, its control on a loopback WebSocket that only accepts the bearer whose SHA-256 is on its argv (the bearer stays
 * in this process's memory), connected only after the listener is proven to be the pinned child's; (3) serve the auth helper ONCE — only a
 * process whose cmdline is exactly the helper invocation and whose direct parent is the pinned app-server receives C (before any tool can
 * exist); (4) the model shim accepts loopback connections owned by exactly the pinned app-server and forwards only `POST /v1/responses`.
 * No credential file, env, argv or pipe; tool children cannot reopen a socket through /proc, nor attach to their ancestors (Yama ≥ 1).
 */
async function main() {
  // First: no same-uid process (a tool child) may open this process's /proc fd/mem/maps/environ — it holds the relay channel and briefly C.
  const hardening = { exports: {} as { setNonDumpable?: () => boolean } }; process.dlopen(hardening, HARDENING);
  if (hardening.exports.setNonDumpable?.() !== true) throw new Error();
  const spec = await fetchText('GET', '/launch'); if (spec.status !== 200) throw new Error();
  const launch = JSON.parse(spec.body) as Launch; if (launch.schemaVersion !== 1) throw new Error();
  const home = '/tmp/deckent-home'; mkdirSync(`${home}/.codex`, { recursive: true, mode: 0o700 });
  let child: ChildProcess | undefined = undefined;
  let appServer: { pid: number; start: string } | null = null, issued = false, sequence = 0;
  const helperServer = createServer((incoming, response) => {
    incoming.resume();
    const peer = peerOf(incoming.socket);
    let exact: boolean;
    try { exact = !!peer && !!appServer && stat(peer.pid).ppid === appServer.pid && stat(appServer.pid).start === appServer.start
      && readFileSync(`/proc/${peer.pid}/cmdline`, 'latin1') === ['node', HELPER, String(helperPort)].join('\0') + '\0'; } catch { exact = false; }
    if (issued || !exact || incoming.method !== 'POST' || incoming.url !== '/capability') { response.writeHead(403).end(); return; }
    issued = true; helperServer.close();
    void fetchText('POST', '/capability').then(answer => { response.writeHead(answer.status === 200 ? 200 : 403); response.end(answer.status === 200 ? answer.body : ''); }, () => response.writeHead(403).end());
  });
  helperServer.maxConnections = 1;
  const shim = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const peer = peerOf(incoming.socket);
    if (!appServer || !peer || peer.pid !== appServer.pid || peer.start !== appServer.start || incoming.method !== 'POST' || incoming.url !== '/v1/responses') {
      incoming.resume(); response.writeHead(403).end(); return;
    }
    const length = incoming.headers['content-length'];
    const forward = host('POST', '/v1/responses', { ...(typeof incoming.headers['authorization'] === 'string' ? { authorization: incoming.headers['authorization'] } : {}),
      'content-type': 'application/json', 'x-deckent-sequence': String(++sequence), ...(length ? { 'content-length': length } : { 'transfer-encoding': 'chunked' }) });
    forward.on('response', answer => { response.writeHead(answer.statusCode ?? 502, { 'content-type': String(answer.headers['content-type'] ?? 'application/octet-stream') }); answer.pipe(response); });
    forward.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    incoming.pipe(forward);
  });
  shim.maxConnections = launch.limits.connections; shim.headersTimeout = launch.limits.idleMs; shim.requestTimeout = 0;
  const [helperPort, shimPort, ctlPort] = await Promise.all([listen(helperServer), listen(shim), freePort()]);
  const token = randomBytes(32).toString('base64url'), tokenSha256 = createHash('sha256').update(token).digest('hex');
  const args = launch.args.map(arg => arg.replaceAll('{capPort}', String(helperPort)).replaceAll('{shimPort}', String(shimPort))
    .replaceAll('{ctlPort}', String(ctlPort)).replaceAll('{ctlTokenSha256}', tokenSha256));
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: `${home}/.codex`, LANG: 'C.UTF-8' };
  child = spawn(nativeAppServer(launch, env), args, { cwd: '/workspace', stdio: 'ignore', env });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { child!.on('error', () => resolve({ code: null, signal: null })); child!.on('exit', (code, signal) => resolve({ code, signal })); });
  await new Promise(resolve => child!.once('spawn', resolve));
  appServer = { pid: child.pid!, start: stat(child.pid!).start };
  const deadline = Date.now() + launch.limits.controlConnectMs;
  while (listener(ctlPort) !== appServer.pid) { if (Date.now() > deadline || child.exitCode !== null) throw new Error(); await new Promise(resolve => setTimeout(resolve, launch.limits.controlPollMs)); }
  const socket = new WebSocket(`ws://127.0.0.1:${ctlPort}`, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error()); });
  const control = host('POST', '/control', { 'content-type': 'application/x-ndjson', 'transfer-encoding': 'chunked' });
  socket.onmessage = event => { if (typeof event.data === 'string') control.write(event.data.replace(/\n/gu, ' ') + '\n'); };
  socket.onclose = () => control.end();
  control.on('response', answer => {
    let buffer = ''; answer.setEncoding('utf8');
    answer.on('data', (part: string) => { buffer += part; for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line) socket.send(line); } });
    // Host ended the turn (settled or revoked): close control, then bounded termination.
    answer.on('end', () => { socket.close(); setTimeout(() => child?.kill('SIGTERM'), launch.limits.drainMs).unref(); setTimeout(() => child?.kill('SIGKILL'), 2 * launch.limits.drainMs).unref(); });
  });
  control.on('error', () => child?.kill('SIGKILL')); control.flushHeaders();
  const result = await exited;
  shim.close(); helperServer.close(); control.end(); socket.close();
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'siwc-worker-exit', ...result, capabilityIssued: issued }) + '\n');
  process.exitCode = result.code === 0 ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exitCode = 78; });
}
